// Package config loads agent configuration from file, environment and flags.
//
// Precedence (highest first): CLI flags > environment (WINDUP_MONITOR_*)
// > JSON config file > built-in defaults. Secrets (enroll token) are
// preferred via environment, never logged.
//
// Compatibility: the legacy STATUSPILOT_* prefix is still read when the new
// prefix is absent, so existing unit/env files keep working in place.
package config

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultInterval        = 15 * time.Second
	DefaultShutdownTimeout = 10 * time.Second
	DefaultStateDir        = "/var/lib/windup-monitor"
	MinInterval            = 5 * time.Second
	MaxInterval            = time.Hour
	EnvPrefix              = "WINDUP_MONITOR_"
	legacyEnvPrefix        = "STATUSPILOT_"
)

// Config holds all agent settings. No secret is ever printed by String().
type Config struct {
	CoreURL           string
	StateDir          string
	Hostname          string
	Interval          time.Duration
	AllowInsecureHTTP bool
	CAFile            string
	EnrollToken       string
	EnrollTokenStdin  bool
	ShutdownTimeout   time.Duration
	ConfigFile        string
	tokenFromFlag     bool
	setFlags          map[string]bool
}

// fileConfig mirrors the JSON config file (no secrets required, but the
// token field is accepted for fully offline provisioning files kept at 0600).
type fileConfig struct {
	CoreURL           string `json:"core_url"`
	StateDir          string `json:"state_dir"`
	Hostname          string `json:"hostname"`
	IntervalS         *int   `json:"interval_s"`
	AllowInsecureHTTP *bool  `json:"allow_insecure_http"`
	CAFile            string `json:"ca_file"`
	EnrollToken       string `json:"enroll_token"`
	ShutdownTimeoutS  *int   `json:"shutdown_timeout_s"`
}

// New returns defaults (hostname resolved from the OS).
func New() *Config {
	h, _ := os.Hostname()
	return &Config{
		StateDir:        DefaultStateDir,
		Hostname:        h,
		Interval:        DefaultInterval,
		ShutdownTimeout: DefaultShutdownTimeout,
		setFlags:        map[string]bool{},
	}
}

// MarkSet records flags explicitly passed on the CLI (for precedence).
func (c *Config) MarkSet(names ...string) {
	for _, n := range names {
		c.setFlags[n] = true
	}
}

func (c *Config) isSet(n string) bool { return c.setFlags[n] }

// Resolve applies config file then environment over cfg for every option
// the user did not set via flags.
func (c *Config) Resolve() error {
	if c.ConfigFile != "" {
		if err := c.applyFile(c.ConfigFile); err != nil {
			return err
		}
	}
	c.applyEnv()
	if err := c.normalize(); err != nil {
		return err
	}
	return ValidateCoreURL(c.CoreURL, c.AllowInsecureHTTP)
}

func (c *Config) applyFile(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read config file: %w", err)
	}
	var f fileConfig
	if err := json.Unmarshal(raw, &f); err != nil {
		return fmt.Errorf("parse config file: %w", err)
	}
	if f.CoreURL != "" && !c.isSet("core-url") && c.CoreURL == "" {
		c.CoreURL = f.CoreURL
	}
	if f.StateDir != "" && !c.isSet("state-dir") && c.StateDir == DefaultStateDir {
		c.StateDir = f.StateDir
	}
	if f.Hostname != "" && !c.isSet("hostname") {
		c.Hostname = f.Hostname
	}
	if f.IntervalS != nil && !c.isSet("interval-s") {
		c.Interval = time.Duration(*f.IntervalS) * time.Second
	}
	if f.AllowInsecureHTTP != nil && !c.isSet("allow-insecure-http") {
		c.AllowInsecureHTTP = *f.AllowInsecureHTTP
	}
	if f.CAFile != "" && !c.isSet("ca-file") {
		c.CAFile = f.CAFile
	}
	if f.EnrollToken != "" && !c.isSet("enroll-token") && c.EnrollToken == "" {
		c.EnrollToken = f.EnrollToken
	}
	if f.ShutdownTimeoutS != nil && !c.isSet("shutdown-timeout-s") {
		c.ShutdownTimeout = time.Duration(*f.ShutdownTimeoutS) * time.Second
	}
	return nil
}

func getenv(n string) (string, bool) {
	if v, ok := os.LookupEnv(EnvPrefix + n); ok {
		return v, true
	}
	return os.LookupEnv(legacyEnvPrefix + n)
}

