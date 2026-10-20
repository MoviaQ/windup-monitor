// Package discover builds the local service-candidate snapshot from /proc.
//
// Pure Go, stdlib only. Sources: os.ReadFile on /proc/net/tcp and tcp6
// (LISTEN sockets) plus per-pid fd mapping, comm, stat start time, exe
// basename, and — bounded to a single pid — cwd/cgroup/cmdline-derived
// metadata for generic naming. No exec.Command, no shell, no Docker
// socket, no network scanning, no environment reads, no D-Bus.
//
// Several deliberate restrictions (see agent/CONTRACT.md §11):
//
//   - fd mapping covers only what the agent's uid may read; root-owned
//     processes (e.g. Jellyfin) expose comm/stat but deny fd — they are
//     recognised by combined evidence (comm + docker-proxy host-port
//     mapping) at medium confidence, never with a guaranteed pid match.
//   - The only cmdline reads are narrow local parses: docker-proxy
//     -host-port/-container-port arguments, and the script entry of an
//     allowlisted Node runtime (exe/comm node|nodejs) used solely to bound
//     the package.json name search. Cmdline, args, env, cwd and paths are
//     never transmitted, logged or stored — only sanitized labels.
//   - The only loopback HTTP fetch is the Jellyfin fingerprint
//     (GET /System/Info/Public on an already-listening 8096, body capped at
//     64 KiB, never logged). It never widens the scan.
//   - Unknown listeners are named generically from the owning process's
//     local metadata (exe basename, comm, nearest package.json name for
//     Node wrappers, systemd unit / container token parsed from cgroup)
//     as kind "unknown" with the stable id generic-<port>, transport tcp
//     and no HTTP suggestion; when no process is attributable the label is
//     "Usługa na porcie N" (low confidence). databases/sshd/DNS keep no
//     HTTP suggestion, and kind stays unknown so monitoring is never
//     blocked by a brand claim.
//   - Probes always hit 127.0.0.1, so only IPv4 127.0.0.1/0.0.0.0 binds are
//     monitorable (`monitorable=true`); LAN-specific and any IPv6 binds
//     surface as tcp/`monitorable=false` without HTTP hints (an IPv6 ::
//     wildcard proves nothing about IPv4 dual-stack); the eligible bind
//     wins identity when a port has several.
package discover

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"windup-monitor/agent/internal/protocol"
)

const (
	// MaxCandidates bounds the snapshot (and the heartbeat envelope).
	MaxCandidates = 64
	// clockTick is Linux CLK_TCK (getconf CLK_TCK == 100 on all supported
	// targets; Go stdlib offers no sysconf without cgo).
	clockTick = 100
	// fingerprintBodyCap caps the Jellyfin fingerprint response body.
	fingerprintBodyCap = 64 * 1024
	// fingerprintPath is the only HTTP route the agent ever fingerprints.
	fingerprintPath = "/System/Info/Public"
	// jellyfinPort is the only port ever fingerprinted, and only when it is
	// already observed listening.
	jellyfinPort = 8096
	// maxCandidateNameLen bounds a derived display name (runes) — names are
	// sanitized labels, never raw file contents.
	maxCandidateNameLen = 64
	// pkgJSONCap bounds one package.json read; a larger file yields no name.
	pkgJSONCap = 64 * 1024
	// maxPkgParents bounds the upward search: starting dir + 3 parents, and
	// at most two starting dirs (cwd, script dir) — never a global fs walk.
	maxPkgParents = 3
	// cmdlineCap bounds the allowlisted-runtime argv read (mirrors the
	// docker-proxy parser bound).
	cmdlineCap = 8192
	// cgroupCap bounds one /proc/<pid>/cgroup read.
	cgroupCap = 16 * 1024
	// maxCwdLen bounds the cwd link target kept for the local search.
	maxCwdLen = 4096
)

// Preset ports for known services.
const (
	portJellyfin = 8096
	portT3       = 3773
	portOpenCode = 4096
)

// Deps parameterises a snapshot; ProcRoot is "/proc" in production and a
// fixture tree in tests.
type Deps struct {
	ProcRoot           string
	Fingerprint        bool // attempt the Jellyfin loopback fingerprint
	FingerprintTimeout time.Duration
	Now                func() time.Time
}

func (d Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d Deps) fpTimeout() time.Duration {
	if d.FingerprintTimeout > 0 {
		return d.FingerprintTimeout
	}
	return 3 * time.Second
}

