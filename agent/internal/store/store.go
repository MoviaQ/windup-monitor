// Package store persists agent credentials, the monotonic sequence counter,
// the server config snapshot and the bounded heartbeat outbox.
//
// All files are written atomically (temp file + fsync + rename + directory
// fsync) with mode 0600 inside a 0700 state directory. The sequence number
// is persisted BEFORE the envelope that carries it is sent, and startup
// reconciles with the highest envelope found on disk, so a restart never
// rolls the sequence back.
package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"windup-monitor/agent/internal/protocol"
)

const (
	// MaxOutbox is the ring capacity: at most this many unsent heartbeat
	// envelopes are kept; older ones are dropped (logged, counted) so the
	// agent never accumulates unbounded data offline.
	MaxOutbox = 20

	credFile     = "credential.json"
	rotationFile = "rotation.json"
	seqFile      = "seq"
	stateFile    = "state.json"
	checksFile   = "service_checks.json"
	outboxDir    = "outbox"
)

// Credential is the enrolled agent identity.
type Credential struct {
	AgentID    string `json:"agent_id"`
	Credential string `json:"credential"`
}

// Rotation is a pending rotation: generated locally and saved BEFORE the
// POST /rotate is sent, so a retry reuses the same rotation_id + secret.
type Rotation struct {
	RotationID string `json:"rotation_id"`
	Next       string `json:"next_credential"`
}

// ServerState mirrors the last known server config snapshot.
type ServerState struct {
	ConfigVersion      int `json:"config_version"`
	HeartbeatIntervalS int `json:"heartbeat_interval_s"`
}

// Store is a 0700 directory of 0600 files.
type Store struct{ dir string }

// Open creates the state dir (0700) if missing, enforces the 0700 contract on
// a pre-existing directory (CONTRACT §9) and reconciles the sequence counter
// with persisted envelopes.
func Open(dir string) (*Store, error) {
	if dir == "" {
		return nil, fmt.Errorf("empty state dir")
	}
	if err := ensurePrivateDir(dir); err != nil {
		return nil, fmt.Errorf("state dir: %w", err)
	}
	if err := ensurePrivateDir(filepath.Join(dir, outboxDir)); err != nil {
		return nil, fmt.Errorf("outbox dir: %w", err)
	}
	return &Store{dir: dir}, nil
}

// ensurePrivateDir makes sure path is a private directory with mode 0700.
// MkdirAll only applies 0700 to directories it creates itself, so an existing
// (e.g. packaging-created 0755) directory is tightened afterwards. Safety:
//
//   - a path reached through a symlink is NEVER chmod'ed: the resolved target
//     must already be 0700 (the operator fixes it explicitly), so the agent
//     cannot re-mode an arbitrary directory chosen by a link;
//   - a directory owned by another user is refused instead of re-moded, so a
//     shared/foreign directory never becomes the agent's credential store.
func ensurePrivateDir(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return fmt.Errorf("create: %w", err)
	}
	link, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("stat: %w", err)
	}
	if link.Mode()&os.ModeSymlink != 0 {
		target, err := filepath.EvalSymlinks(path)
		if err != nil {
			return fmt.Errorf("resolve symlink: %w", err)
		}
		fi, err := os.Stat(target)
		if err != nil {
			return fmt.Errorf("stat symlink target: %w", err)
		}
		if !fi.IsDir() {
			return fmt.Errorf("%s is not a directory", path)
		}
		if err := checkOwner(path, fi); err != nil {
			return err
		}
		if fi.Mode().Perm() != 0o700 {
			return fmt.Errorf("%s is a symlink to a directory with mode %04o (want 0700); chmod %s manually", path, fi.Mode().Perm(), target)
		}
		return nil
	}
	fi, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("stat: %w", err)
	}
	if !fi.IsDir() {
		return fmt.Errorf("%s is not a directory", path)
	}
	if err := checkOwner(path, fi); err != nil {
		return err
	}
	if fi.Mode().Perm() != 0o700 {
		if err := os.Chmod(path, 0o700); err != nil {
			return fmt.Errorf("chmod 0700: %w", err)
		}
	}
	return nil
}

// Dir returns the state directory path.
func (s *Store) Dir() string { return s.dir }

