// Package synceng runs the deferred-sync loop: it drains the durable job queue
// against the machine whenever the proxy owns the connection (owner mode) and
// the machine is idle. Jobs that can't run yet (controller connected, machine
// busy, machine unreachable) simply stay queued and are retried, which is what
// makes the mounted filesystem behave like Google Drive — writes are accepted
// immediately and pushed to the machine when it's free.
package synceng

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/uwin/cnc-proxy/internal/client"
	"github.com/uwin/cnc-proxy/internal/filepolicy"
	"github.com/uwin/cnc-proxy/internal/quicklz"
	"github.com/uwin/cnc-proxy/internal/session"
	"github.com/uwin/cnc-proxy/internal/store"
)

var errJobNoLongerQueued = errors.New("synceng: job is no longer queued")

type machineCompletedError struct {
	job store.Job
	err error
}

func (e machineCompletedError) Error() string {
	return fmt.Sprintf("synceng: machine completed %s %s but durable state update failed: %v", e.job.Kind, e.job.Path, e.err)
}

func (e machineCompletedError) Unwrap() error { return e.err }

const (
	defaultPostUploadCheckTimeout = 2 * time.Second
	defaultMetadataCheckTimeout   = 2 * time.Second
	zeroByteUploadSettle          = 15 * time.Second
)

// Engine executes queued jobs against the machine via the arbiter.
type Engine struct {
	store                  *store.Store
	arb                    *session.Arbiter
	opTimeout              time.Duration
	postUploadCheckTimeout time.Duration
	metadataCheckTimeout   time.Duration

	// backoff bounds. A failed job's next attempt waits up to maxBackoff.
	baseBackoff time.Duration
	maxBackoff  time.Duration
	maxAttempts int

	// compress controls whether uploads larger than quicklz.BlockSize are
	// QuickLZ-compressed when the firmware advertises ".lz" support.
	compress bool

	// ftype caches the firmware's advertised upload type ("lz" => compression
	// supported); empty until first queried on the same connection.
	mu    sync.Mutex
	ftype string

	now func() time.Time
}

// Config configures the sync engine.
type Config struct {
	Store       *store.Store
	Arbiter     *session.Arbiter
	OpTimeout   time.Duration
	BaseBackoff time.Duration
	MaxBackoff  time.Duration
	MaxAttempts int
	// PostUploadCheckTimeout bounds the best-effort md5sum after FILE_END.
	// The upload is already accepted once FILE_END arrives; this check must
	// never hold the queue for the full operation timeout.
	PostUploadCheckTimeout time.Duration
	// MetadataCheckTimeout bounds best-effort md5sum checks during periodic and
	// startup reconcile. These checks must never starve status polling for the
	// full file-operation timeout when a WiFi bridge does not answer md5sum.
	MetadataCheckTimeout time.Duration
	// Compress enables QuickLZ compression for large uploads when the firmware
	// advertises ".lz" support. Defaults to true.
	Compress *bool
}

// New creates an Engine with sensible defaults for unset fields.
func New(cfg Config) *Engine {
	if cfg.OpTimeout == 0 {
		cfg.OpTimeout = 60 * time.Second
	}
	if cfg.BaseBackoff == 0 {
		cfg.BaseBackoff = 2 * time.Second
	}
	if cfg.MaxBackoff == 0 {
		cfg.MaxBackoff = 60 * time.Second
	}
	if cfg.MaxAttempts == 0 {
		cfg.MaxAttempts = 8
	}
	if cfg.PostUploadCheckTimeout == 0 {
		cfg.PostUploadCheckTimeout = defaultPostUploadCheckTimeout
	}
	if cfg.MetadataCheckTimeout == 0 {
		cfg.MetadataCheckTimeout = defaultMetadataCheckTimeout
	}
	compress := true
	if cfg.Compress != nil {
		compress = *cfg.Compress
	}
	return &Engine{
		store:                  cfg.Store,
		arb:                    cfg.Arbiter,
		opTimeout:              cfg.OpTimeout,
		postUploadCheckTimeout: cfg.PostUploadCheckTimeout,
		metadataCheckTimeout:   cfg.MetadataCheckTimeout,
		baseBackoff:            cfg.BaseBackoff,
		maxBackoff:             cfg.MaxBackoff,
		maxAttempts:            cfg.MaxAttempts,
		compress:               compress,
		now:                    time.Now,
	}
}

