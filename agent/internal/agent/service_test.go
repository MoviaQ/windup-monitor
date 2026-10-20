package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"windup-monitor/agent/internal/protocol"
	"windup-monitor/agent/internal/store"
)

// svcCore is a scripted Core with a configurable /config body.
type svcCore struct {
	mu         sync.Mutex
	beats      []map[string]any
	raw        [][]byte
	configResp string
	hbScript   func(call int) (int, string)
	calls      int
}

func (f *svcCore) handler(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch {
	case strings.HasSuffix(r.URL.Path, "/enroll"):
		_, _ = w.Write([]byte(`{"agent_id":"ag_test","credential":"CRED-SECRET-1","heartbeat_interval_s":15,"config_version":7}`))
	case strings.HasSuffix(r.URL.Path, "/config"):
		_, _ = w.Write([]byte(f.configResp))
	case strings.HasSuffix(r.URL.Path, "/heartbeat"):
		var b map[string]any
		_ = json.Unmarshal(raw, &b)
		f.beats = append(f.beats, b)
		f.raw = append(f.raw, append([]byte(nil), raw...))
		call := f.calls
		f.calls++
		status, body := f.hbScript(call)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	default:
		w.WriteHeader(404)
	}
}

func loopbackPort(t *testing.T, h http.Handler) int {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	p, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func svcCandidate(port int) protocol.ServiceCandidate {
	return protocol.ServiceCandidate{
		CandidateID: fmt.Sprintf("t3-code-%d", port), Name: "T3 Code",
		Kind: "t3-code", Port: port, Transport: "http", Source: "proc",
		Confidence: "high", Monitorable: true,
	}
}

func configWithCheck(rev, port int, checkID, candID string) string {
	return fmt.Sprintf(`{"config_version":%d,"heartbeat_interval_s":15,"queue_ttl_s":300,`+
		`"lease_s":120,"result_ttl_s":600,"service_checks":[`+
		`{"check_id":%q,"config_revision":%d,"candidate_id":%q,"port":%d,`+
		`"path":"/","expected_statuses":[200],"interval_s":15,"timeout_s":2,"enabled":true}]}`,
		rev, checkID, rev, candID, port)
}

func decodeBeat(t *testing.T, raw []byte) protocol.HeartbeatRequest {
	t.Helper()
	var env protocol.HeartbeatRequest
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("decode beat: %v\n%s", err, raw)
	}
	return env
}

func okHeartbeatRev(rev int) (int, string) {
	return 200, fmt.Sprintf(`{"server_time":"2026-10-19T12:00:00Z","config_version":%d,"config_changed":false,"pending_commands":[],"full_inventory":false}`, rev)
}

// waitBuffered polls the background result buffer (probes execute off the
// tick path); it fails on timeout instead of sleeping fixed durations.
func waitBuffered(t *testing.T, r *Runner, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if r.resBuf.len() >= want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("buffered results=%d want>=%d", r.resBuf.len(), want)
}

func tickOnce(t *testing.T, r *Runner, cred *store.Credential, cfgVersion *int, pending *[]protocol.CommandResult, failures *int, skip *time.Time) {
	t.Helper()
	if err := r.tick(context.Background(), cred, cfgVersion, pending, failures, skip); err != nil {
		t.Fatal(err)
	}
}

