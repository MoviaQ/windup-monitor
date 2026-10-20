package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"windup-monitor/agent/internal/client"
	"windup-monitor/agent/internal/collect"
	"windup-monitor/agent/internal/config"
	"windup-monitor/agent/internal/protocol"
	"windup-monitor/agent/internal/store"
)

// fakeCore is a scripted Core: records requests, serves canned responses.
type fakeCore struct {
	t      *testing.T
	mu     sync.Mutex
	enroll map[string]any
	beats  []map[string]any // decoded heartbeat bodies in order
	raw    [][]byte         // raw heartbeat bodies in order
	auths  []string
	script func(call int) (status int, body string)
	calls  int
}

func (f *fakeCore) handler(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch {
	case strings.HasSuffix(r.URL.Path, "/enroll"):
		_ = json.Unmarshal(raw, &f.enroll)
		_, _ = w.Write([]byte(`{"agent_id":"ag_test","credential":"CRED-SECRET-1","heartbeat_interval_s":15,"config_version":7}`))
	case strings.HasSuffix(r.URL.Path, "/rotate"):
		var b map[string]any
		_ = json.Unmarshal(raw, &b)
		f.auths = append(f.auths, r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(`{"overlap_until":"2026-10-19T12:10:00Z","rotation_id":"` + jsonString(b["rotation_id"]) + `"}`))
	case strings.HasSuffix(r.URL.Path, "/rotate_confirm"):
		var b map[string]any
		_ = json.Unmarshal(raw, &b)
		f.auths = append(f.auths, r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(`{}`))
	case strings.HasSuffix(r.URL.Path, "/heartbeat"):
		var b map[string]any
		_ = json.Unmarshal(raw, &b)
		f.beats = append(f.beats, b)
		f.raw = append(f.raw, raw)
		f.auths = append(f.auths, r.Header.Get("Authorization"))
		if v := r.Header.Get(protocol.HeaderVersion); v != "1" {
			f.t.Errorf("missing version header, got %q", v)
		}
		if id := r.Header.Get(protocol.HeaderAgentID); id != "ag_test" {
			f.t.Errorf("agent header=%q", id)
		}
		call := f.calls
		f.calls++
		status, body := f.script(call)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	case strings.HasSuffix(r.URL.Path, "/config"):
		_, _ = w.Write([]byte(`{"config_version":8,"heartbeat_interval_s":20,"queue_ttl_s":300,"lease_s":120,"result_ttl_s":600}`))
	default:
		w.WriteHeader(404)
	}
}

func jsonString(v any) string {
	s, _ := v.(string)
	out, _ := json.Marshal(s)
	return string(out[1 : len(out)-1])
}

func okHeartbeat(pending string) (int, string) {
	return 200, `{"server_time":"2026-10-19T12:00:00Z","config_version":7,"config_changed":false,"pending_commands":` + pending + `,"full_inventory":false}`
}