// holder is one process observed holding (or evidencing) a listening port.
type holder struct {
	pid      int
	comm     string
	exeBase  string
	started  *time.Time // nil when no proven timing association
	fdProven bool       // true when linked via an fd socket inode
}

// Snapshot reads the local listening sockets and classifies them into stable
// candidates. It never fails hard on partial visibility: permission-denied
// pids are skipped and reported via Complete=false.
//
// IPv4 loopback/wildcard binds only: probes always hit 127.0.0.1 (contract),
// so only 127.0.0.1 and 0.0.0.0 listeners are HTTP-monitorable. LAN-specific
// and any IPv6 binds (an IPv6 :: wildcard proves nothing about IPv4
// dual-stack) surface as tcp/unmonitorable candidates without HTTP hints —
// never merged into an eligible candidate's identity.
func Snapshot(d Deps) (protocol.ServiceDiscovery, error) {
	now := d.now().UTC()
	root := d.ProcRoot
	if root == "" {
		root = "/proc"
	}
	ports, complete := listenPorts(root)
	btime := readBtime(root)

	// Per-pid evidence, split by bind eligibility so an unsupported bind
	// never corrupts the monitorable candidate's identity.
	byPort := map[int][]holder{}
	eligByPort := map[int][]holder{}
	var jellyfin []holder
	proxy := map[int]int{} // hostPort -> containerPort (docker-proxy args)
	pids := listPIDs(root)
	for _, pid := range pids {
		comm := readComm(root, pid)
		exe := readExeBase(root, pid)
		start := procStart(root, pid, btime)
		if comm == "jellyfin" {
			var h holder
			h.pid, h.comm, h.exeBase = pid, comm, exe
			if start != nil {
				t := *start
				h.started = &t
			}
			jellyfin = append(jellyfin, h)
		}
		if comm == "docker-proxy" || exe == "docker-proxy" {
			for hp, cp := range readProxyMapping(root, pid) {
				if _, ok := proxy[hp]; !ok {
					proxy[hp] = cp
				}
			}
		}
		inodes := pidSocketInodes(root, pid, ports.inodes)
		if len(inodes) == 0 {
			continue
		}
		for ino := range inodes {
			for _, port := range ports.byInode[ino] {
				var h holder
				h.pid, h.comm, h.exeBase, h.fdProven = pid, comm, exe, true
				if start != nil {
					t := *start
					h.started = &t
				}
				byPort[port] = append(byPort[port], h)
				if ports.inodeEligible[ino] {
					eligByPort[port] = append(eligByPort[port], h)
				}
			}
		}
	}

	fingerprinted := false
	if d.Fingerprint && ports.eligible[jellyfinPort] {
		fingerprinted = fingerprintJellyfin(d.fpTimeout())
	}

	cands := make([]protocol.ServiceCandidate, 0, len(ports.list))
	for _, port := range ports.list {
		cands = append(cands, classify(root, port, ports.eligible[port], eligByPort[port], byPort[port], jellyfin, proxy, fingerprinted))
	}
	sort.Slice(cands, func(i, j int) bool {
		// Recognised HTTP candidates first: trimming must never drop a
		// monitorable service in favour of an unknown listener.
		ki := cands[i].Kind != protocol.ServiceKindUnknown
		kj := cands[j].Kind != protocol.ServiceKindUnknown
		if ki != kj {
			return ki
		}
		if cands[i].Port != cands[j].Port {
			return cands[i].Port < cands[j].Port
		}
		return cands[i].CandidateID < cands[j].CandidateID
	})
	if len(cands) > MaxCandidates {
		cands = cands[:MaxCandidates]
	}
	out := protocol.ServiceDiscovery{
		ObservedAt: now.Format(time.RFC3339),
		Complete:   complete,
		Candidates: cands,
	}
	if out.Candidates == nil {
		out.Candidates = []protocol.ServiceCandidate{}
	}
	return out, nil
}

// listenResult is the parsed LISTEN table.
type listenResult struct {
	byInode       map[string][]int // socket inode -> ports
	inodeEligible map[string]bool  // socket inode -> IPv4 loopback/wildcard bind
	inodes        map[string]bool  // interest set for the fd scan
	list          []int            // distinct ports, sorted
	known         map[int]bool     // port presence set
	eligible      map[int]bool     // port -> any IPv4 loopback/wildcard bind
}