func TestServiceFlowDiscoveryConfigProbe(t *testing.T) {
	svcPort := loopbackPort(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	fc := &svcCore{
		configResp: configWithCheck(8, svcPort, "chk_svc1", fmt.Sprintf("t3-code-%d", svcPort)),
		hbScript: func(int) (int, string) {
			return 200, `{"server_time":"2026-10-19T12:00:00Z","config_version":8,"config_changed":false,"pending_commands":[],"full_inventory":false}`
		},
	}
	srv := httptest.NewServer(http.HandlerFunc(fc.handler))
	defer srv.Close()
	r := newTestRunner(t, nil, srv.URL, nil)
	r.snapshotFn = func(now time.Time) (*protocol.ServiceDiscovery, error) {
		return &protocol.ServiceDiscovery{
			ObservedAt: now.UTC().Format(time.RFC3339), Complete: true,
			Candidates: []protocol.ServiceCandidate{svcCandidate(svcPort)},
		}, nil
	}
	enrollTestAgent(t, r)

	cred := store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}
	cfgVersion := 7
	if err := r.refreshConfig(context.Background(), &cred, &cfgVersion); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if cfgVersion != 8 {
		t.Fatalf("cfgVersion=%d want 8", cfgVersion)
	}
	if _, present, _ := r.st.LoadServiceChecks(); !present {
		t.Fatal("checks must persist for restarts")
	}

	failures := 0
	var skip time.Time
	var pending []protocol.CommandResult
	// Tick 1 submits the probe to the background pool; the heartbeat must
	// not wait for it.
	tickOnce(t, r, &cred, &cfgVersion, &pending, &failures, &skip)
	if len(fc.raw) != 1 {
		t.Fatalf("beats=%d", len(fc.raw))
	}
	env1 := decodeBeat(t, fc.raw[0])
	if env1.ServiceDiscovery == nil || len(env1.ServiceDiscovery.Candidates) != 1 ||
		env1.ServiceDiscovery.Candidates[0].CandidateID != fmt.Sprintf("t3-code-%d", svcPort) {
		t.Fatalf("discovery=%+v", env1.ServiceDiscovery)
	}
	if len(env1.Capabilities) != 3 {
		t.Fatalf("capabilities=%v (need caps upgrade path)", env1.Capabilities)
	}
	// Tick 2 (after the background probe completes) delivers the result.
	waitBuffered(t, r, 1)
	tickOnce(t, r, &cred, &cfgVersion, &pending, &failures, &skip)
	env := decodeBeat(t, fc.raw[len(fc.raw)-1])
	if len(env.ServiceResults) != 1 {
		t.Fatalf("results=%+v", env.ServiceResults)
	}
	res := env.ServiceResults[0]
	if res.CheckID != "chk_svc1" || res.ConfigRevision != 8 || !res.OK {
		t.Fatalf("result=%+v", res)
	}
	if res.StatusCode == nil || *res.StatusCode != 200 || res.ErrorCode != nil {
		t.Fatalf("result=%+v", res)
	}

	// Immediate third tick: interval not elapsed -> no duplicate probe.
	tickOnce(t, r, &cred, &cfgVersion, &pending, &failures, &skip)
	env2 := decodeBeat(t, fc.raw[len(fc.raw)-1])
	if len(env2.ServiceResults) != 0 {
		t.Fatalf("third tick must not re-probe: %+v", env2.ServiceResults)
	}
}

func TestStaleConfigReplacedNoStaleResults(t *testing.T) {
	svcPort := loopbackPort(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	candID := fmt.Sprintf("t3-code-%d", svcPort)
	fc := &svcCore{
		configResp: configWithCheck(8, svcPort, "chk_new", candID),
		hbScript: func(int) (int, string) {
			return okHeartbeatRev(8)
		},
	}
	srv := httptest.NewServer(http.HandlerFunc(fc.handler))
	defer srv.Close()
	r := newTestRunner(t, nil, srv.URL, nil)
	r.snapshotFn = func(now time.Time) (*protocol.ServiceDiscovery, error) {
		return &protocol.ServiceDiscovery{
			ObservedAt: now.UTC().Format(time.RFC3339), Complete: true,
			Candidates: []protocol.ServiceCandidate{svcCandidate(svcPort)},
		}, nil
	}
	enrollTestAgent(t, r)

	// Old revision installed (e.g. restored after restart).
	old := protocol.ServiceCheck{CheckID: "chk_old", ConfigRevision: 7,
		CandidateID: candID, Port: svcPort, Path: "/old",
		ExpectedStatuses: []int{200}, IntervalS: 15, TimeoutS: 2, Enabled: true}
	r.setServiceChecks(7, []protocol.ServiceCheck{old}, true)

	cred := store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}
	cfgVersion := 7
	if err := r.refreshConfig(context.Background(), &cred, &cfgVersion); err != nil {
		t.Fatal(err)
	}
	failures := 0
	var skip time.Time
	var pending []protocol.CommandResult
	tickOnce(t, r, &cred, &cfgVersion, &pending, &failures, &skip)
	waitBuffered(t, r, 1)
	tickOnce(t, r, &cred, &cfgVersion, &pending, &failures, &skip)
	env := decodeBeat(t, fc.raw[len(fc.raw)-1])
	if len(env.ServiceResults) != 1 {
		t.Fatalf("results=%+v", env.ServiceResults)
	}
	if env.ServiceResults[0].CheckID != "chk_new" || env.ServiceResults[0].ConfigRevision != 8 {
		t.Fatalf("stale check leaked into results: %+v", env.ServiceResults[0])
	}
}

