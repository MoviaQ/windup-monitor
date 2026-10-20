// Package collect samples host metrics from Linux /proc and statfs.
//
// Only the standard library is used. All /proc paths are rooted at
// Collector.ProcRoot (default "/proc") so parsers are unit-testable with
// fixture trees. No cgo, no external commands.
package collect

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"windup-monitor/agent/internal/protocol"
)

// DiskFSTypes is the allowlist of persistent-disk filesystem types reported
// in metrics.disk. Pseudo filesystems (proc, sysfs, cgroup*, ...) and
// volatile tmpfs are excluded by design (see agent/CONTRACT.md).
var DiskFSTypes = map[string]bool{
	"ext2": true, "ext3": true, "ext4": true,
	"xfs": true, "btrfs": true, "zfs": true, "f2fs": true,
	"vfat": true, "exfat": true, "ntfs": true, "ntfs3": true,
}

// skipMountPrefixes are container/snap backing mounts that would spam the
// disk list with duplicates of the same storage.
var skipMountPrefixes = []string{
	"/snap",
	"/var/lib/docker",
	"/var/lib/kubelet",
	"/run/containers",
	"/run/docker",
}

// Collector keeps previous counter snapshots needed for rate computation.
type Collector struct {
	ProcRoot string

	mu      sync.Mutex
	prevCPU *cpuCounters
	prevNet *netCounters
	prevAt  time.Time
}

// New returns a Collector rooted at procRoot ("/proc" in production).
func New(procRoot string) *Collector {
	if procRoot == "" {
		procRoot = "/proc"
	}
	return &Collector{ProcRoot: procRoot}
}

func (c *Collector) path(p string) string { return filepath.Join(c.ProcRoot, p) }

// Warmup takes a baseline reading (two samples ~500ms apart) so the first
// Sample() already carries a real CPU delta instead of a fake 0%.
func (c *Collector) Warmup() error {
	cpu1, net1, err := c.readCounters()
	if err != nil {
		return err
	}
	time.Sleep(500 * time.Millisecond)
	cpu2, net2, err := c.readCounters()
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.prevCPU = &cpuCounters{idle: cpu2.idle, total: cpu2.total}
	c.prevNet = &netCounters{rx: net2.rx, tx: net2.tx}
	c.prevAt = time.Now()
	_ = cpu1
	_ = net1
	return nil
}

func (c *Collector) readCounters() (cpuCounters, netCounters, error) {
	cpu, err := ParseCPUStatFile(c.path("stat"))
	if err != nil {
		return cpuCounters{}, netCounters{}, err
	}
	rx, tx, err := ParseNetDevFile(c.path("net/dev"))
	if err != nil {
		return cpuCounters{}, netCounters{}, err
	}
	return cpu, netCounters{rx: rx, tx: tx}, nil
}