func writeProc(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	write := func(name, content string) {
		p := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("stat", "cpu  100 0 50 800 50 0 0 0 0 0\n")
	write("loadavg", "0.10 0.05 0.01 1/50 7\n")
	write("meminfo", "MemTotal:        8192 kB\nMemAvailable:      4096 kB\n")
	write("net/dev", "Inter-| R | T\n face |x|y\n  eth0: 10 0 0 0 0 0 0 0 20 0 0 0 0 0 0 0\n")
	write("uptime", "60.00 120.00\n")
	write("mounts", "proc /proc proc rw 0 0\n")
	return root
}

func newTestRunner(t *testing.T, fc *fakeCore, srvURL string, logOut *bytes.Buffer) *Runner {
	t.Helper()
	cfg := config.New()
	cfg.CoreURL = srvURL
	cfg.StateDir = t.TempDir()
	cfg.Hostname = "testhost"
	cfg.Interval = time.Second
	cfg.EnrollToken = "ONE-SHOT-TOKEN"
	st, err := store.Open(cfg.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	logger := log.New(io.Discard, "", 0)
	if logOut != nil {
		logger = log.New(logOut, "", 0)
	}
	r := &Runner{
		cfg: cfg, st: st, col: collect.New(writeProc(t)),
		cli: client.New(srvURL, nil, client.ShortTimeout, "test/1.0"),
		log: logger, nowFn: time.Now,
		procRoot: writeProc(t),
		// Hermetic discovery: empty but complete snapshot (service tests
		// override snapshotFn with their own candidates).
		snapshotFn: func(now time.Time) (*protocol.ServiceDiscovery, error) {
			return &protocol.ServiceDiscovery{
				ObservedAt: now.UTC().Format(time.RFC3339),
				Complete:   true,
				Candidates: []protocol.ServiceCandidate{},
			}, nil
		},
		svcLastRun: map[string]time.Time{},
		inFlight:   map[string]bool{},
		resBuf:     &resultBuffer{},
	}
	// Background probe pool (stopped on cleanup: no leaked workers).
	r.ensurePool()
	t.Cleanup(r.pool.stop)
	return r
}

func enrollTestAgent(t *testing.T, r *Runner) {
	t.Helper()
	cred, err := r.EnsureEnrolled(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if cred.AgentID != "ag_test" || cred.Credential != "CRED-SECRET-1" {
		t.Fatalf("got %+v", cred)
	}
}

func TestEnrollSavesCredential0600(t *testing.T) {
	fc := &fakeCore{t: t, script: func(int) (int, string) { return okHeartbeat(`[]`) }}
	srv := httptest.NewServer(http.HandlerFunc(fc.handler))
	defer srv.Close()
	r := newTestRunner(t, fc, srv.URL, nil)

	enrollTestAgent(t, r)
	fi, err := os.Stat(filepath.Join(r.st.Dir(), "credential.json"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode=%o", fi.Mode().Perm())
	}
	if _, ok := fc.enroll["enroll_token"]; !ok {
		t.Fatalf("enroll body=%v", fc.enroll)
	}
	if caps, _ := fc.enroll["capabilities"].([]any); len(caps) != 3 || caps[0] != "metrics" || caps[1] != "service_discovery" || caps[2] != "http_checks" {
		t.Fatalf("capabilities=%v", fc.enroll["capabilities"])
	}
}

func TestHeartbeatEnvelopeSnakeCaseAndAuth(t *testing.T) {
	fc := &fakeCore{t: t, script: func(int) (int, string) { return okHeartbeat(`[]`) }}
	srv := httptest.NewServer(http.HandlerFunc(fc.handler))
	defer srv.Close()
	var logs bytes.Buffer
	r := newTestRunner(t, fc, srv.URL, &logs)
	enrollTestAgent(t, r)

	failures := 0
	var skip time.Time
	cfgVersion := 7
	var pending []protocol.CommandResult
	if err := r.tick(context.Background(), &store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}, &cfgVersion, &pending, &failures, &skip); err != nil {
		t.Fatal(err)
	}
	if len(fc.beats) != 1 {
		t.Fatalf("beats=%d", len(fc.beats))
	}
	b := fc.beats[0]
	for _, k := range []string{"seq", "observed_at", "config_version", "metrics", "docker", "command_results"} {
		if _, ok := b[k]; !ok {
			t.Fatalf("missing key %q in %v", k, b)
		}
	}
	m := b["metrics"].(map[string]any)
	for _, k := range []string{"cpu", "mem", "disk", "net", "uptime_s"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("missing metrics key %q", k)
		}
	}
	for _, k := range []string{"usage_pct", "load1"} {
		if _, ok := m["cpu"].(map[string]any)[k]; !ok {
			t.Fatalf("missing cpu key %q", k)
		}
	}
	for _, k := range []string{"total_b", "used_b", "avail_b"} {
		if _, ok := m["mem"].(map[string]any)[k]; !ok {
			t.Fatalf("missing mem key %q", k)
		}
	}
	if fc.auths[len(fc.auths)-1] != "Bearer CRED-SECRET-1" {
		t.Fatalf("auth=%v", fc.auths)
	}
	// No secrets in logs.
	for _, leak := range []string{"CRED-SECRET-1"} {
		if strings.Contains(logs.String(), leak) {
			t.Fatalf("log leaks credential:\n%s", logs.String())
		}
	}
}

func TestRetrySendsIdenticalEnvelope(t *testing.T) {
	fc := &fakeCore{t: t}
	attempt := 0
	fc.script = func(call int) (int, string) {
		attempt++
		if attempt == 1 {
			return 500, `{"code":"RATE_LIMITED","message":"slow down"}`
		}
		return okHeartbeat(`[]`)
	}
	srv := httptest.NewServer(http.HandlerFunc(fc.handler))
	defer srv.Close()
	r := newTestRunner(t, fc, srv.URL, nil)
	enrollTestAgent(t, r)

	cred := store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}
	failures := 0
	var skip time.Time
	cfgVersion := 7
	var pending []protocol.CommandResult
	ctx := context.Background()
	if err := r.tick(ctx, &cred, &cfgVersion, &pending, &failures, &skip); err != nil {
		t.Fatal(err)
	}
	// First tick failed (RATE_LIMITED), envelope stays queued.
	if n, _ := r.st.OutboxLen(); n != 1 {
		t.Fatalf("outbox=%d want 1", n)
	}
	// Force immediate retry by clearing backoff and ticking again (new seq
	// would be created, but the old one must be sent FIRST, byte-identical).
	skip = time.Time{}
	firstRaw := append([]byte(nil), fc.raw[0]...)
	if err := r.tick(ctx, &cred, &cfgVersion, &pending, &failures, &skip); err != nil {
		t.Fatal(err)
	}
	if len(fc.raw) < 2 {
		t.Fatalf("expected retry, got %d calls", len(fc.raw))
	}
	var first, second map[string]any
	_ = json.Unmarshal(firstRaw, &first)
	_ = json.Unmarshal(fc.raw[1], &second)
	if first["seq"] != second["seq"] || first["observed_at"] != second["observed_at"] {
		t.Fatalf("retry must resend identical envelope:\n%s\n%s", firstRaw, fc.raw[1])
	}
	if string(firstRaw) != string(fc.raw[1]) {
		t.Fatalf("retry bytes differ:\n%s\n%s", firstRaw, fc.raw[1])
	}
}

func TestPendingCommandsRejectedWithNullOutcome(t *testing.T) {
	fc := &fakeCore{t: t, script: func(int) (int, string) {
		return okHeartbeat(`[{"command_id":"cmd_1","type":"restart_container","issued_at":"2026-10-19T12:00:00Z","queue_expires_at":"2026-10-19T12:05:00Z","lease_s":120,"idempotency_key":"cmd_1"}]`)
	}}
	srv := httptest.NewServer(http.HandlerFunc(fc.handler))
	defer srv.Close()
	r := newTestRunner(t, fc, srv.URL, nil)
	enrollTestAgent(t, r)

	cred := store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}
	failures := 0
	var skip time.Time
	cfgVersion := 7
	var pending []protocol.CommandResult
	ctx := context.Background()
	if err := r.tick(ctx, &cred, &cfgVersion, &pending, &failures, &skip); err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].State != protocol.CmdRejected || pending[0].Outcome != nil {
		t.Fatalf("pending=%+v", pending)
	}
	// Next envelope carries the rejection with explicit JSON null outcome.
	skip = time.Time{}
	if err := r.tick(ctx, &cred, &cfgVersion, &pending, &failures, &skip); err != nil {
		t.Fatal(err)
	}
	last := fc.raw[len(fc.raw)-1]
	if !strings.Contains(string(last), `"outcome":null`) {
		t.Fatalf("rejected outcome must be null:\n%s", last)
	}
	if !strings.Contains(string(last), `"state":"rejected"`) {
		t.Fatalf("missing rejected state:\n%s", last)
	}
}