// supportsMetadataMD5 is deliberately model-gated. Production Z1 firmware
// 1.1.2 does not answer the console md5sum command, while transfer handshakes
// still provide and verify MD5. Repeatedly probing md5sum would monopolize the
// serialized machine path and make otherwise healthy status appear stale.
func (e *Engine) supportsMetadataMD5() bool {
	if e.store == nil {
		return true
	}
	model := strings.ToLower(strings.TrimSpace(e.store.UISettings().Machine.Learned.Identity.Model))
	return !strings.Contains(model, "z1")
}

// Run drives the queue until ctx is canceled, polling at the given interval.
func (e *Engine) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.drain()
		}
	}
}

// drain runs queued jobs while the machine is available. It walks the queue in
// FIFO order, but a single failing or backing-off job does NOT stall unrelated
// jobs — only jobs for the SAME path are kept strictly ordered behind it (so a
// queued delete-then-reupload of one file stays correct). A session-level block
// (controller connected / machine not idle / unreachable) stops the whole pass,
// since it applies to every job equally.
//
// One job runs at a time — the machine is single-conversation.
func (e *Engine) drain() {
	// deferredPaths holds paths with an earlier job we skipped this pass; later
	// jobs for those paths must wait to preserve per-path ordering.
	deferredPaths := make(map[string]bool)
	for _, job := range e.store.QueuedJobs() {
		if jobTouchesDeferredPath(job, deferredPaths) {
			continue // an earlier job for this path is pending; keep order
		}
		if !e.shouldAttempt(job) {
			// Backing off after a failure; skip it (and later same-path jobs)
			// this pass — the next tick retries once its backoff elapses.
			deferJobPaths(job, deferredPaths)
			continue
		}
		ran, err := e.runJob(job)
		if !ran {
			// Session-level block (relay/idle/unreachable): nothing will run
			// this pass, so stop entirely and retry next tick.
			return
		}
		if err != nil {
			// Attempted but failed: defer this path (don't busy-retry within the
			// pass) but keep draining other paths.
			log.Printf("synceng: job %d (%s %s) failed: %v", job.ID, job.Kind, job.Path, err)
			deferJobPaths(job, deferredPaths)
		}
	}
}

func jobTouchesDeferredPath(job store.Job, deferred map[string]bool) bool {
	return deferred[job.Path] || (job.DestPath != "" && deferred[job.DestPath])
}

func deferJobPaths(job store.Job, deferred map[string]bool) {
	deferred[job.Path] = true
	if job.DestPath != "" {
		deferred[job.DestPath] = true
	}
}

// shouldAttempt applies per-job backoff based on attempts and last update.
func (e *Engine) shouldAttempt(j store.Job) bool {
	if j.Kind == store.JobUpload && j.Size == 0 && j.Attempts == 0 && e.now().Sub(j.CreatedAt) < zeroByteUploadSettle {
		return false
	}
	if j.Attempts == 0 {
		return true
	}
	wait := e.baseBackoff << (j.Attempts - 1)
	if wait > e.maxBackoff || wait <= 0 {
		wait = e.maxBackoff
	}
	return e.now().Sub(j.UpdatedAt) >= wait
}

