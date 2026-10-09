package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The reason this command exists is that a hand-rolled curl plus a throwaway
// parser turns a broken call into an empty answer. So the tests that matter
// most here are the negative ones: every failure must surface as an error the
// caller cannot ignore, never as a zero value.

func newClient(h http.HandlerFunc) (*Client, *httptest.Server) {
	srv := httptest.NewServer(h)
	return &Client{base: srv.URL, httpc: &http.Client{Timeout: 2 * time.Second}}, srv
}

func TestNon2xxBecomesAnErrorCarryingStatusAndBody(t *testing.T) {
	c, srv := newClient(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"detail":"Not Found"}`))
	})
	defer srv.Close()

	var out docOut
	err := c.do(context.Background(), "GET", "/api/doc?path=missing.md", nil, &out)
	if err == nil {
		t.Fatal("a 404 returned no error — this is the exact failure the command exists to prevent")
	}
	for _, want := range []string{"404", "Not Found"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error should name %q so the cause is visible, got: %v", want, err)
		}
	}
	if out.Content != "" {
		t.Fatalf("a failed read must not yield content, got %q", out.Content)
	}
}

func TestUnreachableWriterSaysSoRatherThanLookingEmpty(t *testing.T) {
	c, srv := newClient(func(http.ResponseWriter, *http.Request) {})
	srv.Close() // nothing is listening now

	var out docOut
	err := c.do(context.Background(), "GET", "/api/doc?path=x.md", nil, &out)
	if err == nil {
		t.Fatal("a dead writer returned no error")
	}
	if !strings.Contains(err.Error(), "not an empty result") {
		t.Fatalf("the error must distinguish 'down' from 'nothing there', got: %v", err)
	}
}

func TestAWrongShapedBodyIsAnErrorNotASilentZeroValue(t *testing.T) {
	c, srv := newClient(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`["not", "an", "object"]`)) // 200, but the wrong shape
	})
	defer srv.Close()

	var out docOut
	err := c.do(context.Background(), "GET", "/api/doc?path=x.md", nil, &out)
	if err == nil {
		t.Fatal("a 200 with the wrong shape decoded silently into a zero value")
	}
	if !strings.Contains(err.Error(), "did not match the expected shape") {
		t.Fatalf("error should say the shape was wrong, got: %v", err)
	}
}

func TestSuccessDecodesTheFieldsWeActuallyUse(t *testing.T) {
	c, srv := newClient(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("path"); got != "design/network-access.md" {
			t.Errorf("path not passed through: %q", got)
		}
		w.Write([]byte(`{"path":"design/network-access.md","title":"network-access.md","content":"body","hash":"abc","updated_at":1.5}`))
	})
	defer srv.Close()

	var out docOut
	if err := c.do(context.Background(), "GET", query("/api/doc", map[string]string{"path": "design/network-access.md"}), nil, &out); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Content != "body" || out.Hash != "abc" || out.Title != "network-access.md" {
		t.Fatalf("decoded the wrong fields: %+v", out)
	}
}

func TestCleanPathMatchesTheWritersOwnNormalisation(t *testing.T) {
	for in, want := range map[string]string{
		"  design/a.md ": "design/a.md",
		"/design/a.md":   "design/a.md",
		"a.md":           "a.md",
	} {
		got, err := cleanPath(in)
		if err != nil {
			t.Fatalf("cleanPath(%q) errored: %v", in, err)
		}
		if got != want {
			t.Fatalf("cleanPath(%q) = %q, want %q", in, got, want)
		}
	}
	for _, in := range []string{"", "   ", "/"} {
		if _, err := cleanPath(in); err == nil {
			t.Fatalf("cleanPath(%q) should have refused an empty path", in)
		}
	}
}

func TestAPostSendsJSONAndItsBodyReachesTheWriter(t *testing.T) {
	var seen string
	c, srv := newClient(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("missing JSON content-type: %q", r.Header.Get("Content-Type"))
		}
		buf := make([]byte, r.ContentLength)
		r.Body.Read(buf)
		seen = string(buf)
		w.Write([]byte(`{"ok":true,"id":"deadbeef"}`))
	})
	defer srv.Close()

	var out postOut
	err := c.do(context.Background(), "POST", "/api/comments",
		map[string]any{"path": "a.md", "text": "hello", "line": 3}, &out)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !out.OK || out.ID != "deadbeef" {
		t.Fatalf("decoded wrong: %+v", out)
	}
	for _, want := range []string{`"path":"a.md"`, `"text":"hello"`, `"line":3`} {
		if !strings.Contains(seen, want) {
			t.Fatalf("request body missing %s: %s", want, seen)
		}
	}
}

func TestTokenIsSentAsBearer(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	c := &Client{base: srv.URL, token: "s3cret", httpc: srv.Client()}
	if err := c.do(context.Background(), "GET", "/api/structure", nil, &map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if got != "Bearer s3cret" {
		t.Fatalf("Authorization = %q", got)
	}
}

func TestNoTokenSendsNoHeader(t *testing.T) {
	got := "unset"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	c := &Client{base: srv.URL, httpc: srv.Client()}
	if err := c.do(context.Background(), "GET", "/api/structure", nil, &map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("Authorization = %q, want none", got)
	}
}