// listenPorts parses /proc/net/tcp and tcp6, keeping state 0A (LISTEN).
// complete is true only when both files were fully readable.
func listenPorts(root string) (listenResult, bool) {
	res := listenResult{
		byInode:       map[string][]int{},
		inodeEligible: map[string]bool{},
		inodes:        map[string]bool{},
		known:         map[int]bool{},
		eligible:      map[int]bool{},
	}
	complete := true
	for _, name := range []string{"net/tcp", "net/tcp6"} {
		raw, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			complete = false
			continue
		}
		for _, line := range strings.Split(string(raw), "\n") {
			f := strings.Fields(line)
			if len(f) < 10 || f[0] == "sl" {
				continue
			}
			if f[3] != "0A" {
				continue // not LISTEN
			}
			port, elig := parseLocal(f[1])
			if port <= 0 || port > 65535 {
				continue
			}
			ino := f[9]
			if ino == "0" {
				continue
			}
			res.byInode[ino] = append(res.byInode[ino], port)
			if elig {
				res.inodeEligible[ino] = true
				res.eligible[port] = true
			}
			res.inodes[ino] = true
			res.known[port] = true
		}
	}
	for p := range res.known {
		res.list = append(res.list, p)
	}
	sort.Ints(res.list)
	return res, complete
}

// parseLocal extracts the port and the IPv4-loopback eligibility from a
// local_address field. Only 127.0.0.1 (0100007F) and 0.0.0.0 (00000000)
// binds are HTTP-monitorable: probes always hit 127.0.0.1, and an IPv6 ::
// wildcard proves nothing about IPv4 dual-stack, so no IPv6 bind (not even
// ::1) is ever eligible.
func parseLocal(local string) (port int, eligible bool) {
	i := strings.LastIndexByte(local, ':')
	if i < 0 {
		return -1, false
	}
	n, err := strconv.ParseUint(local[i+1:], 16, 32)
	if err != nil {
		return -1, false
	}
	addr := strings.ToUpper(local[:i])
	if len(addr) == 8 && (addr == "00000000" || addr == "0100007F") {
		return int(n), true
	}
	return int(n), false
}

// readBtime returns the system boot time (seconds since epoch), or 0 when
// /proc/stat is unreadable.
func readBtime(root string) int64 {
	raw, err := os.ReadFile(filepath.Join(root, "stat"))
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(line, "btime ") {
			n, err := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(line, "btime ")), 10, 64)
			if err == nil && n > 0 {
				return n
			}
		}
	}
	return 0
}

// listPIDs returns numeric /proc entries, sorted for determinism.
func listPIDs(root string) []int {
	ents, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []int
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		n, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		out = append(out, n)
	}
	sort.Ints(out)
	return out
}

// readComm returns /proc/<pid>/comm trimmed (world-readable even for
// root-owned processes). Empty on any error.
func readComm(root string, pid int) string {
	raw, err := os.ReadFile(filepath.Join(root, strconv.Itoa(pid), "comm"))
	if err != nil {
		return ""
	}
	s := strings.TrimSpace(string(raw))
	if len(s) > 64 {
		s = s[:64]
	}
	return s
}

// readExeBase returns the basename of /proc/<pid>/exe, or "" when the link
// cannot be read (e.g. other uid). A " (deleted)" suffix is stripped.
func readExeBase(root string, pid int) string {
	target, err := os.Readlink(filepath.Join(root, strconv.Itoa(pid), "exe"))
	if err != nil {
		return ""
	}
	target = strings.TrimSuffix(target, " (deleted)")
	return filepath.Base(target)
}

// procStart converts /proc/<pid>/stat field 22 (starttime, clock ticks
// since boot) into an absolute UTC time using btime. Nil when btime is
// unknown or stat is unreadable.
func procStart(root string, pid int, btime int64) *time.Time {
	if btime <= 0 {
		return nil
	}
	raw, err := os.ReadFile(filepath.Join(root, strconv.Itoa(pid), "stat"))
	if err != nil {
		return nil
	}
	// comm may contain spaces/parens: cut after the LAST ')'.
	s := string(raw)
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return nil
	}
	fields := strings.Fields(s[i+1:])
	// fields[0] is state (field 3); starttime is field 22 -> index 19.
	if len(fields) < 20 {
		return nil
	}
	ticks, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil {
		return nil
	}
	t := time.Unix(btime+int64(ticks/clockTick), 0).UTC()
	return &t
}