// writeAtomic writes data to name atomically with mode 0600.
func (s *Store) writeAtomic(name string, data []byte) error {
	tmp, err := os.CreateTemp(s.dir, "."+name+".*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	// Best effort cleanup; success path renames away.
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, filepath.Join(s.dir, name)); err != nil {
		return err
	}
	return fsyncDir(s.dir)
}

func fsyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// SaveCredential stores the enrolled identity (0600, atomic).
func (s *Store) SaveCredential(c Credential) error {
	raw, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return s.writeAtomic(credFile, raw)
}

// LoadCredential returns the enrolled identity.
func (s *Store) LoadCredential() (Credential, bool, error) {
	var c Credential
	raw, err := os.ReadFile(filepath.Join(s.dir, credFile))
	if os.IsNotExist(err) {
		return c, false, nil
	}
	if err != nil {
		return c, false, err
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return c, false, fmt.Errorf("parse credential file: %w", err)
	}
	if c.AgentID == "" || c.Credential == "" {
		return c, false, fmt.Errorf("credential file incomplete")
	}
	return c, true, nil
}

// ClearCredentials deletes credential + rotation files (revocation path).
func (s *Store) ClearCredentials() error {
	var first error
	for _, n := range []string{credFile, rotationFile} {
		if err := os.Remove(filepath.Join(s.dir, n)); err != nil && !os.IsNotExist(err) {
			if first == nil {
				first = err
			}
		}
	}
	if err := fsyncDir(s.dir); err != nil && first == nil {
		first = err
	}
	return first
}

// SaveRotation persists a pending rotation BEFORE it is sent.
func (s *Store) SaveRotation(r Rotation) error {
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return s.writeAtomic(rotationFile, raw)
}

// LoadRotation returns a pending rotation, if any.
func (s *Store) LoadRotation() (Rotation, bool, error) {
	var r Rotation
	raw, err := os.ReadFile(filepath.Join(s.dir, rotationFile))
	if os.IsNotExist(err) {
		return r, false, nil
	}
	if err != nil {
		return r, false, err
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return r, false, fmt.Errorf("parse rotation file: %w", err)
	}
	if r.RotationID == "" || r.Next == "" {
		return r, false, fmt.Errorf("rotation file incomplete")
	}
	return r, true, nil
}

// ClearRotation drops the pending rotation (after confirm/promotion).
func (s *Store) ClearRotation() error {
	if err := os.Remove(filepath.Join(s.dir, rotationFile)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return fsyncDir(s.dir)
}

// lastSeq reads the persisted counter and reconciles it with the highest
// envelope on disk (crash between envelope write and counter write can
// otherwise roll the sequence back on restart).
func (s *Store) lastSeq() (uint64, error) {
	var last uint64
	raw, err := os.ReadFile(filepath.Join(s.dir, seqFile))
	switch {
	case os.IsNotExist(err):
		last = 0
	case err != nil:
		return 0, err
	default:
		n, perr := strconv.ParseUint(strings.TrimSpace(string(raw)), 10, 64)
		if perr != nil {
			return 0, fmt.Errorf("parse seq file: %w", perr)
		}
		last = n
	}
	seqs, err := s.listEnvelopes()
	if err != nil {
		return 0, err
	}
	if len(seqs) > 0 && seqs[len(seqs)-1] > last {
		last = seqs[len(seqs)-1]
	}
	return last, nil
}

// NextSeq allocates and persists the next sequence number. It is called
// BEFORE the envelope is written/sent, so a crash can only leave a gap
// (never a reuse) in the sequence.
func (s *Store) NextSeq() (uint64, error) {
	last, err := s.lastSeq()
	if err != nil {
		return 0, err
	}
	next := last + 1
	if err := s.writeAtomic(seqFile, []byte(strconv.FormatUint(next, 10)+"\n")); err != nil {
		return 0, err
	}
	return next, nil
}

func envelopeName(seq uint64) string {
	return filepath.Join(outboxDir, fmt.Sprintf("%020d.json", seq))
}

// SaveEnvelope persists one heartbeat envelope for seq (retry sends these
// exact bytes; the payload is never regenerated for the same seq).
func (s *Store) SaveEnvelope(seq uint64, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Join(s.dir, outboxDir), ".env.*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, filepath.Join(s.dir, envelopeName(seq))); err != nil {
		return err
	}
	return fsyncDir(filepath.Join(s.dir, outboxDir))
}

