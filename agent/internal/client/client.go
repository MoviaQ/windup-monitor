// Package client is the Core HTTP API client (agent side).
//
// Transport rules enforced here: HTTPS by default; plain HTTP only to
// loopback with explicit opt-in (validated in config); system TLS roots
// plus an optional extra CA file; generous heartbeat timeout because the
// server may hold the response (long-poll up to ~25s). The client never
// logs credentials or tokens.
package client

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"windup-monitor/agent/internal/protocol"
)

const (
	// HeartbeatTimeout covers the worst-case held response (long-poll).
	HeartbeatTimeout = 45 * time.Second
	// ShortTimeout for enroll / rotate / config calls.
	ShortTimeout = 15 * time.Second
	// MaxBody caps response bodies (protocol limit is 256 KB).
	MaxBody = 1 << 20
)

// APIError is a non-2xx Core response. Msg is server-supplied detail kept
// out of Error() so logs carry only status + code, never payload text.
type APIError struct {
	Status int
	Code   string
	Msg    string
}

// IsCode reports whether the error is the given canonical protocol code.
func (e *APIError) IsCode(code string) bool { return e != nil && e.Code == code }

func (e *APIError) Error() string {
	return fmt.Sprintf("core api: http %d code=%s", e.Status, e.Code)
}

// Client talks to one Core base URL.
type Client struct {
	base string
	http *http.Client
	ua   string
}

// BuildTLS returns TLS config with system roots plus an optional PEM CA file.
func BuildTLS(caFile string) (*tls.Config, error) {
	pool, err := x509.SystemCertPool()
	if err != nil {
		pool = x509.NewCertPool()
	}
	if caFile != "" {
		raw, err := os.ReadFile(caFile)
		if err != nil {
			return nil, fmt.Errorf("read ca file: %w", err)
		}
		if !pool.AppendCertsFromPEM(raw) {
			return nil, fmt.Errorf("no certificates parsed from ca file")
		}
	}
	// NOTE: InsecureSkipVerify is never enabled; see agent/CONTRACT.md.
	return &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool}, nil
}

// New builds a client with the given transport timeout.
func New(base string, tlsCfg *tls.Config, timeout time.Duration, userAgent string) *Client {
	tr := &http.Transport{
		TLSClientConfig:   tlsCfg,
		ForceAttemptHTTP2: false,
	}
	return &Client{
		base: base,
		http: &http.Client{Transport: tr, Timeout: timeout},
		ua:   userAgent,
	}
}

// NewDefault builds the production client (heartbeat-grade timeout).
func NewDefault(base string, tlsCfg *tls.Config, userAgent string) *Client {
	return New(base, tlsCfg, HeartbeatTimeout, userAgent)
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Error   string `json:"error"`
}

func (c *Client) do(ctx context.Context, method, path, agentID, credential string, body any, out any) error {
	var rdr io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		rdr = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+"/api/v1/agent"+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set(protocol.HeaderVersion, "1")
	req.Header.Set("User-Agent", c.ua)
	if agentID != "" {
		req.Header.Set(protocol.HeaderAgentID, agentID)
	}
	if credential != "" {
		req.Header.Set("Authorization", "Bearer "+credential)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, MaxBody))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var eb errorBody
		_ = json.Unmarshal(raw, &eb)
		code := eb.Code
		msg := eb.Message
		if msg == "" {
			msg = eb.Error
		}
		if code == "" {
			code = fmt.Sprintf("HTTP_%d", resp.StatusCode)
		}
		return &APIError{Status: resp.StatusCode, Code: code, Msg: msg}
	}
	if out != nil {
		dec := json.NewDecoder(bytes.NewReader(raw))
		if err := dec.Decode(out); err != nil {
			return fmt.Errorf("decode response (malformed): %w", err)
		}
	}
	return nil
}

// Enroll exchanges a one-time token for agent credentials. No Authorization
// header is sent; the token travels once in the JSON body over TLS.
func (c *Client) Enroll(ctx context.Context, token, hostname, agentVersion string, caps []string) (*protocol.EnrollResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, ShortTimeout)
	defer cancel()
	req := protocol.EnrollRequest{
		EnrollToken:     token,
		Hostname:        hostname,
		AgentVersion:    agentVersion,
		ProtocolVersion: protocol.Version,
		Capabilities:    caps,
	}
	var out protocol.EnrollResponse
	if err := c.do(ctx, http.MethodPost, "/enroll", "", "", req, &out); err != nil {
		return nil, err
	}
	if out.AgentID == "" || out.Credential == "" {
		return nil, fmt.Errorf("enroll response incomplete (malformed)")
	}
	return &out, nil
}

// Heartbeat posts one stored envelope (bytes are written by the caller from
// the outbox so retries send the identical payload).
func (c *Client) Heartbeat(ctx context.Context, agentID, credential string, envelope []byte) (*protocol.HeartbeatResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/api/v1/agent/heartbeat", bytes.NewReader(envelope))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set(protocol.HeaderVersion, "1")
	req.Header.Set("User-Agent", c.ua)
	req.Header.Set(protocol.HeaderAgentID, agentID)
	req.Header.Set("Authorization", "Bearer "+credential)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, MaxBody))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var eb errorBody
		_ = json.Unmarshal(raw, &eb)
		code := eb.Code
		msg := eb.Message
		if msg == "" {
			msg = eb.Error
		}
		if code == "" {
			code = fmt.Sprintf("HTTP_%d", resp.StatusCode)
		}
		return nil, &APIError{Status: resp.StatusCode, Code: code, Msg: msg}
	}
	var out protocol.HeartbeatResponse
	if err := json.NewDecoder(bytes.NewReader(raw)).Decode(&out); err != nil {
		return nil, fmt.Errorf("decode response (malformed): %w", err)
	}
	return &out, nil
}

// FetchConfig pulls the canonical server config (CONFIG_STALE path).
func (c *Client) FetchConfig(ctx context.Context, agentID, credential string) (*protocol.ServerConfig, error) {
	ctx, cancel := context.WithTimeout(ctx, ShortTimeout)
	defer cancel()
	var out protocol.ServerConfig
	if err := c.do(ctx, http.MethodGet, "/config", agentID, credential, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Rotate registers the locally pre-generated next credential.
func (c *Client) Rotate(ctx context.Context, agentID, credential, rotationID, next string) (*protocol.RotateResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, ShortTimeout)
	defer cancel()
	req := protocol.RotateRequest{RotationID: rotationID, NewCredential: next}
	var out protocol.RotateResponse
	if err := c.do(ctx, http.MethodPost, "/rotate", agentID, credential, req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RotateConfirm promotes the pending rotation (Bearer = next credential).
func (c *Client) RotateConfirm(ctx context.Context, agentID, nextCred, rotationID string) error {
	ctx, cancel := context.WithTimeout(ctx, ShortTimeout)
	defer cancel()
	req := protocol.RotateConfirmRequest{RotationID: rotationID}
	return c.do(ctx, http.MethodPost, "/rotate_confirm", agentID, nextCred, req, nil)
}