// pidSocketInodes returns the subset of interest inodes this pid holds via
// /proc/<pid>/fd socket links. Unreadable fd dirs (other uid) yield nothing.
func pidSocketInodes(root string, pid int, interest map[string]bool) map[string]bool {
	if len(interest) == 0 {
		return nil
	}
	ents, err := os.ReadDir(filepath.Join(root, strconv.Itoa(pid), "fd"))
	if err != nil {
		return nil
	}
	out := map[string]bool{}
	const maxFDs = 4096
	for i, e := range ents {
		if i >= maxFDs {
			break
		}
		target, err := os.Readlink(filepath.Join(root, strconv.Itoa(pid), "fd", e.Name()))
		if err != nil {
			continue
		}
		if !strings.HasPrefix(target, "socket:[") || !strings.HasSuffix(target, "]") {
			continue
		}
		ino := target[len("socket:[") : len(target)-1]
		if interest[ino] {
			out[ino] = true
		}
	}
	return out
}

// readProxyMapping narrowly parses docker-proxy arguments for this pid only:
// -host-port <hp> and -container-port <cp>. The raw cmdline is used locally
// for port attribution and never leaves the host. Non-proxy processes must
// not call this.
func readProxyMapping(root string, pid int) map[int]int {
	raw, err := os.ReadFile(filepath.Join(root, strconv.Itoa(pid), "cmdline"))
	if err != nil || len(raw) > 8192 {
		return nil
	}
	var toks []string
	for _, t := range strings.Split(string(raw), "\x00") {
		if t != "" {
			toks = append(toks, t)
		}
	}
	var hp, cp int
	for i := 0; i < len(toks); i++ {
		switch toks[i] {
		case "-host-port":
			if i+1 < len(toks) {
				if n, err := strconv.Atoi(toks[i+1]); err == nil {
					hp = n
				}
			}
		case "-container-port":
			if i+1 < len(toks) {
				if n, err := strconv.Atoi(toks[i+1]); err == nil {
					cp = n
				}
			}
		}
	}
	if hp <= 0 || hp > 65535 || cp <= 0 || cp > 65535 {
		return nil
	}
	return map[int]int{hp: cp}
}

