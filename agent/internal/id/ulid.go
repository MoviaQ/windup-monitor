// Package id provides small identifier helpers (rotation IDs, secrets)
// using only the standard library.
package id

import (
	"crypto/rand"
	"encoding/base64"
	"time"
)

// crockford is the ULID base32 alphabet.
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// NewRotationID returns "rot_" + 26-char Crockford ULID (48-bit millis +
// 80-bit crypto randomness). The protocol allows "ULID / rot_ + ULID";
// this is the canonical rot_ form.
func NewRotationID() (string, error) {
	var entropy [10]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return "", err
	}
	return "rot_" + EncodeULID(uint64(time.Now().UnixMilli()), entropy), nil
}

// EncodeULID encodes a 48-bit millisecond timestamp plus 80 bits of entropy
// as a 26-char Crockford string (top 2 bits zero, 130 bits total).
func EncodeULID(ms uint64, entropy [10]byte) string {
	var raw [16]byte
	raw[0] = byte(ms >> 40)
	raw[1] = byte(ms >> 32)
	raw[2] = byte(ms >> 24)
	raw[3] = byte(ms >> 16)
	raw[4] = byte(ms >> 8)
	raw[5] = byte(ms)
	copy(raw[6:], entropy[:])

	out := make([]byte, 0, 26)
	var acc uint32
	n := 0
	emit := func(val uint32, bits int) {
		acc = (acc << uint(bits)) | val
		n += bits
		for n >= 5 {
			n -= 5
			out = append(out, crockford[(acc>>uint(n))&0x1f])
		}
	}
	emit(0, 2) // ULID top padding bits
	for _, b := range raw {
		emit(uint32(b), 8)
	}
	return string(out)
}

// NewSecret generates a 256-bit base64url (no padding) secret for rotation.
func NewSecret() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}
