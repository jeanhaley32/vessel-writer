// Command writer-mcp is the agent-facing adapter for the vessel-writer. It
// speaks MCP over stdio and translates tool calls into HTTP requests against
// the writer's local API.
//
// Why this exists. Before it, every read of a document was a hand-assembled
// curl with a throwaway Python parser piped onto the end. That has three costs:
// a schema change surfaces as empty output rather than an error, nothing
// accumulates between sessions, and relayC — which is meant to be the client —
// got talked to over raw HTTP while its owner used a real UI.
//
// What it deliberately cannot do: replace a document's body. Documents are
// Jean's prose and the editor already owns his edits through Yjs. The model
// writes into a draft through comments and through doc_edit, whose edits are
// anchored to quoted text and change only that span. There is no doc_write
// tool and adding one is not a small change.
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func main() {
	base := flag.String("base", "http://127.0.0.1:8791", "base URL of the vessel-writer")
	tokenFile := flag.String("token-file", "~/vessel-writer/state/token",
		"file holding the writer's token, when its auth is on (WRITER_TOKEN overrides)")
	flag.Parse()

	c := &Client{base: *base, token: loadToken(*tokenFile), httpc: &http.Client{Timeout: 15 * time.Second}}

	srv := mcp.NewServer(&mcp.Implementation{
		Name:    "writer",
		Title:   "vessel-writer (anchored edits and comments; no whole-document writes)",
		Version: "0.1.0",
	}, nil)

	registerTools(srv, c)

	// stdout is the MCP transport; a stray log line there corrupts the protocol.
	log.SetOutput(os.Stderr)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Printf("writer-mcp: serving over stdio, writer=%s", *base)
	if err := srv.Run(ctx, &mcp.StdioTransport{}); err != nil {
		log.Printf("mcp server exited: %v", err)
	}
}

// loadToken returns the writer's token, or "" when none is configured, in
// which case requests go out without one, as they do to a writer with auth off.
func loadToken(path string) string {
	if t := strings.TrimSpace(os.Getenv("WRITER_TOKEN")); t != "" {
		return t
	}
	if rest, ok := strings.CutPrefix(path, "~/"); ok {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		path = filepath.Join(home, rest)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}
