package client

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"windup-monitor/agent/internal/protocol"
)

func TestEnrollSendsNoAuthAndExactKeys(t *testing.T) {
	var gotAuth, gotAgent, gotVersion, gotCT string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotAgent = r.Header.Get(protocol.HeaderAgentID)
		gotVersion = r.Header.Get(protocol.HeaderVersion)
		gotCT = r.Header.Get("Content-Type")
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"agent_id": "ag_01J", "credential": "SECRET",
			"heartbeat_interval_s": 15, "config_version": 7,
		})
	}))
	defer srv.Close()

	cli := New(srv.URL, nil, ShortTimeout, "test/1.0")
	resp, err := cli.Enroll(context.Background(), "TOKEN", "nas-01", "0.1.0", []string{"metrics"})
	if err != nil {
		t.Fatal(err)
	}
	if resp.AgentID != "ag_01J" || resp.Credential != "SECRET" {
		t.Fatalf("got %+v", resp)
	}
	if gotAuth != "" {
		t.Fatalf("enroll must not send Authorization, got %q", gotAuth)
	}
	if gotVersion != "1" {
		t.Fatalf("version header=%q", gotVersion)
	}
	if gotCT != "application/json" || gotAgent != "" {
		t.Fatalf("ct=%q agent=%q", gotCT, gotAgent)
	}
	for _, k := range []string{"enroll_token", "hostname", "agent_version", "protocol_version", "capabilities"} {
		if _, ok := body[k]; !ok {
			t.Fatalf("missing snake_case key %q in %v", k, body)
		}
	}
	if body["enroll_token"] != "TOKEN" || body["protocol_version"] != float64(1) {
		t.Fatalf("body=%v", body)
	}
}

func TestHeartbeatAuthHeaders(t *testing.T) {
	var gotAuth, gotAgent, gotVersion, gotUA string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotAgent = r.Header.Get(protocol.HeaderAgentID)
		gotVersion = r.Header.Get(protocol.HeaderVersion)
		gotUA = r.Header.Get("User-Agent")
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"server_time":"2026-10-19T12:00:00Z","config_version":7,"config_changed":false,"pending_commands":[],"full_inventory":false}`))
	}))
	defer srv.Close()

	cli := New(srv.URL, nil, ShortTimeout, "windup-monitor-agent/0.1.0 (linux/amd64)")
	_, err := cli.Heartbeat(context.Background(), "ag_1", "CRED", []byte(`{"seq":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer CRED" || gotAgent != "ag_1" || gotVersion != "1" {
		t.Fatalf("auth=%q agent=%q version=%q", gotAuth, gotAgent, gotVersion)
	}
	if !strings.HasPrefix(gotUA, "windup-monitor-agent/") {
		t.Fatalf("ua=%q", gotUA)
	}
}

func TestErrorCodesParsed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"code":"AGENT_REVOKED","message":"gone"}`))
	}))
	defer srv.Close()

	cli := New(srv.URL, nil, ShortTimeout, "t")
	_, err := cli.Heartbeat(context.Background(), "ag_1", "CRED", []byte(`{}`))
	ae, ok := err.(*APIError)
	if !ok {
		t.Fatalf("want APIError, got %T (%v)", err, err)
	}
	if !ae.IsCode(protocol.CodeAgentRevoked) || ae.Status != 401 {
		t.Fatalf("got %+v", ae)
	}
	// Error() must not echo server payload text (could theoretically leak).
	if strings.Contains(ae.Error(), "gone") {
		t.Fatalf("Error() leaks payload: %q", ae.Error())
	}
}

func TestNonJSONErrorFallsBackToHTTPCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`<html>proxy</html>`))
	}))
	defer srv.Close()

	cli := New(srv.URL, nil, ShortTimeout, "t")
	_, err := cli.Heartbeat(context.Background(), "ag_1", "CRED", []byte(`{}`))
	ae, ok := err.(*APIError)
	if !ok || ae.Code != "HTTP_502" {
		t.Fatalf("got %v", err)
	}
}

func TestMalformedSuccessBodyIsError(t *testing.T) {
	for _, path := range []string{"/enroll", "/heartbeat"} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"agent_id":`)) // truncated
		}))
		func() {
			defer srv.Close()
			cli := New(srv.URL, nil, ShortTimeout, "t")
			ctx := context.Background()
			var err error
			if path == "/enroll" {
				_, err = cli.Enroll(ctx, "T", "h", "0.1.0", []string{"metrics"})
			} else {
				_, err = cli.Heartbeat(ctx, "a", "c", []byte(`{}`))
			}
			if err == nil || !strings.Contains(err.Error(), "malformed") {
				t.Fatalf("%s: want malformed error, got %v", path, err)
			}
		}()
	}
}

