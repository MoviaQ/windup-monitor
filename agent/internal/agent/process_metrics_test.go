package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"windup-monitor/agent/internal/protocol"
)

func writeProcStat(t *testing.T, root string, pid int, comm string, utime, stime, start, rss uint64) {
	t.Helper()
	dir := filepath.Join(root, strconv.Itoa(pid))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	fields := make([]string, 25)
	for i := range fields {
		fields[i] = "0"
	}
	fields[0] = "S"
	fields[11] = strconv.FormatUint(utime, 10)
	fields[12] = strconv.FormatUint(stime, 10)
	fields[19] = strconv.FormatUint(start, 10)
	fields[21] = strconv.FormatUint(rss, 10)
	stat := fmt.Sprintf("%d (%s) %s\n", pid, comm, joinFields(fields))
	if err := os.WriteFile(filepath.Join(dir, "stat"), []byte(stat), 0o644); err != nil {
		t.Fatal(err)
	}
}

func joinFields(fields []string) string {
	out := ""
	for i, f := range fields {
		if i > 0 {
			out += " "
		}
		out += f
	}
	return out
}

func writeProcStatus(t *testing.T, root string, pid int, vmRSSkB string) {
	t.Helper()
	dir := filepath.Join(root, strconv.Itoa(pid))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "status"), []byte("Name:\ttest\nVmRSS:\t"+vmRSSkB+" kB\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func procCandidate(id string, pid int, started string) protocol.ServiceCandidate {
	return protocol.ServiceCandidate{
		CandidateID: id, Kind: protocol.ServiceKindT3Code, PID: pid, ProcessStartedAt: &started,
	}
}

func TestProcessSamplerFirstNullThenDeltaByElapsed(t *testing.T) {
	root := t.TempDir()
	started := "2026-10-19T09:00:00Z"
	writeProcStat(t, root, 42, "t3", 100, 50, 7000, 12)
	writeProcStatus(t, root, 42, "1234")
	s := newProcessSampler(root)
	s.minInterval = 0 // exercise real elapsed, not the production 15 s cache

	first := s.Sample([]protocol.ServiceCandidate{procCandidate("t3-code-3773", 42, started)},
		time.Date(2026, 10, 19, 9, 0, 0, 0, time.UTC))
	if len(first) != 1 {
		t.Fatalf("metrics=%+v", first)
	}
	if first[0].CPUPercent != nil {
		t.Fatalf("first CPU must be null, got %v", *first[0].CPUPercent)
	}
	if first[0].MemoryRSSBytes == nil || *first[0].MemoryRSSBytes != 1234*1024 {
		t.Fatalf("VmRSS units: %+v", first[0].MemoryRSSBytes)
	}

	// 50 additional ticks over 2.5 s = 50/100/2.5*100 = 20% of one core.
	writeProcStat(t, root, 42, "t3", 125, 75, 7000, 12)
	second := s.Sample([]protocol.ServiceCandidate{procCandidate("t3-code-3773", 42, started)},
		time.Date(2026, 10, 19, 9, 0, 2, 500_000_000, time.UTC))
	if second[0].CPUPercent == nil {
		t.Fatalf("second CPU must be measured: %+v", second[0])
	}
	if got := *second[0].CPUPercent; got < 19.99 || got > 20.01 {
		t.Fatalf("CPU=%v want 20 (elapsed from actual sample)", got)
	}
}

func TestProcessSamplerPIDReuseResetsDelta(t *testing.T) {
	root := t.TempDir()
	started := "2026-10-19T09:00:00Z"
	writeProcStat(t, root, 42, "t3", 100, 0, 7000, 10)
	writeProcStatus(t, root, 42, "100")
	s := newProcessSampler(root)
	at := time.Date(2026, 10, 19, 9, 0, 0, 0, time.UTC)
	s.Sample([]protocol.ServiceCandidate{procCandidate("t3-code-3773", 42, started)}, at)

	// Same pid, new starttime and much larger counters: must not inherit the
	// old baseline (would look like a huge CPU spike).
	writeProcStat(t, root, 42, "t3", 900, 0, 9000, 20)
	got := s.Sample([]protocol.ServiceCandidate{procCandidate("t3-code-3773", 42, started)}, at.Add(15*time.Second))
	if got[0].CPUPercent != nil {
		t.Fatalf("pid reuse must reset CPU to null, got %v", *got[0].CPUPercent)
	}
	if got[0].MemoryRSSBytes == nil || *got[0].MemoryRSSBytes != 100*1024 {
		t.Fatalf("RSS must be measured on reset: %+v", got[0])
	}
}

func TestProcessSamplerMemoryFallbackAndPermissions(t *testing.T) {
	root := t.TempDir()
	started := "2026-10-19T09:00:00Z"
	writeProcStat(t, root, 50, "t3", 10, 0, 100, 7)
	s := newProcessSampler(root)
	s.pageSize = 4096 // deterministic fallback unit
	got := s.Sample([]protocol.ServiceCandidate{procCandidate("t3-code-3773", 50, started)}, time.Now().UTC())
	if got[0].MemoryRSSBytes == nil || *got[0].MemoryRSSBytes != 7*4096 {
		t.Fatalf("stat rss pages fallback: %+v", got[0].MemoryRSSBytes)
	}

	// No files at all (denied/gone): both values null, never zero.
	got = s.Sample([]protocol.ServiceCandidate{procCandidate("t3-code-3773", 51, started)}, time.Now().UTC())
	if got[0].CPUPercent != nil || got[0].MemoryRSSBytes != nil {
		t.Fatalf("unreadable process must yield nulls: %+v", got[0])
	}
}

