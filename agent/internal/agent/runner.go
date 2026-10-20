// Package agent implements the run loop: enroll-if-needed, collect, persist
// sequence + envelope, send in order with bounded retries, graceful stop.
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"runtime"
	"sort"
	"sync"
	"time"

	"windup-monitor/agent/internal/client"
	"windup-monitor/agent/internal/collect"
	"windup-monitor/agent/internal/config"
	"windup-monitor/agent/internal/discover"
	"windup-monitor/agent/internal/id"
	"windup-monitor/agent/internal/probe"
	"windup-monitor/agent/internal/protocol"
	"windup-monitor/agent/internal/store"
)

const (
	// Capabilities is the capability set: host metrics plus local service
	// discovery and loopback HTTP checks (see CONTRACT.md §11). Only
	// allowlisted values are ever sent.
	AgentVersion = "0.1.0"
	// MaxSendsPerTick caps catch-up traffic after offline (protocol: max 5).
	MaxSendsPerTick = 5
	// MaxAuthFailures bounds consecutive 401 BAD_CREDENTIAL retries before
	// the agent stops and waits for the operator (files are kept).
	MaxAuthFailures = 10

	// DiscoveryInterval refreshes the local candidate snapshot (initial
	// snapshot at startup, then at most this often). Every heartbeat
	// carries the latest snapshot.
	DiscoveryInterval = 60 * time.Second
	// MaxServiceChecks bounds the stored/executed check set.
	MaxServiceChecks = 64
	// MaxResultsPerEnvelope bounds service_results per heartbeat envelope.
	MaxResultsPerEnvelope = 64
	// MaxEnvelopeBytes is the protocol body limit (256 KB); envelopes are
	// truncated (results first) to stay within it.
	MaxEnvelopeBytes = 256 * 1024
	// ProbeWorkers bounds concurrent check execution (no concurrent run of
	// the same check; ticks are sequential).
	ProbeWorkers = 4
)

// Capabilities lists the values sent at enroll and in every heartbeat so
// Core can upgrade persisted caps of existing agents without re-enroll.
var Capabilities = []string{"metrics", "service_discovery", "http_checks"}

// ErrRevoked signals the credential is no longer usable (401 AGENT_REVOKED or
// local state wiped while running): the local files are wiped (unless they
// already hold a newer secret) and the process must stop — exit 3, no retry
// with the same secret.
var ErrRevoked = errors.New("credential revoked by core (awaiting re-enroll)")

// ErrUpgrade signals a protocol major mismatch: the operator must upgrade.
var ErrUpgrade = errors.New("protocol upgrade required")

// Runner wires config, store, collector and client.
type Runner struct {
	cfg   *config.Config
	st    *store.Store
	col   *collect.Collector
	cli   *client.Client
	log   *log.Logger
	nowFn func() time.Time

	// procRoot roots local discovery ("/proc" in production).
	procRoot string
	// snapshotFn builds the service-discovery snapshot; stubbed in tests.
	// Nil means the default discover.Snapshot over procRoot.
	snapshotFn func(now time.Time) (*protocol.ServiceDiscovery, error)

	svcMu       sync.Mutex
	svcChecks   []protocol.ServiceCheck
	svcRevision int
	svcLastRun  map[string]time.Time
	// inFlight tracks checks currently executing in the background pool:
	// one in-flight run per check, never concurrent with itself.
	inFlight map[string]bool
	// resBuf holds completed results until a tick durably persists them.
	resBuf *resultBuffer
	// pool executes probes off the heartbeat path (see scheduler.go).
	pool *probePool
	// discovery is the cached snapshot attached to every envelope;
	// discoveryAt is its store time. discRefreshing guards one in-flight
	// background refresh (production path never blocks the tick).
	discovery      *protocol.ServiceDiscovery
	discoveryAt    time.Time
	discRefreshing bool
	// procSampler keeps the bounded per-process CPU/RSS baseline. It reads
	// only candidate pids proven by the cached discovery snapshot and never
	// transmits a pid.
	procSampler *processSampler
}

// New builds a Runner. tlsCfg/userAgent are injected for tests.
func New(cfg *config.Config, st *store.Store, logger *log.Logger, userAgent string, newClient func(base string) *client.Client) (*Runner, error) {
	tlsCfg, err := client.BuildTLS(cfg.CAFile)
	if err != nil {
		return nil, err
	}
	var cli *client.Client
	if newClient != nil {
		cli = newClient(cfg.CoreURL)
	} else {
		cli = client.NewDefault(cfg.CoreURL, tlsCfg, userAgent)
	}
	r := &Runner{
		cfg: cfg, st: st, col: collect.New("/proc"),
		cli: cli, log: logger, nowFn: time.Now,
		procRoot: "/proc", svcLastRun: map[string]time.Time{},
		inFlight: map[string]bool{}, resBuf: &resultBuffer{},
		procSampler: newProcessSampler("/proc"),
	}
	r.wirePool()
	return r, nil
}

