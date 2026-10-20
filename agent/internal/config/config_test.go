package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestValidateCoreURL(t *testing.T) {
	cases := []struct {
		url   string
		insec bool
		ok    bool
	}{
		{"https://core:8080", false, true},
		{"https://core:8080/", false, true},
		{"http://core:8080", false, false},       // plain HTTP without opt-in
		{"http://example.com", true, false},      // opt-in but not loopback
		{"http://127.0.0.1:8080", true, true},    // loopback dev
		{"http://localhost:8080", true, true},    // loopback dev
		{"http://[::1]:8080", true, true},        // loopback dev
		{"http://127.0.0.5:8080", true, true},    // 127/8
		{"http://192.168.1.2:8080", true, false}, // LAN is not loopback
		{"ftp://core/x", false, false},           // wrong scheme
		{"::not-a-url::", false, false},
	}
	for _, c := range cases {
		if err := ValidateCoreURL(c.url, c.insec); (err == nil) != c.ok {
			t.Errorf("ValidateCoreURL(%q, %v) err=%v want ok=%v", c.url, c.insec, err, c.ok)
		}
	}
}

func TestPrecedenceFlagOverEnvOverFile(t *testing.T) {
	fp := filepath.Join(t.TempDir(), "cfg.json")
	if err := os.WriteFile(fp, []byte(`{"core_url":"https://file:8080","interval_s":30,"state_dir":"/tmp/ignored"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WINDUP_MONITOR_CORE_URL", "https://env:8080")
	t.Setenv("WINDUP_MONITOR_INTERVAL_S", "45")

	c := New()
	c.ConfigFile = fp
	c.MarkSet("interval-s")
	c.Interval = 99 * time.Second // CLI flag wins over env and file
	if err := c.Resolve(); err != nil {
		t.Fatal(err)
	}
	if c.CoreURL != "https://env:8080" {
		t.Fatalf("env must win over file: %s", c.CoreURL)
	}
	if c.Interval != 99*time.Second {
		t.Fatalf("flag must win over env: %s", c.Interval)
	}
}

func TestFileAlone(t *testing.T) {
	fp := filepath.Join(t.TempDir(), "cfg.json")
	if err := os.WriteFile(fp, []byte(`{"core_url":"https://file:8080","allow_insecure_http":false}`), 0o600); err != nil {
		t.Fatal(err)
	}
	c := New()
	c.ConfigFile = fp
	c.StateDir = "/tmp/custom"
	if err := c.Resolve(); err != nil {
		t.Fatal(err)
	}
	if c.CoreURL != "https://file:8080" {
		t.Fatalf("got %s", c.CoreURL)
	}
	if c.StateDir != "/tmp/custom" {
		t.Fatalf("CLI-set value must not be overwritten by file default: %s", c.StateDir)
	}
}

func TestSafeStringHidesNothingSensitive(t *testing.T) {
	c := New()
	c.CoreURL = "https://core:8080"
	c.EnrollToken = "TOPSECRET"
	s := c.SafeString()
	for _, leak := range []string{"TOPSECRET", "enroll"} {
		if strings.Contains(s, leak) {
			t.Fatalf("SafeString leaks %q: %s", leak, s)
		}
	}
}