// Sample collects one Metrics snapshot. observedAt is returned alongside so
// the caller stamps observed_at from the same instant.
func (c *Collector) Sample() (protocol.Metrics, time.Time, error) {
	now := time.Now().UTC()

	cpuRaw, err := ParseCPUStatFile(c.path("stat"))
	if err != nil {
		return protocol.Metrics{}, now, fmt.Errorf("cpu: %w", err)
	}
	load1, err := ParseLoadAvgFile(c.path("loadavg"))
	if err != nil {
		return protocol.Metrics{}, now, fmt.Errorf("loadavg: %w", err)
	}
	memTotal, memUsed, memAvail, err := ParseMemInfoFile(c.path("meminfo"))
	if err != nil {
		return protocol.Metrics{}, now, fmt.Errorf("mem: %w", err)
	}
	rx, tx, err := ParseNetDevFile(c.path("net/dev"))
	if err != nil {
		return protocol.Metrics{}, now, fmt.Errorf("net: %w", err)
	}
	uptime, err := ParseUptimeFile(c.path("uptime"))
	if err != nil {
		return protocol.Metrics{}, now, fmt.Errorf("uptime: %w", err)
	}
	disks, err := c.sampleDisks()
	if err != nil {
		return protocol.Metrics{}, now, fmt.Errorf("disk: %w", err)
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	var usage, rxBps, txBps float64
	if c.prevCPU != nil {
		usage = CPUUsage(*c.prevCPU, cpuRaw)
	}
	if c.prevNet != nil && !c.prevAt.IsZero() {
		dt := now.Sub(c.prevAt).Seconds()
		if dt > 0.1 {
			if rx >= c.prevNet.rx {
				rxBps = float64(rx-c.prevNet.rx) / dt
			}
			if tx >= c.prevNet.tx {
				txBps = float64(tx-c.prevNet.tx) / dt
			}
		}
	}
	c.prevCPU = &cpuCounters{idle: cpuRaw.idle, total: cpuRaw.total}
	c.prevNet = &netCounters{rx: rx, tx: tx}
	c.prevAt = now

	return protocol.Metrics{
		CPU:     protocol.CPU{UsagePct: usage, Load1: load1},
		Mem:     protocol.Mem{TotalB: memTotal, UsedB: memUsed, AvailB: memAvail},
		Disk:    disks,
		Net:     protocol.Net{RxB: rx, TxB: tx, RxBps: rxBps, TxBps: txBps},
		UptimeS: uptime,
	}, now, nil
}

func (c *Collector) sampleDisks() ([]protocol.Disk, error) {
	f, err := os.Open(c.path("mounts"))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	mounts, err := SelectMounts(f)
	if err != nil {
		return nil, err
	}
	out := make([]protocol.Disk, 0, len(mounts))
	for _, mp := range mounts {
		var st syscall.Statfs_t
		if err := syscall.Statfs(mp, &st); err != nil {
			continue // transient (unmounted between read and stat); skip
		}
		bs := uint64(st.Bsize)
		total := st.Blocks * bs
		free := st.Bfree * bs
		avail := st.Bavail * bs
		var used uint64
		if total > free {
			used = total - free
		}
		out = append(out, protocol.Disk{
			Mount: mp, TotalB: total, UsedB: used, AvailB: avail,
		})
	}
	return out, nil
}

// cpuCounters is the parsed "cpu" aggregate line.
type cpuCounters struct{ idle, total uint64 }

// ParseCPUStatFile reads the aggregate "cpu" line from a stat-like file.
func ParseCPUStatFile(path string) (cpuCounters, error) {
	f, err := os.Open(path)
	if err != nil {
		return cpuCounters{}, err
	}
	defer f.Close()
	return ParseCPUStat(f)
}

// ParseCPUStat parses the aggregate "cpu" line: idle = idle+iowait,
// total = sum of the first 8 fields.
func ParseCPUStat(r io.Reader) (cpuCounters, error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 64*1024)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)[1:]
		if len(fields) < 4 {
			return cpuCounters{}, fmt.Errorf("short cpu line: %q", line)
		}
		nums := make([]uint64, 0, len(fields))
		for i, f := range fields {
			if i >= 8 {
				break
			}
			n, err := strconv.ParseUint(f, 10, 64)
			if err != nil {
				return cpuCounters{}, fmt.Errorf("bad cpu field %q: %w", f, err)
			}
			nums = append(nums, n)
		}
		var total uint64
		for _, n := range nums {
			total += n
		}
		idle := nums[3]
		if len(nums) > 4 {
			idle += nums[4]
		}
		return cpuCounters{idle: idle, total: total}, nil
	}
	if err := sc.Err(); err != nil {
		return cpuCounters{}, err
	}
	return cpuCounters{}, fmt.Errorf("no aggregate cpu line found")
}

// CPUUsage returns 100*(1-idleDelta/totalDelta), clamped to [0,100].
func CPUUsage(prev, cur cpuCounters) float64 {
	if cur.total <= prev.total {
		return 0
	}
	totalD := cur.total - prev.total
	idleD := 0.0
	if cur.idle >= prev.idle {
		idleD = float64(cur.idle - prev.idle)
	}
	u := 100.0 * (1.0 - idleD/float64(totalD))
	if u < 0 {
		return 0
	}
	if u > 100 {
		return 100
	}
	return u
}

// ParseLoadAvgFile reads the 1-minute load average.
func ParseLoadAvgFile(path string) (float64, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	return ParseLoadAvg(f)
}

// ParseLoadAvg parses /proc/loadavg (first field).
func ParseLoadAvg(r io.Reader) (float64, error) {
	raw, err := io.ReadAll(io.LimitReader(r, 4096))
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(string(raw))
	if len(fields) < 1 {
		return 0, fmt.Errorf("empty loadavg")
	}
	v, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, fmt.Errorf("bad loadavg %q: %w", fields[0], err)
	}
	return v, nil
}

