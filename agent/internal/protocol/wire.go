// Package protocol holds the Agent <-> Core v1 wire types.
//
// Exact field names follow docs/agent-protocol.md (snake_case). Forward
// compatibility rule: unknown JSON fields are ignored on decode; the agent
// never sends fields outside this contract (see agent/CONTRACT.md).
package protocol

import (
	"bytes"
	"encoding/json"
)

const (
	// Version is the agent protocol version sent in every request.
	Version = 1

	HeaderVersion = "Agent-Protocol-Version"
	HeaderAgentID = "X-Agent-ID"
)

// Canonical error codes (agent-protocol.md section 9).
const (
	CodeInvalidBody        = "INVALID_BODY"
	CodeStaleSeq           = "STALE_SEQ"
	CodeStaleSnapshot      = "STALE_SNAPSHOT"
	CodeBadCredential      = "BAD_CREDENTIAL"
	CodeAgentRevoked       = "AGENT_REVOKED"
	CodeUnknownCommandType = "UNKNOWN_COMMAND_TYPE"
	CodeCommandExpired     = "COMMAND_EXPIRED"
	CodeRotationConflict   = "ROTATION_CONFLICT"
	CodeCommandConflict    = "COMMAND_CONFLICT"
	CodeRateLimited        = "RATE_LIMITED"
	CodeConfigStale        = "CONFIG_STALE"
	CodeUpgradeRequired    = "UPGRADE_REQUIRED"
)

// Command states (canonical, identical to data-model section 5).
const (
	CmdQueued    = "queued"
	CmdClaimed   = "claimed"
	CmdRunning   = "running"
	CmdSucceeded = "succeeded"
	CmdFailed    = "failed"
	CmdExpired   = "expired"
	CmdCancelled = "cancelled"
	CmdRejected  = "rejected"
)

// Command outcomes (canonical: succeeded -> OK, failed -> NEGATIVE|AMBIGUOUS,
// every other state -> NULL, i.e. omitted as JSON null).
const (
	OutcomeOK        = "OK"
	OutcomeNegative  = "NEGATIVE"
	OutcomeAmbiguous = "AMBIGUOUS"
)

// ServiceKind enumerates the known service identities an agent may report.
// Unknown listeners are always "unknown" (never guessed).
const (
	ServiceKindJellyfin = "jellyfin"
	ServiceKindT3Code   = "t3-code"
	ServiceKindOpencode = "opencode"
	ServiceKindUnknown  = "unknown"
)

// ServiceTransport is the local transport of a discovered candidate.
const (
	ServiceTransportHTTP = "http"
	ServiceTransportTCP  = "tcp"
)

// ServiceConfidence grades the evidence behind a candidate.
const (
	ServiceConfidenceHigh   = "high"
	ServiceConfidenceMedium = "medium"
	ServiceConfidenceLow    = "low"
)

// ServiceDiscoverySource is a closed enum of safe evidence labels. It never
// carries process arguments, paths, env or cmdline — only which local rule
// produced the candidate.
const (
	ServiceSourceProc            = "proc"             // fd-proven pid mapping
	ServiceSourceProcComm        = "proc-comm"        // comm-only evidence (Jellyfin, fd denied)
	ServiceSourceDockerProxy     = "docker-proxy"     // docker-proxy host-port mapping
	ServiceSourceHTTPFingerprint = "http-fingerprint" // confirmed via loopback HTTP fingerprint
)

// NameSource is the closed enum of the additive nullable `name_source`
// field: which local rule produced the candidate's display name. It is a
// safe label only — never a path, argv, env or file content. `fingerprint`
// is the verified Jellyfin HTTP fingerprint; `fallback` means no process
// metadata was attributable and the name is the "Usługa na porcie N" port
// label.
const (
	NameSourceExe         = "exe"          // /proc/<pid>/exe basename
	NameSourceComm        = "comm"         // /proc/<pid>/comm
	NameSourcePackageJSON = "package-json" // nearest package.json "name" (Node wrapper)
	NameSourceSystemd     = "systemd"      // systemd unit parsed from /proc/<pid>/cgroup
	NameSourceContainer   = "container"    // readable container token from cgroup metadata
	NameSourceFallback    = "fallback"     // port label, no attributable process
	NameSourceFingerprint = "fingerprint"  // loopback HTTP fingerprint (Jellyfin preset)
)

