package main

import (
	"context"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type pathArgs struct {
	Path string `json:"path" jsonschema:"the document path, as the structure listing prints it, e.g. design/network-access.md"`
}

type noArgs struct{}

type commentArgs struct {
	Path  string `json:"path" jsonschema:"the document the comment is about"`
	Text  string `json:"text" jsonschema:"the comment itself"`
	Quote string `json:"quote,omitempty" jsonschema:"the exact text in the document this is about; the browser resolves it to a span. Prefer this over line."`
	Line  int    `json:"line,omitempty" jsonschema:"1-indexed line to anchor to when there is no quote; the comment then marks the whole line"`
	Kind  string `json:"kind,omitempty" jsonschema:"short label for the comment type, default note"`
}

type resolveArgs struct {
	Path string `json:"path" jsonschema:"the document the comment is on"`
	ID   string `json:"id" jsonschema:"the comment id to dismiss; omit to clear the document-level meta instead"`
}

type listeningArgs struct {
	Listening bool `json:"listening" jsonschema:"true for active listening, false for solitude"`
}

type docOut struct {
	Path      string  `json:"path"`
	Title     string  `json:"title"`
	Content   string  `json:"content"`
	Hash      string  `json:"hash"`
	UpdatedAt float64 `json:"updated_at"`
}

type commentsOut struct {
	Comments []map[string]any `json:"comments"`
	Meta     map[string]any   `json:"meta"`
}

type postOut struct {
	OK bool   `json:"ok"`
	ID string `json:"id"`
}

type resolveOut struct {
	OK      bool `json:"ok"`
	Removed int  `json:"removed"`
}

type listeningOut struct {
	Listening bool    `json:"listening"`
	Pending   int     `json:"pending"`
	Sent      int     `json:"sent"`
	Failed    int     `json:"failed"`
	LastError *string `json:"last_error"`
	ConvID    string  `json:"conv_id"`
}

// postComment validates an inline comment and sends it. Validation lives here,
// not inline in the handler, so a malformed call is refused locally with a
// message naming what is missing instead of becoming a 400 to interpret.
func postComment(ctx context.Context, c *Client, in commentArgs) (*mcp.CallToolResult, postOut, error) {
	path, err := cleanPath(in.Path)
	if err != nil {
		return nil, postOut{}, err
	}
	if in.Text == "" {
		return nil, postOut{}, fmt.Errorf("text is required")
	}
	if in.Quote == "" && in.Line == 0 {
		return nil, postOut{}, fmt.Errorf("a comment needs a quote or a line to anchor to")
	}
	body := map[string]any{"path": path, "text": in.Text}
	if in.Quote != "" {
		body["quote"] = in.Quote
	}
	if in.Line != 0 {
		body["line"] = in.Line
	}
	if in.Kind != "" {
		body["kind"] = in.Kind
	}
	var out postOut
	err = c.do(ctx, "POST", "/api/comments", body, &out)
	return nil, out, err
}

// registerTools wires every tool and returns the names it actually registered.
// It returns them rather than exposing a hand-written list so a test can check
// the design's central boundary — that nothing here can replace a document
// body — against what was really wired up, not against a second list that
// could drift from it.
func registerTools(s *mcp.Server, c *Client) []string {
	var registered []string
	add := func(t *mcp.Tool) *mcp.Tool {
		registered = append(registered, t.Name)
		return t
	}

	mcp.AddTool(s, add(&mcp.Tool{
		Name:        "doc_read",
		Description: "Read one document's current content from the vessel-writer.",
	}), func(ctx context.Context, _ *mcp.CallToolRequest, in pathArgs) (*mcp.CallToolResult, docOut, error) {
		path, err := cleanPath(in.Path)
		if err != nil {
			return nil, docOut{}, err
		}
		var out docOut
		err = c.do(ctx, "GET", query("/api/doc", map[string]string{"path": path}), nil, &out)
		return nil, out, err
	})

	mcp.AddTool(s, add(&mcp.Tool{
		Name:        "doc_list",
		Description: "List the documents in the vessel-writer, so a path never has to be guessed.",
	}), func(ctx context.Context, _ *mcp.CallToolRequest, _ noArgs) (*mcp.CallToolResult, map[string]any, error) {
		var out map[string]any
		err := c.do(ctx, "GET", "/api/structure", nil, &out)
		return nil, out, err
	})

	mcp.AddTool(s, add(&mcp.Tool{
		Name: "comment_post",
		Description: "Leave an inline comment on a document. This is the ONLY way to write into " +
			"someone's draft from here: comments are additive and dismissible, and there is " +
			"deliberately no tool that can replace a document's body. Anchor with quote where " +
			"possible so the mark lands on the exact span.",
	}), func(ctx context.Context, _ *mcp.CallToolRequest, in commentArgs) (*mcp.CallToolResult, postOut, error) {
		return postComment(ctx, c, in)
	})

	mcp.AddTool(s, add(&mcp.Tool{
		Name:        "comment_list",
		Description: "List the comments currently anchored on a document.",
	}), func(ctx context.Context, _ *mcp.CallToolRequest, in pathArgs) (*mcp.CallToolResult, commentsOut, error) {
		path, err := cleanPath(in.Path)
		if err != nil {
			return nil, commentsOut{}, err
		}
		var out commentsOut
		err = c.do(ctx, "GET", query("/api/comments", map[string]string{"path": path}), nil, &out)
		return nil, out, err
	})

	mcp.AddTool(s, add(&mcp.Tool{
		Name:        "comment_resolve",
		Description: "Dismiss a comment by id, clearing it from the document.",
	}), func(ctx context.Context, _ *mcp.CallToolRequest, in resolveArgs) (*mcp.CallToolResult, resolveOut, error) {
		path, err := cleanPath(in.Path)
		if err != nil {
			return nil, resolveOut{}, err
		}
		body := map[string]any{"path": path}
		if in.ID != "" {
			body["id"] = in.ID
		}
		var out resolveOut
		err = c.do(ctx, "POST", "/api/comments/resolve", body, &out)
		return nil, out, err
	})

	mcp.AddTool(s, add(&mcp.Tool{
		Name: "listening_get",
		Description: "Report whether the writer is in active listening or solitude, plus the " +
			"inject counters. Read this rather than assuming — the mode is the owner's choice.",
	}), func(ctx context.Context, _ *mcp.CallToolRequest, _ noArgs) (*mcp.CallToolResult, listeningOut, error) {
		var out listeningOut
		err := c.do(ctx, "GET", "/api/listening", nil, &out)
		return nil, out, err
	})

	mcp.AddTool(s, add(&mcp.Tool{
		Name: "listening_set",
		Description: "Switch between active listening and solitude. This is the owner's setting; " +
			"change it on his behalf only when he has asked.",
	}), func(ctx context.Context, _ *mcp.CallToolRequest, in listeningArgs) (*mcp.CallToolResult, listeningOut, error) {
		var out listeningOut
		err := c.do(ctx, "PUT", "/api/listening", map[string]any{"listening": in.Listening}, &out)
		return nil, out, err
	})

	return registered
}
