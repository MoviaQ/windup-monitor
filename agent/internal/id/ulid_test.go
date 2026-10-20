package id

import (
	"strings"
	"testing"
)

func TestNewRotationIDFormat(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		id, err := NewRotationID()
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(id, "rot_") {
			t.Fatalf("missing prefix: %s", id)
		}
		body := strings.TrimPrefix(id, "rot_")
		if len(body) != 26 {
			t.Fatalf("ULID part len=%d: %s", len(body), id)
		}
		for _, ch := range body {
			if !strings.ContainsRune("0123456789ABCDEFGHJKMNPQRSTVWXYZ", ch) {
				t.Fatalf("non-Crockford char %q in %s", ch, id)
			}
		}
		if seen[id] {
			t.Fatalf("duplicate id %s", id)
		}
		seen[id] = true
	}
}

func TestEncodeULIDDeterministic(t *testing.T) {
	var e [10]byte
	if EncodeULID(123456789, e) != EncodeULID(123456789, e) {
		t.Fatal("not deterministic")
	}
}

func TestNewSecretStrength(t *testing.T) {
	s1, err := NewSecret()
	if err != nil {
		t.Fatal(err)
	}
	s2, err := NewSecret()
	if err != nil {
		t.Fatal(err)
	}
	// 32 bytes -> 43 base64url chars, no padding.
	if len(s1) != 43 || strings.ContainsAny(s1, "+/=") {
		t.Fatalf("bad secret format: %q", s1)
	}
	if s1 == s2 {
		t.Fatal("secrets must differ")
	}
}
