package service

import (
	"fmt"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/uwin/cnc-proxy/internal/client"
	"github.com/uwin/cnc-proxy/internal/gcodelog"
	"github.com/uwin/cnc-proxy/internal/machine"
	"github.com/uwin/cnc-proxy/internal/protocol"
	"github.com/uwin/cnc-proxy/internal/session"
	"github.com/uwin/cnc-proxy/internal/store"
)

func upcomingProgram(j store.Job, order int) store.UpcomingProgram {
	if j.Size <= 0 {
		return store.UpcomingProgram{}
	}
	switch strings.ToLower(path.Ext(j.Path)) {
	case ".nc", ".cnc", ".gcode", ".ngc", ".tap":
		return store.UpcomingProgram{ID: j.ID, Path: j.Path, MD5: j.MD5, Order: order}
	}
	return store.UpcomingProgram{}
}

type UpcomingItem struct {
	store.UpcomingProgram
	Sync  store.SyncState `json:"sync"`
	Ready bool            `json:"ready"`
}
type UpcomingState struct {
	Items    []UpcomingItem  `json:"items"`
	OfferID  int64           `json:"offer_id,omitempty"`
	OfferMs  int64           `json:"offer_ms,omitempty"`
	Transfer *store.Transfer `json:"transfer,omitempty"`
}

func (s *Service) Upcoming() UpcomingState {
	result := UpcomingState{Items: []UpcomingItem{}}
	for _, entry := range s.store.ListEntries() {
		u := entry.Upcoming
		if u.ID == 0 || u.Path != entry.Path || u.MD5 != entry.MD5 {
			continue
		}
		switch entry.Sync {
		case store.PendingUpload, store.Uploading, store.Synced, store.Error:
			result.Items = append(result.Items, UpcomingItem{UpcomingProgram: u, Sync: entry.Sync, Ready: entry.Sync == store.Synced && entry.CacheState == store.CacheReady && !u.ReadyAt.IsZero()})
		}
	}
	sort.Slice(result.Items, func(i, j int) bool {
		a, b := result.Items[i], result.Items[j]
		if a.Order != b.Order {
			if a.Order == 0 {
				return false
			}
			if b.Order == 0 {
				return true
			}
			return a.Order < b.Order
		}
		return a.ID < b.ID
	})
	s.RefreshUpcomingOffer(&result)
	return result
}

// RefreshUpcomingOffer updates the short-lived action for a status change.
// The ordered list only needs rebuilding when the catalog changes.
func (s *Service) RefreshUpcomingOffer(result *UpcomingState) {
	result.OfferID, result.OfferMs = 0, 0
	for _, item := range result.Items {
		if !item.Ready {
			continue
		}
		if remaining := s.offerRemaining(item.UpcomingProgram); remaining > 0 {
			result.OfferID = item.ID
			result.OfferMs = remaining.Milliseconds()
			break
		}
	}
	result.Transfer = s.store.Transfer()
}

func (s *Service) offerRemaining(u store.UpcomingProgram) time.Duration {
	if u.ReadyAt.IsZero() || s.arb == nil {
		return 0
	}
	tracker := s.arb.Tracker()
	state, age := tracker.Snapshot()
	if state != machine.Idle || age > s.arb.StateMaxAge() || tracker.LastNonIdle().After(u.ReadyAt) {
		return 0
	}
	return time.Until(u.ReadyAt.Add(30 * time.Second))
}

type UpcomingAction struct {
	ID        int64  `json:"id"`
	Path      string `json:"path"`
	MD5       string `json:"md5"`
	FromOffer bool   `json:"from_offer"`
}

func (s *Service) consumeUpcoming(action UpcomingAction, start bool) error {
	return s.store.Batch(func(b *store.Batch) error {
		entry, ok := b.GetEntry(action.Path)
		if !ok || entry.Upcoming.ID == 0 || entry.Upcoming.ID != action.ID || entry.Upcoming.Path != action.Path || entry.MD5 != action.MD5 || entry.Upcoming.MD5 != action.MD5 {
			return fmt.Errorf("%w: this upload is no longer in Up next", ErrActiveGcodeUnavailable)
		}
		if start && (entry.Sync != store.Synced || entry.Upcoming.ReadyAt.IsZero() || entry.CacheState != store.CacheReady) {
			return fmt.Errorf("%w: uploaded file is not ready", ErrActiveGcodeUnavailable)
		}
		if start && action.FromOffer && s.offerRemaining(entry.Upcoming) <= 0 {
			return fmt.Errorf("%w: start prompt expired", ErrActiveGcodeUnavailable)
		}
		entry.Upcoming = store.UpcomingProgram{}
		b.PutEntry(entry)
		if start {
			b.SetActiveGcodePath(entry.Path)
		}
		return nil
	})
}

func (s *Service) RemoveUpcoming(action UpcomingAction) error {
	return s.consumeUpcoming(action, false)
}

func (s *Service) StartUpcoming(action UpcomingAction) (MachineActionResult, error) {
	result := MachineActionResult{Action: "run_gcode", Path: action.Path}
	err := s.arb.WithMachine(true, func(c *client.Conn) error {
		st, err := s.queryRecoveryStatus(c)
		if err != nil {
			return err
		}
		if st.State != machine.Idle {
			return session.ErrNotIdle
		}
		// Claim the specific revision durably before issuing play, including when the
		// outcome of the write is ambiguous. Another tab cannot replay the claim.
		if err := s.consumeUpcoming(action, true); err != nil {
			return err
		}
		display := "play " + action.Path
		s.gcodeLog.Append(gcodelog.DirSend, gcodelog.SourceAPI, display)
		result.Command = display
		result.Output, err = s.sendOperatorConsole(c, ensureWireLine(protocol.PlayLine(action.Path)), client.GcodeOpts{Cap: gcodeReplyCap})
		if err != nil {
			return err
		}
		if result.Output != "" {
			s.gcodeLog.Append(gcodelog.DirRecv, gcodelog.SourceAPI, result.Output)
		}
		result.Message = "Start command sent for " + action.Path + "; playback unconfirmed."
		if observed, err := s.queryRecoveryStatus(c); err == nil && observed.State == machine.Run {
			result.Verified = true
			result.Message = "Machine running after start of " + action.Path + "."
		}
		return nil
	})
	return result, err
}