func TestRevokedStopsAndWipesCredentials(t *testing.T) {
	fc := &fakeCore{t: t, script: func(int) (int, string) {
		return 401, `{"code":"AGENT_REVOKED","message":"revoked"}`
	}}
	srv := httptest.NewServer(http.HandlerFunc(fc.handler))
	defer srv.Close()
	var logs bytes.Buffer
	r := newTestRunner(t, fc, srv.URL, &logs)
	enrollTestAgent(t, r)

	cred := store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}
	failures := 0
	var skip time.Time
	cfgVersion := 7
	var pending []protocol.CommandResult
	err := r.tick(context.Background(), &cred, &cfgVersion, &pending, &failures, &skip)
	if err == nil || !strings.Contains(err.Error(), "revoked") {
		t.Fatalf("want ErrRevoked, got %v", err)
	}
	if _, ok, _ := r.st.LoadCredential(); ok {
		t.Fatal("credential must be wiped after revoke")
	}
	for _, leak := range []string{"CRED-SECRET-1"} {
		if strings.Contains(logs.String(), leak) {
			t.Fatalf("log leaks credential:\n%s", logs.String())
		}
	}
}

func TestConfigStaleFetchesConfig(t *testing.T) {
	fc := &fakeCore{t: t, script: func(int) (int, string) {
		return 200, `{"server_time":"2026-10-19T12:00:00Z","config_version":8,"config_changed":true,"pending_commands":[],"full_inventory":false}`
	}}
	srv := httptest.NewServer(http.HandlerFunc(fc.handler))
	defer srv.Close()
	r := newTestRunner(t, fc, srv.URL, nil)
	enrollTestAgent(t, r)

	cred := store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}
	failures := 0
	var skip time.Time
	cfgVersion := 7
	var pending []protocol.CommandResult
	if err := r.tick(context.Background(), &cred, &cfgVersion, &pending, &failures, &skip); err != nil {
		t.Fatal(err)
	}
	if cfgVersion != 8 {
		t.Fatalf("config version=%d want 8", cfgVersion)
	}
	if r.cfg.Interval != 20*time.Second {
		t.Fatalf("interval=%s want 20s", r.cfg.Interval)
	}
}