func TestDisappearedCandidateReportsUnavailable(t *testing.T) {
	fc := &svcCore{
		configResp: configWithCheck(8, 18099, "chk_gone", "t3-code-18099"),
		hbScript: func(int) (int, string) {
			return okHeartbeatRev(8)
		},
	}
	srv := httptest.NewServer(http.HandlerFunc(fc.handler))
	defer srv.Close()
	r := newTestRunner(t, nil, srv.URL, nil) // empty snapshot: candidate gone
	enrollTestAgent(t, r)

	cred := store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}
	cfgVersion := 7
	if err := r.refreshConfig(context.Background(), &cred, &cfgVersion); err != nil {
		t.Fatal(err)
	}
	failures := 0
	var skip time.Time
	var pending []protocol.CommandResult
	tickOnce(t, r, &cred, &cfgVersion, &pending, &failures, &skip)
	waitBuffered(t, r, 1)
	tickOnce(t, r, &cred, &cfgVersion, &pending, &failures, &skip)
	env := decodeBeat(t, fc.raw[len(fc.raw)-1])
	if len(env.ServiceResults) != 1 {
		t.Fatalf("results=%+v", env.ServiceResults)
	}
	res := env.ServiceResults[0]
	if res.OK || res.ErrorCode == nil || *res.ErrorCode != "SERVICE_UNAVAILABLE" || res.StatusCode != nil {
		t.Fatalf("disappeared candidate must fail unavailable: %+v", res)
	}
}

func TestServiceResultsSurviveOutboxRetry(t *testing.T) {
	release := make(chan struct{})
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release: // deterministic: tick 1 submits, its envelope carries no results yet
		case <-time.After(30 * time.Second): // backstop: never hang cleanup on failure
		}
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv2.Close()
	u, _ := url.Parse(srv2.URL)
	svcPort, _ := strconv.Atoi(u.Port())
	candID := fmt.Sprintf("t3-code-%d", svcPort)
	fc := &svcCore{configResp: configWithCheck(8, svcPort, "chk_retry", candID)}
	calls := 0
	fc.hbScript = func(int) (int, string) {
		calls++
		if calls == 2 {
			return 500, `{"code":"RATE_LIMITED","message":"slow down"}`
		}
		return okHeartbeatRev(8)
	}
	srv := httptest.NewServer(http.HandlerFunc(fc.handler))
	defer srv.Close()
	r := newTestRunner(t, nil, srv.URL, nil)
	r.snapshotFn = func(now time.Time) (*protocol.ServiceDiscovery, error) {
		return &protocol.ServiceDiscovery{
			ObservedAt: now.UTC().Format(time.RFC3339), Complete: true,
			Candidates: []protocol.ServiceCandidate{svcCandidate(svcPort)},
		}, nil
	}
	enrollTestAgent(t, r)

	cred := store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}
	cfgVersion := 7
	if err := r.refreshConfig(context.Background(), &cred, &cfgVersion); err != nil {
		t.Fatal(err)
	}
	failures := 0
	var skip time.Time
	var pending []protocol.CommandResult
	ctx := context.Background()
	// Tick 1: probe still blocked -> envelope 1 carries metrics only.
	tickOnce(t, r, &cred, &cfgVersion, &pending, &failures, &skip)
	if n, _ := r.st.OutboxLen(); n != 0 {
		t.Fatalf("outbox=%d want 0", n)
	}
	// Release the probe; tick 2 persists envelope 2 WITH the result, then
	// Core 500s it into the outbox.
	close(release)
	waitBuffered(t, r, 1)
	tickOnce(t, r, &cred, &cfgVersion, &pending, &failures, &skip)
	if n, _ := r.st.OutboxLen(); n != 1 {
		t.Fatalf("outbox=%d want 1", n)
	}
	failed := append([]byte(nil), fc.raw[1]...)
	if !strings.Contains(string(failed), "chk_retry") {
		t.Fatalf("envelope 2 lost service payload:\n%s", failed)
	}
	// Tick 3 resends envelope 2 byte-identical, then the fresh envelope 3.
	skip = time.Time{}
	tickOnce(t, r, &cred, &cfgVersion, &pending, &failures, &skip)
	if len(fc.raw) < 4 || string(fc.raw[2]) != string(failed) {
		t.Fatalf("retry must resend identical service envelope (%d sends)", len(fc.raw))
	}
	env3 := decodeBeat(t, fc.raw[3])
	if len(env3.ServiceResults) != 0 {
		t.Fatalf("envelope 3 must not duplicate results: %+v", env3.ServiceResults)
	}
	if n, _ := r.st.OutboxLen(); n != 0 {
		t.Fatalf("outbox=%d want 0", n)
	}
	_ = ctx
}

