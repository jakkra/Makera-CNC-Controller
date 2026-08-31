package notifications

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// NtfySender publishes to a complete ntfy topic URL, for example
// https://ntfy.example.net/my-z1-topic.
type NtfySender struct {
	url    string
	token  string
	client *http.Client
}

// NewNtfySender validates and creates an ntfy sender. Token is optional for a
// topic whose server does not require authentication.
func NewNtfySender(topicURL, token string) (*NtfySender, error) {
	parsed, err := url.Parse(strings.TrimSpace(topicURL))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || strings.Trim(parsed.Path, "/") == "" {
		return nil, fmt.Errorf("notifications: ntfy URL must be a complete http(s) topic URL")
	}
	if parsed.User != nil {
		return nil, fmt.Errorf("notifications: ntfy URL must not contain credentials; use the token option")
	}
	return &NtfySender{
		url:   parsed.String(),
		token: strings.TrimSpace(token),
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}, nil
}

func (s *NtfySender) Name() string { return "ntfy" }

// Send uses ntfy's documented POST body and notification headers. It never
// includes machine-control action buttons; Click only opens the configured UI.
func (s *NtfySender) Send(ctx context.Context, msg Message) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url, strings.NewReader(msg.Body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "text/plain; charset=utf-8")
	req.Header.Set("Title", msg.Title)
	if msg.Priority != "" {
		req.Header.Set("Priority", msg.Priority)
	}
	if len(msg.Tags) > 0 {
		req.Header.Set("Tags", strings.Join(msg.Tags, ","))
	}
	if msg.ClickURL != "" {
		req.Header.Set("Click", msg.ClickURL)
	}
	if msg.SequenceID != "" {
		req.Header.Set("Sequence-ID", msg.SequenceID)
	}
	if s.token != "" {
		req.Header.Set("Authorization", "Bearer "+s.token)
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("ntfy publish returned %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	return nil
}