// wirePool attaches the background probe pool. Tests constructing a Runner
// literal get one via ensurePool instead.
func (r *Runner) wirePool() {
	if r.pool == nil {
		r.pool = newProbePool(ProbeWorkers, r.handleProbeJob)
	}
}

// ensurePool lazily wires the pool for hand-built Runners (tests); the
// production path wires it in New/initialisation.
func (r *Runner) ensurePool() {
	if r.pool == nil {
		r.wirePool()
	}
	if r.resBuf == nil {
		r.resBuf = &resultBuffer{}
	}
	r.svcMu.Lock()
	if r.svcLastRun == nil {
		r.svcLastRun = map[string]time.Time{}
	}
	if r.inFlight == nil {
		r.inFlight = map[string]bool{}
	}
	r.svcMu.Unlock()
}

// UserAgent identifies this build to Core (no secrets in it).
func UserAgent() string {
	return "windup-monitor-agent/" + AgentVersion + " (" + runtime.GOOS + "/" + runtime.GOARCH + ")"
}

// Backoff returns the delay before the next attempt after `attempt`
// consecutive failures (1-based): exponential from 1s, capped at 5min,
// with up to +25% jitter. Pure function, unit-tested.
func Backoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > 9 {
		attempt = 9
	}
	base := time.Second << uint(attempt-1)
	if base > 5*time.Minute {
		base = 5 * time.Minute
	}
	jitter := time.Duration(rand.Int63n(int64(base) / 4)) //nolint:gosec // jitter only
	return base + jitter
}

// EnsureEnrolled loads the credential or performs a one-shot enrollment.
// The token is used once and never logged.
func (r *Runner) EnsureEnrolled(ctx context.Context) (store.Credential, error) {
	if cred, ok, err := r.st.LoadCredential(); err != nil {
		return store.Credential{}, err
	} else if ok {
		return cred, nil
	}
	token := r.cfg.EnrollToken
	if token == "" {
		return store.Credential{}, fmt.Errorf("not enrolled and no enroll token: set %sENROLL_TOKEN, --enroll-token or --enroll-token-stdin", config.EnvPrefix)
	}
	resp, err := r.cli.Enroll(ctx, token, r.cfg.Hostname, AgentVersion, Capabilities)
	if err != nil {
		return store.Credential{}, fmt.Errorf("enroll: %w", err)
	}
	cred := store.Credential{AgentID: resp.AgentID, Credential: resp.Credential}
	if err := r.st.SaveCredential(cred); err != nil {
		return store.Credential{}, fmt.Errorf("save credential: %w", err)
	}
	interval := time.Duration(resp.HeartbeatIntervalS) * time.Second
	if interval >= config.MinInterval && interval <= config.MaxInterval {
		r.cfg.Interval = interval
	}
	if err := r.st.SaveState(store.ServerState{
		ConfigVersion:      resp.ConfigVersion,
		HeartbeatIntervalS: int(r.cfg.Interval / time.Second),
	}); err != nil {
		return store.Credential{}, fmt.Errorf("save state: %w", err)
	}
	r.log.Printf("enrolled as %s (credential stored 0600)", resp.AgentID)
	return cred, nil
}

// EnrollOnce performs a one-shot enrollment and exits (used by the
// `enroll` subcommand and the pairing screen flow).
func (r *Runner) EnrollOnce(ctx context.Context, force bool) error {
	if _, ok, err := r.st.LoadCredential(); err != nil {
		return err
	} else if ok && !force {
		return fmt.Errorf("already enrolled (refusing to overwrite; use --force to re-enroll after losing both secrets)")
	}
	_, err := r.EnsureEnrolledFresh(ctx)
	return err
}

