// Command windup-monitor-agent is the Windup Monitor host agent (S1).
//
// Modes: `run` (default: enroll if needed, then heartbeat loop),
// `enroll` (one-shot pairing), `rotate` (one-shot credential rotation).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"windup-monitor/agent/internal/agent"
	"windup-monitor/agent/internal/config"
	"windup-monitor/agent/internal/store"
)

const usage = `windup-monitor-agent - Windup Monitor host agent (protocol v1, S1 metrics only)

Usage:
  windup-monitor-agent [run] [flags]     enroll if needed, then heartbeat loop (default)
  windup-monitor-agent enroll [flags]    one-shot enrollment, then exit
  windup-monitor-agent rotate [flags]    one-shot credential rotation, then exit

Flags (CLI > WINDUP_MONITOR_* env > JSON config file > defaults):
  --core-url https://core:8080
  --state-dir /var/lib/windup-monitor
  --hostname HOST            (default: OS hostname)
  --interval-s 15            (server value wins after enroll/config fetch)
  --ca-file PATH             extra PEM CA for Core TLS
  --allow-insecure-http      ONLY for http://loopback dev setups
  --enroll-token TOKEN       discouraged (visible in ps); prefer WINDUP_MONITOR_ENROLL_TOKEN
  --enroll-token-stdin       read one-shot token from stdin
  --config PATH              JSON config file
  --force                    enroll: overwrite existing credential
  --shutdown-timeout-s 10

Exit codes: 0 ok · 1 error · 2 upgrade required · 3 revoked/awaiting repair.
`

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(argv []string) int {
	logger := log.New(os.Stderr, "windup-monitor-agent: ", log.LstdFlags|log.LUTC)

	mode := "run"
	rest := argv
	if len(rest) > 0 && (rest[0] == "run" || rest[0] == "enroll" || rest[0] == "rotate") {
		mode = rest[0]
		rest = rest[1:]
	}

	cfg := config.New()
	fs := flag.NewFlagSet("windup-monitor-agent", flag.ContinueOnError)
	coreURL := fs.String("core-url", "", "Core base URL (https, or http loopback with --allow-insecure-http)")
	stateDir := fs.String("state-dir", "", "state directory (default /var/lib/windup-monitor)")
	hostname := fs.String("hostname", "", "hostname reported to Core (default OS hostname)")
	intervalS := fs.Int("interval-s", 0, "heartbeat interval seconds (server value wins)")
	caFile := fs.String("ca-file", "", "extra PEM CA bundle for Core TLS")
	allowInsecure := fs.Bool("allow-insecure-http", false, "allow http://loopback only (dev)")
	enrollToken := fs.String("enroll-token", "", "one-shot enroll token (prefer env)")
	enrollStdin := fs.Bool("enroll-token-stdin", false, "read enroll token from stdin")
	configFile := fs.String("config", "", "JSON config file")
	force := fs.Bool("force", false, "enroll: overwrite existing credential")
	shutdownS := fs.Int("shutdown-timeout-s", 0, "graceful shutdown timeout seconds")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	if err := fs.Parse(rest); err != nil {
		return 1
	}
	touched := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { touched[f.Name] = true })
	cfg.MarkSet(mapKeys(touched)...)

	if *coreURL != "" {
		cfg.CoreURL = *coreURL
	}
	if *stateDir != "" {
		cfg.StateDir = *stateDir
	}
	if *hostname != "" {
		cfg.Hostname = *hostname
	}
	if *intervalS != 0 {
		cfg.Interval = time.Duration(*intervalS) * time.Second
	}
	if *caFile != "" {
		cfg.CAFile = *caFile
	}
	if touched["allow-insecure-http"] {
		cfg.AllowInsecureHTTP = *allowInsecure
	}
	if *enrollStdin {
		cfg.EnrollTokenStdin = true
	}
	if *configFile != "" {
		cfg.ConfigFile = *configFile
	}
	if *shutdownS != 0 {
		cfg.ShutdownTimeout = time.Duration(*shutdownS) * time.Second
	}
	tokenFromFlag := *enrollToken != ""
	if tokenFromFlag {
		cfg.SetTokenFromFlag(*enrollToken)
	}

	if err := cfg.Resolve(); err != nil {
		logger.Printf("config: %v", err)
		return 1
	}
	if tokenFromFlag || cfg.TokenSource() == "flag" {
		logger.Printf("warning: --enroll-token is visible in the process list; prefer WINDUP_MONITOR_ENROLL_TOKEN")
	}

	st, err := store.Open(cfg.StateDir)
	if err != nil {
		logger.Printf("state: %v", err)
		return 1
	}
	r, err := agent.New(cfg, st, logger, agent.UserAgent(), nil)
	if err != nil {
		logger.Printf("init: %v", err)
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	switch mode {
	case "enroll":
		cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
		if err := r.EnrollOnce(cctx, *force); err != nil {
			logger.Printf("enroll: %v", err)
			return 1
		}
		return 0
	case "rotate":
		cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
		if err := r.RotateOnce(cctx); err != nil {
			logger.Printf("rotate: %v", err)
			// Revoked credentials must exit 3 (same contract as `run`).
			return exitFor(err)
		}
		return 0
	default:
		// Graceful stop: give the in-flight request a bounded window.
		runCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		errCh := make(chan error, 1)
		go func() { errCh <- r.Run(runCtx) }()
		select {
		case <-ctx.Done():
			logger.Printf("shutting down (timeout %s)...", cfg.ShutdownTimeout)
			deadline := time.After(cfg.ShutdownTimeout)
			select {
			case err := <-errCh:
				if err != nil {
					logger.Printf("run: %v", err)
					return exitFor(err)
				}
				return 0
			case <-deadline:
				logger.Printf("shutdown timed out")
				return 1
			}
		case err := <-errCh:
			if err != nil {
				logger.Printf("run: %v", err)
				return exitFor(err)
			}
			return 0
		}
	}
}

func exitFor(err error) int {
	if errors.Is(err, agent.ErrUpgrade) {
		return 2
	}
	if errors.Is(err, agent.ErrRevoked) {
		return 3
	}
	return 1
}

func mapKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