// runJob attempts one job. The bool reports whether execution was actually
// attempted (false = blocked, should retry later); the error is the job's
// outcome when attempted.
func (e *Engine) runJob(job store.Job) (bool, error) {
	// Most jobs require idle; that is the firmware's constraint for file ops.
	err := e.arb.WithMachine(true, func(c *client.Conn) error {
		started, err := e.recordRunning(job)
		if err != nil {
			return err
		}
		if !started {
			return errJobNoLongerQueued
		}
		return e.execute(c, job)
	})
	switch {
	case errors.Is(err, errJobNoLongerQueued):
		return true, nil
	case session.Retryable(err):
		return false, nil // blocked (relay/idle/busy), not a failure
	case err != nil && isMachineCompletedError(err):
		if recErr := e.recordMachineCompletedFailure(job, err); recErr != nil {
			log.Printf("synceng: failed to record completed-machine persistence failure for job %d: %v", job.ID, recErr)
		}
		return true, err
	case err != nil:
		if recErr := e.recordFailure(job, err); recErr != nil {
			log.Printf("synceng: failed to record error state for job %d: %v", job.ID, recErr)
		}
		return true, err
	default:
		if err := e.recordSuccess(job); err != nil {
			err = machineCompletedError{job: job, err: err}
			if recErr := e.recordMachineCompletedFailure(job, err); recErr != nil {
				log.Printf("synceng: failed to record completed-machine persistence failure for job %d: %v", job.ID, recErr)
			}
			return true, err
		}
		return true, nil
	}
}

func isMachineCompletedError(err error) bool {
	var completed machineCompletedError
	return errors.As(err, &completed)
}

// execute performs the actual protocol operation and updates catalog state.
func (e *Engine) execute(c *client.Conn, job store.Job) error {
	if !filepolicy.IsGcodePath(job.Path) {
		return fmt.Errorf("synceng: refusing job path outside /sd/gcodes: %q", job.Path)
	}
	if job.Kind == store.JobRename && !filepolicy.IsGcodePath(job.DestPath) {
		return fmt.Errorf("synceng: refusing rename destination outside /sd/gcodes: %q", job.DestPath)
	}
	switch job.Kind {
	case store.JobMkdir:
		if err := c.Mkdir(job.Path, e.opTimeout); err != nil {
			return err
		}
		if _, _, err := e.store.SetEntrySyncIfMatch(job.Path, store.Synced, "", func(entry store.Entry) bool {
			return entry.IsDir && entry.Sync == store.PendingUpload
		}); err != nil {
			return machineCompletedError{job: job, err: err}
		}
		return nil

	case store.JobDelete:
		if _, _, err := e.store.SetEntrySyncIf(job.Path, store.Deleting, "", store.PendingDelete, store.Deleting); err != nil {
			return err
		}
		if err := c.Remove(job.Path, e.opTimeout); err != nil {
			return err
		}
		// Drop the catalog entry and its cache file on successful delete, but
		// only if the entry still represents this delete. A WebDAV replacement
		// upload may have arrived while the rm was in flight.
		if entry, ok, err := e.store.DeleteEntryIfSync(job.Path, store.PendingDelete, store.Deleting); err != nil {
			return machineCompletedError{job: job, err: err}
		} else if ok && entry.CachePath != "" {
			os.Remove(entry.CachePath)
		}
		return nil

	case store.JobRename:
		if err := c.Rename(job.Path, job.DestPath, e.opTimeout); err != nil {
			return err
		}
		// Move the catalog entry to the new path.
		if err := e.store.Batch(func(b *store.Batch) error {
			if entry, ok := b.GetEntry(job.Path); ok && renameEntryMatchesJob(entry, job) {
				if dest, exists := b.GetEntry(job.DestPath); exists && hasLocalIntent(dest.Sync) {
					b.DeleteEntry(job.Path)
					return nil
				}
				entry.Path = job.DestPath
				entry.Sync = store.Synced
				entry.Error = ""
				b.PutEntry(entry)
				b.DeleteEntry(job.Path)
			}
			return nil
		}); err != nil {
			return machineCompletedError{job: job, err: err}
		}
		return nil

	case store.JobUpload:
		if ok, err := e.setUploadJobSync(job, store.Uploading, ""); err != nil {
			return err
		} else if !ok {
			return nil
		}
		if err := e.doUpload(c, job); err != nil {
			return err
		}
		// FILE_END means the firmware accepted the transfer. It stores the
		// controller-provided MD5 sidecar during the upload, but does not make
		// this immediate md5sum part of the transfer contract. Keep it strictly
		// best-effort so a cache flush race cannot hold the queue for a minute.
		if e.postUploadCheckTimeout > 0 {
			if remoteMD5, mErr := c.Md5(job.Path, e.postUploadCheckTimeout); mErr != nil {
				log.Printf("synceng: post-upload md5 check skipped for %s: %v", job.Path, mErr)
			} else if remoteMD5 != job.MD5 {
				log.Printf("synceng: post-upload md5 mismatch for %s (got %s want %s)", job.Path, remoteMD5, job.MD5)
			}
		}
		if ok, err := e.setUploadJobSync(job, store.Synced, ""); err != nil {
			return machineCompletedError{job: job, err: err}
		} else if !ok {
			return nil
		}
		return nil

	default:
		return errors.New("synceng: unknown job kind " + string(job.Kind))
	}
}