// EnsureEnrolledFresh always enrolls with the configured token.
func (r *Runner) EnsureEnrolledFresh(ctx context.Context) (store.Credential, error) {
	token := r.cfg.EnrollToken
	if token == "" {
		return store.Credential{}, fmt.Errorf("no enroll token: set %sENROLL_TOKEN, --enroll-token or --enroll-token-stdin", config.EnvPrefix)
	}
	resp, err := r.cli.Enroll(ctx, token, r.cfg.Hostname, AgentVersion, Capabilities)
	if err != nil {
		return store.Credential{}, fmt.Errorf("enroll: %w", err)
	}
	cred := store.Credential{AgentID: resp.AgentID, Credential: resp.Credential}
	if err := r.st.SaveCredential(cred); err != nil {
		return store.Credential{}, err
	}
	// A pending rotation always belongs to the PREVIOUS identity: drop it
	// only after the new credential is durably stored, so a failed enroll
	// never destroys the existing identity or its rotation state.
	if err := r.st.ClearRotation(); err != nil {
		return store.Credential{}, fmt.Errorf("clear stale rotation: %w", err)
	}
	interval := time.Duration(resp.HeartbeatIntervalS) * time.Second
	if interval >= config.MinInterval && interval <= config.MaxInterval {
		r.cfg.Interval = interval
	}
	if err := r.st.SaveState(store.ServerState{
		ConfigVersion:      resp.ConfigVersion,
		HeartbeatIntervalS: int(r.cfg.Interval / time.Second),
	}); err != nil {
		return store.Credential{}, err
	}
	r.log.Printf("enrolled as %s (credential stored 0600)", resp.AgentID)
	return cred, nil
}

// RotateOnce performs the full rotation flow (generate -> save locally ->
// POST /rotate -> POST /rotate_confirm) and exits. A retry reuses the saved
// rotation_id + secret, never generating a new one.
func (r *Runner) RotateOnce(ctx context.Context) error {
	cred, ok, err := r.st.LoadCredential()
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("not enrolled: enroll first")
	}
	rot, pending, err := r.st.LoadRotation()
	if err != nil {
		return err
	}
	if !pending {
		next, err := id.NewSecret()
		if err != nil {
			return fmt.Errorf("generate secret: %w", err)
		}
		rid, err := id.NewRotationID()
		if err != nil {
			return fmt.Errorf("generate rotation id: %w", err)
		}
		rot = store.Rotation{RotationID: rid, Next: next}
		// Persist BEFORE sending (crash-safe retry of the same envelope).
		if err := r.st.SaveRotation(rot); err != nil {
			return fmt.Errorf("save rotation: %w", err)
		}
	}
	tryRotate := func(bearer string) (*protocol.RotateResponse, error) {
		return r.cli.Rotate(ctx, cred.AgentID, bearer, rot.RotationID, rot.Next)
	}
	resp, err := tryRotate(cred.Credential)
	if apiIs(err, protocol.CodeBadCredential) {
		// Dual-accept window: the server may already hold next as pending.
		r.log.Printf("rotate with current credential rejected; retrying with pending next credential")
		resp, err = tryRotate(rot.Next)
	}
	if err != nil {
		if apiIs(err, protocol.CodeAgentRevoked) {
			// Same terminal handling as heartbeat: wipe + exit 3.
			return r.stopRevoked("rotate", cred.Credential)
		}
		if apiIs(err, protocol.CodeRotationConflict) {
			return fmt.Errorf("rotation conflict (server holds a different pending secret): confirm or re-enroll per runbook")
		}
		return fmt.Errorf("rotate: %w", err)
	}
	if err := r.cli.RotateConfirm(ctx, cred.AgentID, rot.Next, rot.RotationID); err != nil {
		if apiIs(err, protocol.CodeAgentRevoked) {
			return r.stopRevoked("rotate confirm", cred.Credential)
		}
		return fmt.Errorf("rotate confirm: %w (rotation %s stays pending; retry `rotate` reuses it)", err, rot.RotationID)
	}
	// Promote locally only after the server confirmed.
	if err := r.st.SaveCredential(store.Credential{AgentID: cred.AgentID, Credential: rot.Next}); err != nil {
		return fmt.Errorf("promote credential: %w", err)
	}
	if err := r.st.ClearRotation(); err != nil {
		return fmt.Errorf("clear rotation: %w", err)
	}
	_ = resp
	r.log.Printf("rotation %s confirmed", rot.RotationID)
	return nil
}

// stopRevoked is the single terminal handler for 401 AGENT_REVOKED (heartbeat
// send, rotate, dual-accept fallback with `next`, rotate confirm, config
// fetch). It wipes credential + rotation files and returns ErrRevoked, which
// main maps to exit 3 (CONTRACT §5).
//
// Exception: when the state dir already holds a NEWER credential than `used`
// (an external `rotate` landed while a request carrying the previous secret
// was in flight), that fresher secret is kept on disk — a late revoke answer
// for the old secret never deletes the new one. The process still stops (exit
// 3) so the operator sees the revocation.
func (r *Runner) stopRevoked(op, used string) error {
	if fresh, ok, err := r.st.LoadCredential(); err == nil && ok && fresh.Credential != used {
		r.log.Printf("%s: revoked for the previous credential; keeping the newer secret on disk", op)
		return ErrRevoked
	}
	if cerr := r.st.ClearCredentials(); cerr != nil {
		r.log.Printf("clear credentials after revoke failed: %v", cerr)
	}
	r.log.Printf("%s: credential revoked by core; credential + rotation wiped (awaiting re-enroll)", op)
	return ErrRevoked
}

