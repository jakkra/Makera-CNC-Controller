package protocol

import "testing"

func TestParsePlayStatus(t *testing.T) {
	const digest = "0123456789abcdef0123456789abcdef"
	got, err := ParsePlayStatus([]byte("/sd/gcodes/my\x01job.nc|" + digest + "\r\n"))
	if err != nil {
		t.Fatal(err)
	}
	if got.Path != "/sd/gcodes/my job.nc" || got.MD5 != digest {
		t.Fatalf("play status = %+v", got)
	}

	none, err := ParsePlayStatus([]byte("|"))
	if err != nil || none.Path != "" || none.MD5 != "" {
		t.Fatalf("empty play status = %+v, %v", none, err)
	}
}

func TestParsePlayStatusRejectsMalformedPayload(t *testing.T) {
	for _, payload := range []string{"missing separator", "/sd/gcodes/a.nc|bad", "/sd/gcodes/a.nc|0123456789abcdef0123456789abcdef|extra"} {
		if _, err := ParsePlayStatus([]byte(payload)); err == nil {
			t.Fatalf("ParsePlayStatus(%q) unexpectedly succeeded", payload)
		}
	}
}