func TestDiscoveryFailureKeepsHeartbeat(t *testing.T) {
	fc := &svcCore{
		configResp: `{"config_version":7,"heartbeat_interval_s":15}`,
		hbScript:   func(int) (int, string) { return okHeartbeat(`[]`) },
	}
	srv := httptest.NewServer(http.HandlerFunc(fc.handler))
	defer srv.Close()
	r := newTestRunner(t, nil, srv.URL, nil)
	r.snapshotFn = func(time.Time) (*protocol.ServiceDiscovery, error) {
		return nil, fmt.Errorf("proc unavailable")
	}
	enrollTestAgent(t, r)

	cred := store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}
	failures := 0
	var skip time.Time
	cfgVersion := 7
	var pending []protocol.CommandResult
	if err := r.tick(context.Background(), &cred, &cfgVersion, &pending, &failures, &skip); err != nil {
		t.Fatal(err)
	}
	if len(fc.raw) != 1 {
		t.Fatalf("heartbeat must go out despite discovery failure (beats=%d)", len(fc.raw))
	}
	env := decodeBeat(t, fc.raw[0])
	if env.ServiceDiscovery != nil {
		t.Fatalf("no snapshot must mean absent key, got %+v", env.ServiceDiscovery)
	}
}

func configWithChecks(rev, port int, ids []string) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, `{"config_version":%d,"heartbeat_interval_s":15,"queue_ttl_s":300,"lease_s":120,"result_ttl_s":600,"service_checks":[`, rev)
	for i, id := range ids {
		if i > 0 {
			sb.WriteByte(',')
		}
		fmt.Fprintf(&sb, `{"check_id":%q,"config_revision":%d,"candidate_id":"t3-code-%d","port":%d,"path":%q,"expected_statuses":[200],"interval_s":15,"timeout_s":10,"enabled":true}`,
			id, rev, port, port, "/h"+strconv.Itoa(i))
	}
	sb.WriteString(`]}`)
	return sb.String()
}