func (s *Store) listEnvelopes() ([]uint64, error) {
	entries, err := os.ReadDir(filepath.Join(s.dir, outboxDir))
	if err != nil {
		return nil, err
	}
	var seqs []uint64
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".json") || strings.HasPrefix(name, ".") {
			continue
		}
		n, err := strconv.ParseUint(strings.TrimSuffix(name, ".json"), 10, 64)
		if err != nil {
			continue
		}
		seqs = append(seqs, n)
	}
	sort.Slice(seqs, func(i, j int) bool { return seqs[i] < seqs[j] })
	return seqs, nil
}

// ListEnvelopes returns persisted unsent sequence numbers, ascending.
func (s *Store) ListEnvelopes() ([]uint64, error) { return s.listEnvelopes() }

// ReadEnvelope returns the exact bytes persisted for seq.
func (s *Store) ReadEnvelope(seq uint64) ([]byte, error) {
	return os.ReadFile(filepath.Join(s.dir, envelopeName(seq)))
}

// DeleteEnvelope removes the envelope after the server accepted it (or
// after a terminal poison verdict such as INVALID_BODY / STALE_SEQ).
func (s *Store) DeleteEnvelope(seq uint64) error {
	err := os.Remove(filepath.Join(s.dir, envelopeName(seq)))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// OutboxLen returns the number of buffered envelopes.
func (s *Store) OutboxLen() (int, error) {
	seqs, err := s.listEnvelopes()
	if err != nil {
		return 0, err
	}
	return len(seqs), nil
}

// PruneOutbox drops the oldest envelopes beyond max, returning how many
// were dropped. The queue is bounded: never infinite, never unbounded.
func (s *Store) PruneOutbox(max int) (int, error) {
	seqs, err := s.listEnvelopes()
	if err != nil {
		return 0, err
	}
	dropped := 0
	for len(seqs)-dropped > max {
		if err := s.DeleteEnvelope(seqs[dropped]); err != nil {
			return dropped, err
		}
		dropped++
	}
	return dropped, nil
}

// SaveState persists the server config snapshot.
func (s *Store) SaveState(st ServerState) error {
	raw, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return s.writeAtomic(stateFile, raw)
}

// LoadState returns the server config snapshot (zero value if none).
func (s *Store) LoadState() (ServerState, error) {
	var st ServerState
	raw, err := os.ReadFile(filepath.Join(s.dir, stateFile))
	if os.IsNotExist(err) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	if err := json.Unmarshal(raw, &st); err != nil {
		return st, fmt.Errorf("parse state file: %w", err)
	}
	return st, nil
}

// ServiceChecksState is the persisted Core-assigned HTTP check set: this
// agent's own checks only. Restored at startup so a restart keeps probing
// with the last known config until /config is safely refreshed.
type ServiceChecksState struct {
	ConfigRevision int                     `json:"config_revision"`
	Checks         []protocol.ServiceCheck `json:"checks"`
}

// SaveServiceChecks persists the assigned check set (0600, atomic).
func (s *Store) SaveServiceChecks(st ServiceChecksState) error {
	if st.Checks == nil {
		st.Checks = []protocol.ServiceCheck{}
	}
	raw, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return s.writeAtomic(checksFile, raw)
}

// LoadServiceChecks returns the stored check set. present=false when no
// config was ever received (fresh agent / older Core without the key).
func (s *Store) LoadServiceChecks() (ServiceChecksState, bool, error) {
	var st ServiceChecksState
	raw, err := os.ReadFile(filepath.Join(s.dir, checksFile))
	if os.IsNotExist(err) {
		return st, false, nil
	}
	if err != nil {
		return st, false, err
	}
	if err := json.Unmarshal(raw, &st); err != nil {
		return st, false, fmt.Errorf("parse service checks file: %w", err)
	}
	if st.Checks == nil {
		st.Checks = []protocol.ServiceCheck{}
	}
	return st, true, nil
}