// rejectedResults converts pending commands into S1 rejections: the S1
// agent executes nothing (no docker/exec in S1), so every command is
// rejected with a NULL outcome (canonical for rejected).
func rejectedResults(cmds []protocol.PendingCommand, at time.Time) []protocol.CommandResult {
	out := make([]protocol.CommandResult, 0, len(cmds))
	for _, pc := range cmds {
		key := pc.IdempotencyKey
		if key == "" {
			key = pc.CommandID
		}
		out = append(out, protocol.CommandResult{
			CommandID:      pc.CommandID,
			State:          protocol.CmdRejected,
			Outcome:        nil, // canonical NULL for rejected
			ResultDetail:   "UNSUPPORTED_COMMAND_TYPE: S1 agent supports metrics only, type=" + pc.Type,
			CompletedAt:    at.UTC().Format(time.RFC3339),
			IdempotencyKey: key,
		})
	}
	return out
}

func apiIs(err error, code string) bool {
	var ae *client.APIError
	return errors.As(err, &ae) && ae.IsCode(code)
}

// Run executes the heartbeat loop until ctx is cancelled.
func (r *Runner) Run(ctx context.Context) error {
	cred, err := r.EnsureEnrolled(ctx)
	if err != nil {
		return err
	}
	st, err := r.st.LoadState()
	if err != nil {
		return err
	}
	cfgVersion := st.ConfigVersion
	if st.HeartbeatIntervalS*int(time.Second) >= int(config.MinInterval) &&
		time.Duration(st.HeartbeatIntervalS)*time.Second <= config.MaxInterval &&
		st.HeartbeatIntervalS > 0 {
		r.cfg.Interval = time.Duration(st.HeartbeatIntervalS) * time.Second
	}

	if err := r.col.Warmup(); err != nil {
		r.log.Printf("warmup failed (first sample will use zero baseline): %v", err)
	}
	// Restart path: restore the last known check set, then safely refresh
	// /config once (best effort — stored checks keep probing on failure).
	if scs, present, err := r.st.LoadServiceChecks(); err != nil {
		r.log.Printf("load service checks failed (starting empty): %v", err)
	} else if present {
		r.setServiceChecks(scs.ConfigRevision, scs.Checks, false)
	}
	if err := r.refreshConfig(ctx, &cred, &cfgVersion); err != nil {
		if errors.Is(err, ErrRevoked) || errors.Is(err, ErrUpgrade) {
			return err
		}
		r.log.Printf("startup config refresh failed (using stored checks): %v", err)
	}
	r.ensurePool()
	defer r.pool.stop()
	r.log.Printf("agent %s running every %s", cred.AgentID, r.cfg.Interval)

	ticker := time.NewTicker(r.cfg.Interval)
	defer ticker.Stop()

	var pendingResults []protocol.CommandResult
	failures := 0
	var skipUntil time.Time
	lastInterval := r.cfg.Interval

	afterTick := func() {
		if r.cfg.Interval != lastInterval {
			ticker.Reset(r.cfg.Interval)
			lastInterval = r.cfg.Interval
			r.log.Printf("heartbeat interval now %s", r.cfg.Interval)
		}
	}

	// Immediate first tick, then one per interval.
	if fatal := r.tick(ctx, &cred, &cfgVersion, &pendingResults, &failures, &skipUntil); fatal != nil {
		return fatal
	}
	afterTick()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
		if fatal := r.tick(ctx, &cred, &cfgVersion, &pendingResults, &failures, &skipUntil); fatal != nil {
			return fatal
		}
		afterTick()
	}
}