// classify assigns kind/name/confidence/source/monitorability to one port.
// candidate_id is <kind>-port for recognised kinds and generic-port for
// unidentified listeners, so a reused port never attaches to an old
// signature of a different application.
//
// eligible reports an IPv4 127.0.0.1/0.0.0.0 bind for this port: only then
// Monitorable is true and Transport http with a suggested path may appear
// (the probe target 127.0.0.1 is proven to reach this listener). Without it
// the candidate stays visible as tcp/monitorable=false with no HTTP hint,
// so no probe can report a false down for an app bound elsewhere. elig
// holders (proven via an eligible bind) win identity over ineligible ones
// sharing the port.
//
// Generic naming (kind stays unknown): the owning process's local metadata
// only — package.json name of an allowlisted Node wrapper, exe basename,
// comm, systemd unit / readable container token parsed from cgroup — each
// sanitized and bounded, never argv/env/path. Owners that disagree on that
// metadata, or no attributable owner, yield "Usługa na porcie N" at low
// confidence (source proc). Recognised presets keep their fixed names and
// legacy <kind>-<port> ids.
func classify(root string, port int, eligible bool, elig, all []holder, jellyfin []holder, proxy map[int]int, fingerprinted bool) protocol.ServiceCandidate {
	sort.Slice(all, func(i, j int) bool { return all[i].pid < all[j].pid })
	sort.Slice(elig, func(i, j int) bool { return elig[i].pid < elig[j].pid })
	cand := protocol.ServiceCandidate{Port: port, SuggestedStatuses: []int{}, Monitorable: eligible}
	str := func(s string) *string { v := s; return &v }
	portLabel := fmt.Sprintf("Usługa na porcie %d", port)
	unmonitorable := func(kind, name, nameSource, confidence string, started *time.Time) protocol.ServiceCandidate {
		cand.CandidateID = fmt.Sprintf("%s-%d", kind, port)
		cand.Name = name
		cand.Kind = kind
		cand.Transport = protocol.ServiceTransportTCP
		cand.Source = protocol.ServiceSourceProc
		cand.NameSource = str(nameSource)
		cand.Confidence = confidence
		if started != nil {
			t := started.Format(time.RFC3339)
			cand.ProcessStartedAt = str(t)
		}
		return cand
	}

	// Jellyfin: root-owned comm is readable while fd is denied, and
	// docker-proxy publishes host-port 8096. Combined evidence at medium
	// confidence — explicitly no guaranteed pid match.
	if port == portJellyfin {
		cp, hasProxy := proxy[port]
		if (hasProxy && cp == portJellyfin) || len(jellyfin) > 0 || fingerprinted {
			source := protocol.ServiceSourceProcComm
			if hasProxy {
				source = protocol.ServiceSourceDockerProxy
			} else if fingerprinted && len(jellyfin) == 0 {
				source = protocol.ServiceSourceHTTPFingerprint
			}
			// Name provenance: the verified fingerprint wins, then the
			// comm match; proxy-only evidence is container metadata.
			nameSource := protocol.NameSourceContainer
			switch {
			case fingerprinted:
				nameSource = protocol.NameSourceFingerprint
			case len(jellyfin) > 0:
				nameSource = protocol.NameSourceComm
			}
			var started *time.Time
			if len(jellyfin) > 0 {
				started = jellyfin[0].started
			}
			// CPU/RSS evidence is allowed only for exactly one jellyfin
			// process whose public fingerprint was verified. fd is denied
			// for the root-owned process, so this stays an explicitly
			// medium-confidence association — and never the docker-proxy
			// pid. Multiple jellyfin processes are ambiguous => no pid.
			jellyfinPID := 0
			if len(jellyfin) == 1 && fingerprinted {
				jellyfinPID = jellyfin[0].pid
			}
			if !eligible {
				// Recognised but bound away from loopback: inventory
				// only, never an HTTP suggestion (probing 127.0.0.1
				// would report a false down).
				c := unmonitorable(protocol.ServiceKindJellyfin, "Jellyfin", nameSource, protocol.ServiceConfidenceMedium, started)
				c.Source = source
				c.PID = jellyfinPID
				return c
			}
			cand.CandidateID = fmt.Sprintf("%s-%d", protocol.ServiceKindJellyfin, port)
			cand.Name = "Jellyfin"
			cand.Kind = protocol.ServiceKindJellyfin
			cand.Transport = protocol.ServiceTransportHTTP
			cand.Source = source
			cand.NameSource = str(nameSource)
			cand.Confidence = protocol.ServiceConfidenceMedium
			cand.PID = jellyfinPID
			// Runtime evidence for start time is acceptable at medium
			// confidence (comm match), but never guessed without it.
			if started != nil {
				t := started.Format(time.RFC3339)
				cand.ProcessStartedAt = str(t)
			}
			cand.SuggestedPath = str(fingerprintPath)
			cand.SuggestedStatuses = []int{200}
			return cand
		}
	}

	// Known fd-proven identities (exact matches only — never prefix sweeps
	// that would mislabel e.g. t3-resource-monitor as T3). Eligible binds
	// first; an ineligible-only match stays visible but unmonitorable.
	matchKind := func(h holder) (kind, name, path, nameSource string, statuses []int, ok bool) {
		switch {
		case h.exeBase == "t3" || h.comm == "t3":
			nameSource = protocol.NameSourceComm
			if h.exeBase == "t3" {
				nameSource = protocol.NameSourceExe
			}
			return protocol.ServiceKindT3Code, "T3 Code", "/", nameSource, []int{200}, true
		case h.comm == "opencode" || h.exeBase == "opencode" || h.exeBase == "opencode.exe":
			// Labelled OpenCode (backend serving T3) — never asserted to
			// be a T3 instance itself.
			nameSource = protocol.NameSourceComm
			if h.exeBase == "opencode" || h.exeBase == "opencode.exe" {
				nameSource = protocol.NameSourceExe
			}
			return protocol.ServiceKindOpencode, "OpenCode", "/", nameSource, []int{200, 401}, true
		}
		return "", "", "", "", nil, false
	}
	// Exactly one fd-proven owner pid may be used for CPU/RSS. If two
	// different processes share the eligible port, the identity is
	// ambiguous and metrics stay unavailable (null), never guessed.
	var owner *holder
	ambiguous := false
	for i := range elig {
		h := elig[i]
		if kind, name, path, nameSource, statuses, ok := matchKind(h); ok {
			if owner == nil {
				owner = &elig[i]
			} else if owner.pid != h.pid {
				ambiguous = true
			}
			cand.CandidateID = fmt.Sprintf("%s-%d", kind, port)
			cand.Name = name
			cand.Kind = kind
			cand.Transport = protocol.ServiceTransportHTTP
			cand.Source = protocol.ServiceSourceProc
			cand.NameSource = str(nameSource)
			cand.Confidence = protocol.ServiceConfidenceHigh
			if h.started != nil {
				t := h.started.Format(time.RFC3339)
				cand.ProcessStartedAt = str(t)
			}
			cand.SuggestedPath = str(path)
			cand.SuggestedStatuses = statuses
		}
	}
	if owner != nil {
		if !ambiguous {
			cand.PID = owner.pid
		}
		return cand
	}
	for _, h := range all {
		if kind, name, _, nameSource, _, ok := matchKind(h); ok {
			return unmonitorable(kind, name, nameSource, protocol.ServiceConfidenceHigh, h.started)
		}
	}

	// Generic listener: kind stays unknown (monitoring is never blocked by
	// a brand claim), the id is the stable generic-<port>, and the name
	// comes from the owning process's local metadata only. All observed
	// owners must agree on that metadata — a reused port is never named by
	// whichever pid sorts first — and only a single proven owner exposes a
	// pid. No attributable process → the port label, source proc, low.
	holders := elig
	if len(holders) == 0 {
		holders = all
	}
	cand.CandidateID = fmt.Sprintf("generic-%d", port)
	cand.Kind = protocol.ServiceKindUnknown
	cand.Transport = protocol.ServiceTransportTCP
	cand.Source = protocol.ServiceSourceProc
	name, nameSource := portLabel, protocol.NameSourceFallback
	var pid int
	var started *time.Time
	if len(holders) > 0 && holdersAgree(holders) {
		name, nameSource = genericName(root, port, holders[0])
		single := true
		for _, h := range holders[1:] {
			if h.pid != holders[0].pid {
				single = false
				break
			}
		}
		if single {
			pid = holders[0].pid
			started = holders[0].started
		}
	}
	cand.Name = name
	cand.NameSource = str(nameSource)
	cand.PID = pid
	if started != nil {
		t := started.Format(time.RFC3339)
		cand.ProcessStartedAt = str(t)
	}
	if nameSource == protocol.NameSourceFallback {
		cand.Confidence = protocol.ServiceConfidenceLow
	} else {
		cand.Confidence = protocol.ServiceConfidenceMedium
	}
	return cand
}

