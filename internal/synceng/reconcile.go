package synceng

import (
	"context"
	"log"
	"os"
	"path"
	"time"

	"github.com/uwin/cnc-proxy/internal/client"
	"github.com/uwin/cnc-proxy/internal/protocol"
	"github.com/uwin/cnc-proxy/internal/service"
	"github.com/uwin/cnc-proxy/internal/session"
	"github.com/uwin/cnc-proxy/internal/store"
)

// settledStates are the catalog states a reconcile sweep is allowed to touch.
// Anything else (pending_upload, uploading, pending_delete, deleting,
// pending_rename, error) represents a local intention still in flight, which
// reconcile must not clobber.
func isSettled(s store.SyncState) bool {
	return s == store.Synced || s == store.RemoteOnly
}

// Reconcile walks the machine's gcode tree and folds the result into the
// catalog, so files added, changed, or removed out-of-band (e.g. by the
// official controller) become visible. It runs through the arbiter and so only
// proceeds in owner mode with an idle machine; otherwise it returns the
// arbiter's error and changes nothing.
//
// It is conservative: it only adds previously-unknown files (as remote_only),
// flips settled entries whose size changed back to remote_only (so the next
// read re-fetches), and drops settled entries that vanished from the machine.
// In-flight entries are left untouched.
func (e *Engine) Reconcile(maxDepth int) error {
	return e.reconcile(maxDepth, false)
}

// DeepReconcile performs the metadata reconcile plus MD5 checks for cached
// synced files. It is intentionally separate from the frequent metadata sweep:
// md5sum is slower and firmware-shaped, but it catches same-size out-of-band
// edits that listing metadata alone cannot distinguish.
func (e *Engine) DeepReconcile(maxDepth int) error {
	return e.reconcile(maxDepth, true)
}

// PrepareStartupCacheValidation makes persisted startup state conservative:
// interrupted running jobs become visible failed jobs, and synced cache entries
// are blocked until the machine confirms they still match. It only touches local
// catalog/cache state.
func (e *Engine) PrepareStartupCacheValidation() error {
	if err := e.recoverInterruptedJobs(); err != nil {
		return err
	}
	for _, existing := range e.store.ListEntries() {
		if existing.IsDir {
			if existing.CacheState != store.CacheNone || !existing.CacheCheckedAt.IsZero() {
				existing.CacheState = store.CacheNone
				existing.CacheCheckedAt = time.Time{}
				if err := e.store.PutEntry(existing); err != nil {
					return err
				}
			}
			continue
		}
		if existing.Sync == store.RemoteOnly {
			changed := false
			if existing.CachePath != "" {
				_ = os.Remove(existing.CachePath)
				existing.CachePath = ""
				changed = true
			}
			if existing.CacheState != store.CacheNone || !existing.CacheCheckedAt.IsZero() {
				existing.CacheState = store.CacheNone
				existing.CacheCheckedAt = time.Time{}
				changed = true
			}
			if changed {
				if err := e.store.PutEntry(existing); err != nil {
					return err
				}
			}
			continue
		}
		if existing.CachePath == "" {
			changed := false
			if existing.Sync == store.Synced {
				existing.Sync = store.RemoteOnly
				existing.Error = ""
				changed = true
			}
			if existing.CacheState != store.CacheNone || !existing.CacheCheckedAt.IsZero() {
				existing.CacheState = store.CacheNone
				existing.CacheCheckedAt = time.Time{}
				changed = true
			}
			if changed {
				if err := e.store.PutEntry(existing); err != nil {
					return err
				}
			}
			continue
		}
		if existing.Sync == store.Synced {
			if _, err := os.Stat(existing.CachePath); os.IsNotExist(err) {
				existing.CachePath = ""
				existing.CacheState = store.CacheNone
				existing.CacheCheckedAt = time.Time{}
				existing.Sync = store.RemoteOnly
				existing.Error = ""
				if err := e.store.PutEntry(existing); err != nil {
					return err
				}
				continue
			}
			if existing.CacheState != store.CacheValidating || !existing.CacheCheckedAt.IsZero() {
				existing.CacheState = store.CacheValidating
				existing.CacheCheckedAt = time.Time{}
				existing.Error = ""
				if err := e.store.PutEntry(existing); err != nil {
					return err
				}
			}
			continue
		}
		if existing.CacheState != store.CacheReady || !existing.CacheCheckedAt.IsZero() {
			existing.CacheState = store.CacheReady
			existing.CacheCheckedAt = time.Time{}
			if err := e.store.PutEntry(existing); err != nil {
				return err
			}
		}
	}
	return nil
}