// tick performs one collect-persist-send cycle. Recoverable problems are
// logged with backoff; revoked/upgraded/exhausted credentials are fatal.
func (r *Runner) tick(ctx context.Context, cred *store.Credential, cfgVersion *int, pendingResults *[]protocol.CommandResult, failures *int, skipUntil *time.Time) error {
	// Hot credential reload: an external `rotate`/`rotate_confirm` (separate
	// process) atomically replaces credential.json while this daemon runs.
	// Only the secret is re-read here — the seq counter, the outbox and the
	// pending command results are untouched, so no delivery state is lost.
	switch fresh, ok, err := r.st.LoadCredential(); {
	case err != nil:
		r.log.Printf("reload credential failed (continuing with the in-memory one): %v", err)
	case !ok:
		// The state was wiped on disk while running (operator revoked or is
		// repairing): stop instead of sending with a secret that is gone.
		r.log.Printf("credential file removed on disk; stopping (awaiting re-enroll)")
		return ErrRevoked
	case fresh != *cred:
		r.log.Printf("credential changed on disk; reloading it")
		*cred = fresh
	}

	if now := r.nowFn(); now.Before(*skipUntil) {
		return nil
	}

	metrics, observedAt, err := r.col.Sample()
	if err != nil {
		r.log.Printf("collect failed: %v", err)
		return nil
	}
	// Local service discovery (cached; refreshes never block this path)
	// plus due-probe submission and ready-result drain. Probe execution
	// happens in the background pool: the metric heartbeat below never
	// waits for it. Drained results are consumed from the buffer only once
	// the envelope carrying them is durable (see commit below), so a
	// NextSeq/marshal/store failure keeps them for the next tick.
	discovery := r.refreshDiscovery()
	r.submitDueChecks(discovery)
	processMetrics := r.sampleProcessMetrics(discovery)
	svcResults, resMark := r.peekResults()
	seq, err := r.st.NextSeq() // persisted BEFORE send
	if err != nil {
		r.log.Printf("allocate seq failed: %v", err)
		return nil
	}
	results := *pendingResults
	if results == nil {
		results = []protocol.CommandResult{}
	}
	env := protocol.HeartbeatRequest{
		Seq:                   seq,
		ObservedAt:            observedAt.Format(time.RFC3339),
		ConfigVersion:         *cfgVersion,
		Capabilities:          append([]string(nil), Capabilities...),
		Metrics:               metrics,
		Docker:                protocol.Docker{Present: false},
		CommandResults:        results,
		ServiceDiscovery:      discovery,
		ServiceResults:        svcResults,
		ServiceProcessMetrics: processMetrics,
	}
	raw, err := marshalBounded(env)
	if err != nil {
		r.log.Printf("encode envelope seq=%d failed: %v", seq, err)
		return nil
	}
	if err := r.st.SaveEnvelope(seq, raw); err != nil {
		r.log.Printf("persist envelope seq=%d failed: %v", seq, err)
		return nil
	}
	// The envelope (with its service_results) is durable: only now consume
	// the drained results from the buffer (exactly once). Retry sends these
	// exact bytes; the payload is never regenerated for the same seq.
	r.resBuf.commit(resMark)
	// Attached results now live durably inside envelope seq: reset the
	// buffer so the next tick attaches only new results (exactly once).
	// The envelope is retried byte-identical until accepted.
	*pendingResults = nil
	if dropped, err := r.st.PruneOutbox(store.MaxOutbox); err != nil {
		r.log.Printf("prune outbox failed: %v", err)
	} else if dropped > 0 {
		r.log.Printf("outbox full: dropped %d oldest envelope(s)", dropped)
	}

	if err := r.flush(ctx, cred, cfgVersion, pendingResults); err != nil {
		if errors.Is(err, ErrRevoked) || errors.Is(err, ErrUpgrade) {
			return err
		}
		*failures++
		if *failures >= MaxAuthFailures && apiIs(err, protocol.CodeBadCredential) {
			return fmt.Errorf("credential rejected %d times in a row (keeping files, awaiting operator): %w", *failures, err)
		}
		*skipUntil = r.nowFn().Add(Backoff(*failures))
		r.log.Printf("heartbeat failed (backoff %s): %v", Backoff(*failures), err)
		return nil
	}
	*failures = 0
	return nil
}

// flush sends up to MaxSendsPerTick oldest envelopes in order. It returns
// nil when every attempt succeeded (or the outbox is empty).
func (r *Runner) flush(ctx context.Context, cred *store.Credential, cfgVersion *int, pendingResults *[]protocol.CommandResult) error {
	seqs, err := r.st.ListEnvelopes()
	if err != nil {
		return err
	}
	sent := 0
	for _, seq := range seqs {
		if sent >= MaxSendsPerTick {
			break
		}
		raw, err := r.st.ReadEnvelope(seq)
		if err != nil {
			r.log.Printf("read envelope seq=%d failed: %v", seq, err)
			continue
		}
		resp, err := r.sendEnvelope(ctx, cred, raw)
		if err != nil && apiIs(err, protocol.CodeConfigStale) {
			// Canonical CONFIG_STALE path (protocol §3a, CONTRACT §5): pull
			// GET /config once, then resend the SAME envelope bytes with the
			// refreshed config_version. A second CONFIG_STALE falls through to
			// the bounded backoff below (at most 2 sends + 1 config GET per
			// envelope per tick), so a misbehaving server cannot busy-loop.
			r.log.Printf("config stale for seq=%d; fetching /config", seq)
			if cerr := r.refreshConfig(ctx, cred, cfgVersion); cerr != nil {
				return cerr
			}
			resp, err = r.sendEnvelope(ctx, cred, raw)
		}
		if err != nil {
			if errors.Is(err, ErrRevoked) || errors.Is(err, ErrUpgrade) {
				return err
			}
			if apiIs(err, protocol.CodeUpgradeRequired) {
				return ErrUpgrade
			}
			if apiIs(err, protocol.CodeStaleSeq) || apiIs(err, protocol.CodeInvalidBody) {
				// Poison guard: the server will never accept this envelope.
				r.log.Printf("dropping poison envelope seq=%d (%s)", seq, codeOf(err))
				_ = r.st.DeleteEnvelope(seq)
				sent++
				continue
			}
			return err
		}
		_ = r.st.DeleteEnvelope(seq)
		sent++
		if err := r.applyServerResponse(ctx, cred, cfgVersion, pendingResults, resp); err != nil {
			return err
		}
	}
	return nil
}

