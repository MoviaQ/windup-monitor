package discover

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"windup-monitor/agent/internal/protocol"
)

const testBtime = 1789398549

// fixtureRoot builds a fake /proc tree: btime + tcp/tcp6 tables.
func fixtureRoot(t *testing.T, tcp, tcp6 string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "stat"), []byte(fmt.Sprintf("cpu  0\nbtime %d\n", testBtime)), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "net"), 0o755); err != nil {
		t.Fatal(err)
	}
	if tcp != "" {
		if err := os.WriteFile(filepath.Join(root, "net", "tcp"), []byte(tcp), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if tcp6 != "" {
		if err := os.WriteFile(filepath.Join(root, "net", "tcp6"), []byte(tcp6), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func tcpHeader() string {
	return "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
}

func tcpLine(port, inode int) string {
	return tcpLineAddr("00000000", port, inode)
}

func tcpLineAddr(addr string, port, inode int) string {
	return fmt.Sprintf("   0: %s:%04X 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 %d 1 0000000000000000 100 0 0 10 0\n", addr, port, inode)
}

func tcp6LineAddr(addr string, port, inode int) string {
	return fmt.Sprintf("   0: %s:%04X 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 %d 1 0000000000000000 100 0 0 10 0\n", addr, port, inode)
}

// fixturePID creates /proc/<pid>/{comm,stat,fd} (+exe symlink, +cmdline).
// startTicks<0 omits stat; exeTarget "" omits the exe link.
func fixturePID(t *testing.T, root string, pid int, comm string, startTicks int64, inode int, exeTarget, cmdline string) {
	t.Helper()
	dir := filepath.Join(root, strconv.Itoa(pid))
	if err := os.MkdirAll(filepath.Join(dir, "fd"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "comm"), []byte(comm+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if startTicks >= 0 {
		fields := make([]string, 25)
		for i := range fields {
			fields[i] = "0"
		}
		fields[0] = "S"
		fields[19] = strconv.FormatInt(startTicks, 10)
		stat := fmt.Sprintf("%d (%s) %s\n", pid, comm, strings.Join(fields, " "))
		if err := os.WriteFile(filepath.Join(dir, "stat"), []byte(stat), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if inode > 0 {
		// Real /proc fd entries are symlinks to socket:[inode]; tests use a
		// real socket target string via a symlink to a temp file is wrong,
		// so link to a synthetic path and rely on readlink text? No:
		// os.Symlink requires an existing-or-not target string — the link
		// CONTENT is what matters, existence is irrelevant.
		if err := os.Symlink(fmt.Sprintf("socket:[%d]", inode), filepath.Join(dir, "fd", "10")); err != nil {
			t.Fatal(err)
		}
	}
	if exeTarget != "" {
		if err := os.Symlink(exeTarget, filepath.Join(dir, "exe")); err != nil {
			t.Fatal(err)
		}
	}
	if cmdline != "" {
		if err := os.WriteFile(filepath.Join(dir, "cmdline"), []byte(cmdline), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func snap(t *testing.T, root string) protocol.ServiceDiscovery {
	t.Helper()
	s, err := Snapshot(Deps{ProcRoot: root, Now: func() time.Time {
		return time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	}})
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	return s
}

func byID(s protocol.ServiceDiscovery) map[string]protocol.ServiceCandidate {
	m := map[string]protocol.ServiceCandidate{}
	for _, c := range s.Candidates {
		m[c.CandidateID] = c
	}
	return m
}

// Generic (kind=unknown) candidates: no brand guessing, but the owning
// process's local metadata (exe basename here) may name them — the wire
// carries the sanitized label, never argv/env.
func TestUnknownListenersGenericNaming(t *testing.T) {
	root := fixtureRoot(t, tcpHeader()+tcpLine(22, 1001)+tcpLine(8443, 1002), tcpHeader())
	exe, _ := filepath.Abs("myapp-bin")
	// Cmdline with a sentinel smuggled in: the exe/comm metadata may name
	// the candidate, but argv must never travel.
	fixturePID(t, root, 500, "myapp", 360000, 1002, exe, "myapp\x00--token=SECRET-SENTINEL-ABC\x00")

	s := snap(t, root)
	if !s.Complete {
		t.Fatal("complete must be true when tcp+tcp6 readable")
	}
	m := byID(s)
	if len(m) != 2 {
		t.Fatalf("candidates=%v", s.Candidates)
	}
	// Port 22: no attributable process (no fd-proven owner) → the port
	// label at low confidence, source proc, no pid.
	ssh, ok := m["generic-22"]
	if !ok {
		t.Fatalf("missing generic-22 in %v", m)
	}
	if ssh.Name != "Usługa na porcie 22" || ssh.Kind != "unknown" || ssh.Transport != "tcp" || ssh.Confidence != "low" {
		t.Fatalf("bad port-label candidate: %+v", ssh)
	}
	if ssh.Source != "proc" || ssh.PID != 0 || !ssh.Monitorable {
		t.Fatalf("no-owner candidate must be proc/low/no-pid/monitorable(bind-eligible): %+v", ssh)
	}
	if ssh.NameSource == nil || *ssh.NameSource != "fallback" {
		t.Fatalf("port label must be name_source=fallback: %+v", ssh)
	}
	if ssh.SuggestedPath != nil || len(ssh.SuggestedStatuses) != 0 {
		t.Fatalf("unknown must carry no HTTP suggestion: %+v", ssh)
	}
	if ssh.ProcessStartedAt != nil {
		t.Fatalf("unattributed port must have null started_at: %+v", ssh)
	}
	// Port 8443: single fd-proven owner → named from exe metadata.
	app, ok := m["generic-8443"]
	if !ok {
		t.Fatalf("missing generic-8443 in %v", m)
	}
	if app.Name != "myapp-bin" || app.Kind != "unknown" || app.Confidence != "medium" || app.Source != "proc" {
		t.Fatalf("generic candidate must be named from exe metadata: %+v", app)
	}
	if app.NameSource == nil || *app.NameSource != "exe" {
		t.Fatalf("exe-named candidate must be name_source=exe: %+v", app)
	}
	if !app.Monitorable || app.PID != 500 {
		t.Fatalf("single proven owner must expose pid and monitorable bind: %+v", app)
	}
	wantStart := time.Unix(testBtime+360000/100, 0).UTC().Format(time.RFC3339)
	if app.ProcessStartedAt == nil || *app.ProcessStartedAt != wantStart {
		t.Fatalf("started_at=%v want %s", app.ProcessStartedAt, wantStart)
	}
	// The sanitized NAME may travel; argv and secrets never do.
	raw, _ := json.Marshal(s)
	if !strings.Contains(string(raw), `"name":"myapp-bin"`) {
		t.Fatalf("snapshot must carry the sanitized process name:\n%s", raw)
	}
	for _, leak := range []string{"SECRET-SENTINEL-ABC", "--token"} {
		if strings.Contains(string(raw), leak) {
			t.Fatalf("snapshot leaks cmdline detail %q:\n%s", leak, raw)
		}
	}
}

func TestPartialVisibilityDegrades(t *testing.T) {
	// tcp6 missing -> complete=false, but tcp candidates still reported.
	root := fixtureRoot(t, tcpHeader()+tcpLine(22, 1001), "")
	s := snap(t, root)
	if s.Complete {
		t.Fatal("complete must be false when tcp6 unreadable")
	}
	if len(s.Candidates) != 1 || s.Candidates[0].Port != 22 {
		t.Fatalf("partial snapshot must keep readable candidates: %+v", s.Candidates)
	}

	// fd dir unreadable (other uid) -> port known, timing unattributed.
	root2 := fixtureRoot(t, tcpHeader()+tcpLine(9443, 2002), tcpHeader())
	pidDir := filepath.Join(root2, "777")
	if err := os.MkdirAll(filepath.Join(pidDir, "fd"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pidDir, "comm"), []byte("db\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(pidDir, "fd"), 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(pidDir, "fd"), 0o755) })
	s2 := snap(t, root2)
	if !s2.Complete {
		t.Fatal("fd permission must not flip complete (tcp tables are readable)")
	}
	if len(s2.Candidates) != 1 || s2.Candidates[0].CandidateID != "generic-9443" {
		t.Fatalf("candidates=%+v", s2.Candidates)
	}
	// comm is readable but fd is denied: without an fd-proven owner the
	// candidate keeps the honest port label, low confidence, no pid.
	c := s2.Candidates[0]
	if c.Name != "Usługa na porcie 9443" || c.Confidence != "low" || c.PID != 0 {
		t.Fatalf("denied fd must yield the port label without pid: %+v", c)
	}
	if c.NameSource == nil || *c.NameSource != "fallback" {
		t.Fatalf("denied fd must be name_source=fallback: %+v", c)
	}
	if c.ProcessStartedAt != nil {
		t.Fatalf("unmapped fd must yield null started_at: %+v", s2.Candidates[0])
	}
}

func TestJellyfinCombinedEvidenceNoLeak(t *testing.T) {
	root := fixtureRoot(t, tcpHeader()+tcpLine(8096, 3003), tcpHeader())
	// Jellyfin itself: comm readable, fd denied (no fd dir at all).
	pidDir := filepath.Join(root, "100")
	if err := os.MkdirAll(pidDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pidDir, "comm"), []byte("jellyfin\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	fields := make([]string, 25)
	for i := range fields {
		fields[i] = "0"
	}
	fields[0] = "S"
	fields[19] = "720000"
	if err := os.WriteFile(filepath.Join(pidDir, "stat"), []byte("100 (jellyfin) "+strings.Join(fields, " ")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// docker-proxy with a secret sentinel smuggled into its argv: the parse
	// may use host/container ports locally but must never transmit argv.
	proxyCmd := "docker-proxy\x00-proto\x00tcp\x00-host-ip\x000.0.0.0\x00-host-port\x008096\x00-container-ip\x00172.17.0.3\x00-container-port\x008096\x00--token=SECRET-SENTINEL-XYZ\x00"
	fixturePID(t, root, 101, "docker-proxy", 100, 0, "/usr/bin/docker-proxy", proxyCmd)

	s := snap(t, root)
	m := byID(s)
	j, ok := m["jellyfin-8096"]
	if !ok {
		t.Fatalf("missing jellyfin-8096 in %+v", s.Candidates)
	}
	if j.Name != "Jellyfin" || j.Kind != "jellyfin" || j.Transport != "http" {
		t.Fatalf("bad jellyfin candidate: %+v", j)
	}
	if j.Confidence != "medium" {
		t.Fatalf("jellyfin without pid match must stay medium: %+v", j)
	}
	if j.SuggestedPath == nil || *j.SuggestedPath != "/System/Info/Public" {
		t.Fatalf("jellyfin hint=%v", j.SuggestedPath)
	}
	if len(j.SuggestedStatuses) != 1 || j.SuggestedStatuses[0] != 200 {
		t.Fatalf("jellyfin statuses=%v", j.SuggestedStatuses)
	}
	if j.NameSource == nil || *j.NameSource != "comm" || !j.Monitorable {
		t.Fatalf("jellyfin comm evidence must be name_source=comm/monitorable: %+v", j)
	}
	wantStart := time.Unix(testBtime+720000/100, 0).UTC().Format(time.RFC3339)
	if j.ProcessStartedAt == nil || *j.ProcessStartedAt != wantStart {
		t.Fatalf("started_at=%v want %s (comm runtime evidence)", j.ProcessStartedAt, wantStart)
	}
	raw, _ := json.Marshal(s)
	if strings.Contains(string(raw), "SECRET-SENTINEL-XYZ") {
		t.Fatalf("snapshot leaks cmdline secret:\n%s", raw)
	}
	// Argv details (container IP, flags) must never appear; the closed
	// "source" enum value itself is the only allowed proxy trace.
	for _, leak := range []string{"172.17.0.3", "--token", "host-port", "container-port", "-proto"} {
		if strings.Contains(string(raw), leak) {
			t.Fatalf("snapshot leaks argv detail %q:\n%s", leak, raw)
		}
	}
}

func TestT3AndOpenCodeExactIdentity(t *testing.T) {
	root := fixtureRoot(t, tcpHeader()+tcpLine(3773, 4001)+tcpLine(4096, 4002)+tcpLine(9999, 4003), tcpHeader())
	bin := t.TempDir()
	t3bin := filepath.Join(bin, "t3")
	ocbin := filepath.Join(bin, "opencode.exe")
	for _, p := range []string{t3bin, ocbin} {
		if err := os.WriteFile(p, []byte("x"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	fixturePID(t, root, 200, "node-MainThread", 500000, 4001, t3bin, "")
	fixturePID(t, root, 201, "opencode", 600000, 4002, ocbin, "")
	// t3-resource-monitor must NOT match the t3 rule (no prefix sweep).
	mon := filepath.Join(bin, "t3-resource-monitor")
	if err := os.WriteFile(mon, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	fixturePID(t, root, 202, "t3-resource-mon", 100, 4003, mon, "")

	s := snap(t, root)
	m := byID(s)
	t3, ok := m["t3-code-3773"]
	if !ok {
		t.Fatalf("missing t3-code-3773 in %+v", s.Candidates)
	}
	if t3.Name != "T3 Code" || t3.Confidence != "high" || t3.Source != "proc" {
		t.Fatalf("bad t3 candidate: %+v", t3)
	}
	if t3.NameSource == nil || *t3.NameSource != "exe" || !t3.Monitorable {
		t.Fatalf("t3 must be name_source=exe/monitorable: %+v", t3)
	}
	if t3.SuggestedPath == nil || *t3.SuggestedPath != "/" || len(t3.SuggestedStatuses) != 1 {
		t.Fatalf("bad t3 hint: %+v", t3)
	}
	oc, ok := m["opencode-4096"]
	if !ok {
		t.Fatalf("missing opencode-4096 in %+v", s.Candidates)
	}
	if oc.Name != "OpenCode" || oc.Kind != "opencode" || oc.Confidence != "high" {
		t.Fatalf("bad opencode candidate (must not claim T3): %+v", oc)
	}
	if oc.NameSource == nil || *oc.NameSource != "exe" || !oc.Monitorable {
		t.Fatalf("opencode must be name_source=exe/monitorable: %+v", oc)
	}
	if len(oc.SuggestedStatuses) != 2 {
		t.Fatalf("opencode must suggest 200+401 (auth gate): %+v", oc.SuggestedStatuses)
	}
	// t3-resource-monitor must NOT match the t3 rule; it stays a generic
	// candidate named from its own exe metadata.
	gc, ok := m["generic-9999"]
	if !ok {
		t.Fatalf("resource monitor must stay generic: %+v", s.Candidates)
	}
	if gc.Kind != "unknown" || gc.Name != "t3-resource-monitor" || gc.Confidence != "medium" {
		t.Fatalf("generic resource monitor must keep its own metadata name: %+v", gc)
	}
	if gc.NameSource == nil || *gc.NameSource != "exe" || gc.SuggestedPath != nil {
		t.Fatalf("generic must stay tcp without HTTP hint: %+v", gc)
	}
}

func TestSnapshotStableIDs(t *testing.T) {
	root := fixtureRoot(t, tcpHeader()+tcpLine(8096, 3003)+tcpLine(3773, 4001)+tcpLine(9100, 7001), tcpHeader())
	fixturePID(t, root, 200, "node-MainThread", 500000, 4001, "/tmp/t3-test-bin", "")
	a := snap(t, root)
	b := snap(t, root)
	if len(a.Candidates) != len(b.Candidates) {
		t.Fatalf("unstable count %d vs %d", len(a.Candidates), len(b.Candidates))
	}
	for i := range a.Candidates {
		// Stable identity: everything but the snapshot timestamp repeats.
		aa, bb := a.Candidates[i], b.Candidates[i]
		if aa.CandidateID != bb.CandidateID || aa.Kind != bb.Kind || aa.Port != bb.Port ||
			aa.Name != bb.Name || aa.Transport != bb.Transport || aa.Source != bb.Source ||
			aa.Confidence != bb.Confidence || aa.Monitorable != bb.Monitorable {
			t.Fatalf("unstable candidate:\n%+v\n%+v", aa, bb)
		}
	}
	// The generic id is the stable generic-<port> in every snapshot.
	if _, ok := byID(a)["generic-9100"]; !ok {
		t.Fatalf("missing stable generic-9100 in %+v", a.Candidates)
	}
	if byID(a)["generic-9100"].Name != byID(b)["generic-9100"].Name {
		t.Fatal("generic name must be stable across snapshots")
	}
}

func TestMaxCandidatesBound(t *testing.T) {
	var sb strings.Builder
	sb.WriteString(tcpHeader())
	for i := 0; i < 70; i++ {
		sb.WriteString(tcpLine(10000+i, 50000+i))
	}
	root := fixtureRoot(t, sb.String(), tcpHeader())
	s := snap(t, root)
	if len(s.Candidates) != MaxCandidates {
		t.Fatalf("candidates=%d want %d", len(s.Candidates), MaxCandidates)
	}
	raw, _ := json.Marshal(s)
	if len(raw) > 256*1024 {
		t.Fatalf("snapshot alone exceeds envelope bound: %d", len(raw))
	}
}

// MED2: only IPv4 127.0.0.1/0.0.0.0 binds are HTTP-monitorable. A known app
// bound to a LAN address stays visible but tcp/unmonitorable (no suggestion),
// so probing 127.0.0.1 can never report a false down for it.
func TestBindEligibilityGuardsHTTPSuggestion(t *testing.T) {
	bin := t.TempDir()
	t3bin := filepath.Join(bin, "t3")
	if err := os.WriteFile(t3bin, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name     string
		tcp      string
		tcp6     string
		wantHTTP bool
		wantID   string
	}{
		{"v4wildcard", tcpLineAddr("00000000", 9090, 9001), "", true, "t3-code-9090"},
		{"v4loopback", tcpLineAddr("0100007F", 9090, 9001), "", true, "t3-code-9090"},
		{"v4lan", tcpLineAddr("0501A8C0", 9090, 9001), "", false, "t3-code-9090"},
		{"v6loopbackOnly", "", tcp6LineAddr("00000000000000000000000000000001", 9090, 9001), false, "t3-code-9090"},
		{"v6wildcardOnly", "", tcp6LineAddr("00000000000000000000000000000000", 9090, 9001), false, "t3-code-9090"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tcp := tcpHeader()
			if tc.tcp != "" {
				tcp += tc.tcp
			}
			tcp6 := tcpHeader()
			if tc.tcp6 != "" {
				tcp6 += tc.tcp6
			}
			root := fixtureRoot(t, tcp, tcp6)
			fixturePID(t, root, 600, "node-MainThread", 500000, 9001, t3bin, "")
			s := snap(t, root)
			m := byID(s)
			c, ok := m[tc.wantID]
			if !ok {
				t.Fatalf("missing %s in %+v", tc.wantID, s.Candidates)
			}
			if tc.wantHTTP {
				if c.Transport != "http" || c.SuggestedPath == nil || !c.Monitorable {
					t.Fatalf("eligible bind must be http-monitorable: %+v", c)
				}
			} else {
				if c.Transport != "tcp" || c.SuggestedPath != nil || len(c.SuggestedStatuses) != 0 {
					t.Fatalf("ineligible bind must be tcp/unmonitorable: %+v", c)
				}
				if c.Monitorable {
					t.Fatalf("IPv6/LAN-only bind must be monitorable=false: %+v", c)
				}
				if c.Kind != "t3-code" {
					t.Fatalf("identity stays visible as inventory: %+v", c)
				}
			}
		})
	}
}

// MED2: one port, two binds (eligible t3 + LAN opencode) — the eligible
// bind wins identity and timing; the unsupported bind is not merged in.
func TestSamePortMixedBindsEligibleWins(t *testing.T) {
	bin := t.TempDir()
	t3bin := filepath.Join(bin, "t3")
	ocbin := filepath.Join(bin, "opencode")
	for _, p := range []string{t3bin, ocbin} {
		if err := os.WriteFile(p, []byte("x"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	root := fixtureRoot(t,
		tcpHeader()+tcpLineAddr("00000000", 9090, 9101)+tcpLineAddr("0501A8C0", 9090, 9102),
		tcpHeader())
	fixturePID(t, root, 601, "node-MainThread", 500000, 9101, t3bin, "")
	fixturePID(t, root, 602, "opencode", 600000, 9102, ocbin, "")
	s := snap(t, root)
	m := byID(s)
	if len(m) != 1 {
		t.Fatalf("one port must yield one candidate: %+v", s.Candidates)
	}
	c := m["t3-code-9090"]
	if c.Transport != "http" || c.SuggestedPath == nil {
		t.Fatalf("eligible bind must win: %+v", c)
	}
	wantStart := time.Unix(testBtime+500000/100, 0).UTC().Format(time.RFC3339)
	if c.ProcessStartedAt == nil || *c.ProcessStartedAt != wantStart {
		t.Fatalf("timing must come from the eligible holder: %v want %s", c.ProcessStartedAt, wantStart)
	}
}

// Non-blocker: recognised HTTP candidates sort before unknown ones, so
// trimming to MaxCandidates never drops a monitorable service for noise.
func TestKnownCandidatesSurviveTrim(t *testing.T) {
	var sb strings.Builder
	sb.WriteString(tcpHeader())
	for i := 0; i < 70; i++ {
		sb.WriteString(tcpLine(10000+i, 60000+i))
	}
	sb.WriteString(tcpLine(50000, 69999))
	root := fixtureRoot(t, sb.String(), tcpHeader())
	bin := t.TempDir()
	t3bin := filepath.Join(bin, "t3")
	if err := os.WriteFile(t3bin, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	fixturePID(t, root, 700, "node-MainThread", 500000, 69999, t3bin, "")
	s := snap(t, root)
	if len(s.Candidates) != MaxCandidates {
		t.Fatalf("candidates=%d want %d", len(s.Candidates), MaxCandidates)
	}
	if _, ok := byID(s)["t3-code-50000"]; !ok {
		t.Fatalf("known high-port candidate trimmed away: %+v", s.Candidates[0])
	}
}

func TestUnknownCandidateHasArrayStatuses(t *testing.T) {
	c := classify("", 12345, true, nil, nil, nil, nil, false)
	if c.SuggestedStatuses == nil {
		t.Fatal("wire suggested_statuses must be [] rather than null")
	}
}

// Only a proven single owner may expose a local PID for process metrics;
// docker-proxy, missing fingerprint and ambiguous multiple processes never
// do, and PID is never serialised.
func TestCandidateLocalProcessPID(t *testing.T) {
	now := time.Date(2026, 10, 19, 9, 0, 0, 0, time.UTC)
	t3 := []holder{{pid: 200, comm: "node-MainThread", exeBase: "t3", started: &now}}
	if c := classify("", 3773, true, t3, t3, nil, nil, false); c.PID != 200 {
		t.Fatalf("single fd-proven owner must expose pid: %+v", c)
	}
	two := []holder{
		{pid: 200, comm: "node-MainThread", exeBase: "t3", started: &now},
		{pid: 201, comm: "node-MainThread", exeBase: "t3", started: &now},
	}
	if c := classify("", 3773, true, two, two, nil, nil, false); c.PID != 0 {
		t.Fatalf("ambiguous owners must not expose pid: %+v", c)
	}

	jf := []holder{{pid: 100, comm: "jellyfin", started: &now}}
	proxy := map[int]int{8096: 8096}
	if c := classify("", 8096, true, nil, nil, jf, proxy, true); c.PID != 100 {
		t.Fatalf("verified single jellyfin comm must expose its own pid: %+v", c)
	}
	if c := classify("", 8096, true, nil, nil, jf, proxy, false); c.PID != 0 {
		t.Fatalf("jellyfin without verified fingerprint must not expose pid: %+v", c)
	}
	both := append(jf, holder{pid: 101, comm: "jellyfin", started: &now})
	if c := classify("", 8096, true, nil, nil, both, proxy, true); c.PID != 0 {
		t.Fatalf("multiple jellyfin processes are ambiguous: %+v", c)
	}

	// Local PID is json:"-" and must never reach the wire.
	c := classify("", 3773, true, t3, t3, nil, nil, false)
	raw, _ := json.Marshal(c)
	if strings.Contains(string(raw), "\"pid\"") {
		t.Fatalf("PID leaked on wire: %s", raw)
	}
}

// Generic naming chain: exe denied → comm; the sanitized metadata name may
// travel, the process identity stays bounded to that label.
func TestGenericCommFallbackWhenExeDenied(t *testing.T) {
	root := fixtureRoot(t, tcpHeader()+tcpLine(9300, 8301), tcpHeader())
	fixturePID(t, root, 900, "coolapp", 100, 8301, "", "")
	s := snap(t, root)
	c := byID(s)["generic-9300"]
	if c.Name != "coolapp" || c.Kind != "unknown" || c.Confidence != "medium" || c.Source != "proc" {
		t.Fatalf("comm-named generic candidate: %+v", c)
	}
	if c.NameSource == nil || *c.NameSource != "comm" {
		t.Fatalf("comm-named candidate must be name_source=comm: %+v", c)
	}
	if !c.Monitorable || c.PID != 900 || c.SuggestedPath != nil {
		t.Fatalf("generic candidate must be monitorable/pid/no-hint: %+v", c)
	}
}

// Names are sanitized labels: control characters stripped, length capped
// (never split mid-rune), so the wire stays valid and UI-safe.
func TestGenericNameSanitization(t *testing.T) {
	root := fixtureRoot(t, tcpHeader()+tcpLine(9310, 8311)+tcpLine(9311, 8312), tcpHeader())
	fixturePID(t, root, 910, "evil\nname\x07", 100, 8311, "", "")
	fixturePID(t, root, 911, strings.Repeat("x", 100), 100, 8312, "", "")
	m := byID(snap(t, root))
	if got := m["generic-9310"].Name; got != "evilname" {
		t.Fatalf("control chars must be stripped, got %q", got)
	}
	long := m["generic-9311"].Name
	if rs := []rune(long); len(rs) > maxCandidateNameLen {
		t.Fatalf("name must be capped at %d runes, got %d", maxCandidateNameLen, len(rs))
	}
	if strings.HasSuffix(long, "\x00") {
		t.Fatal("name must not end mid-rune")
	}
	raw, _ := json.Marshal(snap(t, root))
	if !json.Valid(raw) {
		t.Fatalf("sanitized snapshot must stay valid JSON: %s", raw)
	}
}

// Node wrappers (exe/comm node) are named from the nearest package.json —
// via cwd or via the allowlisted argv script dir; an oversized package.json
// (capped at 64 KiB) yields no name and must fall through honestly.
func TestGenericNodePackageName(t *testing.T) {
	newRoot := func(t *testing.T, port, inode, pid int, cmdline string) string {
		t.Helper()
		root := fixtureRoot(t, tcpHeader()+tcpLine(port, inode), tcpHeader())
		fixturePID(t, root, pid, "node", 100, inode, "/usr/bin/node", cmdline)
		return root
	}
	t.Run("cwd", func(t *testing.T) {
		appDir := filepath.Join(t.TempDir(), "app")
		if err := os.MkdirAll(appDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(appDir, "package.json"), []byte(`{"name":"my-node-app","version":"1.0.0"}`), 0o644); err != nil {
			t.Fatal(err)
		}
		root := newRoot(t, 9400, 8401, 920, "node\x00server.js\x00")
		if err := os.Symlink(appDir, filepath.Join(root, "920", "cwd")); err != nil {
			t.Fatal(err)
		}
		c := byID(snap(t, root))["generic-9400"]
		if c.Name != "my-node-app" || c.Kind != "unknown" || c.Confidence != "medium" {
			t.Fatalf("node wrapper must take the package.json name: %+v", c)
		}
		if c.NameSource == nil || *c.NameSource != "package-json" || !c.Monitorable {
			t.Fatalf("package name provenance: %+v", c)
		}
		// The name may travel; the searched path never does.
		raw, _ := json.Marshal(snap(t, root))
		if strings.Contains(string(raw), appDir) {
			t.Fatalf("snapshot leaks the searched path:\n%s", raw)
		}
	})
	t.Run("argv-script-dir", func(t *testing.T) {
		// cwd is empty (nothing up the chain); the argv entry file points
		// into the app's dist/ — the only allowed argv read, Node only.
		base := t.TempDir()
		appDir := filepath.Join(base, "app")
		if err := os.MkdirAll(filepath.Join(appDir, "dist"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(appDir, "package.json"), []byte(`{"name":"argv-app"}`), 0o644); err != nil {
			t.Fatal(err)
		}
		cwdDir := filepath.Join(base, "cwd")
		if err := os.MkdirAll(cwdDir, 0o755); err != nil {
			t.Fatal(err)
		}
		root := newRoot(t, 9401, 8402, 921, "node\x00"+filepath.Join(appDir, "dist", "server.js")+"\x00")
		if err := os.Symlink(cwdDir, filepath.Join(root, "921", "cwd")); err != nil {
			t.Fatal(err)
		}
		c := byID(snap(t, root))["generic-9401"]
		if c.Name != "argv-app" || c.NameSource == nil || *c.NameSource != "package-json" {
			t.Fatalf("argv script dir must bound the package.json search: %+v", c)
		}
	})
	t.Run("oversized-package-json", func(t *testing.T) {
		appDir := filepath.Join(t.TempDir(), "app")
		if err := os.MkdirAll(appDir, 0o755); err != nil {
			t.Fatal(err)
		}
		big := `{"name":"nope","pad":"` + strings.Repeat("a", 70*1024) + `"}`
		if err := os.WriteFile(filepath.Join(appDir, "package.json"), []byte(big), 0o644); err != nil {
			t.Fatal(err)
		}
		root := newRoot(t, 9402, 8403, 922, "node\x00server.js\x00")
		if err := os.Symlink(appDir, filepath.Join(root, "922", "cwd")); err != nil {
			t.Fatal(err)
		}
		c := byID(snap(t, root))["generic-9402"]
		// 64 KiB cap honoured: no name, and "node" itself is no label.
		if c.Name != "Usługa na porcie 9402" || c.NameSource == nil || *c.NameSource != "fallback" || c.Confidence != "low" {
			t.Fatalf("oversized package.json must fall through to the port label: %+v", c)
		}
	})
}

// Cgroup metadata replaces D-Bus: a systemd unit names the service; a
// container scope never masquerades as a unit — only a readable token
// becomes a container name, bare ids keep the port label.
func TestSystemdUnitAndContainerNameFromCgroup(t *testing.T) {
	root := fixtureRoot(t, tcpHeader()+tcpLine(9500, 8501)+tcpLine(9501, 8502)+tcpLine(9502, 8503), tcpHeader())
	cgroups := map[int]string{
		930: "0::/system.slice/myapp.service\n",
		931: "0::/system.slice/docker-deadbeefcafe1234.scope\n",
		932: "0::/system.slice/docker-web.scope\n",
	}
	inodes := map[int]int{930: 8501, 931: 8502, 932: 8503}
	for pid, cg := range cgroups {
		fixturePID(t, root, pid, "sh", 100, inodes[pid], "/bin/sh", "")
		if err := os.WriteFile(filepath.Join(root, strconv.Itoa(pid), "cgroup"), []byte(cg), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	m := byID(snap(t, root))
	unit := m["generic-9500"]
	if unit.Name != "myapp.service" || unit.NameSource == nil || *unit.NameSource != "systemd" || unit.Confidence != "medium" {
		t.Fatalf("systemd unit must name the service: %+v", unit)
	}
	id := m["generic-9501"]
	if id.Name != "Usługa na porcie 9501" || id.NameSource == nil || *id.NameSource != "fallback" || id.Confidence != "low" {
		t.Fatalf("bare container id must never become a name: %+v", id)
	}
	tok := m["generic-9502"]
	if tok.Name != "web" || tok.NameSource == nil || *tok.NameSource != "container" || tok.Confidence != "medium" {
		t.Fatalf("readable container token must be the name: %+v", tok)
	}
}

// Owners sharing one port: agreeing metadata keeps the name (no pid
// guess), disagreeing owners keep the honest port label.
func TestGenericAmbiguousOwners(t *testing.T) {
	root := fixtureRoot(t, tcpHeader()+tcpLine(9600, 8601)+tcpLine(9601, 8602), tcpHeader())
	fixturePID(t, root, 940, "multiapp", 100, 8601, "/usr/bin/multiapp", "")
	fixturePID(t, root, 941, "multiapp", 100, 8601, "/usr/bin/multiapp", "")
	fixturePID(t, root, 942, "app-a", 100, 8602, "/usr/bin/app-a", "")
	fixturePID(t, root, 943, "app-b", 100, 8602, "/usr/bin/app-b", "")
	m := byID(snap(t, root))
	agree := m["generic-9600"]
	if agree.Name != "multiapp" || agree.Confidence != "medium" || agree.PID != 0 || agree.ProcessStartedAt != nil {
		t.Fatalf("agreeing owners must keep the name but never a pid/timing: %+v", agree)
	}
	merge := m["generic-9601"]
	if merge.Name != "Usługa na porcie 9601" || merge.NameSource == nil || *merge.NameSource != "fallback" || merge.Confidence != "low" || merge.PID != 0 {
		t.Fatalf("disagreeing owners must fall back to the port label: %+v", merge)
	}
}

// IPv6-only generic listeners stay visible as inventory but must never be
// monitorable: probes hit 127.0.0.1 only, and ::1 proves nothing there.
func TestGenericIPv6OnlyBindNotMonitorable(t *testing.T) {
	root := fixtureRoot(t, tcpHeader(), tcp6LineAddr("00000000000000000000000000000001", 9700, 8701))
	fixturePID(t, root, 950, "myv6app", 100, 8701, "/usr/bin/myv6app", "")
	c := byID(snap(t, root))["generic-9700"]
	if c.Kind != "unknown" || c.Name != "myv6app" {
		t.Fatalf("identity must stay visible as inventory: %+v", c)
	}
	if c.Monitorable || c.Transport != "tcp" || c.SuggestedPath != nil || len(c.SuggestedStatuses) != 0 {
		t.Fatalf("IPv6-only bind must be tcp/monitorable=false without HTTP hint: %+v", c)
	}
}