func TestProcessSamplerMultiCoreAbove100AndThrottle(t *testing.T) {
	root := t.TempDir()
	started := "2026-10-19T09:00:00Z"
	writeProcStat(t, root, 60, "t3", 0, 0, 100, 1)
	writeProcStatus(t, root, 60, "64")
	s := newProcessSampler(root)
	s.minInterval = 0
	at := time.Date(2026, 10, 19, 9, 0, 0, 0, time.UTC)
	c := []protocol.ServiceCandidate{procCandidate("t3-code-3773", 60, started)}
	s.Sample(c, at)
	writeProcStat(t, root, 60, "t3", 200, 0, 100, 1)
	got := s.Sample(c, at.Add(time.Second))
	if got[0].CPUPercent == nil || *got[0].CPUPercent < 199.9 || *got[0].CPUPercent > 200.1 {
		t.Fatalf("multi-core CPU must exceed 100: %+v", got[0].CPUPercent)
	}
	// Inside the 15 s window the exact previous observation is reused, not
	// recomputed with a fake shorter elapsed.
	s.minInterval = processSampleInterval
	writeProcStat(t, root, 60, "t3", 300, 0, 100, 1)
	throttled := s.Sample(c, at.Add(2*time.Second))
	if throttled[0].ObservedAt != got[0].ObservedAt || *throttled[0].CPUPercent != *got[0].CPUPercent {
		t.Fatalf("expected cached sample, got %+v vs %+v", throttled[0], got[0])
	}
}

// Generic (kind=unknown) candidates with an exact single fd-proven owner
// must be measured like recognised ones — no brand claim required.
func TestProcessSamplerIncludesGenericProvenPID(t *testing.T) {
	root := t.TempDir()
	started := "2026-10-19T09:00:00Z"
	writeProcStat(t, root, 70, "myapp", 100, 0, 7000, 12)
	writeProcStatus(t, root, 70, "2048")
	s := newProcessSampler(root)
	s.minInterval = 0 // exercise real elapsed, not the production 15 s cache
	generic := func() []protocol.ServiceCandidate {
		c := procCandidate("generic-9443", 70, started)
		c.Kind = protocol.ServiceKindUnknown
		return []protocol.ServiceCandidate{c}
	}

	first := s.Sample(generic(), time.Date(2026, 10, 19, 9, 0, 0, 0, time.UTC))
	if len(first) != 1 {
		t.Fatalf("generic proven-pid candidate must be sampled: %+v", first)
	}
	if first[0].CPUPercent != nil {
		t.Fatalf("first generic CPU must be null: %+v", first[0])
	}
	if first[0].MemoryRSSBytes == nil || *first[0].MemoryRSSBytes != 2048*1024 {
		t.Fatalf("generic RSS must be measured: %+v", first[0])
	}

	// 50 ticks over 1 s = 50% of one core — delta validation applies to
	// generic candidates exactly like to recognised ones.
	writeProcStat(t, root, 70, "myapp", 150, 0, 7000, 12)
	second := s.Sample(generic(), time.Date(2026, 10, 19, 9, 0, 1, 0, time.UTC))
	if second[0].CPUPercent == nil {
		t.Fatalf("generic CPU delta must be computed: %+v", second[0])
	}
	if got := *second[0].CPUPercent; got < 49.9 || got > 50.1 {
		t.Fatalf("CPU=%v want 50", got)
	}

	// PID reuse guard is unchanged for generic too: a new starttime on the
	// same pid must reset the delta instead of spiking.
	writeProcStat(t, root, 70, "myapp", 900, 0, 9001, 12)
	reused := s.Sample(generic(), time.Date(2026, 10, 19, 9, 0, 2, 0, time.UTC))
	if reused[0].CPUPercent != nil {
		t.Fatalf("pid reuse must reset generic CPU to null: %+v", reused[0])
	}
}

// Ambiguous (multi-pid) owners and ports with no attributable process
// never reach the sampler: no pid/no starttime → no fabricated metrics.
func TestProcessSamplerSkipsGenericWithoutProvenPID(t *testing.T) {
	root := t.TempDir()
	started := "2026-10-19T09:00:00Z"
	s := newProcessSampler(root)
	amb := procCandidate("generic-9600", 0, started) // multiple agreeing workers
	amb.Kind = protocol.ServiceKindUnknown
	noOwner := procCandidate("generic-22", 0, started) // no fd-proven owner
	noOwner.Kind = protocol.ServiceKindUnknown
	noTiming := procCandidate("generic-9700", 71, started) // pid but no proven start
	noTiming.Kind = protocol.ServiceKindUnknown
	noTiming.ProcessStartedAt = nil
	got := s.Sample([]protocol.ServiceCandidate{amb, noOwner, noTiming},
		time.Date(2026, 10, 19, 9, 0, 0, 0, time.UTC))
	if len(got) != 0 {
		t.Fatalf("generic candidates without proven pid+starttime must stay unsampled: %+v", got)
	}
}