// sendEnvelope posts one stored envelope (identical bytes on every retry).
//
// On 401 AGENT_REVOKED it reloads the credential from disk ONCE when the state
// dir already holds a different (newer) secret — an external rotate can land
// while a request carrying the previous secret is in flight, and that answer
// must neither wipe the fresh secret nor kill a healthy daemon. If the retry
// (or the first attempt without a fresher secret) is revoked as well, the local
// files are wiped and ErrRevoked is returned (exit 3). Bounded: at most two
// sends per envelope.
func (r *Runner) sendEnvelope(ctx context.Context, cred *store.Credential, raw []byte) (*protocol.HeartbeatResponse, error) {
	for attempt := 0; ; attempt++ {
		resp, err := r.cli.Heartbeat(ctx, cred.AgentID, cred.Credential, raw)
		if err == nil {
			return resp, nil
		}
		if !apiIs(err, protocol.CodeAgentRevoked) {
			return nil, err
		}
		if fresh, ok, lerr := r.st.LoadCredential(); lerr == nil && ok &&
			fresh.Credential != cred.Credential && attempt == 0 {
			r.log.Printf("credential rotated on disk; reloading it after revoke of the previous secret")
			*cred = fresh
			continue
		}
		return nil, r.stopRevoked("heartbeat", cred.Credential)
	}
}

func codeOf(err error) string {
	var ae *client.APIError
	if errors.As(err, &ae) {
		return ae.Code
	}
	return "transport"
}

// refreshConfig pulls GET /api/v1/agent/config — the canonical CONFIG_STALE
// target (protocol §3a) — and applies config_version + heartbeat interval to
// memory and disk. A revoked answer wipes local state (unless a newer
// credential exists) and returns ErrRevoked.
func (r *Runner) refreshConfig(ctx context.Context, cred *store.Credential, cfgVersion *int) error {
	scfg, err := r.cli.FetchConfig(ctx, cred.AgentID, cred.Credential)
	if err != nil {
		if apiIs(err, protocol.CodeAgentRevoked) {
			return r.stopRevoked("config fetch", cred.Credential)
		}
		return err
	}
	*cfgVersion = scfg.ConfigVersion
	if iv := time.Duration(scfg.HeartbeatIntervalS) * time.Second; iv >= config.MinInterval && iv <= config.MaxInterval {
		r.cfg.Interval = iv
	}
	if err := r.st.SaveState(store.ServerState{
		ConfigVersion:      scfg.ConfigVersion,
		HeartbeatIntervalS: int(r.cfg.Interval / time.Second),
	}); err != nil {
		return fmt.Errorf("save state: %w", err)
	}
	// Additive service checks: a present key (null, empty or populated)
	// replaces the stored set atomically; an absent key (older Core) keeps
	// it. Replacement resets per-check schedules so the new set probes
	// promptly, and no result from the previous revision is ever generated
	// afterwards.
	if scfg.ServiceChecks.Present {
		r.setServiceChecks(scfg.ConfigVersion, scfg.ServiceChecks.Checks, true)
	}
	return nil
}

// setServiceChecks installs a check set (sorted, bounded to
// MaxServiceChecks), resets per-check schedules and persists it for
// restarts. When persist is false the set is memory-only (startup restore
// of what is already on disk).
func (r *Runner) setServiceChecks(revision int, checks []protocol.ServiceCheck, persist bool) {
	cp := append([]protocol.ServiceCheck(nil), checks...)
	sort.Slice(cp, func(i, j int) bool { return cp[i].CheckID < cp[j].CheckID })
	if len(cp) > MaxServiceChecks {
		r.log.Printf("service checks truncated to %d (got %d)", MaxServiceChecks, len(cp))
		cp = cp[:MaxServiceChecks]
	}
	r.svcMu.Lock()
	r.svcChecks = cp
	r.svcRevision = revision
	r.svcLastRun = map[string]time.Time{}
	r.svcMu.Unlock()
	if persist {
		if err := r.st.SaveServiceChecks(store.ServiceChecksState{
			ConfigRevision: revision,
			Checks:         cp,
		}); err != nil {
			r.log.Printf("save service checks failed: %v", err)
		}
	}
}

