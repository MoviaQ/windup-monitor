// Package probe executes the agent-side typed checks (HTTP and TCP).
//
// Every check runs on the reporting agent host against the numeric loopback
// literal 127.0.0.1 and the exact candidate port — never an arbitrary
// hostname or URL. Hard rules (see agent/CONTRACT.md §11):
//
//   - transport "http" (the default when Core omits the key): path must be
//     relative (single leading '/', no '//', no absolute URL, no userinfo
//     '@', no whitespace/control, no backslash), max 512 chars.
//   - transport "tcp": bare connect to 127.0.0.1:port — no DNS, no
//     payload, no reads; success is OK with status_code=null.
//   - redirects are never followed, proxies are disabled, no cookies, no
//     auth headers, no custom header injection (Accept + User-Agent only).
//   - the response body is closed without being read or logged.
//   - total timeout is bounded (1..10 s, always below the check interval).
//   - checks for candidates that are not monitorable (IPv6/LAN-only bind)
//     fail as INVALID_CHECK without any network I/O: no fake healthy and
//     no false down for a service bound elsewhere.
package probe

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"windup-monitor/agent/internal/protocol"
)

const (
	// Error codes: closed enum, safe to ship on the wire.
	CodeServiceUnavailable = "SERVICE_UNAVAILABLE"
	CodeTimeout            = "TIMEOUT"
	CodeTransportError     = "TRANSPORT_ERROR"
	CodeUnexpectedStatus   = "UNEXPECTED_STATUS"
	CodeInvalidPath        = "INVALID_PATH"
	CodeInvalidCheck       = "INVALID_CHECK"
)

const (
	// MaxPathLen bounds the configured path length.
	MaxPathLen = 512
	// DefaultIntervalS applies when Core sends 0 (per-config default 30s).
	DefaultIntervalS = 30
	// DefaultTimeoutS applies when Core sends 0.
	DefaultTimeoutS = 5
	// MinIntervalS/MaxIntervalS clamp scheduling (15s..1h).
	MinIntervalS = 15
	MaxIntervalS = 3600
	// MinTimeoutS/MaxTimeoutS clamp the request deadline (1..10s).
	MinTimeoutS = 1
	MaxTimeoutS = 10
)

// IntervalS normalises the scheduling interval for a check.
func IntervalS(check protocol.ServiceCheck) int {
	iv := check.IntervalS
	if iv == 0 {
		iv = DefaultIntervalS
	}
	if iv < MinIntervalS {
		return MinIntervalS
	}
	if iv > MaxIntervalS {
		return MaxIntervalS
	}
	return iv
}

// TimeoutS normalises the request deadline: clamped to 1..10s and always
// strictly below the (normalised) interval.
func TimeoutS(check protocol.ServiceCheck) int {
	to := check.TimeoutS
	if to == 0 {
		to = DefaultTimeoutS
	}
	if to < MinTimeoutS {
		to = MinTimeoutS
	}
	if to > MaxTimeoutS {
		to = MaxTimeoutS
	}
	if iv := IntervalS(check); to >= iv {
		to = iv - 1
		if to < MinTimeoutS {
			to = MinTimeoutS
		}
	}
	return to
}

// Transport normalises the check transport: an absent/empty key (older
// Core) means HTTP — backward compatible; only "http" and "tcp" are valid,
// anything else yields "" (rejected as INVALID_CHECK, never guessed).
func Transport(check protocol.ServiceCheck) string {
	switch check.Transport {
	case "", protocol.ServiceTransportHTTP:
		return protocol.ServiceTransportHTTP
	case protocol.ServiceTransportTCP:
		return protocol.ServiceTransportTCP
	default:
		return ""
	}
}

// ValidatePath enforces the relative-path allowlist. Anything that could
// smuggle a host, credentials or control characters is rejected.
func ValidatePath(p string) error {
	if p == "" {
		return errors.New("empty path")
	}
	if len(p) > MaxPathLen {
		return errors.New("path too long")
	}
	if !strings.HasPrefix(p, "/") {
		return errors.New("path must start with '/'")
	}
	if strings.Contains(p, "//") {
		return errors.New("double slash rejected")
	}
	if strings.Contains(p, "://") {
		return errors.New("absolute URL rejected")
	}
	if strings.ContainsRune(p, '@') {
		return errors.New("userinfo rejected")
	}
	if strings.ContainsRune(p, '\\') {
		return errors.New("backslash rejected")
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f {
			return errors.New("control character rejected")
		}
	}
	if strings.ContainsAny(p, " \t\r\n") {
		return errors.New("whitespace rejected")
	}
	return nil
}