// MED1: many hung probes must never stall the metric heartbeat. Fake clock
// advances past intervals while 8 checks stay in-flight; every tick must
// return fast with heartbeats flowing, and each check runs exactly once.
func TestHeartbeatFlowsWhileProbesHang(t *testing.T) {
	release := make(chan struct{})
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-time.After(30 * time.Second): // backstop: never hang cleanup on failure
		}
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv2.Close()
	u, _ := url.Parse(srv2.URL)
	svcPort, _ := strconv.Atoi(u.Port())
	ids := []string{"chk_h0", "chk_h1", "chk_h2", "chk_h3", "chk_h4", "chk_h5", "chk_h6", "chk_h7"}
	fc := &svcCore{
		configResp: configWithChecks(9, svcPort, ids),
		hbScript: func(int) (int, string) {
			return okHeartbeatRev(9)
		},
	}
	srv := httptest.NewServer(http.HandlerFunc(fc.handler))
	defer srv.Close()
	r := newTestRunner(t, nil, srv.URL, nil)
	cur := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	r.nowFn = func() time.Time { return cur }
	r.snapshotFn = func(now time.Time) (*protocol.ServiceDiscovery, error) {
		return &protocol.ServiceDiscovery{
			ObservedAt: now.UTC().Format(time.RFC3339), Complete: true,
			Candidates: []protocol.ServiceCandidate{svcCandidate(svcPort)},
		}, nil
	}
	enrollTestAgent(t, r)

	cred := store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}
	cfgVersion := 7
	if err := r.refreshConfig(context.Background(), &cred, &cfgVersion); err != nil {
		t.Fatal(err)
	}
	failures := 0
	var skip time.Time
	var pending []protocol.CommandResult

	start := time.Now()
	tickOnce(t, r, &cred, &cfgVersion, &pending, &failures, &skip)
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("tick blocked on hung probes: %s", el)
	}
	if len(fc.raw) != 1 {
		t.Fatalf("beats=%d want 1 (heartbeat must flow)", len(fc.raw))
	}
	if n := len(decodeBeat(t, fc.raw[0]).ServiceResults); n != 0 {
		t.Fatalf("hung probes must not appear yet: %d results", n)
	}

	// Past the interval with all 8 still in-flight: no resubmits, heartbeat flows.
	cur = cur.Add(16 * time.Second)
	start = time.Now()
	tickOnce(t, r, &cred, &cfgVersion, &pending, &failures, &skip)
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("tick blocked on hung probes: %s", el)
	}
	if len(fc.raw) != 2 {
		t.Fatalf("beats=%d want 2", len(fc.raw))
	}

	// Release: all 8 complete exactly once; next due tick delivers them.
	close(release)
	waitBuffered(t, r, 8)
	cur = cur.Add(16 * time.Second)
	tickOnce(t, r, &cred, &cfgVersion, &pending, &failures, &skip)
	env := decodeBeat(t, fc.raw[len(fc.raw)-1])
	if len(env.ServiceResults) != 8 {
		t.Fatalf("results=%d want 8 (one per check, no duplicates)", len(env.ServiceResults))
	}
	seen := map[string]bool{}
	for _, res := range env.ServiceResults {
		if !res.OK || res.ConfigRevision != 9 {
			t.Fatalf("bad result: %+v", res)
		}
		seen[res.CheckID] = true
	}
	for _, id := range ids {
		if !seen[id] {
			t.Fatalf("missing result for %s: %+v", id, env.ServiceResults)
		}
	}
}

// MED1: a stuck discovery backend (e.g. repeatedly stale 3 s fingerprint)
// must not block the heartbeat: the tick attaches the cached snapshot and
// moves on, the background refresh completes when the backend answers.
func TestSlowDiscoveryDoesNotBlockHeartbeat(t *testing.T) {
	fc := &svcCore{
		configResp: `{"config_version":7,"heartbeat_interval_s":15}`,
		hbScript: func(int) (int, string) {
			return okHeartbeatRev(7)
		},
	}
	srv := httptest.NewServer(http.HandlerFunc(fc.handler))
	defer srv.Close()
	r := newTestRunner(t, nil, srv.URL, nil)
	// Production path (no stub): /proc/net/tcp is a FIFO with no writer,
	// so the background snapshot blocks until the test releases it.
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "net"), 0o755); err != nil {
		t.Fatal(err)
	}
	fifo := filepath.Join(root, "net", "tcp")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	r.snapshotFn = nil
	r.procRoot = root
	enrollTestAgent(t, r)

	cred := store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}
	failures := 0
	var skip time.Time
	cfgVersion := 7
	var pending []protocol.CommandResult
	start := time.Now()
	tickOnce(t, r, &cred, &cfgVersion, &pending, &failures, &skip)
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("tick blocked on discovery: %s", el)
	}
	if len(fc.raw) != 1 {
		t.Fatalf("beats=%d want 1", len(fc.raw))
	}
	if env := decodeBeat(t, fc.raw[0]); env.ServiceDiscovery != nil {
		t.Fatalf("pending refresh must mean absent key, got %+v", env.ServiceDiscovery)
	}
	// Release the backend: header-only table, tcp6 missing (partial).
	// OpenFile pairs with the reader already blocked inside.
	w, err := os.OpenFile(fifo, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte("  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"))
	_ = w.Close()
	deadline := time.Now().Add(5 * time.Second)
	for {
		r.svcMu.Lock()
		done := r.discovery != nil
		r.svcMu.Unlock()
		if done {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("background discovery never completed")
		}
		time.Sleep(5 * time.Millisecond)
	}
	tickOnce(t, r, &cred, &cfgVersion, &pending, &failures, &skip)
	env := decodeBeat(t, fc.raw[len(fc.raw)-1])
	if env.ServiceDiscovery == nil || env.ServiceDiscovery.Complete {
		t.Fatalf("background snapshot must attach (incomplete): %+v", env.ServiceDiscovery)
	}
}