// snapshotDiscovery builds a fresh discovery snapshot over procRoot.
func (r *Runner) snapshotDiscovery(now time.Time) (*protocol.ServiceDiscovery, error) {
	if r.snapshotFn != nil {
		return r.snapshotFn(now)
	}
	root := r.procRoot
	if root == "" {
		root = "/proc"
	}
	snap, err := discover.Snapshot(discover.Deps{
		ProcRoot:    root,
		Fingerprint: true,
		Now:         func() time.Time { return now },
	})
	if err != nil {
		return nil, err
	}
	return &snap, nil
}

// refreshDiscovery returns the snapshot to attach to this tick's envelope.
// It never blocks the heartbeat path: stubbed snapshotFns (tests) run
// synchronously, while the production /proc scan (including the bounded
// Jellyfin fingerprint) refreshes in the background — at most one refresh
// in flight, at most every DiscoveryInterval. A failed or pending refresh
// keeps the previous snapshot (possibly nil on the first ticks) — Core's
// complete=false / observed_at rules decide what to do with staleness.
func (r *Runner) refreshDiscovery() *protocol.ServiceDiscovery {
	now := r.nowFn()
	r.svcMu.Lock()
	prev := r.discovery
	at := r.discoveryAt
	refreshing := r.discRefreshing
	stubbed := r.snapshotFn != nil
	r.svcMu.Unlock()
	if prev != nil && now.Sub(at) < DiscoveryInterval {
		return prev
	}
	if stubbed {
		snap, err := r.snapshotDiscovery(now)
		if err != nil {
			r.log.Printf("service discovery failed (keeping previous snapshot): %v", err)
			return prev
		}
		if len(snap.Candidates) > discover.MaxCandidates {
			snap.Candidates = snap.Candidates[:discover.MaxCandidates]
		}
		r.svcMu.Lock()
		r.discovery = snap
		r.discoveryAt = now
		r.svcMu.Unlock()
		return snap
	}
	if refreshing {
		return prev
	}
	r.svcMu.Lock()
	r.discRefreshing = true
	r.svcMu.Unlock()
	go func() {
		snap, err := r.snapshotDiscovery(now)
		if err != nil {
			r.log.Printf("service discovery failed (keeping previous snapshot): %v", err)
		}
		r.svcMu.Lock()
		defer r.svcMu.Unlock()
		r.discRefreshing = false
		if err != nil {
			return
		}
		if len(snap.Candidates) > discover.MaxCandidates {
			snap.Candidates = snap.Candidates[:discover.MaxCandidates]
		}
		r.discovery = snap
		r.discoveryAt = r.nowFn()
	}()
	return prev
}

// sampleProcessMetrics reads a small bounded set of /proc/<pid> files for
// candidates with a proven owner pid. The pid mapping comes from the cached
// discovery snapshot, so this never rescans /proc/net or the process table.
// Failures degrade to null per metric; they never block or fail the tick.
func (r *Runner) sampleProcessMetrics(discovery *protocol.ServiceDiscovery) []protocol.ServiceProcessMetric {
	if discovery == nil || len(discovery.Candidates) == 0 {
		return nil
	}
	if r.procSampler == nil {
		r.procSampler = newProcessSampler(r.procRoot)
	}
	return r.procSampler.Sample(discovery.Candidates, r.nowFn())
}

// handleProbeJob executes one background probe and buffers its result. It
// runs detached from any run context (bounded by the check's own timeout)
// so shutdown never aborts a measurement; the buffer is mutex-guarded and
// outlives the Runner safely.
func (r *Runner) handleProbeJob(job probeJob) {
	res := probe.Execute(context.Background(), job.check, job.cands, job.at)
	r.resBuf.push(res)
	r.svcMu.Lock()
	delete(r.inFlight, job.check.CheckID)
	r.svcMu.Unlock()
}