func TestRotateReusesSavedRotationOnRetry(t *testing.T) {
	var rotates int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		raw, _ := io.ReadAll(r.Body)
		switch {
		case strings.HasSuffix(r.URL.Path, "/enroll"):
			_, _ = w.Write([]byte(`{"agent_id":"ag_test","credential":"CRED-SECRET-1","heartbeat_interval_s":15,"config_version":7}`))
		case strings.HasSuffix(r.URL.Path, "/rotate"):
			rotates++
			if rotates == 1 {
				w.WriteHeader(500)
				_, _ = w.Write([]byte(`{"code":"RATE_LIMITED"}`))
				return
			}
			var b map[string]any
			_ = json.Unmarshal(raw, &b)
			_, _ = w.Write([]byte(`{"overlap_until":"x","rotation_id":"` + jsonString(b["rotation_id"]) + `"}`))
		case strings.HasSuffix(r.URL.Path, "/rotate_confirm"):
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer srv.Close()
	r := newTestRunner(t, nil, srv.URL, nil)
	enrollTestAgent(t, r)

	ctx := context.Background()
	if err := r.RotateOnce(ctx); err == nil {
		t.Fatal("first rotate must fail on 500")
	}
	rot1, ok, err := r.st.LoadRotation()
	if err != nil || !ok {
		t.Fatalf("rotation must be saved before send: %v %v", rot1, ok)
	}
	if err := r.RotateOnce(ctx); err != nil {
		t.Fatalf("retry: %v", err)
	}
	rot2, ok, _ := r.st.LoadRotation()
	if ok {
		t.Fatalf("rotation must be cleared after confirm: %+v", rot2)
	}
	cred, _, _ := r.st.LoadCredential()
	if cred.Credential == "CRED-SECRET-1" {
		t.Fatal("credential must be promoted to next")
	}
	_ = rot1
}

func TestBackoffBounds(t *testing.T) {
	d1 := Backoff(1)
	if d1 < time.Second || d1 > 1500*time.Millisecond {
		t.Fatalf("attempt1=%s", d1)
	}
	for i := 1; i <= 12; i++ {
		d := Backoff(i)
		if d < time.Second || d > 7*time.Minute {
			t.Fatalf("attempt%d=%s out of bounds", i, d)
		}
	}
	if d := Backoff(100); d > 7*time.Minute {
		t.Fatalf("must cap, got %s", d)
	}
}

// revokedCore serves an enroll plus scripted rotate/confirm answers so the
// three revoke paths (rotate, dual-accept fallback, confirm) can be driven.
func revokedCore(t *testing.T, mode string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		raw, _ := io.ReadAll(r.Body)
		switch {
		case strings.HasSuffix(r.URL.Path, "/enroll"):
			_, _ = w.Write([]byte(`{"agent_id":"ag_test","credential":"CRED-SECRET-1","heartbeat_interval_s":15,"config_version":7}`))
		case strings.HasSuffix(r.URL.Path, "/rotate_confirm"):
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"code":"AGENT_REVOKED","message":"revoked"}`))
		case strings.HasSuffix(r.URL.Path, "/rotate"):
			switch mode {
			case "rotate":
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"code":"AGENT_REVOKED","message":"revoked"}`))
			case "fallback":
				if r.Header.Get("Authorization") == "Bearer CRED-SECRET-1" {
					w.WriteHeader(http.StatusUnauthorized)
					_, _ = w.Write([]byte(`{"code":"BAD_CREDENTIAL","message":"stale"}`))
					return
				}
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"code":"AGENT_REVOKED","message":"revoked"}`))
			default:
				var b map[string]any
				_ = json.Unmarshal(raw, &b)
				_, _ = w.Write([]byte(`{"overlap_until":"x","rotation_id":"` + jsonString(b["rotation_id"]) + `"}`))
			}
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

// F1: every rotate path (rotate, dual-accept fallback, confirm) must wipe
// credential + rotation on 401 AGENT_REVOKED and surface ErrRevoked (exit 3).
func TestRotateRevokedWipesStateAndSignalsRevoked(t *testing.T) {
	for _, mode := range []string{"rotate", "fallback", "confirm"} {
		t.Run(mode, func(t *testing.T) {
			var logs bytes.Buffer
			srv := revokedCore(t, mode)
			defer srv.Close()
			r := newTestRunner(t, nil, srv.URL, &logs)
			enrollTestAgent(t, r)
			if err := r.st.SaveRotation(store.Rotation{RotationID: "rot_pending", Next: "NEXT-SECRET-1"}); err != nil {
				t.Fatal(err)
			}

			err := r.RotateOnce(context.Background())
			if !errors.Is(err, ErrRevoked) {
				t.Fatalf("want ErrRevoked (exit 3), got %v", err)
			}
			if _, ok, _ := r.st.LoadCredential(); ok {
				t.Fatal("credential must be wiped on revoke")
			}
			if _, ok, _ := r.st.LoadRotation(); ok {
				t.Fatal("pending rotation must be wiped on revoke")
			}
			for _, leak := range []string{"CRED-SECRET-1", "NEXT-SECRET-1"} {
				if strings.Contains(logs.String(), leak) {
					t.Fatalf("log leaks a secret:\n%s", logs.String())
				}
			}
		})
	}
}

// F2: a successful forced re-enroll drops the pending rotation that belongs to
// the PREVIOUS identity.
func TestEnrollForceDropsStalePendingRotation(t *testing.T) {
	fc := &fakeCore{t: t, script: func(int) (int, string) { return okHeartbeat(`[]`) }}
	srv := httptest.NewServer(http.HandlerFunc(fc.handler))
	defer srv.Close()
	r := newTestRunner(t, fc, srv.URL, nil)

	if err := r.st.SaveCredential(store.Credential{AgentID: "ag_old", Credential: "OLD-SECRET-1"}); err != nil {
		t.Fatal(err)
	}
	if err := r.st.SaveRotation(store.Rotation{RotationID: "rot_old", Next: "OLD-NEXT-1"}); err != nil {
		t.Fatal(err)
	}

	if err := r.EnrollOnce(context.Background(), true); err != nil {
		t.Fatalf("force enroll: %v", err)
	}
	cred, ok, err := r.st.LoadCredential()
	if err != nil || !ok {
		t.Fatalf("load credential: %v ok=%v", err, ok)
	}
	if cred.Credential != "CRED-SECRET-1" {
		t.Fatalf("credential=%q want the new one", cred.Credential)
	}
	if _, ok, _ := r.st.LoadRotation(); ok {
		t.Fatal("rotation of the previous identity must be cleared after a successful re-enroll")
	}
}

// F2: a FAILED enroll (even with --force) must not destroy the existing
// identity nor its rotation state.
func TestEnrollFailureKeepsExistingIdentityAndRotation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"code":"RATE_LIMITED","message":"slow down"}`))
	}))
	defer srv.Close()
	r := newTestRunner(t, nil, srv.URL, nil)

	if err := r.st.SaveCredential(store.Credential{AgentID: "ag_old", Credential: "OLD-SECRET-1"}); err != nil {
		t.Fatal(err)
	}
	if err := r.st.SaveRotation(store.Rotation{RotationID: "rot_old", Next: "OLD-NEXT-1"}); err != nil {
		t.Fatal(err)
	}

	if err := r.EnrollOnce(context.Background(), true); err == nil {
		t.Fatal("enroll must fail when Core answers 500")
	}
	cred, ok, err := r.st.LoadCredential()
	if err != nil || !ok {
		t.Fatalf("load credential: %v ok=%v", err, ok)
	}
	if cred.Credential != "OLD-SECRET-1" {
		t.Fatalf("identity destroyed by a failed enroll: %+v", cred)
	}
	rot, ok, err := r.st.LoadRotation()
	if err != nil || !ok || rot.RotationID != "rot_old" {
		t.Fatalf("rotation destroyed by a failed enroll: %+v ok=%v err=%v", rot, ok, err)
	}
}

