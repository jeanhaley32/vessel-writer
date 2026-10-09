package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// Client is a thin HTTP client to the writer.
type Client struct {
	base  string
	token string // sent as a bearer token when the writer has auth on; empty otherwise
	httpc *http.Client
}

// do issues the request and decodes into out. Every non-2xx becomes an error
// carrying the status and the body, because the failure this whole command
// exists to prevent is a broken call that looks like an empty answer.
func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var rdr io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encoding request: %w", err)
		}
		rdr = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rdr)
	if err != nil {
		return fmt.Errorf("building request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.httpc.Do(req)
	if err != nil {
		return fmt.Errorf("the writer is unreachable at %s (%w) — this is not an empty result", c.base, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("reading response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("%s %s: %s: %s", method, path, resp.Status, strings.TrimSpace(string(raw)))
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("the writer answered %s but the body did not match the expected shape (%w): %s",
			resp.Status, err, truncate(string(raw), 200))
	}
	return nil
}

// cleanPath normalises a document path the same way the writer's own
// _clean_path does, so a leading slash or stray spaces is not an error the
// model has to learn about by trial.
func cleanPath(p string) (string, error) {
	p = strings.TrimSpace(p)
	p = strings.TrimPrefix(p, "/")
	if p == "" {
		return "", fmt.Errorf("path is required")
	}
	return p, nil
}

func query(path string, kv map[string]string) string {
	v := url.Values{}
	for k, val := range kv {
		v.Set(k, val)
	}
	return path + "?" + v.Encode()
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