func (e *Engine) recoverInterruptedJobs() error {
	msg := "proxy restarted while this job was running; inspect the machine state and retry manually"
	return e.store.Batch(func(b *store.Batch) error {
		for _, job := range b.ListJobs() {
			if job.State != store.Running {
				continue
			}
			b.UpdateJob(job.ID, func(j *store.Job) {
				j.State = store.Failed
				j.LastError = msg
			})
		}
		return nil
	})
}

// ValidateStartupCache checks validation-pending cache entries against the
// machine. Matching entries become cache-ready; changed or missing entries lose
// their cache reference. Transient md5sum failures leave that entry validating.
func (e *Engine) ValidateStartupCache(maxDepth int) error {
	candidates := e.startupCacheValidationCandidates()
	if len(candidates) == 0 {
		return nil
	}
	var remote map[string]protocol.DirEntry
	results := map[string]cacheValidationResult{}
	err := e.arb.WithMachine(true, func(c *client.Conn) error {
		var lerr error
		remote, lerr = listTree(c, service.GcodeRoot, maxDepth, e.opTimeout)
		if lerr != nil {
			return lerr
		}
		results, lerr = e.checkCachedEntries(c, remote, candidates)
		return lerr
	})
	if err != nil {
		return err
	}
	e.applyCacheValidationResults(candidates, results)
	return nil
}

