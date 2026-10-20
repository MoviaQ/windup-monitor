package store

import (
	"os"
	"path/filepath"
	"testing"

	"windup-monitor/agent/internal/protocol"
)

func TestOpenCreatesSecureDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sub", "state")
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(st.Dir())
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o700 {
		t.Fatalf("state dir mode=%o want 700", fi.Mode().Perm())
	}
}

func TestCredentialRoundTrip0600(t *testing.T) {
	st, _ := Open(t.TempDir())
	if err := st.SaveCredential(Credential{AgentID: "ag_x", Credential: "s3cr3t"}); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(st.Dir(), "credential.json"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("credential mode=%o want 600", fi.Mode().Perm())
	}
	got, ok, err := st.LoadCredential()
	if err != nil || !ok {
		t.Fatalf("load: %v ok=%v", err, ok)
	}
	if got.AgentID != "ag_x" || got.Credential != "s3cr3t" {
		t.Fatalf("got %+v", got)
	}
}

func TestNextSeqMonotonicAndPersisted(t *testing.T) {
	st, _ := Open(t.TempDir())
	for want := uint64(1); want <= 3; want++ {
		got, err := st.NextSeq()
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("got %d want %d", got, want)
		}
	}
	// Reopen: counter survives restarts without rollback.
	st2, _ := Open(st.Dir())
	got, err := st2.NextSeq()
	if err != nil {
		t.Fatal(err)
	}
	if got != 4 {
		t.Fatalf("after reopen got %d want 4", got)
	}
}

func TestSeqReconcilesWithOrphanEnvelope(t *testing.T) {
	st, _ := Open(t.TempDir())
	// Simulate crash: envelope for seq 10 persisted, counter file at 5.
	if err := st.SaveEnvelope(10, []byte(`{"seq":10}`)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(st.Dir(), "seq"), []byte("5\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := st.NextSeq()
	if err != nil {
		t.Fatal(err)
	}
	if got != 11 {
		t.Fatalf("orphan envelope must prevent rollback: got %d want 11", got)
	}
}

func TestEnvelopeRetryIsByteIdentical(t *testing.T) {
	st, _ := Open(t.TempDir())
	payload := []byte(`{"seq":1,"metrics":{"cpu":{"usage_pct":1.5}}}`)
	if err := st.SaveEnvelope(1, payload); err != nil {
		t.Fatal(err)
	}
	got, err := st.ReadEnvelope(1)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(payload) {
		t.Fatalf("envelope mutated: %q", got)
	}
	fi, _ := os.Stat(filepath.Join(st.Dir(), "outbox", "00000000000000000001.json"))
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("envelope mode=%o want 600", fi.Mode().Perm())
	}
}

func TestPruneOutboxBounded(t *testing.T) {
	st, _ := Open(t.TempDir())
	for i := uint64(1); i <= 25; i++ {
		if _, err := st.NextSeq(); err != nil {
			t.Fatal(err)
		}
		if err := st.SaveEnvelope(i, []byte(`{}`)); err != nil {
			t.Fatal(err)
		}
	}
	dropped, err := st.PruneOutbox(MaxOutbox)
	if err != nil {
		t.Fatal(err)
	}
	if dropped != 5 {
		t.Fatalf("dropped=%d want 5", dropped)
	}
	seqs, err := st.ListEnvelopes()
	if err != nil {
		t.Fatal(err)
	}
	if len(seqs) != MaxOutbox || seqs[0] != 6 || seqs[len(seqs)-1] != 25 {
		t.Fatalf("oldest must be dropped first: %v", seqs)
	}
}

func TestRotationPersistAndClear(t *testing.T) {
	st, _ := Open(t.TempDir())
	if err := st.SaveRotation(Rotation{RotationID: "rot_1", Next: "next-secret"}); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(filepath.Join(st.Dir(), "rotation.json"))
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("rotation mode=%o want 600", fi.Mode().Perm())
	}
	got, ok, err := st.LoadRotation()
	if err != nil || !ok {
		t.Fatalf("load: %v ok=%v", err, ok)
	}
	if got.RotationID != "rot_1" || got.Next != "next-secret" {
		t.Fatalf("got %+v", got)
	}
	if err := st.ClearRotation(); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := st.LoadRotation(); ok {
		t.Fatal("rotation should be gone")
	}
}