func (c *Config) applyEnv() {
	if v, ok := getenv("CORE_URL"); ok && !c.isSet("core-url") {
		c.CoreURL = strings.TrimSpace(v)
	}
	if v, ok := getenv("STATE_DIR"); ok && !c.isSet("state-dir") {
		c.StateDir = strings.TrimSpace(v)
	}
	if v, ok := getenv("HOSTNAME"); ok && !c.isSet("hostname") {
		c.Hostname = strings.TrimSpace(v)
	}
	if v, ok := getenv("INTERVAL_S"); ok && !c.isSet("interval-s") {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			c.Interval = time.Duration(n) * time.Second
		}
	}
	if v, ok := getenv("ALLOW_INSECURE_HTTP"); ok && !c.isSet("allow-insecure-http") {
		c.AllowInsecureHTTP = parseBool(v)
	}
	if v, ok := getenv("CA_FILE"); ok && !c.isSet("ca-file") {
		c.CAFile = strings.TrimSpace(v)
	}
	if v, ok := getenv("ENROLL_TOKEN"); ok && !c.isSet("enroll-token") {
		c.EnrollToken = strings.TrimSpace(v)
	}
	if v, ok := getenv("SHUTDOWN_TIMEOUT_S"); ok && !c.isSet("shutdown-timeout-s") {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			c.ShutdownTimeout = time.Duration(n) * time.Second
		}
	}
}

func parseBool(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func (c *Config) normalize() error {
	c.CoreURL = strings.TrimRight(strings.TrimSpace(c.CoreURL), "/")
	c.Hostname = strings.TrimSpace(c.Hostname)
	if c.Hostname == "" {
		return fmt.Errorf("hostname is empty")
	}
	if c.Interval < MinInterval {
		c.Interval = MinInterval
	}
	if c.Interval > MaxInterval {
		c.Interval = MaxInterval
	}
	if c.ShutdownTimeout <= 0 {
		c.ShutdownTimeout = DefaultShutdownTimeout
	}
	if c.EnrollTokenStdin {
		data, err := readStdinLine()
		if err != nil {
			return err
		}
		c.EnrollToken = data
	}
	return nil
}

// TokenSource reports where the enroll token came from (for warnings).
// It never returns the token itself.
func (c *Config) TokenSource() string {
	_, tokenInEnv := getenv("ENROLL_TOKEN")
	switch {
	case c.tokenFromFlag:
		return "flag"
	case tokenInEnv && !c.isSet("enroll-token"):
		return "env"
	case c.EnrollTokenStdin:
		return "stdin"
	case c.ConfigFile != "":
		return "file"
	default:
		return "none"
	}
}

// SetTokenFromFlag records a token passed via CLI (discouraged: visible in
// the process list) so TokenSource can warn about it.
func (c *Config) SetTokenFromFlag(tok string) {
	c.EnrollToken = tok
	c.tokenFromFlag = true
}

func readStdinLine() (string, error) {
	raw, err := os.ReadFile("/dev/stdin")
	if err != nil {
		return "", fmt.Errorf("read token from stdin: %w", err)
	}
	// One-shot: first line only.
	line := strings.TrimSpace(strings.SplitN(string(raw), "\n", 2)[0])
	if line == "" {
		return "", fmt.Errorf("empty token on stdin")
	}
	return line, nil
}

// ValidateCoreURL enforces HTTPS by default; plain HTTP is accepted only
// with explicit opt-in AND a loopback host (localhost dev).
func ValidateCoreURL(raw string, allowInsecure bool) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid core url: %w", err)
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		return nil
	case "http":
		if !allowInsecure {
			return fmt.Errorf("refusing plain HTTP without allow-insecure-http (use https)")
		}
		if !isLoopbackHost(strings.ToLower(u.Hostname())) {
			return fmt.Errorf("allow-insecure-http permits only loopback hosts, got %q", u.Hostname())
		}
		return nil
	default:
		return fmt.Errorf("unsupported url scheme %q (want https)", u.Scheme)
	}
}

func isLoopbackHost(h string) bool {
	if h == "localhost" || h == "127.0.0.1" || h == "::1" {
		return true
	}
	// 127/8 without depending on DNS.
	if strings.HasPrefix(h, "127.") {
		rest := strings.TrimPrefix(h, "127.")
		parts := strings.Split(rest, ".")
		if len(parts) == 3 {
			ok := true
			for _, p := range parts {
				n, err := strconv.Atoi(p)
				if err != nil || n < 0 || n > 255 {
					ok = false
					break
				}
			}
			if ok {
				return true
			}
		}
	}
	return false
}

// SafeString renders config without secrets for logs and errors.
func (c *Config) SafeString() string {
	return fmt.Sprintf("core_url=%s state_dir=%s hostname=%s interval=%s insecure_http=%v ca_file=%s",
		c.CoreURL, c.StateDir, c.Hostname, c.Interval, c.AllowInsecureHTTP, c.CAFile)
}
