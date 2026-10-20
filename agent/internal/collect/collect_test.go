package collect

import (
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func openFixture(t *testing.T, name string) *os.File {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

func TestParseCPUStat(t *testing.T) {
	c1, err := ParseCPUStat(openFixture(t, "stat1.txt"))
	if err != nil {
		t.Fatal(err)
	}
	// total=1000, idle=850
	if c1.total != 1000 || c1.idle != 850 {
		t.Fatalf("got idle=%d total=%d", c1.idle, c1.total)
	}
	c2, err := ParseCPUStat(openFixture(t, "stat2.txt"))
	if err != nil {
		t.Fatal(err)
	}
	u := CPUUsage(c1, c2)
	want := 100.0 * (1.0 - 750.0/900.0)
	if math.Abs(u-want) > 0.001 {
		t.Fatalf("usage=%f want %f", u, want)
	}
}

func TestCPUUsageGuards(t *testing.T) {
	if u := CPUUsage(cpuCounters{idle: 5, total: 10}, cpuCounters{idle: 5, total: 10}); u != 0 {
		t.Fatalf("zero delta must be 0, got %f", u)
	}
	if u := CPUUsage(cpuCounters{idle: 10, total: 20}, cpuCounters{idle: 5, total: 10}); u != 0 {
		t.Fatalf("rollback must be 0, got %f", u)
	}
}

func TestParseMemInfo(t *testing.T) {
	total, used, avail, err := ParseMemInfo(openFixture(t, "meminfo.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if total != 16384*1024 || avail != 8192*1024 || used != 8192*1024 {
		t.Fatalf("got total=%d used=%d avail=%d", total, used, avail)
	}
}

func TestParseMemInfoFallback(t *testing.T) {
	total, used, avail, err := ParseMemInfo(openFixture(t, "meminfo-noavail.txt"))
	if err != nil {
		t.Fatal(err)
	}
	// avail = free+buffers+cached = (4096+1024+2048)*1024
	if avail != (4096+1024+2048)*1024 {
		t.Fatalf("fallback avail=%d", avail)
	}
	if used != total-avail {
		t.Fatalf("used=%d want total-avail", used)
	}
}

func TestParseNetDev(t *testing.T) {
	rx, tx, err := ParseNetDev(openFixture(t, "netdev.txt"))
	if err != nil {
		t.Fatal(err)
	}
	// lo excluded: eth0 + wlan0 only.
	if rx != 4000 || tx != 6000 {
		t.Fatalf("got rx=%d tx=%d", rx, tx)
	}
}

func TestParseUptime(t *testing.T) {
	u, err := ParseUptime(openFixture(t, "uptime.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if u != 12345 {
		t.Fatalf("got %d", u)
	}
}

func TestParseLoadAvg(t *testing.T) {
	v, err := ParseLoadAvg(openFixture(t, "loadavg.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if v != 0.75 {
		t.Fatalf("got %f", v)
	}
}

func TestSelectMounts(t *testing.T) {
	mounts, err := SelectMounts(openFixture(t, "mounts.txt"))
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(mounts, ",")
	// "/" first, /data kept; pseudo, tmpfs, /snap/*, docker overlay dropped.
	if len(mounts) != 2 || mounts[0] != "/" || mounts[1] != "/data" {
		t.Fatalf("got %q", joined)
	}
}

func TestSampleIntegration(t *testing.T) {
	root := t.TempDir()
	write := func(name, content string) {
		p := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("stat", "cpu  100 0 50 800 50 0 0 0 0 0\n")
	write("loadavg", "0.75 0.50 0.25 1/100 1234\n")
	write("meminfo", "MemTotal:        16384 kB\nMemAvailable:      8192 kB\n")
	write("net/dev", "Inter-| Receive | Transmit\n face |bytes x|bytes x\n  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n")
	write("uptime", "100.00 200.00\n")
	write("mounts", "proc /proc proc rw 0 0\n")

	col := New(root)
	m, observedAt, err := col.Sample()
	if err != nil {
		t.Fatal(err)
	}
	if observedAt.IsZero() {
		t.Fatal("zero observed_at")
	}
	if m.Mem.TotalB != 16384*1024 || m.Mem.AvailB != 8192*1024 || m.Mem.UsedB != 8192*1024 {
		t.Fatalf("mem: %+v", m.Mem)
	}
	if m.Net.RxB != 1000 || m.Net.TxB != 2000 {
		t.Fatalf("net: %+v", m.Net)
	}
	if m.UptimeS != 100 {
		t.Fatalf("uptime: %d", m.UptimeS)
	}
	if m.CPU.Load1 != 0.75 {
		t.Fatalf("load1: %f", m.CPU.Load1)
	}
	if len(m.Disk) != 1 || m.Disk[0].Mount != "/" {
		t.Fatalf("disk: %+v", m.Disk)
	}
	if m.Disk[0].TotalB == 0 || m.Disk[0].UsedB > m.Disk[0].TotalB {
		t.Fatalf("disk statfs looks wrong: %+v", m.Disk[0])
	}
	// Second sample after a real delta carries non-negative usage.
	m2, _, err := col.Sample()
	if err != nil {
		t.Fatal(err)
	}
	if m2.CPU.UsagePct < 0 || m2.CPU.UsagePct > 100 {
		t.Fatalf("usage out of range: %f", m2.CPU.UsagePct)
	}
	if m2.Mem.UsedB > m2.Mem.TotalB {
		t.Fatalf("mem invariant violated: %+v", m2.Mem)
	}
}