// MED3: explicit null clears the persisted set and stops future probes.
func TestNullServiceChecksClearPersisted(t *testing.T) {
	svcPort := loopbackPort(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	candID := fmt.Sprintf("t3-code-%d", svcPort)
	fc := &svcCore{
		configResp: configWithCheck(8, svcPort, "chk_old", candID),
		hbScript: func(int) (int, string) {
			return okHeartbeatRev(8)
		},
	}
	srv := httptest.NewServer(http.HandlerFunc(fc.handler))
	defer srv.Close()
	r := newTestRunner(t, nil, srv.URL, nil)
	r.snapshotFn = func(now time.Time) (*protocol.ServiceDiscovery, error) {
		return &protocol.ServiceDiscovery{
			ObservedAt: now.UTC().Format(time.RFC3339), Complete: true,
			Candidates: []protocol.ServiceCandidate{svcCandidate(svcPort)},
		}, nil
	}
	enrollTestAgent(t, r)

	cred := store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}
	cfgVersion := 7
	if err := r.refreshConfig(context.Background(), &cred, &cfgVersion); err != nil {
		t.Fatal(err)
	}
	failures := 0
	var skip time.Time
	var pending []protocol.CommandResult
	tickOnce(t, r, &cred, &cfgVersion, &pending, &failures, &skip)
	waitBuffered(t, r, 1) // sanity: the old check really probed

	fc.configResp = `{"config_version":9,"heartbeat_interval_s":15,"service_checks":null}`
	if err := r.refreshConfig(context.Background(), &cred, &cfgVersion); err != nil {
		t.Fatal(err)
	}
	if cfgVersion != 9 {
		t.Fatalf("cfgVersion=%d want 9", cfgVersion)
	}
	got, present, err := r.st.LoadServiceChecks()
	if err != nil || !present || len(got.Checks) != 0 || got.ConfigRevision != 9 {
		t.Fatalf("null must atomically clear persisted checks: %+v %v %v", got, present, err)
	}
	tickOnce(t, r, &cred, &cfgVersion, &pending, &failures, &skip)
	env := decodeBeat(t, fc.raw[len(fc.raw)-1])
	if len(env.ServiceResults) != 0 {
		t.Fatalf("cleared checks must never probe again: %+v", env.ServiceResults)
	}
	if r.resBuf.len() != 0 {
		t.Fatalf("buffered=%d want 0 (stale result dropped)", r.resBuf.len())
	}
}

// MED3: explicit [] clears like null.
func TestEmptyListServiceChecksClears(t *testing.T) {
	svcPort := loopbackPort(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	candID := fmt.Sprintf("t3-code-%d", svcPort)
	fc := &svcCore{
		configResp: configWithCheck(8, svcPort, "chk_old", candID),
		hbScript: func(int) (int, string) {
			return okHeartbeatRev(8)
		},
	}
	srv := httptest.NewServer(http.HandlerFunc(fc.handler))
	defer srv.Close()
	r := newTestRunner(t, nil, srv.URL, nil)
	r.snapshotFn = func(now time.Time) (*protocol.ServiceDiscovery, error) {
		return &protocol.ServiceDiscovery{
			ObservedAt: now.UTC().Format(time.RFC3339), Complete: true,
			Candidates: []protocol.ServiceCandidate{svcCandidate(svcPort)},
		}, nil
	}
	enrollTestAgent(t, r)

	cred := store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}
	cfgVersion := 7
	if err := r.refreshConfig(context.Background(), &cred, &cfgVersion); err != nil {
		t.Fatal(err)
	}
	fc.configResp = `{"config_version":9,"heartbeat_interval_s":15,"service_checks":[]}`
	if err := r.refreshConfig(context.Background(), &cred, &cfgVersion); err != nil {
		t.Fatal(err)
	}
	got, present, err := r.st.LoadServiceChecks()
	if err != nil || !present || len(got.Checks) != 0 {
		t.Fatalf("[] must atomically clear persisted checks: %+v %v %v", got, present, err)
	}
	failures := 0
	var skip time.Time
	var pending []protocol.CommandResult
	tickOnce(t, r, &cred, &cfgVersion, &pending, &failures, &skip)
	if n := len(decodeBeat(t, fc.raw[len(fc.raw)-1]).ServiceResults); n != 0 {
		t.Fatalf("results=%d want 0", n)
	}
}

