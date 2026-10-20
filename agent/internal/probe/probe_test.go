package probe

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"windup-monitor/agent/internal/protocol"
)

// mockService starts a loopback HTTP server and returns its port.
func mockService(t *testing.T, h http.Handler) int {
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

func candFor(port int) map[string]protocol.ServiceCandidate {
	return map[string]protocol.ServiceCandidate{
		"t3-code-1": {
			CandidateID: "t3-code-1", Name: "T3 Code", Kind: "t3-code",
			Port: port, Transport: "http", Source: "proc", Confidence: "high",
			Monitorable: true,
		},
	}
}

// candTCPFor models a generic (kind unknown) monitorable candidate —
// exactly what discovery produces for an unidentified loopback listener.
func candTCPFor(port int) map[string]protocol.ServiceCandidate {
	return map[string]protocol.ServiceCandidate{
		"generic-1": {
			CandidateID: "generic-1", Name: "myapp", Kind: "unknown",
			Port: port, Transport: "tcp", Source: "proc", Confidence: "medium",
			Monitorable: true,
		},
	}
}

func tcpCheckFor(port int) protocol.ServiceCheck {
	return protocol.ServiceCheck{
		CheckID: "chk_tcp", ConfigRevision: 8, CandidateID: "generic-1",
		Port: port, Transport: "tcp", IntervalS: 30, TimeoutS: 2, Enabled: true,
	}
}

func checkFor(port int) protocol.ServiceCheck {
	return protocol.ServiceCheck{
		CheckID: "chk_test", ConfigRevision: 8, CandidateID: "t3-code-1",
		Port: port, Path: "/", ExpectedStatuses: []int{200},
		IntervalS: 30, TimeoutS: 5, Enabled: true,
	}
}

func TestValidatePathAllowlist(t *testing.T) {
	for _, p := range []string{"/", "/System/Info/Public", "/a-b_c~d?e=f&g", "/x%20y"} {
		if err := ValidatePath(p); err != nil {
			t.Fatalf("valid path %q rejected: %v", p, err)
		}
	}
	for _, p := range []string{
		"", "http://127.0.0.1:8096/", "//evil.com/x", "/a//b", "/a@b",
		"/a\\b", "/a b", "/a\x01b", "relative", "/ok\x7f",
		strings.Repeat("/a", 300),
	} {
		if err := ValidatePath(p); err == nil {
			t.Fatalf("hostile path %q accepted", p)
		}
	}
}

func TestExecuteOK(t *testing.T) {
	port := mockService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			w.WriteHeader(404)
			return
		}
		// Probes must not inject auth/cookies/custom headers.
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("X-Custom") != "" {
			w.WriteHeader(400)
			return
		}
		_, _ = w.Write([]byte("hello"))
	}))
	res := Execute(context.Background(), checkFor(port), candFor(port), time.Now())
	if !res.OK || res.ErrorCode != nil {
		t.Fatalf("got %+v", res)
	}
	if res.StatusCode == nil || *res.StatusCode != 200 {
		t.Fatalf("status=%v", res.StatusCode)
	}
	if res.LatencyMs < 0 || res.LatencyMs > 5000 {
		t.Fatalf("latency=%v", res.LatencyMs)
	}
}

func TestExecuteUnexpectedStatus(t *testing.T) {
	port := mockService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
	}))
	res := Execute(context.Background(), checkFor(port), candFor(port), time.Now())
	if res.OK || res.ErrorCode == nil || *res.ErrorCode != CodeUnexpectedStatus {
		t.Fatalf("got %+v", res)
	}
	if res.StatusCode == nil || *res.StatusCode != 500 {
		t.Fatalf("status must be recorded: %+v", res)
	}
}

func TestRedirectsNotFollowed(t *testing.T) {
	var targetHits int64
	port := mockService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/target" {
			atomic.AddInt64(&targetHits, 1)
			return
		}
		w.Header().Set("Location", "/target")
		w.WriteHeader(302)
	}))
	res := Execute(context.Background(), checkFor(port), candFor(port), time.Now())
	if res.OK {
		t.Fatalf("302 must not count as up for expected [200]: %+v", res)
	}
	if res.StatusCode == nil || *res.StatusCode != 302 {
		t.Fatalf("must record the 3xx without following: %+v", res)
	}
	if atomic.LoadInt64(&targetHits) != 0 {
		t.Fatal("redirect target was followed")
	}
}

