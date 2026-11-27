package service

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"sync"
)

// UpcomingSummary describes a queued program for the start prompt. It is
// informational only and never controls the machine.
type UpcomingSummary struct {
	EstimatedMs int64          `json:"estimated_ms,omitempty"`
	Tools       []UpcomingTool `json:"tools,omitempty"`
	Notes       []string       `json:"notes,omitempty"`
	Lines       int            `json:"lines"`
}

type UpcomingTool struct {
	Number int    `json:"number"`
	Name   string `json:"name,omitempty"`
}

const upcomingSummaryNotes = 4

// Parsed summaries by file content; a revision is never parsed twice.
var upcomingSummaries sync.Map

func (s *Service) UpcomingSummary(path, md5 string) (UpcomingSummary, error) {
	entry, ok := s.store.GetEntry(path)
	if !ok || entry.IsDir || md5 == "" || entry.MD5 != md5 {
		return UpcomingSummary{}, ErrNotFound
	}
	if cached, ok := upcomingSummaries.Load(md5); ok {
		return cached.(UpcomingSummary), nil
	}
	if entry.CachePath == "" {
		return UpcomingSummary{}, ErrNotCached
	}
	file, err := os.Open(entry.CachePath)
	if err != nil {
		return UpcomingSummary{}, ErrNotCached
	}
	defer file.Close()
	preview, _, err := parseGcodePreviewWithFeed(file, s.machineFeedProfile())
	if err != nil {
		return UpcomingSummary{}, fmt.Errorf("read program: %w", err)
	}
	summary := UpcomingSummary{EstimatedMs: preview.EstimatedDurationMs, Lines: preview.LineCount}
	named := map[int]string{}
	for _, tool := range preview.ToolMetadata {
		named[tool.Number] = tool.Name
	}
	for _, number := range preview.Tools {
		summary.Tools = append(summary.Tools, UpcomingTool{Number: number, Name: named[number]})
	}
	if _, err := file.Seek(0, 0); err == nil {
		summary.Notes = leadingGcodeNotes(bufio.NewScanner(file), upcomingSummaryNotes)
	}
	upcomingSummaries.Store(md5, summary)
	return summary, nil
}

// leadingGcodeNotes returns the first descriptive comments of a program, such
// as a CAM post's program name or Sensei's own description. Tool table lines
// and internal setup markers are skipped; reading stops at the first motion.
func leadingGcodeNotes(scanner *bufio.Scanner, limit int) []string {
	var notes []string
	for lines := 0; scanner.Scan() && lines < 80 && len(notes) < limit; lines++ {
		text := strings.TrimSpace(scanner.Text())
		if text == "" || text == "%" {
			continue
		}
		var note string
		switch {
		case strings.HasPrefix(text, ";"):
			note = strings.TrimSpace(strings.TrimLeft(text, ";"))
		case strings.HasPrefix(text, "(") && strings.HasSuffix(text, ")"):
			note = strings.TrimSpace(text[1 : len(text)-1])
		default:
			switch strings.ToUpper(strings.Fields(text)[0]) {
			case "G0", "G00", "G1", "G01", "G2", "G02", "G3", "G03":
				return notes
			}
			continue
		}
		if note == "" || gcodeToolCommentRE.MatchString(note) || strings.HasPrefix(note, "Sensei alignment setup") || cadMachineNote(note) {
			continue
		}
		if len(note) > 120 {
			note = note[:117] + "..."
		}
		notes = append(notes, note)
	}
	return notes
}

// Fusion and similar posts list the machine (vendor, model) in the header;
// it says nothing about this job.
func cadMachineNote(note string) bool {
	lower := strings.ToLower(note)
	if lower == "machine" || !strings.ContainsAny(lower, "abcdefghijklmnopqrstuvwxyz0123456789") {
		return true
	}
	for _, prefix := range []string{"vendor:", "model:", "description:"} {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	return false
}