// MED3: a missing key (older Core) leaves the stored set untouched.
func TestMissingServiceChecksKeepsStored(t *testing.T) {
	svcPort := loopbackPort(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	candID := fmt.Sprintf("t3-code-%d", svcPort)
	fc := &svcCore{
		configResp: configWithCheck(8, svcPort, "chk_keep", candID),
		hbScript: func(int) (int, string) {
			return okHeartbeatRev(8)
		},
	}
	srv := httptest.NewServer(http.HandlerFunc(fc.handler))
	defer srv.Close()
	r := newTestRunner(t, nil, srv.URL, nil)
	cur := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	r.nowFn = func() time.Time { return cur }
	r.snapshotFn = func(now time.Time) (*protocol.ServiceDiscovery, error) {
		return &protocol.ServiceDiscovery{
			ObservedAt: now.UTC().Format(time.RFC3339), Complete: true,
			Candidates: []protocol.ServiceCandidate{svcCandidate(svcPort)},
		}, nil
	}
	enrollTestAgent(t, r)

	cred := store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}
	cfgVersion := 7
	if err := r.refreshConfig(context.Background(), &cred, &cfgVersion); err != nil {
		t.Fatal(err)
	}
	// Older Core without the key: version advances, checks survive.
	fc.configResp = `{"config_version":9,"heartbeat_interval_s":15}`
	if err := r.refreshConfig(context.Background(), &cred, &cfgVersion); err != nil {
		t.Fatal(err)
	}
	got, present, err := r.st.LoadServiceChecks()
	if err != nil || !present || len(got.Checks) != 1 || got.Checks[0].CheckID != "chk_keep" {
		t.Fatalf("missing key must keep stored checks: %+v %v %v", got, present, err)
	}
	failures := 0
	var skip time.Time
	var pending []protocol.CommandResult
	cur = cur.Add(16 * time.Second)
	tickOnce(t, r, &cred, &cfgVersion, &pending, &failures, &skip)
	waitBuffered(t, r, 1)
	tickOnce(t, r, &cred, &cfgVersion, &pending, &failures, &skip)
	env := decodeBeat(t, fc.raw[len(fc.raw)-1])
	if len(env.ServiceResults) != 1 || env.ServiceResults[0].CheckID != "chk_keep" {
		t.Fatalf("kept check must still probe: %+v", env.ServiceResults)
	}
}

func TestCheckRevisionsIndependentOfConfigVersion(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	r := newTestRunner(t, nil, srv.URL, nil)
	checks := []protocol.ServiceCheck{}
	for i, rev := range []int{1, 3} {
		checks = append(checks, protocol.ServiceCheck{CheckID: fmt.Sprintf("check_%d", i), ConfigRevision: rev,
			CandidateID: fmt.Sprintf("t3-code-%d", port), Port: port, Path: "/", ExpectedStatuses: []int{200},
			IntervalS: 15, TimeoutS: 2, Enabled: true})
	}
	r.setServiceChecks(27, checks, false)
	r.submitDueChecks(&protocol.ServiceDiscovery{Candidates: []protocol.ServiceCandidate{svcCandidate(port)}})
	waitBuffered(t, r, 2)
	results, _ := r.peekResults()
	if len(results) != 2 {
		t.Fatalf("global config version must not suppress per-check revisions: %+v", results)
	}
	for _, result := range results {
		if !result.OK {
			t.Fatalf("probe failed: %+v", result)
		}
	}
	r.setServiceChecks(28, nil, false)
	results, _ = r.peekResults()
	if len(results) != 0 {
		t.Fatal("removed checks leaked buffered results")
	}
}

func TestNoSnapshotDoesNotManufactureUnavailable(t *testing.T) {
	r := newTestRunner(t, nil, "http://127.0.0.1:1", nil)
	r.setServiceChecks(27, []protocol.ServiceCheck{{CheckID: "waiting", ConfigRevision: 1, Enabled: true}}, false)
	r.submitDueChecks(nil)
	if len(r.inFlight) != 0 || r.resBuf.len() != 0 {
		t.Fatal("startup without discovery must stay unknown")
	}
}