func TestTimeoutBounded(t *testing.T) {
	port := mockService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(3 * time.Second)
	}))
	ch := checkFor(port)
	ch.TimeoutS = 1
	start := time.Now()
	res := Execute(context.Background(), ch, candFor(port), start)
	el := time.Since(start)
	if res.OK || res.ErrorCode == nil || *res.ErrorCode != CodeTimeout {
		t.Fatalf("got %+v", res)
	}
	if res.StatusCode != nil {
		t.Fatalf("timeout must leave status null: %+v", res)
	}
	if el > 2500*time.Millisecond {
		t.Fatalf("probe not bounded: %s", el)
	}
}

func TestConnectionRefusedIsUnavailable(t *testing.T) {
	// Bind then close to get a (near-certainly) refused loopback port.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	u, _ := url.Parse(srv.URL)
	p, _ := strconv.Atoi(u.Port())
	srv.Close()
	res := Execute(context.Background(), checkFor(p), candFor(p), time.Now())
	if res.OK || res.ErrorCode == nil || *res.ErrorCode != CodeServiceUnavailable {
		t.Fatalf("got %+v", res)
	}
	if res.StatusCode != nil {
		t.Fatalf("refused must leave status null: %+v", res)
	}
}

func TestMissingOrMovedCandidateFailsWithoutNetwork(t *testing.T) {
	var hits int64
	port := mockService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&hits, 1)
	}))
	now := time.Now()
	// Unknown candidate id.
	ch := checkFor(port)
	ch.CandidateID = "unknown-9999"
	if res := Execute(context.Background(), ch, candFor(port), now); !failedWith(res, CodeServiceUnavailable) {
		t.Fatalf("missing candidate: %+v", res)
	}
	// Same id but moved port (arbitrary-port probing is forbidden).
	ch2 := checkFor(port + 1)
	if res := Execute(context.Background(), ch2, candFor(port), now); !failedWith(res, CodeServiceUnavailable) {
		t.Fatalf("moved port: %+v", res)
	}
	// Invalid path never touches the network.
	ch3 := checkFor(port)
	ch3.Path = "http://evil/"
	if res := Execute(context.Background(), ch3, candFor(port), now); !failedWith(res, CodeInvalidPath) {
		t.Fatalf("invalid path: %+v", res)
	}
	if atomic.LoadInt64(&hits) != 0 {
		t.Fatalf("rejected checks hit the network %d times", hits)
	}
}

func failedWith(res protocol.ServiceResult, code string) bool {
	return !res.OK && res.ErrorCode != nil && *res.ErrorCode == code && res.StatusCode == nil
}

func TestLargeBodyDiscarded(t *testing.T) {
	port := mockService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(make([]byte, 1<<20)) // 1 MiB must not be retained
	}))
	start := time.Now()
	res := Execute(context.Background(), checkFor(port), candFor(port), start)
	if !res.OK {
		t.Fatalf("got %+v", res)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("large body slowed the probe")
	}
}

func TestResultWireNulls(t *testing.T) {
	res := Execute(context.Background(), checkFor(9), map[string]protocol.ServiceCandidate{}, time.Now())
	raw, _ := json.Marshal(res)
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"check_id", "config_revision", "observed_at", "ok", "status_code", "latency_ms", "error_code"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("missing key %q in %s", k, raw)
		}
	}
	if m["status_code"] != nil || m["error_code"] == nil {
		t.Fatalf("null contract violated: %s", raw)
	}
}

// withTCPDial replaces the dial seam for one test and counts calls, so
// rejected checks can be proven to never touch the network.
func withTCPDial(t *testing.T, fn func(ctx context.Context, network, address string) (net.Conn, error)) *int32 {
	t.Helper()
	var calls int32
	prev := tcpDial
	tcpDial = func(ctx context.Context, network, address string) (net.Conn, error) {
		atomic.AddInt32(&calls, 1)
		if fn != nil {
			return fn(ctx, network, address)
		}
		return prev(ctx, network, address)
	}
	t.Cleanup(func() { tcpDial = prev })
	return &calls
}

func TestTransportNormalisation(t *testing.T) {
	if got := Transport(protocol.ServiceCheck{}); got != "http" {
		t.Fatalf("absent transport must default to http, got %q", got)
	}
	if got := Transport(protocol.ServiceCheck{Transport: "http"}); got != "http" {
		t.Fatalf("explicit http: %q", got)
	}
	if got := Transport(protocol.ServiceCheck{Transport: "tcp"}); got != "tcp" {
		t.Fatalf("explicit tcp: %q", got)
	}
	if got := Transport(protocol.ServiceCheck{Transport: "udp"}); got != "" {
		t.Fatalf("unknown transport must be rejected, got %q", got)
	}
}