// F3: CONFIG_STALE as a 4xx protocol code (not config_changed on 200) must
// fetch GET /config and resend the byte-identical envelope.
func TestConfigStale4xxFetchesConfigAndResendsSameEnvelope(t *testing.T) {
	var heartbeats, configHits int
	var bodies [][]byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		raw, _ := io.ReadAll(r.Body)
		switch {
		case strings.HasSuffix(r.URL.Path, "/enroll"):
			_, _ = w.Write([]byte(`{"agent_id":"ag_test","credential":"CRED-SECRET-1","heartbeat_interval_s":15,"config_version":7}`))
		case strings.HasSuffix(r.URL.Path, "/config"):
			configHits++
			_, _ = w.Write([]byte(`{"config_version":8,"heartbeat_interval_s":20,"queue_ttl_s":300,"lease_s":120,"result_ttl_s":600}`))
		case strings.HasSuffix(r.URL.Path, "/heartbeat"):
			heartbeats++
			bodies = append(bodies, append([]byte(nil), raw...))
			if heartbeats == 1 {
				w.WriteHeader(http.StatusConflict)
				_, _ = w.Write([]byte(`{"code":"CONFIG_STALE","message":"config_version outdated"}`))
				return
			}
			_, _ = w.Write([]byte(`{"server_time":"2026-10-19T12:00:00Z","config_version":8,"config_changed":false,"pending_commands":[],"full_inventory":false}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	r := newTestRunner(t, nil, srv.URL, nil)
	enrollTestAgent(t, r)

	cred := store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}
	failures := 0
	var skip time.Time
	cfgVersion := 7
	var pending []protocol.CommandResult
	if err := r.tick(context.Background(), &cred, &cfgVersion, &pending, &failures, &skip); err != nil {
		t.Fatalf("tick: %v", err)
	}
	if configHits != 1 {
		t.Fatalf("GET /config hits=%d want 1", configHits)
	}
	if heartbeats != 2 {
		t.Fatalf("heartbeat calls=%d want 2 (stale + resend)", heartbeats)
	}
	if len(bodies) != 2 || string(bodies[0]) != string(bodies[1]) {
		t.Fatalf("retry must resend identical envelope:\n%s\n%s", bodies[0], bodies[1])
	}
	if cfgVersion != 8 {
		t.Fatalf("config version=%d want 8", cfgVersion)
	}
	if r.cfg.Interval != 20*time.Second {
		t.Fatalf("interval=%s want 20s", r.cfg.Interval)
	}
	if failures != 0 {
		t.Fatalf("failures=%d want 0 (CONFIG_STALE was handled)", failures)
	}
	if n, _ := r.st.OutboxLen(); n != 0 {
		t.Fatalf("outbox=%d want 0", n)
	}
}

// F3: a server that keeps answering CONFIG_STALE must not busy-loop the agent:
// one refresh + one resend per tick, then bounded backoff with the envelope
// kept for a later retry.
func TestConfigStaleRepeatedStaysBounded(t *testing.T) {
	var heartbeats, configHits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/enroll"):
			_, _ = w.Write([]byte(`{"agent_id":"ag_test","credential":"CRED-SECRET-1","heartbeat_interval_s":15,"config_version":7}`))
		case strings.HasSuffix(r.URL.Path, "/config"):
			configHits++
			_, _ = w.Write([]byte(`{"config_version":8,"heartbeat_interval_s":20,"queue_ttl_s":300,"lease_s":120,"result_ttl_s":600}`))
		case strings.HasSuffix(r.URL.Path, "/heartbeat"):
			heartbeats++
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"code":"CONFIG_STALE"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	r := newTestRunner(t, nil, srv.URL, nil)
	enrollTestAgent(t, r)

	cred := store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}
	failures := 0
	var skip time.Time
	cfgVersion := 7
	var pending []protocol.CommandResult
	ctx := context.Background()
	if err := r.tick(ctx, &cred, &cfgVersion, &pending, &failures, &skip); err != nil {
		t.Fatalf("tick must stay recoverable: %v", err)
	}
	if heartbeats != 2 || configHits != 1 {
		t.Fatalf("per tick want 2 heartbeats + 1 config fetch, got %d/%d", heartbeats, configHits)
	}
	if failures != 1 {
		t.Fatalf("failures=%d want 1 (bounded backoff)", failures)
	}
	if !skip.After(r.nowFn()) {
		t.Fatal("backoff window must be armed")
	}
	if n, _ := r.st.OutboxLen(); n != 1 {
		t.Fatalf("outbox=%d want 1 (envelope kept for retry)", n)
	}
	// Inside the backoff window nothing is sent: no hot loop.
	if err := r.tick(ctx, &cred, &cfgVersion, &pending, &failures, &skip); err != nil {
		t.Fatalf("tick in backoff: %v", err)
	}
	if heartbeats != 2 || configHits != 1 {
		t.Fatalf("backoff tick must not send: %d/%d", heartbeats, configHits)
	}
}

// F3: when GET /config itself fails, the envelope stays queued and the failure
// is counted into the bounded backoff instead of being dropped or looped.
func TestConfigStaleConfigFetchFailureKeepsEnvelope(t *testing.T) {
	var heartbeats int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/enroll"):
			_, _ = w.Write([]byte(`{"agent_id":"ag_test","credential":"CRED-SECRET-1","heartbeat_interval_s":15,"config_version":7}`))
		case strings.HasSuffix(r.URL.Path, "/config"):
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"code":"RATE_LIMITED"}`))
		case strings.HasSuffix(r.URL.Path, "/heartbeat"):
			heartbeats++
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"code":"CONFIG_STALE"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	r := newTestRunner(t, nil, srv.URL, nil)
	enrollTestAgent(t, r)

	cred := store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}
	failures := 0
	var skip time.Time
	cfgVersion := 7
	var pending []protocol.CommandResult
	if err := r.tick(context.Background(), &cred, &cfgVersion, &pending, &failures, &skip); err != nil {
		t.Fatalf("tick: %v", err)
	}
	if heartbeats != 1 {
		t.Fatalf("heartbeats=%d want 1 (no resend without fresh config)", heartbeats)
	}
	if failures != 1 || !skip.After(r.nowFn()) {
		t.Fatalf("failures=%d skip=%s want bounded backoff", failures, skip)
	}
	if n, _ := r.st.OutboxLen(); n != 1 {
		t.Fatalf("outbox=%d want 1 (envelope must not be lost)", n)
	}
}