// ServiceCandidate is one locally discovered listening service. All fields
// are safe labels/numbers; no cmdline, env, stdout or body ever travels.
type ServiceCandidate struct {
	CandidateID string `json:"candidate_id"`
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Port        int    `json:"port"`
	Transport   string `json:"transport"`
	Source      string `json:"source"`
	Confidence  string `json:"confidence"`
	// Monitorable is true only for IPv4 127.0.0.1/0.0.0.0 binds: probes
	// always hit the numeric loopback literal, so LAN-specific and any
	// IPv6 bind (unsupported here) are false and must receive no checks.
	Monitorable bool `json:"monitorable"`
	// NameSource (nullable, optional) says which local rule produced Name:
	// exe | comm | package-json | systemd | container | fallback |
	// fingerprint. Null only when a sender outside discovery omits it.
	NameSource       *string `json:"name_source"`
	ProcessStartedAt *string `json:"process_started_at"`
	SuggestedPath    *string `json:"suggested_path"`
	// SuggestedStatuses is an HTTP hint; empty for TCP-only candidates.
	SuggestedStatuses []int `json:"suggested_statuses"`
	// PID is the locally proven owner process for this candidate. It is
	// never serialised: only candidate_id and process_started_at leave the
	// host, and the agent keeps the pid only for its own /proc sampling.
	PID int `json:"-"`
}

// ServiceDiscovery is the additive heartbeat block: the latest local
// snapshot. Complete is false when /proc could not be fully read — Core
// must NOT delete known candidates on an incomplete snapshot.
type ServiceDiscovery struct {
	ObservedAt string             `json:"observed_at"`
	Complete   bool               `json:"complete"`
	Candidates []ServiceCandidate `json:"candidates"`
}

// ServiceProcessMetric is one bounded per-process CPU/RSS observation for a
// discovered candidate. CPUPercent is null until a second real sample for the
// same pid+starttime exists (first sample is always null); MemoryRSSBytes is
// always measured when /proc allows it. Both are null when the process is
// ambiguous, inaccessible or gone — never a fabricated zero.
type ServiceProcessMetric struct {
	CandidateID      string   `json:"candidate_id"`
	ProcessStartedAt string   `json:"process_started_at"`
	ObservedAt       string   `json:"observed_at"`
	CPUPercent       *float64 `json:"cpu_percent"`
	MemoryRSSBytes   *uint64  `json:"memory_rss_bytes"`
}

// ServiceResult is one executed HTTP check outcome. StatusCode and ErrorCode
// are null when not applicable (never zero-valued sentinels).
type ServiceResult struct {
	CheckID        string  `json:"check_id"`
	ConfigRevision int     `json:"config_revision"`
	ObservedAt     string  `json:"observed_at"`
	OK             bool    `json:"ok"`
	StatusCode     *int    `json:"status_code"`
	LatencyMs      float64 `json:"latency_ms"`
	ErrorCode      *string `json:"error_code"`
}

// ServiceCheck is one Core-assigned check (from GET /config). Checks
// always execute on the reporting agent host against 127.0.0.1 only.
type ServiceCheck struct {
	CheckID        string `json:"check_id"`
	ConfigRevision int    `json:"config_revision"`
	CandidateID    string `json:"candidate_id"`
	Port           int    `json:"port"`
	// Transport selects execution: "http" (GET + path/status matching) or
	// "tcp" (bare loopback connect, no payload, no DNS). Absent/empty key
	// (older Core) defaults to HTTP — backward compatible.
	Transport        string `json:"transport"`
	Path             string `json:"path"`
	ExpectedStatuses []int  `json:"expected_statuses"`
	IntervalS        int    `json:"interval_s"`
	TimeoutS         int    `json:"timeout_s"`
	Enabled          bool   `json:"enabled"`
}

type EnrollRequest struct {
	EnrollToken     string   `json:"enroll_token"`
	Hostname        string   `json:"hostname"`
	AgentVersion    string   `json:"agent_version"`
	ProtocolVersion int      `json:"protocol_version"`
	Capabilities    []string `json:"capabilities"`
}

type EnrollResponse struct {
	AgentID            string `json:"agent_id"`
	Credential         string `json:"credential"`
	HeartbeatIntervalS int    `json:"heartbeat_interval_s"`
	ConfigVersion      int    `json:"config_version"`
}

type CPU struct {
	UsagePct float64 `json:"usage_pct"`
	Load1    float64 `json:"load1"`
}