// submitDueChecks enqueues due checks to the background pool without
// blocking: one in-flight run per check, schedules stamped at submit. A
// full/stopped pool only defers the check to its next due tick.
func (r *Runner) submitDueChecks(discovery *protocol.ServiceDiscovery) {
	// No snapshot yet is unknown, not proof that a candidate disappeared.
	if discovery == nil {
		return
	}
	r.ensurePool()
	now := r.nowFn()
	r.svcMu.Lock()
	checks := append([]protocol.ServiceCheck(nil), r.svcChecks...)
	if r.svcLastRun == nil {
		r.svcLastRun = map[string]time.Time{}
	}
	if r.inFlight == nil {
		r.inFlight = map[string]bool{}
	}
	r.svcMu.Unlock()

	cands := map[string]protocol.ServiceCandidate{}
	if discovery != nil {
		for _, c := range discovery.Candidates {
			cands[c.CandidateID] = c
		}
	}
	deferred := 0
	for _, ch := range checks {
		if !ch.Enabled {
			continue
		}
		r.svcMu.Lock()
		_, busy := r.inFlight[ch.CheckID]
		due := !busy
		if due {
			if last, ok := r.svcLastRun[ch.CheckID]; ok {
				if now.Sub(last) < time.Duration(probe.IntervalS(ch))*time.Second {
					due = false
				}
			}
		}
		r.svcMu.Unlock()
		if !due {
			continue
		}
		// Mark busy before publishing to workers: a fast failure can finish
		// immediately, and must never clear the flag before we set it.
		r.svcMu.Lock()
		r.svcLastRun[ch.CheckID] = now
		r.inFlight[ch.CheckID] = true
		r.svcMu.Unlock()
		if !r.pool.submit(probeJob{check: ch, cands: cands, at: now}) {
			r.svcMu.Lock()
			delete(r.inFlight, ch.CheckID)
			delete(r.svcLastRun, ch.CheckID)
			r.svcMu.Unlock()
			deferred++
		}
	}
	if deferred > 0 {
		r.log.Printf("probe queue full: %d check(s) deferred to next due tick", deferred)
	}
}

// peekResults drains up to MaxResultsPerEnvelope ready results. They stay
// buffered until the caller commits them after a durable envelope persist.
func (r *Runner) peekResults() ([]protocol.ServiceResult, uint64) {
	r.svcMu.Lock()
	revisions := make(map[string]int, len(r.svcChecks))
	for _, check := range r.svcChecks {
		if check.Enabled {
			revisions[check.CheckID] = check.ConfigRevision
		}
	}
	r.svcMu.Unlock()
	return r.resBuf.peek(MaxResultsPerEnvelope, revisions)
}

// marshalBounded encodes the envelope and keeps it within MaxEnvelopeBytes
// by shedding service_results first (metrics + discovery are always small
// by construction: max 64 candidates of safe labels/numbers).
func marshalBounded(env protocol.HeartbeatRequest) ([]byte, error) {
	raw, err := json.Marshal(env)
	if err != nil {
		return nil, err
	}
	for len(raw) > MaxEnvelopeBytes && len(env.ServiceResults) > 0 {
		drop := len(env.ServiceResults) / 2
		if drop == 0 {
			drop = 1
		}
		env.ServiceResults = env.ServiceResults[:len(env.ServiceResults)-drop]
		raw, err = json.Marshal(env)
		if err != nil {
			return nil, err
		}
	}
	if len(raw) > MaxEnvelopeBytes {
		return nil, fmt.Errorf("envelope still %d bytes over the %d limit without service results", len(raw), MaxEnvelopeBytes)
	}
	return raw, nil
}

// applyServerResponse handles config changes, pending commands and drift.
func (r *Runner) applyServerResponse(ctx context.Context, cred *store.Credential, cfgVersion *int, pendingResults *[]protocol.CommandResult, resp *protocol.HeartbeatResponse) error {
	if resp.ConfigChanged || (resp.ConfigVersion != 0 && resp.ConfigVersion != *cfgVersion) {
		if err := r.refreshConfig(ctx, cred, cfgVersion); err != nil {
			if errors.Is(err, ErrRevoked) {
				return err
			}
			r.log.Printf("fetch config failed: %v", err)
		}
	}
	if len(resp.PendingCommands) > 0 {
		*pendingResults = append(*pendingResults, rejectedResults(resp.PendingCommands, r.nowFn())...)
		r.log.Printf("rejected %d unsupported command(s)", len(resp.PendingCommands))
	}
	if resp.FullInventory {
		r.log.Printf("server asked for full inventory (no docker in S1: nothing to send)")
	}
	if resp.ServerTime != "" {
		if st, err := time.Parse(time.RFC3339, resp.ServerTime); err == nil {
			if drift := r.nowFn().Sub(st); drift > time.Minute || drift < -time.Minute {
				r.log.Printf("clock drift vs core: %s (check NTP)", drift.Round(time.Second))
			}
		}
	}
	return nil
}