func renameEntryMatchesJob(entry store.Entry, job store.Job) bool {
	if entry.Sync != store.PendingRename {
		return false
	}
	if job.CachePath != "" && entry.CachePath != job.CachePath {
		return false
	}
	if job.MD5 != "" && entry.MD5 != job.MD5 {
		return false
	}
	return job.Size == 0 || entry.Size == job.Size
}

func hasLocalIntent(state store.SyncState) bool {
	switch state {
	case store.LocalOnly, store.PendingUpload, store.Uploading, store.PendingDelete, store.Deleting, store.PendingRename, store.Error:
		return true
	default:
		return false
	}
}

func (e *Engine) setUploadJobSync(job store.Job, state store.SyncState, errMsg string) (bool, error) {
	_, ok, err := e.store.SetEntrySyncIfMatch(job.Path, state, errMsg, func(entry store.Entry) bool {
		if entry.IsDir {
			return false
		}
		if entry.CachePath != job.CachePath || entry.MD5 != job.MD5 || entry.Size != job.Size {
			return false
		}
		return entry.Sync == store.PendingUpload || entry.Sync == store.Uploading || entry.Sync == state
	})
	return ok, err
}

// doUpload transfers a job's file, compressing it with QuickLZ first when the
// machine supports ".lz" and the file is large enough to benefit. The MD5 sent
// and later verified is always of the UNCOMPRESSED content (the firmware
// decompresses on receipt and stores that MD5), so verification is unchanged.
func (e *Engine) doUpload(c *client.Conn, job store.Job) error {
	if !filepolicy.IsWithinDir(e.store.CacheDir(), job.CachePath) {
		return fmt.Errorf("synceng: refusing upload cache path outside cache directory")
	}
	// .bin firmware images are never compressed (matches the controller).
	if e.compress && job.Size > quicklz.BlockSize && !strings.HasSuffix(job.Path, ".bin") && e.lzSupported(c) {
		return e.uploadCompressed(c, job)
	}
	f, err := os.Open(job.CachePath)
	if err != nil {
		return err
	}
	defer f.Close()
	return c.Upload(job.Path, f, job.Size, job.MD5, e.opTimeout, nil)
}

// uploadCompressed compresses the cache file into a temporary .lz container and
// uploads it under "<path>.lz". The firmware strips the .lz suffix, decompresses
// the content, and stores it under job.Path, so the catalog path is unchanged.
func (e *Engine) uploadCompressed(c *client.Conn, job store.Job) error {
	in, err := os.Open(job.CachePath)
	if err != nil {
		return err
	}
	defer in.Close()

	tmp, err := os.CreateTemp("", "cnc-upload-*.lz")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()

	if _, err := quicklz.CompressStream(tmp, in); err != nil {
		return err
	}
	size, err := tmp.Seek(0, os.SEEK_CUR)
	if err != nil {
		return err
	}
	if _, err := tmp.Seek(0, os.SEEK_SET); err != nil {
		return err
	}
	// Upload under the .lz name; MD5 is of the uncompressed original.
	return c.Upload(job.Path+".lz", tmp, size, job.MD5, e.opTimeout, nil)
}