// ParseMemInfoFile reads MemTotal/MemAvailable (kB) and returns bytes.
func ParseMemInfoFile(path string) (total, used, avail uint64, err error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, 0, err
	}
	defer f.Close()
	return ParseMemInfo(f)
}

// ParseMemInfo parses /proc/meminfo. used = total - available. On kernels
// without MemAvailable it falls back to free+buffers+cached.
func ParseMemInfo(r io.Reader) (total, used, avail uint64, err error) {
	vals := map[string]uint64{}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 64*1024)
	for sc.Scan() {
		parts := strings.Fields(sc.Text())
		if len(parts) < 2 {
			continue
		}
		key := strings.TrimSuffix(parts[0], ":")
		n, perr := strconv.ParseUint(parts[1], 10, 64)
		if perr != nil {
			continue
		}
		vals[key] = n * 1024 // meminfo is in kB
	}
	if err := sc.Err(); err != nil {
		return 0, 0, 0, err
	}
	var ok bool
	if total, ok = vals["MemTotal"]; !ok || total == 0 {
		return 0, 0, 0, fmt.Errorf("MemTotal missing")
	}
	if avail, ok = vals["MemAvailable"]; !ok {
		avail = vals["MemFree"] + vals["Buffers"] + vals["Cached"]
	}
	if avail > total {
		avail = total
	}
	return total, total - avail, avail, nil
}

// netCounters is the summed byte counters.
type netCounters struct{ rx, tx uint64 }

// ParseNetDevFile sums rx/tx bytes over all interfaces except lo.
func ParseNetDevFile(path string) (rx, tx uint64, err error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()
	return ParseNetDev(f)
}

// ParseNetDev parses /proc/net/dev. Loopback is excluded (host traffic view);
// all other interfaces (eth, wlan, tunnels, bridges) are summed.
func ParseNetDev(r io.Reader) (rx, tx uint64, err error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 256*1024), 256*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		colon := strings.IndexByte(line, ':')
		if colon < 0 {
			continue // header lines
		}
		iface := strings.TrimSpace(line[:colon])
		if iface == "" || iface == "lo" || strings.ContainsAny(iface, " .") {
			if iface == "lo" {
				continue
			}
			if strings.ContainsAny(iface, " .") {
				continue // header residue
			}
		}
		fields := strings.Fields(line[colon+1:])
		if len(fields) < 9 {
			continue
		}
		rb, e1 := strconv.ParseUint(fields[0], 10, 64)
		tb, e2 := strconv.ParseUint(fields[8], 10, 64)
		if e1 != nil || e2 != nil {
			continue
		}
		rx += rb
		tx += tb
	}
	return rx, tx, sc.Err()
}

// ParseUptimeFile reads /proc/uptime (whole seconds).
func ParseUptimeFile(path string) (uint64, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	return ParseUptime(f)
}

// ParseUptime parses /proc/uptime (first field, truncated to seconds).
func ParseUptime(r io.Reader) (uint64, error) {
	raw, err := io.ReadAll(io.LimitReader(r, 4096))
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(string(raw))
	if len(fields) < 1 {
		return 0, fmt.Errorf("empty uptime")
	}
	v, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || v < 0 {
		return 0, fmt.Errorf("bad uptime %q", fields[0])
	}
	return uint64(v), nil
}

// SelectMounts picks mountpoints to report: "/" always first, then every
// /proc/mounts entry with an allowlisted persistent fs type, minus denylisted
// container/snap prefixes, deduplicated.
func SelectMounts(r io.Reader) ([]string, error) {
	seen := map[string]bool{"/": true}
	out := []string{"/"}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 256*1024), 256*1024)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 3 {
			continue
		}
		mp, fstype := fields[1], fields[2]
		if !DiskFSTypes[fstype] || seen[mp] {
			continue
		}
		skip := false
		for _, p := range skipMountPrefixes {
			if mp == p || strings.HasPrefix(mp, p+"/") {
				skip = true
				break
			}
		}
		if skip {
			continue
		}
		seen[mp] = true
		out = append(out, mp)
	}
	return out, sc.Err()
}
