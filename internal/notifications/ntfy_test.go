package notifications

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNtfySenderPublishesDocumentedHeaders(t *testing.T) {
	var got struct {
		method, body, title, priority, tags, click, sequence, authorization string
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got.method = r.Method
		got.body = string(body)
		got.title = r.Header.Get("Title")
		got.priority = r.Header.Get("Priority")
		got.tags = r.Header.Get("Tags")
		got.click = r.Header.Get("Click")
		got.sequence = r.Header.Get("Sequence-ID")
		got.authorization = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	sender, err := NewNtfySender(srv.URL+"/shop-z1", "secret")
	if err != nil {
		t.Fatal(err)
	}
	err = sender.Send(context.Background(), Message{
		Title: "Z1 paused", Body: "Needs input", Priority: "high", Tags: []string{"pause_button", "warning"}, ClickURL: "https://z1.tail.example/", SequenceID: "z1-attention-9",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.method != http.MethodPost || got.body != "Needs input" || got.title != "Z1 paused" || got.priority != "high" || got.tags != "pause_button,warning" || got.click != "https://z1.tail.example/" || got.sequence != "z1-attention-9" || got.authorization != "Bearer secret" {
		t.Fatalf("request = %+v", got)
	}
}

func TestNtfySenderRejectsBadURLAndReportsHTTPFailure(t *testing.T) {
	for _, raw := range []string{"", "ntfy.example/topic", "https://ntfy.example/", "https://user:pass@ntfy.example/topic"} {
		if _, err := NewNtfySender(raw, ""); err == nil {
			t.Errorf("NewNtfySender(%q) succeeded", raw)
		}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "denied", http.StatusForbidden)
	}))
	defer srv.Close()
	sender, _ := NewNtfySender(srv.URL+"/topic", "")
	if err := sender.Send(context.Background(), Message{Body: "test"}); err == nil {
		t.Fatal("Send succeeded, want HTTP failure")
	}
}