// lzSupported reports whether the firmware advertises ".lz" upload support,
// querying once and caching the answer. A query failure is treated as "no
// compression" so uploads still proceed uncompressed.
func (e *Engine) lzSupported(c *client.Conn) bool {
	e.mu.Lock()
	cached := e.ftype
	e.mu.Unlock()
	if cached == "" {
		t, err := c.Ftype(e.opTimeout)
		if err != nil {
			return false
		}
		e.mu.Lock()
		e.ftype = t
		e.mu.Unlock()
		cached = t
	}
	return strings.Contains(cached, "lz")
}

func (e *Engine) recordSuccess(job store.Job) error {
	return e.store.UpdateJob(job.ID, func(j *store.Job) {
		j.State = store.Done
		j.Attempts++
		j.LastError = ""
	})
}

func (e *Engine) recordRunning(job store.Job) (bool, error) {
	_, ok, err := e.store.StartJob(job.ID)
	return ok, err
}

func (e *Engine) recordFailure(job store.Job, err error) error {
	attempts := job.Attempts + 1
	terminal := attempts >= e.maxAttempts
	return e.store.Batch(func(b *store.Batch) error {
		if _, ok := b.UpdateJob(job.ID, func(j *store.Job) {
			j.Attempts = attempts
			j.LastError = err.Error()
			if terminal {
				j.State = store.Failed
			} else {
				j.State = store.Queued
			}
		}); !ok {
			return fmt.Errorf("store: job %d not found", job.ID)
		}
		state := failedEntrySyncState(job.Kind, terminal)
		e.setFailedEntrySync(b, job, state, err.Error())
		return nil
	})
}

func (e *Engine) recordMachineCompletedFailure(job store.Job, err error) error {
	msg := fmt.Sprintf("machine operation completed, but durable state update failed: %v", err)
	return e.store.Batch(func(b *store.Batch) error {
		if _, ok := b.UpdateJob(job.ID, func(j *store.Job) {
			j.Attempts++
			j.State = store.Failed
			j.LastError = msg
		}); !ok {
			return fmt.Errorf("store: job %d not found", job.ID)
		}
		e.setFailedEntrySync(b, job, store.Error, msg)
		return nil
	})
}

func (e *Engine) setFailedEntrySync(b *store.Batch, job store.Job, state store.SyncState, errMsg string) {
	switch job.Kind {
	case store.JobUpload:
		b.SetEntrySyncIfMatch(job.Path, state, errMsg, func(entry store.Entry) bool {
			if entry.IsDir {
				return false
			}
			if entry.CachePath != job.CachePath || entry.MD5 != job.MD5 || entry.Size != job.Size {
				return false
			}
			return entry.Sync == store.PendingUpload || entry.Sync == store.Uploading || entry.Sync == state
		})
	case store.JobDelete:
		b.SetEntrySyncIf(job.Path, state, errMsg, store.PendingDelete, store.Deleting)
	case store.JobRename:
		b.SetEntrySyncIf(job.Path, state, errMsg, store.PendingRename)
	case store.JobMkdir:
		b.SetEntrySyncIf(job.Path, state, errMsg, store.PendingUpload)
	default:
		b.SetEntrySyncIf(job.Path, state, errMsg, store.PendingUpload, store.PendingDelete, store.PendingRename, store.Uploading, store.Deleting)
	}
}

func failedEntrySyncState(kind store.JobKind, terminal bool) store.SyncState {
	if terminal {
		return store.Error
	}
	switch kind {
	case store.JobUpload, store.JobMkdir:
		return store.PendingUpload
	case store.JobDelete:
		return store.PendingDelete
	case store.JobRename:
		return store.PendingRename
	default:
		return store.Error
	}
}