func TestClearCredentials(t *testing.T) {
	st, _ := Open(t.TempDir())
	_ = st.SaveCredential(Credential{AgentID: "ag_x", Credential: "s"})
	_ = st.SaveRotation(Rotation{RotationID: "r", Next: "n"})
	if err := st.ClearCredentials(); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := st.LoadCredential(); ok {
		t.Fatal("credential should be gone")
	}
	if _, ok, _ := st.LoadRotation(); ok {
		t.Fatal("rotation should be gone")
	}
}

// F4: MkdirAll(0700) leaves pre-existing directories untouched — Open must
// tighten an existing 0755 state dir (and its outbox) to the 0700 contract.
func TestOpenTightensExistingLooseDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.MkdirAll(filepath.Join(dir, outboxDir), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{st.Dir(), filepath.Join(st.Dir(), outboxDir)} {
		fi, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0o700 {
			t.Fatalf("%s mode=%o want 700", p, fi.Mode().Perm())
		}
	}
}

// F4: a loose directory reached through a symlink is refused, and the target
// is NOT chmod'ed (no re-moding of an arbitrary directory chosen by a link).
func TestOpenRefusesSymlinkToLooseDirectory(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "shared")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "state")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(link); err == nil {
		t.Fatal("Open must refuse a symlink pointing to a non-0700 directory")
	}
	fi, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o755 {
		t.Fatalf("symlink target was re-moded: %o", fi.Mode().Perm())
	}
}

// F4: a symlink whose target already honours 0700 (and is owned by us) is
// accepted without any chmod through the link.
func TestOpenAcceptsSymlinkToPrivateDirectory(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "private")
	if err := os.MkdirAll(target, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "state")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	st, err := Open(link)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SaveCredential(Credential{AgentID: "ag_x", Credential: "s"}); err != nil {
		t.Fatalf("store behind symlink must stay usable: %v", err)
	}
	fi, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o700 {
		t.Fatalf("target mode=%o want 700", fi.Mode().Perm())
	}
}

// F4: a regular file at the state path is a hard error, not a silent pass.
func TestOpenRejectsNonDirectory(t *testing.T) {
	base := t.TempDir()
	file := filepath.Join(base, "state")
	if err := os.WriteFile(file, []byte("not a dir"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(file); err == nil {
		t.Fatal("Open must fail when the state path is a file")
	}
}

func TestServiceChecksRoundTrip0600(t *testing.T) {
	st, _ := Open(t.TempDir())
	if _, present, err := st.LoadServiceChecks(); err != nil || present {
		t.Fatalf("fresh store: present=%v err=%v", present, err)
	}
	in := ServiceChecksState{ConfigRevision: 8, Checks: []protocol.ServiceCheck{{
		CheckID: "chk_1", ConfigRevision: 8, CandidateID: "jellyfin-8096",
		Port: 8096, Path: "/System/Info/Public", ExpectedStatuses: []int{200},
		IntervalS: 30, TimeoutS: 5, Enabled: true,
	}}}
	if err := st.SaveServiceChecks(in); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(st.Dir(), "service_checks.json"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode=%o want 600", fi.Mode().Perm())
	}
	got, present, err := st.LoadServiceChecks()
	if err != nil || !present {
		t.Fatalf("load: %v present=%v", err, present)
	}
	if got.ConfigRevision != 8 || len(got.Checks) != 1 || got.Checks[0].CheckID != "chk_1" {
		t.Fatalf("got %+v", got)
	}
	// Reopen: checks survive restarts (restart loads existing config).
	st2, _ := Open(st.Dir())
	got2, present, err := st2.LoadServiceChecks()
	if err != nil || !present || len(got2.Checks) != 1 {
		t.Fatalf("after reopen: %+v %v %v", got2, present, err)
	}
}