type Mem struct {
	TotalB uint64 `json:"total_b"`
	UsedB  uint64 `json:"used_b"`
	AvailB uint64 `json:"avail_b"`
}

type Disk struct {
	Mount  string `json:"mount"`
	TotalB uint64 `json:"total_b"`
	UsedB  uint64 `json:"used_b"`
	AvailB uint64 `json:"avail_b"`
}

type Net struct {
	RxB   uint64  `json:"rx_b"`
	TxB   uint64  `json:"tx_b"`
	RxBps float64 `json:"rx_bps"`
	TxBps float64 `json:"tx_bps"`
}

type Metrics struct {
	CPU     CPU    `json:"cpu"`
	Mem     Mem    `json:"mem"`
	Disk    []Disk `json:"disk"`
	Net     Net    `json:"net"`
	UptimeS uint64 `json:"uptime_s"`
}

// Docker is the S1 minimal form: the S1 agent has no docker capability and
// always reports present=false (see agent/CONTRACT.md).
type Docker struct {
	Present bool `json:"present"`
}

type CommandResult struct {
	CommandID      string  `json:"command_id"`
	State          string  `json:"state"`
	Outcome        *string `json:"outcome"`
	ResultDetail   string  `json:"result_detail"`
	CompletedAt    string  `json:"completed_at"`
	IdempotencyKey string  `json:"idempotency_key"`
}

type HeartbeatRequest struct {
	Seq              uint64            `json:"seq"`
	ObservedAt       string            `json:"observed_at"`
	ConfigVersion    int               `json:"config_version"`
	Capabilities     []string          `json:"capabilities,omitempty"`
	Metrics          Metrics           `json:"metrics"`
	Docker           Docker            `json:"docker"`
	CommandResults   []CommandResult   `json:"command_results"`
	ServiceDiscovery *ServiceDiscovery `json:"service_discovery,omitempty"`
	ServiceResults   []ServiceResult   `json:"service_results,omitempty"`
	// ServiceProcessMetrics is the additive per-process block (max 64),
	// keyed by candidate_id. It never carries a pid, cmdline or environment.
	ServiceProcessMetrics []ServiceProcessMetric `json:"service_process_metrics,omitempty"`
}

type PendingCommand struct {
	CommandID      string `json:"command_id"`
	Type           string `json:"type"`
	IssuedAt       string `json:"issued_at"`
	QueueExpiresAt string `json:"queue_expires_at"`
	LeaseS         int    `json:"lease_s"`
	IdempotencyKey string `json:"idempotency_key"`
}

type HeartbeatResponse struct {
	ServerTime      string           `json:"server_time"`
	ConfigVersion   int              `json:"config_version"`
	ConfigChanged   bool             `json:"config_changed"`
	PendingCommands []PendingCommand `json:"pending_commands"`
	FullInventory   bool             `json:"full_inventory"`
}

type ServerConfig struct {
	ConfigVersion      int `json:"config_version"`
	HeartbeatIntervalS int `json:"heartbeat_interval_s"`
	QueueTTLS          int `json:"queue_ttl_s"`
	LeaseS             int `json:"lease_s"`
	ResultTTLS         int `json:"result_ttl_s"`
	// ServiceChecks carries this agent's own checks (additive v1; HTTP and
	// TCP). Absent (older Core) leaves stored checks untouched, while explicit
	// null and [] both clear the set atomically (persist + scheduler).
	ServiceChecks ServiceChecksField `json:"service_checks"`
}

// ServiceChecksField tracks presence of the additive service_checks key so
// absent can be told apart from explicit null: absent keeps the stored set
// (backwards compatibility), null/[] clear it.
type ServiceChecksField struct {
	Present bool
	Checks  []ServiceCheck
}

// UnmarshalJSON records key presence. Explicit null yields Present=true
// with no checks (clear); [] yields Present=true with an empty set.
func (f *ServiceChecksField) UnmarshalJSON(data []byte) error {
	f.Present = true
	if len(bytes.TrimSpace(data)) == 0 || string(bytes.TrimSpace(data)) == "null" {
		f.Checks = nil
		return nil
	}
	return json.Unmarshal(data, &f.Checks)
}

type RotateRequest struct {
	RotationID    string `json:"rotation_id"`
	NewCredential string `json:"new_credential"`
}

type RotateResponse struct {
	OverlapUntil string `json:"overlap_until"`
	RotationID   string `json:"rotation_id"`
}

type RotateConfirmRequest struct {
	RotationID string `json:"rotation_id"`
}