// F5: a credential replaced on disk by an external `rotate` is reloaded by the
// running daemon without losing the seq counter or the queued envelopes.
func TestReloadsCredentialFromDiskWithoutLosingSeqOrOutbox(t *testing.T) {
	fc := &fakeCore{t: t}
	attempt := 0
	fc.script = func(int) (int, string) {
		attempt++
		if attempt == 1 {
			return 500, `{"code":"RATE_LIMITED"}`
		}
		return okHeartbeat(`[]`)
	}
	srv := httptest.NewServer(http.HandlerFunc(fc.handler))
	defer srv.Close()
	r := newTestRunner(t, fc, srv.URL, nil)
	enrollTestAgent(t, r)

	cred := store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}
	failures := 0
	var skip time.Time
	cfgVersion := 7
	var pending []protocol.CommandResult
	ctx := context.Background()
	if err := r.tick(ctx, &cred, &cfgVersion, &pending, &failures, &skip); err != nil {
		t.Fatal(err)
	}
	if n, _ := r.st.OutboxLen(); n != 1 {
		t.Fatalf("outbox=%d want 1 (Core offline)", n)
	}

	// External `rotate` (separate process) promotes a new secret atomically.
	if err := r.st.SaveCredential(store.Credential{AgentID: "ag_test", Credential: "CRED-ROTATED-2"}); err != nil {
		t.Fatal(err)
	}
	skip = time.Time{}
	if err := r.tick(ctx, &cred, &cfgVersion, &pending, &failures, &skip); err != nil {
		t.Fatal(err)
	}
	if len(fc.raw) < 2 || string(fc.raw[0]) != string(fc.raw[1]) {
		t.Fatalf("resend after reload must be byte-identical (outbox loss): %d envelopes", len(fc.raw))
	}
	if len(fc.auths) < 2 || fc.auths[0] != "Bearer CRED-SECRET-1" {
		t.Fatalf("auths=%v", fc.auths)
	}
	if fc.auths[1] != "Bearer CRED-ROTATED-2" {
		t.Fatalf("resent envelope must use the reloaded secret, auths=%v", fc.auths)
	}
	if cred.Credential != "CRED-ROTATED-2" {
		t.Fatalf("in-memory credential=%q want the reloaded one", cred.Credential)
	}
	if n, _ := r.st.OutboxLen(); n != 0 {
		t.Fatalf("outbox=%d want 0", n)
	}
	if next, err := r.st.NextSeq(); err != nil || next != 3 {
		t.Fatalf("seq=%d err=%v want 3 (no rollback)", next, err)
	}
	if failures != 0 {
		t.Fatalf("failures=%d want 0", failures)
	}
}