// Execute runs one check and returns its result. Validation failures and a
// disappeared local candidate produce fail results without any network I/O.
// No response body content is returned or logged — only status/latency.
func Execute(ctx context.Context, check protocol.ServiceCheck, cands map[string]protocol.ServiceCandidate, now time.Time) protocol.ServiceResult {
	res := protocol.ServiceResult{
		CheckID:        check.CheckID,
		ConfigRevision: check.ConfigRevision,
		ObservedAt:     now.UTC().Format(time.RFC3339),
	}
	fail := func(code string) protocol.ServiceResult {
		res.OK = false
		res.ErrorCode = &code
		return res
	}

	cand, ok := cands[check.CandidateID]
	if !ok || cand.Port != check.Port {
		// Local candidate disappeared (or the config does not bind to a
		// locally discovered candidate): fail, never probe elsewhere.
		return fail(CodeServiceUnavailable)
	}
	if check.Port <= 0 || check.Port > 65535 {
		return fail(CodeInvalidCheck)
	}
	// Unsupported bind (IPv6/LAN-only, monitorable=false): 127.0.0.1 can
	// neither prove health nor absence of the service — fail as a config
	// error without any network I/O, so no fake healthy and no false down
	// for a service bound elsewhere.
	if !cand.Monitorable {
		return fail(CodeInvalidCheck)
	}
	switch Transport(check) {
	case protocol.ServiceTransportTCP:
		return executeTCP(ctx, check, res)
	case protocol.ServiceTransportHTTP:
	default:
		return fail(CodeInvalidCheck)
	}
	if len(check.ExpectedStatuses) == 0 {
		return fail(CodeInvalidCheck)
	}
	if err := ValidatePath(check.Path); err != nil {
		return fail(CodeInvalidPath)
	}

	timeout := time.Duration(TimeoutS(check)) * time.Second
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	url := "http://127.0.0.1:" + itoa(check.Port) + check.Path
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fail(CodeInvalidCheck)
	}
	req.Header.Set("Accept", "*/*")
	req.Header.Set("User-Agent", "windup-monitor-agent/probe")
	// No cookies, no auth, no custom headers — by construction.

	tr := &http.Transport{Proxy: nil} // proxies disabled
	cli := &http.Client{
		Transport: tr,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse // redirects never followed
		},
		Timeout: timeout + 2*time.Second, // backstop; ctx deadline governs
	}
	start := time.Now()
	resp, err := cli.Do(req)
	latency := time.Since(start).Seconds() * 1000
	res.LatencyMs = latency
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || ctx.Err() == context.DeadlineExceeded {
			return fail(CodeTimeout)
		}
		// Connection refused/reset and other transport failures all mean
		// the local service is not serving HTTP right now.
		if isConnRefused(err) {
			return fail(CodeServiceUnavailable)
		}
		if errors.Is(err, context.Canceled) {
			return fail(CodeTimeout)
		}
		return fail(CodeTransportError)
	}
	defer resp.Body.Close()
	// Headers alone determine health; never read or log response bodies.
	code := resp.StatusCode
	res.StatusCode = &code
	for _, want := range check.ExpectedStatuses {
		if resp.StatusCode == want {
			res.OK = true
			return res
		}
	}
	return fail(CodeUnexpectedStatus)
}

// tcpDial is the single TCP entry point (test seam). Production always
// dials the numeric loopback literal "127.0.0.1:<port>" — no hostname, no
// resolver, no payload, no reads.
var tcpDial = func(ctx context.Context, network, address string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, network, address)
}

// executeTCP performs a transport-tcp check: one bounded connect to
// 127.0.0.1:<port> and nothing else. Success is OK=true with status_code
// and error_code both null (never zero/empty sentinels). Refused/reset and
// timeout map to the same canonical codes as the HTTP path.
func executeTCP(ctx context.Context, check protocol.ServiceCheck, res protocol.ServiceResult) protocol.ServiceResult {
	timeout := time.Duration(TimeoutS(check)) * time.Second
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	addr := "127.0.0.1:" + itoa(check.Port) // numeric literal: no DNS by construction
	start := time.Now()
	conn, err := tcpDial(ctx, "tcp", addr)
	res.LatencyMs = time.Since(start).Seconds() * 1000
	if err != nil {
		code := CodeTransportError
		switch {
		case errors.Is(err, context.DeadlineExceeded) || ctx.Err() == context.DeadlineExceeded,
			errors.Is(err, context.Canceled):
			code = CodeTimeout
		case isConnRefused(err):
			code = CodeServiceUnavailable
		}
		res.OK = false
		res.ErrorCode = &code
		return res
	}
	_ = conn.Close()
	// Established TCP connection: up. StatusCode/ErrorCode stay null.
	res.OK = true
	return res
}

// isConnRefused reports connection-refused/reset style errors without
// importing syscall details into the message (no OS text on the wire).
func isConnRefused(err error) bool {
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "connection refused") ||
		strings.Contains(s, "connection reset") ||
		strings.Contains(s, "no such host") // unreachable, defensive
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [8]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
