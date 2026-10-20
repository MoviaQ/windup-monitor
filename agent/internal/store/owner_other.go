//go:build !unix

package store

import "os"

// checkOwner is a no-op where the owner is not observable; the caller still
// enforces the 0700 mode and the directory type.
func checkOwner(path string, fi os.FileInfo) error { return nil }