func (e *Engine) RunStartupCacheValidation(ctx context.Context, interval time.Duration, maxDepth int) {
	if interval <= 0 {
		interval = 5 * time.Second
	}
	for {
		if !e.hasStartupCacheValidationPending() {
			return
		}
		if err := e.ValidateStartupCache(maxDepth); err != nil {
			if !isBlocked(err) {
				log.Printf("synceng: startup cache validation error: %v", err)
			}
		}
		if !e.hasStartupCacheValidationPending() {
			return
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (e *Engine) reconcile(maxDepth int, deep bool) error {
	var remote map[string]protocol.DirEntry
	err := e.arb.WithMachine(true, func(c *client.Conn) error {
		var lerr error
		remote, lerr = listTree(c, service.GcodeRoot, maxDepth, e.opTimeout)
		if lerr == nil && deep {
			lerr = e.deepCheck(c, remote)
		}
		return lerr
	})
	if err != nil {
		return err
	}

	// Index existing catalog entries.
	known := map[string]store.Entry{}
	for _, en := range e.store.ListEntries() {
		known[en.Path] = en
	}

	// Add or update from the remote view.
	for p, de := range remote {
		existing, ok := known[p]
		if !ok {
			// Re-check under the store lock: a local upload may have published
			// this path while the machine listing was in flight.
			if err := e.putDiscoveredIfAbsent(store.Entry{
				Path:  p,
				IsDir: de.IsDir,
				Size:  de.Size,
				MTime: de.MTime,
				Sync:  syncStateFor(de),
			}); err != nil {
				log.Printf("synceng: failed to record discovered file %s: %v", p, err)
			}
			continue
		}
		if de.IsDir || existing.IsDir {
			continue
		}
		// A settled file whose machine metadata changed: re-fetch on next read.
		// For freshly uploaded synced files, local mtime and machine mtime are
		// often different even when content is identical, so mtime alone only
		// invalidates remote_only entries. DeepReconcile uses md5sum for synced
		// cached files to catch same-size content changes without that false hit.
		if isSettled(existing.Sync) && (existing.Size != de.Size || remoteOnlyMTimeChanged(existing, de)) {
			e.markRemoteOnly(existing, de, "")
		}
	}

	// Drop settled entries that disappeared from the machine.
	for p, en := range known {
		if _, stillThere := remote[p]; stillThere {
			continue
		}
		if isSettled(en.Sync) {
			if err := e.deleteEntryIfUnchanged(en); err != nil {
				log.Printf("synceng: failed to drop missing settled entry %s: %v", p, err)
			}
		}
	}
	return nil
}

func (e *Engine) putDiscoveredIfAbsent(entry store.Entry) error {
	return e.store.Batch(func(b *store.Batch) error {
		if _, exists := b.GetEntry(entry.Path); !exists {
			b.PutEntry(entry)
		}
		return nil
	})
}

func sameReconcileEntry(current, snapshot store.Entry) bool {
	return current.Path == snapshot.Path &&
		current.IsDir == snapshot.IsDir &&
		current.Size == snapshot.Size &&
		current.MD5 == snapshot.MD5 &&
		current.CachePath == snapshot.CachePath &&
		current.CacheState == snapshot.CacheState &&
		current.Sync == snapshot.Sync &&
		current.UpdatedAt.Equal(snapshot.UpdatedAt)
}

func (e *Engine) deleteEntryIfUnchanged(snapshot store.Entry) error {
	return e.store.Batch(func(b *store.Batch) error {
		current, ok := b.GetEntry(snapshot.Path)
		if ok && sameReconcileEntry(current, snapshot) {
			b.DeleteEntry(snapshot.Path)
		}
		return nil
	})
}

func remoteOnlyMTimeChanged(existing store.Entry, de protocol.DirEntry) bool {
	return existing.Sync == store.RemoteOnly && !existing.MTime.IsZero() && !de.MTime.IsZero() && !existing.MTime.Equal(de.MTime)
}

func (e *Engine) deepCheck(c *client.Conn, remote map[string]protocol.DirEntry) error {
	for _, existing := range e.store.ListEntries() {
		if existing.Sync != store.Synced || existing.IsDir || existing.CachePath == "" || existing.CacheState == store.CacheNone {
			continue
		}
		de, ok := remote[existing.Path]
		if !ok || de.IsDir {
			continue
		}
		if existing.Size != de.Size {
			// The metadata pass below will invalidate this entry. Never mark a
			// size-changed cache ready merely because model-specific MD5 is off.
			continue
		}
		if !e.supportsMetadataMD5() {
			e.markCacheReady(existing, de, "")
			continue
		}
		remoteMD5, err := c.Md5(existing.Path, e.metadataCheckTimeout)
		if err != nil {
			log.Printf("synceng: deep reconcile md5 skipped for %s: %v", existing.Path, err)
			if client.IsConnectionError(err) {
				return err
			}
			continue
		}
		if existing.MD5 != "" && remoteMD5 != existing.MD5 {
			e.markRemoteOnly(existing, de, remoteMD5)
			continue
		}
		e.markCacheReady(existing, de, remoteMD5)
	}
	return nil
}

func (e *Engine) markRemoteOnly(existing store.Entry, de protocol.DirEntry, remoteMD5 string) {
	err := e.store.Batch(func(b *store.Batch) error {
		latest, ok := b.GetEntry(existing.Path)
		if !ok || !sameReconcileEntry(latest, existing) {
			return nil
		}
		latest.Size = de.Size
		latest.MTime = de.MTime
		latest.Sync = store.RemoteOnly
		latest.CachePath = ""
		latest.CacheState = store.CacheNone
		latest.CacheCheckedAt = time.Time{}
		latest.MD5 = remoteMD5
		latest.Error = ""
		b.PutEntry(latest)
		return nil
	})
	if err != nil {
		log.Printf("synceng: failed to mark %s remote_only: %v", existing.Path, err)
	}
}

type cacheValidationResult struct {
	remote     protocol.DirEntry
	exists     bool
	md5Checked bool
	md5        string
	md5Err     error
}

func (e *Engine) startupCacheValidationCandidates() []store.Entry {
	var out []store.Entry
	for _, existing := range e.store.ListEntries() {
		if existing.Sync != store.Synced || existing.IsDir || existing.CachePath == "" {
			continue
		}
		if existing.CacheState == store.CacheValidating || existing.CacheState == "" {
			out = append(out, existing)
		}
	}
	return out
}

func (e *Engine) hasStartupCacheValidationPending() bool {
	return len(e.startupCacheValidationCandidates()) > 0
}

func (e *Engine) checkCachedEntries(c *client.Conn, remote map[string]protocol.DirEntry, candidates []store.Entry) (map[string]cacheValidationResult, error) {
	results := make(map[string]cacheValidationResult, len(candidates))
	for _, existing := range candidates {
		de, ok := remote[existing.Path]
		res := cacheValidationResult{remote: de, exists: ok}
		if !ok || de.IsDir || existing.Size != de.Size {
			results[existing.Path] = res
			continue
		}
		if !e.supportsMetadataMD5() {
			results[existing.Path] = res
			continue
		}
		res.md5Checked = true
		res.md5, res.md5Err = c.Md5(existing.Path, e.metadataCheckTimeout)
		results[existing.Path] = res
		if client.IsConnectionError(res.md5Err) {
			return results, res.md5Err
		}
	}
	return results, nil
}

func (e *Engine) applyCacheValidationResults(candidates []store.Entry, results map[string]cacheValidationResult) {
	for _, candidate := range candidates {
		latest, ok := e.store.GetEntry(candidate.Path)
		if !ok || latest.Sync != store.Synced || latest.CachePath != candidate.CachePath ||
			(latest.CacheState != store.CacheValidating && latest.CacheState != "") {
			continue
		}
		res := results[candidate.Path]
		if !res.exists || res.remote.IsDir {
			if err := e.deleteEntryIfUnchanged(latest); err != nil {
				log.Printf("synceng: failed to delete invalid startup cache entry %s: %v", latest.Path, err)
			}
			continue
		}
		if latest.Size != res.remote.Size {
			e.markRemoteOnly(latest, res.remote, "")
			continue
		}
		if res.md5Checked && res.md5Err != nil {
			log.Printf("synceng: startup cache validation md5 skipped for %s: %v", latest.Path, res.md5Err)
			continue
		}
		if res.md5Checked && latest.MD5 != "" && res.md5 != latest.MD5 {
			e.markRemoteOnly(latest, res.remote, res.md5)
			continue
		}
		e.markCacheReady(latest, res.remote, res.md5)
	}
}

func (e *Engine) markCacheReady(existing store.Entry, de protocol.DirEntry, remoteMD5 string) {
	err := e.store.Batch(func(b *store.Batch) error {
		latest, ok := b.GetEntry(existing.Path)
		if !ok || !sameReconcileEntry(latest, existing) {
			return nil
		}
		latest.Size = de.Size
		latest.MTime = de.MTime
		if remoteMD5 != "" {
			latest.MD5 = remoteMD5
		}
		latest.CacheState = store.CacheReady
		latest.CacheCheckedAt = e.now()
		latest.Error = ""
		b.PutEntry(latest)
		return nil
	})
	if err != nil {
		log.Printf("synceng: failed to mark %s cache ready: %v", existing.Path, err)
	}
}

func syncStateFor(de protocol.DirEntry) store.SyncState {
	if de.IsDir {
		return store.Synced // directories have no content to fetch
	}
	return store.RemoteOnly
}

// listTree lists dir and its subdirectories up to maxDepth levels deep,
// returning a map of machine-absolute path -> entry (both files and dirs).
func listTree(c *client.Conn, root string, maxDepth int, timeout time.Duration) (map[string]protocol.DirEntry, error) {
	out := map[string]protocol.DirEntry{}
	type item struct {
		dir   string
		depth int
	}
	queue := []item{{dir: root, depth: 0}}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		entries, err := c.List(cur.dir, timeout)
		if err != nil {
			return nil, err
		}
		for _, de := range entries {
			full := path.Join(cur.dir, de.Name)
			out[full] = de
			if de.IsDir && cur.depth < maxDepth {
				queue = append(queue, item{dir: full, depth: cur.depth + 1})
			}
		}
	}
	return out, nil
}

// RunReconcile periodically reconciles, until ctx is canceled. The first sweep
// happens after one interval (the engine's job drain handles immediate needs).
func (e *Engine) RunReconcile(ctx context.Context, interval time.Duration, maxDepth int) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := e.Reconcile(maxDepth); err != nil {
				// Blocked (relay/idle) or transient: not worth logging loudly.
				if !isBlocked(err) {
					log.Printf("synceng: reconcile error: %v", err)
				}
			}
		}
	}
}

// RunDeepReconcile periodically runs the slower MD5-based reconcile until ctx is
// canceled. It is meant to run less frequently than RunReconcile.
func (e *Engine) RunDeepReconcile(ctx context.Context, interval time.Duration, maxDepth int) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := e.DeepReconcile(maxDepth); err != nil {
				if !isBlocked(err) {
					log.Printf("synceng: deep reconcile error: %v", err)
				}
			}
		}
	}
}

// isBlocked reports whether an error is the expected "can't run right now" kind
// (a controller transaction in progress, or the machine isn't idle yet).
func isBlocked(err error) bool {
	return session.Retryable(err)
}
