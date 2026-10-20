package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestHeartbeatServiceKeysRoundTrip(t *testing.T) {
	path := "/System/Info/Public"
	started := "2026-10-19T11:00:00Z"
	status := 200
	nameSource := "container"
	env := HeartbeatRequest{
		Seq:            9,
		ObservedAt:     "2026-10-19T12:00:15Z",
		ConfigVersion:  8,
		Capabilities:   []string{"metrics", "service_discovery", "http_checks"},
		Metrics:        Metrics{},
		Docker:         Docker{Present: false},
		CommandResults: []CommandResult{},
		ServiceDiscovery: &ServiceDiscovery{
			ObservedAt: "2026-10-19T12:00:10Z",
			Complete:   true,
			Candidates: []ServiceCandidate{{
				CandidateID: "jellyfin-8096", Name: "Jellyfin", Kind: "jellyfin",
				Port: 8096, Transport: "http", Source: "docker-proxy",
				Confidence: "medium", Monitorable: true, NameSource: &nameSource,
				ProcessStartedAt: &started,
				SuggestedPath:    &path, SuggestedStatuses: []int{200},
			}},
		},
		ServiceResults: []ServiceResult{{
			CheckID: "chk_1", ConfigRevision: 8, ObservedAt: "2026-10-19T12:00:12Z",
			OK: true, StatusCode: &status, LatencyMs: 4.2,
		}},
	}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"service_discovery", "service_results", "capabilities"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("missing additive key %q in %s", k, raw)
		}
	}
	sd := m["service_discovery"].(map[string]any)
	for _, k := range []string{"observed_at", "complete", "candidates"} {
		if _, ok := sd[k]; !ok {
			t.Fatalf("missing discovery key %q", k)
		}
	}
	c := sd["candidates"].([]any)[0].(map[string]any)
	for _, k := range []string{"candidate_id", "name", "kind", "port", "transport", "source", "confidence", "monitorable", "name_source", "process_started_at", "suggested_path", "suggested_statuses"} {
		if _, ok := c[k]; !ok {
			t.Fatalf("missing candidate key %q", k)
		}
	}
	if c["monitorable"] != true || c["name_source"] != "container" {
		t.Fatalf("monitorable/name_source must serialise: %v", c)
	}
	r := m["service_results"].([]any)[0].(map[string]any)
	for _, k := range []string{"check_id", "config_revision", "observed_at", "ok", "status_code", "latency_ms", "error_code"} {
		if _, ok := r[k]; !ok {
			t.Fatalf("missing result key %q", k)
		}
	}
	// No arbitrary stdout/body/env/cmdline-shaped keys on the wire.
	for _, bad := range []string{"cmdline", "stdout", "body", "env", "args"} {
		if strings.Contains(string(raw), `"`+bad+`"`) {
			t.Fatalf("wire contains forbidden key %q", bad)
		}
	}
	var back HeartbeatRequest
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	if back.ServiceDiscovery == nil || len(back.ServiceDiscovery.Candidates) != 1 ||
		back.ServiceDiscovery.Candidates[0].CandidateID != "jellyfin-8096" {
		t.Fatalf("discovery roundtrip: %+v", back.ServiceDiscovery)
	}
	if len(back.ServiceResults) != 1 || !back.ServiceResults[0].OK {
		t.Fatalf("results roundtrip: %+v", back.ServiceResults)
	}
}

func TestLegacyHeartbeatWithoutServiceKeys(t *testing.T) {
	raw := []byte(`{"seq":1,"observed_at":"2026-10-19T12:00:15Z","config_version":7,` +
		`"metrics":{"cpu":{"usage_pct":1,"load1":0},"mem":{"total_b":1,"used_b":0,"avail_b":1},` +
		`"disk":[],"net":{"rx_b":0,"tx_b":0,"rx_bps":0,"tx_bps":0},"uptime_s":1},` +
		`"docker":{"present":false},"command_results":[]}`)
	var env HeartbeatRequest
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	if env.ServiceDiscovery != nil || env.ServiceResults != nil {
		t.Fatalf("legacy envelope must decode with nil service blocks: %+v", env)
	}
}

func TestServerConfigServiceChecksRoundTrip(t *testing.T) {
	raw := []byte(`{"config_version":8,"heartbeat_interval_s":15,"queue_ttl_s":300,` +
		`"lease_s":120,"result_ttl_s":600,"service_checks":[` +
		`{"check_id":"chk_1","config_revision":8,"candidate_id":"jellyfin-8096","port":8096,` +
		`"transport":"tcp","path":"/System/Info/Public","expected_statuses":[200],"interval_s":30,"timeout_s":5,"enabled":true},` +
		`{"check_id":"chk_2","config_revision":8,"candidate_id":"generic-9000","port":9000,` +
		`"path":"","expected_statuses":[],"interval_s":30,"timeout_s":5,"enabled":true}]}`)
	var sc ServerConfig
	if err := json.Unmarshal(raw, &sc); err != nil {
		t.Fatal(err)
	}
	if !sc.ServiceChecks.Present {
		t.Fatal("explicit key must set Present")
	}
	if len(sc.ServiceChecks.Checks) != 2 || sc.ServiceChecks.Checks[0].Path != "/System/Info/Public" {
		t.Fatalf("checks: %+v", sc.ServiceChecks.Checks)
	}
	// Explicit transport round-trips; an absent transport key decodes to
	// "" (the agent defaults it to HTTP — backward compatible).
	if sc.ServiceChecks.Checks[0].Transport != "tcp" {
		t.Fatalf("transport must round-trip: %+v", sc.ServiceChecks.Checks[0])
	}
	if sc.ServiceChecks.Checks[1].Transport != "" {
		t.Fatalf("absent transport must decode empty: %+v", sc.ServiceChecks.Checks[1])
	}
	var old ServerConfig
	if err := json.Unmarshal([]byte(`{"config_version":7,"heartbeat_interval_s":15}`), &old); err != nil {
		t.Fatal(err)
	}
	if old.ServiceChecks.Present {
		t.Fatal("absent key must leave Present=false (keep stored checks)")
	}
	var nulled ServerConfig
	if err := json.Unmarshal([]byte(`{"config_version":9,"service_checks":null}`), &nulled); err != nil {
		t.Fatal(err)
	}
	if !nulled.ServiceChecks.Present || nulled.ServiceChecks.Checks != nil {
		t.Fatalf("explicit null must present-clear: %+v", nulled.ServiceChecks)
	}
	var emptied ServerConfig
	if err := json.Unmarshal([]byte(`{"config_version":9,"service_checks":[]}`), &emptied); err != nil {
		t.Fatal(err)
	}
	if !emptied.ServiceChecks.Present || emptied.ServiceChecks.Checks == nil || len(emptied.ServiceChecks.Checks) != 0 {
		t.Fatalf("explicit [] must present-clear to empty: %+v", emptied.ServiceChecks)
	}
}
