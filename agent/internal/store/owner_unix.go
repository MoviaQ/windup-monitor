//go:build unix

package store

import (
	"fmt"
	"os"
	"syscall"
)

// checkOwner refuses a directory that belongs to a different user: the agent
// must never chmod (or store its credentials inside) a shared/foreign
// directory. Verified whenever the platform exposes the owner (unix).
func checkOwner(path string, fi os.FileInfo) error {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}
	if st.Uid != uint32(os.Geteuid()) {
		return fmt.Errorf("%s is owned by uid %d, not the effective user %d: refusing to re-mode a foreign directory", path, st.Uid, os.Geteuid())
	}
	return nil
}