// holdersAgree reports whether every observed owner agrees on the same
// binary identity (exe basename + comm). A port shared by different
// processes (e.g. SO_REUSEPORT with distinct apps) must not be named from
// whichever pid sorts first.
func holdersAgree(hs []holder) bool {
	for i := 1; i < len(hs); i++ {
		if hs[i].exeBase != hs[0].exeBase || hs[i].comm != hs[0].comm {
			return false
		}
	}
	return true
}

// nodeRuntimes is the cmdline-read allowlist: only these exe/comm values
// make argv eligible for the bounded script-dir lookup (a wrapper such as
// `node /opt/app/dist/server.js` whose cwd may be "/").
var nodeRuntimes = map[string]bool{"node": true, "nodejs": true}

// genericLabelJunk are interpreter/shell/init basenames that never
// identify a service on their own; they are skipped (not labelled) so the
// chain reaches cgroup evidence or the honest port label. A python*
// prefix matches every pythonX.Y.
var genericLabelJunk = map[string]bool{
	"node": true, "nodejs": true, "npm": true, "yarn": true, "pnpm": true,
	"bun": true, "deno": true,
	"sh": true, "bash": true, "dash": true, "zsh": true, "ksh": true,
	"csh": true, "fish": true, "busybox": true, "env": true,
	"systemd": true, "init": true,
	"java": true, "perl": true, "ruby": true,
}

func junkLabel(s string) bool {
	return genericLabelJunk[s] || strings.HasPrefix(s, "python")
}

// sanitizeName turns raw local metadata into a display label: control
// characters removed, whitespace trimmed, bounded to maxCandidateNameLen
// runes (never split mid-rune, so the wire stays valid UTF-8). Empty means
// "no usable name" and the caller continues its evidence chain.
func sanitizeName(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r < 0x20 || r == 0x7f { // control chars, incl. NUL/newline
			continue
		}
		b.WriteRune(r)
	}
	s = strings.TrimSpace(b.String())
	if rs := []rune(s); len(rs) > maxCandidateNameLen {
		s = strings.TrimSpace(string(rs[:maxCandidateNameLen]))
	}
	return s
}

