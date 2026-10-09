package main

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// registeredNames wires the real tools onto a real server and reports what was
// actually registered, so the assertions below cannot pass against a stale
// hand-written list.
func registeredNames(t *testing.T) []string {
	t.Helper()
	srv := mcp.NewServer(&mcp.Implementation{Name: "writer", Version: "test"}, nil)
	return registerTools(srv, &Client{base: "http://127.0.0.1:1"})
}

// The guarantee this file defends: a tool refuses a malformed call locally,
// before it reaches the writer, so the model gets told what is wrong instead of
// a 400 it has to interpret. Each case asserts the writer is never contacted.

func toolsOnDeadWriter(t *testing.T) *Client {
	t.Helper()
	c, srv := newClient(func(http.ResponseWriter, *http.Request) {
		t.Fatal("the writer was contacted for a call that should have been refused locally")
	})
	t.Cleanup(srv.Close)
	return c
}

func TestCommentPostRefusesAnUnanchoredComment(t *testing.T) {
	c := toolsOnDeadWriter(t)
	_, _, err := postComment(context.Background(), c, commentArgs{Path: "a.md", Text: "floating"})
	if err == nil {
		t.Fatal("a comment with neither quote nor line was accepted")
	}
	if !strings.Contains(err.Error(), "quote or a line") {
		t.Fatalf("error should name the missing anchor, got: %v", err)
	}
}

func TestCommentPostRefusesEmptyText(t *testing.T) {
	c := toolsOnDeadWriter(t)
	_, _, err := postComment(context.Background(), c, commentArgs{Path: "a.md", Line: 1})
	if err == nil || !strings.Contains(err.Error(), "text is required") {
		t.Fatalf("empty text should be refused locally, got: %v", err)
	}
}

func TestCommentPostRefusesEmptyPath(t *testing.T) {
	c := toolsOnDeadWriter(t)
	_, _, err := postComment(context.Background(), c, commentArgs{Text: "hi", Line: 1})
	if err == nil || !strings.Contains(err.Error(), "path is required") {
		t.Fatalf("empty path should be refused locally, got: %v", err)
	}
}

func TestThereIsNoToolThatCanReplaceADocumentBody(t *testing.T) {
	// The boundary is the point of the design, so it is asserted rather than
	// left to a comment: documents are the owner's prose, and the model's only
	// channel into a draft is additive, dismissible comments.
	for _, name := range registeredNames(t) {
		lower := strings.ToLower(name)
		if strings.Contains(lower, "write") || strings.Contains(lower, "save") ||
			strings.Contains(lower, "put") || strings.Contains(lower, "delete") {
			t.Fatalf("tool %q can mutate a document — see the no-doc_write boundary in main.go", name)
		}
	}
}

func TestTheExpectedToolsAreAllRegistered(t *testing.T) {
	names := registeredNames(t)
	got := map[string]bool{}
	for _, n := range names {
		got[n] = true
	}
	for _, want := range []string{
		"doc_read", "doc_list",
		"comment_post", "comment_list", "comment_resolve",
		"listening_get", "listening_set",
	} {
		if !got[want] {
			t.Errorf("tool %q is not registered", want)
		}
	}
	if len(got) != 7 {
		t.Errorf("expected exactly 7 tools, got %d: %v", len(got), names)
	}
}
