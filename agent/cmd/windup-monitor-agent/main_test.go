package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"windup-monitor/agent/internal/agent"
	"windup-monitor/agent/internal/store"
)

// Exit codes are part of the operator contract (CONTRACT §5): revoked must be
// 3 also for the one-shot subcommands (`rotate` now maps through exitFor).
func TestExitFor(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"revoked", agent.ErrRevoked, 3},
		{"revoked wrapped", fmt.Errorf("rotate: %w", agent.ErrRevoked), 3},
		{"upgrade", agent.ErrUpgrade, 2},
		{"generic", errors.New("boom"), 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := exitFor(tc.err); got != tc.want {
				t.Fatalf("exitFor(%v)=%d want %d", tc.err, got, tc.want)
			}
		})
	}
}

// End-to-end wiring: `windup-monitor-agent rotate` against a Core that answers
// 401 AGENT_REVOKED exits 3 and leaves no credential/rotation behind.
func TestRunRotateRevokedExits3AndWipes(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SaveCredential(store.Credential{AgentID: "ag_test", Credential: "CRED-SECRET-1"}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveRotation(store.Rotation{RotationID: "rot_x", Next: "NEXT-SECRET-1"}); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.Copy(io.Discard, r.Body)
		if strings.HasSuffix(r.URL.Path, "/rotate") {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"code":"AGENT_REVOKED","message":"revoked"}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	code := run([]string{
		"rotate",
		"--state-dir", dir,
		"--core-url", srv.URL,
		"--allow-insecure-http",
	})
	if code != 3 {
		t.Fatalf("exit code=%d want 3 (revoked)", code)
	}
	if _, ok, _ := st.LoadCredential(); ok {
		t.Fatal("credential must be wiped")
	}
	if _, ok, _ := st.LoadRotation(); ok {
		t.Fatal("rotation must be wiped")
	}
}