// genericName derives a display name for an unidentified listener from the
// owning process's local metadata. Evidence chain (first hit wins):
// package.json name of an allowlisted Node wrapper, exe basename, comm,
// systemd unit from cgroup, readable container token from cgroup, else
// the port label (fallback). Nothing here is a brand claim and nothing
// but a sanitized label may leave the host.
func genericName(root string, port int, h holder) (name, nameSource string) {
	if n, ok := nodePackageName(root, h.pid, h.exeBase, h.comm); ok {
		return n, protocol.NameSourcePackageJSON
	}
	if h.exeBase != "" {
		if n := sanitizeName(h.exeBase); n != "" && !junkLabel(n) {
			return n, protocol.NameSourceExe
		}
	}
	if h.comm != "" {
		if n := sanitizeName(h.comm); n != "" && !junkLabel(n) {
			return n, protocol.NameSourceComm
		}
	}
	if cg := readCgroup(root, h.pid); cg != "" {
		if u := systemdUnit(cg); u != "" {
			return u, protocol.NameSourceSystemd
		}
		if containerCgroup(cg) {
			if tok := containerLabel(cg); tok != "" {
				return tok, protocol.NameSourceContainer
			}
		}
	}
	return fmt.Sprintf("Usługa na porcie %d", port), protocol.NameSourceFallback
}

// nodePackageName resolves the nearest package.json "name" for an
// allowlisted Node runtime wrapper. Bounded by construction: at most two
// starting dirs (cwd, then the argv script dir), dir + up to 3 parents
// each, 64 KiB per file — never a global filesystem walk. Only the parsed
// (sanitized) name may be used further; cwd/script paths stay local.
func nodePackageName(root string, pid int, exeBase, comm string) (string, bool) {
	if !nodeRuntimes[exeBase] && !nodeRuntimes[comm] {
		return "", false
	}
	cwd := readCwd(root, pid)
	dirs := make([]string, 0, 2)
	if cwd != "" {
		dirs = append(dirs, cwd)
	}
	if sd := nodeScriptDir(root, pid, cwd); sd != "" && (len(dirs) == 0 || dirs[0] != sd) {
		dirs = append(dirs, sd)
	}
	for _, dir := range dirs {
		cur := dir
		for level := 0; level <= maxPkgParents; level++ {
			if name, ok := pkgJSONName(filepath.Join(cur, "package.json")); ok {
				return name, true
			}
			parent := filepath.Dir(cur)
			if parent == cur {
				break
			}
			cur = parent
		}
	}
	return "", false
}

// pkgJSONName reads only the "name" field of one package.json, capped at
// pkgJSONCap; an oversized or unparsable file yields no name.
func pkgJSONName(path string) (string, bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, pkgJSONCap))
	if err != nil {
		return "", false
	}
	var pkg struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		return "", false
	}
	if name := sanitizeName(pkg.Name); name != "" {
		return name, true
	}
	return "", false
}

// nodeScriptDir narrowly derives the script directory from argv — allowed
// ONLY for the allowlisted Node runtimes above. Raw argv never leaves this
// function: the first token that looks like a JS/TS entry file is reduced
// to its directory (absolute, or resolved against cwd) and used solely as
// a bounded package.json starting point. Flags and eval code are skipped.
func nodeScriptDir(root string, pid int, cwd string) string {
	raw, err := os.ReadFile(filepath.Join(root, strconv.Itoa(pid), "cmdline"))
	if err != nil || len(raw) == 0 || len(raw) > cmdlineCap {
		return ""
	}
	toks := strings.Split(string(raw), "\x00")
	for i := 1; i < len(toks); i++ { // argv0 is the interpreter itself
		t := toks[i]
		if t == "" || t[0] == '-' || !jsEntry(t) {
			continue
		}
		dir := filepath.Dir(t)
		switch {
		case dir == ".":
			if cwd == "" {
				continue
			}
			return cwd
		case filepath.IsAbs(dir):
			return dir
		default: // relative script dir: only meaningful with a known cwd
			if cwd == "" {
				continue
			}
			return filepath.Join(cwd, dir)
		}
	}
	return ""
}

// jsEntry reports whether an argv token looks like a JS/TS entry file.
var jsEntrySuffixes = []string{".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx"}

func jsEntry(tok string) bool {
	for _, s := range jsEntrySuffixes {
		if strings.HasSuffix(tok, s) {
			return true
		}
	}
	return false
}

// readCwd returns /proc/<pid>/cwd (local only; the path itself is never
// transmitted). Empty on any error.
func readCwd(root string, pid int) string {
	target, err := os.Readlink(filepath.Join(root, strconv.Itoa(pid), "cwd"))
	if err != nil {
		return ""
	}
	target = strings.TrimSuffix(target, " (deleted)")
	if target == "" || len(target) > maxCwdLen {
		return ""
	}
	return target
}

