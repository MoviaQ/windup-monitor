package agent

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"windup-monitor/agent/internal/protocol"
)

const (
	// processSampleInterval is the minimum spacing of /proc/<pid> reads.
	// Heartbeats may be faster; between samples the last real observation is
	// reused (with its own observed_at) instead of inventing a new one.
	processSampleInterval = 15 * time.Second
	// maxProcessMetrics matches the wire bound (<=64 entries).
	maxProcessMetrics = 64
	// processClockTick is Linux CLK_TCK, identical to discovery.
	processClockTick = 100
)

// processSample is the per-candidate baseline used for one CPU delta. The
// raw starttime ticks (not the truncated ISO timestamp) detect pid reuse.
type processSample struct {
	pid    int
	start  uint64
	ticks  uint64
	at     time.Time
	usable bool
}

// processSampler reads CPU/RSS for a small bounded set of proven owner pids.
// It keeps no pid on the wire: callers attach only candidate_id and the
// discovery-provided process_started_at to the heartbeat block.
type processSampler struct {
	procRoot    string
	pageSize    uint64
	minInterval time.Duration
	mu          sync.Mutex
	states      map[string]processSample
	lastAt      time.Time
	lastKey     string
	last        []protocol.ServiceProcessMetric
}

func newProcessSampler(procRoot string) *processSampler {
	if procRoot == "" {
		procRoot = "/proc"
	}
	page := os.Getpagesize()
	if page <= 0 {
		page = 4096
	}
	return &processSampler{
		procRoot:    procRoot,
		pageSize:    uint64(page),
		minInterval: processSampleInterval,
		states:      map[string]processSample{},
	}
}

type procStatSample struct {
	ticks  uint64
	start  uint64
	rss    uint64
	hasRSS bool
}

func (s *processSampler) path(pid int, name string) string {
	return filepath.Join(s.procRoot, strconv.Itoa(pid), name)
}

// readStat parses utime/stime (fields 14/15), starttime (22) and rss (24)
// from /proc/<pid>/stat. comm may contain spaces/parens, so parsing starts
// after the last ')'.
func (s *processSampler) readStat(pid int) (procStatSample, bool) {
	raw, err := os.ReadFile(s.path(pid, "stat"))
	if err != nil {
		return procStatSample{}, false
	}
	text := string(raw)
	i := strings.LastIndexByte(text, ')')
	if i < 0 {
		return procStatSample{}, false
	}
	fields := strings.Fields(text[i+1:])
	// fields[0] = state (field 3). utime = field 14 -> index 11,
	// stime = 15 -> index 12, starttime = 22 -> index 19,
	// rss = 24 -> index 21.
	if len(fields) < 22 {
		return procStatSample{}, false
	}
	utime, err1 := strconv.ParseUint(fields[11], 10, 64)
	stime, err2 := strconv.ParseUint(fields[12], 10, 64)
	start, err3 := strconv.ParseUint(fields[19], 10, 64)
	if err1 != nil || err2 != nil || err3 != nil {
		return procStatSample{}, false
	}
	out := procStatSample{ticks: utime + stime, start: start}
	if rss, err := strconv.ParseUint(fields[21], 10, 64); err == nil {
		out.rss = rss
		out.hasRSS = true
	}
	return out, true
}

// readStatusRSS reads VmRSS from /proc/<pid>/status. The file is usually
// world-readable even for root-owned services (Jellyfin); on any error the
// caller falls back to stat's rss pages.
func (s *processSampler) readStatusRSS(pid int) (uint64, bool) {
	raw, err := os.ReadFile(s.path(pid, "status"))
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if !strings.HasPrefix(line, "VmRSS:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return 0, false
		}
		kb, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return 0, false
		}
		return kb * 1024, true
	}
	return 0, false
}