func TestTLSVerificationAndCAFile(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"server_time":"2026-10-19T12:00:00Z","config_version":1,"config_changed":false,"pending_commands":[],"full_inventory":false}`))
	}))
	defer srv.Close()

	// System roots must NOT trust the test server (verification is on).
	strictCfg, err := BuildTLS("")
	if err != nil {
		t.Fatal(err)
	}
	cli := New(srv.URL, strictCfg, ShortTimeout, "t")
	if _, err := cli.Heartbeat(context.Background(), "a", "c", []byte(`{}`)); err == nil {
		t.Fatal("self-signed server must be rejected without its CA")
	}

	// With the server CA pinned via file, the same call succeeds.
	der := srv.Certificate()
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der.Raw})
	caFile := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(caFile, pemBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	pinnedCfg, err := BuildTLS(caFile)
	if err != nil {
		t.Fatal(err)
	}
	cli2 := New(srv.URL, pinnedCfg, ShortTimeout, "t")
	if _, err := cli2.Heartbeat(context.Background(), "a", "c", []byte(`{}`)); err != nil {
		t.Fatalf("CA-pinned request failed: %v", err)
	}
}

func TestRotateAndConfirmFlow(t *testing.T) {
	var rotateBearer string
	var rotateBody map[string]any
	var confirmBearer string
	var confirmBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/agent/rotate":
			rotateBearer = r.Header.Get("Authorization")
			_ = json.NewDecoder(r.Body).Decode(&rotateBody)
			_ = json.NewEncoder(w).Encode(map[string]any{"overlap_until": "2026-10-19T12:10:00Z", "rotation_id": rotateBody["rotation_id"]})
		case "/api/v1/agent/rotate_confirm":
			confirmBearer = r.Header.Get("Authorization")
			_ = json.NewDecoder(r.Body).Decode(&confirmBody)
			_, _ = w.Write([]byte(`{}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	cli := New(srv.URL, nil, ShortTimeout, "t")
	ctx := context.Background()
	resp, err := cli.Rotate(ctx, "ag_1", "OLD", "rot_9", "NEXTSECRET")
	if err != nil {
		t.Fatal(err)
	}
	if resp.RotationID != "rot_9" {
		t.Fatalf("got %+v", resp)
	}
	if rotateBearer != "Bearer OLD" {
		t.Fatalf("rotate bearer=%q", rotateBearer)
	}
	for _, k := range []string{"rotation_id", "new_credential"} {
		if _, ok := rotateBody[k]; !ok {
			t.Fatalf("rotate body missing %q: %v", k, rotateBody)
		}
	}
	if err := cli.RotateConfirm(ctx, "ag_1", "NEXTSECRET", "rot_9"); err != nil {
		t.Fatal(err)
	}
	if confirmBearer != "Bearer NEXTSECRET" {
		t.Fatalf("confirm must use NEXT credential, got %q", confirmBearer)
	}
	if confirmBody["rotation_id"] != "rot_9" {
		t.Fatalf("confirm body=%v", confirmBody)
	}
}