// readCgroup returns /proc/<pid>/cgroup, capped at cgroupCap (local only).
// The local substitute for a D-Bus unit query: no dependency, no socket.
func readCgroup(root string, pid int) string {
	f, err := os.Open(filepath.Join(root, strconv.Itoa(pid), "cgroup"))
	if err != nil {
		return ""
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, cgroupCap))
	if err != nil {
		return ""
	}
	return string(raw)
}

// systemdUnit extracts a systemd unit name from cgroup metadata — the
// local alternative to a D-Bus query (no dependency, no socket, no exec).
// Containerized processes are never reported as units (their scope is
// container metadata, not an app name); "" when nothing readable exists.
func systemdUnit(cgroup string) string {
	if containerCgroup(cgroup) {
		return ""
	}
	for _, line := range strings.Split(cgroup, "\n") {
		i := strings.LastIndexByte(line, ':')
		if i < 0 || i+1 >= len(line) {
			continue
		}
		path := line[i+1:]
		if path == "" || path == "/" {
			continue
		}
		base := path[strings.LastIndexByte(path, '/')+1:]
		dot := strings.LastIndexByte(base, '.')
		if dot <= 0 {
			continue
		}
		switch base[dot+1:] {
		case "service", "socket", "target", "timer", "mount":
		default: // scopes/slices are containers, sessions or groups — not names
			continue
		}
		if name := sanitizeName(base); name != "" {
			return name
		}
	}
	return ""
}

// containerCgroup reports whether cgroup metadata places the process in a
// container runtime scope/path. It exists so a container id is never
// mistaken for a systemd unit — no Docker socket, no root grants and no
// exec are involved anywhere in this path.
func containerCgroup(cgroup string) bool {
	for _, line := range strings.Split(cgroup, "\n") {
		i := strings.LastIndexByte(line, ':')
		if i < 0 {
			continue
		}
		p := line[i+1:]
		switch {
		case strings.Contains(p, "/docker/"), strings.Contains(p, "kubepods"),
			strings.Contains(p, "/lxc/"), strings.Contains(p, "cri-containerd"),
			strings.Contains(p, "libpod-"), strings.Contains(p, "podman-"),
			strings.Contains(p, "crio-"), strings.Contains(p, "containerd-"):
			return true
		case strings.Contains(p, "docker-") && strings.HasSuffix(p, ".scope"):
			return true
		}
	}
	return false
}

// containerLabel extracts a readable container name token from cgroup
// metadata (e.g. docker-<name>.scope from a custom cgroup parent). Bare
// container ids (12/64-hex) yield "" — with no Docker socket there is no
// name to claim, and the caller keeps the honest port label.
func containerLabel(cgroup string) string {
	for _, line := range strings.Split(cgroup, "\n") {
		i := strings.LastIndexByte(line, ':')
		if i < 0 {
			continue
		}
		p := line[i+1:]
		if !strings.HasSuffix(p, ".scope") {
			continue // pod/kube/container paths carry ids, never names
		}
		base := p[strings.LastIndexByte(p, '/')+1:]
		base = strings.TrimSuffix(base, ".scope")
		for _, pre := range []string{"docker-", "libpod-", "podman-", "crio-", "cri-containerd-", "containerd-", "machine-"} {
			base = strings.TrimPrefix(base, pre)
		}
		if base == "" || isHexToken(base) {
			continue
		}
		if name := sanitizeName(base); name != "" {
			return name
		}
	}
	return ""
}

// isHexToken reports the bare-container-id shape (all hex, long enough to
// be an id rather than a human name).
func isHexToken(s string) bool {
	if len(s) < 6 {
		return false
	}
	for _, r := range s {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return false
		}
	}
	return true
}

// fingerprintJellyfin performs the single allowed loopback identification
// fetch: GET http://127.0.0.1:8096/System/Info/Public with a capped body,
// no proxy, no redirects, no auth, no logging of the body. It reports only
// whether ProductName identifies Jellyfin. Any failure keeps the proc-based
// classification (never an error).
func fingerprintJellyfin(timeout time.Duration) bool {
	if timeout <= 0 || timeout > 10*time.Second {
		timeout = 3 * time.Second
	}
	tr := &http.Transport{Proxy: nil}
	cli := &http.Client{
		Transport: tr,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Timeout: timeout,
	}
	req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d%s", jellyfinPort, fingerprintPath), nil)
	if err != nil {
		return false
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "windup-monitor-agent/discover")
	resp, err := cli.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return false
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, fingerprintBodyCap))
	if err != nil {
		return false
	}
	var v struct {
		ProductName string `json:"ProductName"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return false
	}
	return strings.Contains(v.ProductName, "Jellyfin")
}