func cloneMetrics(in []protocol.ServiceProcessMetric) []protocol.ServiceProcessMetric {
	if len(in) == 0 {
		return nil
	}
	out := make([]protocol.ServiceProcessMetric, len(in))
	copy(out, in)
	for i := range out {
		if in[i].CPUPercent != nil {
			v := *in[i].CPUPercent
			out[i].CPUPercent = &v
		}
		if in[i].MemoryRSSBytes != nil {
			v := *in[i].MemoryRSSBytes
			out[i].MemoryRSSBytes = &v
		}
	}
	return out
}

// Sample returns bounded per-process observations for candidates with a
// locally proven pid and discovery start time — kind is irrelevant: a
// generic (kind=unknown) service with an exact single fd-proven owner must
// not lose CPU/RSS for lacking a brand claim. first CPU sample is null;
// RSS is measured immediately. All failures degrade to null per metric and
// never fail the heartbeat.
func (s *processSampler) Sample(cands []protocol.ServiceCandidate, now time.Time) []protocol.ServiceProcessMetric {
	now = now.UTC()
	targets := make([]protocol.ServiceCandidate, 0, maxProcessMetrics)
	for _, c := range cands {
		// PID>0 + starttime is set by discovery only for one unambiguous
		// fd-proven owner (never a proxy/heuristic match). Ambiguous
		// multi-pid holders and ports with no attributable process stay
		// out of the target set — their metrics stay null, never guessed.
		if c.PID <= 0 || c.ProcessStartedAt == nil {
			continue
		}
		targets = append(targets, c)
		if len(targets) >= maxProcessMetrics {
			break
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	keyParts := make([]string, 0, len(targets))
	for _, c := range targets {
		keyParts = append(keyParts, c.CandidateID+"|"+strconv.Itoa(c.PID)+"|"+*c.ProcessStartedAt)
	}
	key := strings.Join(keyParts, ",")
	// Minimal sampler: at most one /proc pass per 15 s while the candidate
	// set is unchanged. The reused block keeps the observed_at of the real
	// sample, so Core can still age it out honestly.
	if s.minInterval > 0 && s.lastKey == key && len(s.last) > 0 && now.Sub(s.lastAt) < s.minInterval {
		return cloneMetrics(s.last)
	}

	live := map[string]bool{}
	out := make([]protocol.ServiceProcessMetric, 0, len(targets))
	for _, c := range targets {
		live[c.CandidateID] = true
		observed := now.Format(time.RFC3339)
		metric := protocol.ServiceProcessMetric{
			CandidateID:      c.CandidateID,
			ProcessStartedAt: *c.ProcessStartedAt,
			ObservedAt:       observed,
		}

		stat, statOK := s.readStat(c.PID)
		if statOK {
			prev, seen := s.states[c.CandidateID]
			// A different pid/starttime is a different process: never carry
			// a delta across pid reuse.
			if seen && prev.usable && prev.pid == c.PID && prev.start == stat.start {
				elapsed := now.Sub(prev.at).Seconds()
				if elapsed > 0 && stat.ticks >= prev.ticks {
					cpu := float64(stat.ticks-prev.ticks) / processClockTick / elapsed * 100
					if cpu >= 0 {
						metric.CPUPercent = &cpu
					}
				}
			}
			if rss, ok := s.readStatusRSS(c.PID); ok {
				metric.MemoryRSSBytes = &rss
			} else if stat.hasRSS {
				rss := stat.rss * s.pageSize
				metric.MemoryRSSBytes = &rss
			}
			s.states[c.CandidateID] = processSample{
				pid: c.PID, start: stat.start, ticks: stat.ticks, at: now, usable: true,
			}
		} else {
			// Unreadable stat: no trustworthy starttime, so CPU stays null
			// and the baseline is cleared instead of being reused later.
			delete(s.states, c.CandidateID)
			if rss, ok := s.readStatusRSS(c.PID); ok {
				metric.MemoryRSSBytes = &rss
			}
		}
		out = append(out, metric)
	}
	for id := range s.states {
		if !live[id] {
			delete(s.states, id)
		}
	}
	if len(out) == 0 {
		s.last = nil
		s.lastKey = key
		s.lastAt = now
		return nil
	}
	s.last = out
	s.lastKey = key
	s.lastAt = now
	return cloneMetrics(out)
}