func TestTCPSuccessIsConnectOnly(t *testing.T) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	port := ln.Addr().(*net.TCPAddr).Port

	var gotAddr, gotNet string
	calls := withTCPDial(t, func(ctx context.Context, network, address string) (net.Conn, error) {
		gotNet, gotAddr = network, address
		var d net.Dialer
		return d.DialContext(ctx, network, address)
	})
	res := Execute(context.Background(), tcpCheckFor(port), candTCPFor(port), time.Now())
	if !res.OK || res.ErrorCode != nil {
		t.Fatalf("tcp connect must be ok with null error_code: %+v", res)
	}
	if res.StatusCode != nil {
		t.Fatalf("tcp result must keep status_code null: %+v", res)
	}
	if res.LatencyMs < 0 || res.LatencyMs > 5000 {
		t.Fatalf("latency=%v", res.LatencyMs)
	}
	if atomic.LoadInt32(calls) != 1 || gotNet != "tcp" || gotAddr != "127.0.0.1:"+itoa(port) {
		t.Fatalf("must dial exactly the numeric loopback literal once: net=%q addr=%q calls=%d", gotNet, gotAddr, calls)
	}
}

func TestTCPRefusedIsUnavailable(t *testing.T) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	res := Execute(context.Background(), tcpCheckFor(port), candTCPFor(port), time.Now())
	if !failedWith(res, CodeServiceUnavailable) {
		t.Fatalf("refused tcp must be SERVICE_UNAVAILABLE with null status: %+v", res)
	}
}

func TestTCPTimeoutBounded(t *testing.T) {
	withTCPDial(t, func(ctx context.Context, _ string, _ string) (net.Conn, error) {
		<-ctx.Done() // black-holed connect: the deadline must govern
		return nil, ctx.Err()
	})
	ch := tcpCheckFor(16000)
	ch.TimeoutS = 1
	start := time.Now()
	res := Execute(context.Background(), ch, candTCPFor(16000), start)
	if !failedWith(res, CodeTimeout) {
		t.Fatalf("tcp timeout must be TIMEOUT with null status: %+v", res)
	}
	if el := time.Since(start); el > 2500*time.Millisecond {
		t.Fatalf("tcp check not bounded: %s", el)
	}
}

func TestTCPDeniesUndiscoveredPortWithoutNetwork(t *testing.T) {
	calls := withTCPDial(t, nil)
	res := Execute(context.Background(), tcpCheckFor(16001), map[string]protocol.ServiceCandidate{}, time.Now())
	if !failedWith(res, CodeServiceUnavailable) {
		t.Fatalf("undiscovered port must fail unavailable: %+v", res)
	}
	// Moved port for the same id is equally undiscovered.
	ch := tcpCheckFor(16002)
	res = Execute(context.Background(), ch, candTCPFor(16001), time.Now())
	if !failedWith(res, CodeServiceUnavailable) {
		t.Fatalf("moved port must fail unavailable: %+v", res)
	}
	if atomic.LoadInt32(calls) != 0 {
		t.Fatalf("rejected checks dialed %d times", atomic.LoadInt32(calls))
	}
}

// Unsupported bind (IPv6/LAN-only, monitorable=false) must never produce a
// fake healthy nor a false down from a 127.0.0.1 probe: no network at all.
func TestNonMonitorableCandidateFailsWithoutNetwork(t *testing.T) {
	calls := withTCPDial(t, nil)
	cands := candTCPFor(16003)
	c := cands["generic-1"]
	c.Monitorable = false
	cands["generic-1"] = c
	httpCh := checkFor(16003)
	httpCh.CandidateID = "generic-1"
	for _, ch := range []protocol.ServiceCheck{tcpCheckFor(16003), httpCh} {
		res := Execute(context.Background(), ch, cands, time.Now())
		if !failedWith(res, CodeInvalidCheck) {
			t.Fatalf("non-monitorable candidate must fail INVALID_CHECK (transport %q): %+v", ch.Transport, res)
		}
	}
	if atomic.LoadInt32(calls) != 0 {
		t.Fatalf("non-monitorable checks dialed %d times", calls)
	}
}

func TestUnknownTransportRejected(t *testing.T) {
	calls := withTCPDial(t, nil)
	ch := tcpCheckFor(16004)
	ch.Transport = "udp"
	res := Execute(context.Background(), ch, candTCPFor(16004), time.Now())
	if !failedWith(res, CodeInvalidCheck) {
		t.Fatalf("unknown transport must be INVALID_CHECK: %+v", res)
	}
	if atomic.LoadInt32(calls) != 0 {
		t.Fatalf("invalid transport dialed %d times", calls)
	}
}