// F5: a late 401 AGENT_REVOKED that answers for the PREVIOUS secret (external
// rotate raced the revoke) must reload the fresh secret and keep it on disk —
// never wipe a newer credential because of an answer for the old one.
func TestLateRevokeForPreviousCredentialKeepsNewSecret(t *testing.T) {
	var rRef *Runner
	var heartbeats int
	var auths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/enroll"):
			_, _ = w.Write([]byte(`{"agent_id":"ag_test","credential":"CRED-SECRET-1","heartbeat_interval_s":15,"config_version":7}`))
		case strings.HasSuffix(r.URL.Path, "/heartbeat"):
			heartbeats++
			auth := r.Header.Get("Authorization")
			auths = append(auths, auth)
			if auth == "Bearer CRED-SECRET-1" {
				// The external rotate lands while this request is in flight:
				// the answer that comes back was generated for the OLD secret.
				if rRef != nil {
					_ = rRef.st.SaveCredential(store.Credential{AgentID: "ag_test", Credential: "CRED-ROTATED-2"})
				}
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"code":"AGENT_REVOKED","message":"revoked"}`))
				return
			}
			_, _ = w.Write([]byte(`{"server_time":"2026-10-19T12:00:00Z","config_version":7,"config_changed":false,"pending_commands":[],"full_inventory":false}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	r := newTestRunner(t, nil, srv.URL, nil)
	rRef = r
	enrollTestAgent(t, r)

	cred := store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}
	failures := 0
	var skip time.Time
	cfgVersion := 7
	var pending []protocol.CommandResult
	if err := r.tick(context.Background(), &cred, &cfgVersion, &pending, &failures, &skip); err != nil {
		t.Fatalf("late revoke for the previous secret must not stop the daemon: %v", err)
	}
	if heartbeats != 2 || auths[len(auths)-1] != "Bearer CRED-ROTATED-2" {
		t.Fatalf("want reload + one retry, heartbeats=%d auths=%v", heartbeats, auths)
	}
	stored, ok, err := r.st.LoadCredential()
	if err != nil || !ok || stored.Credential != "CRED-ROTATED-2" {
		t.Fatalf("the newer secret must survive a late revoke: %+v ok=%v err=%v", stored, ok, err)
	}
	if cred.Credential != "CRED-ROTATED-2" {
		t.Fatalf("in-memory credential=%q want reloaded one", cred.Credential)
	}
	if n, _ := r.st.OutboxLen(); n != 0 {
		t.Fatalf("outbox=%d want 0", n)
	}
}
