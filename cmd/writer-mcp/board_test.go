package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBoardAppendRefusesMalformedOpsLocally(t *testing.T) {
	c := toolsOnDeadWriter(t)
	cases := []struct {
		name string
		in   boardAppendArgs
		want string
	}{
		{"no ops", boardAppendArgs{Path: "a.md"}, "at least one op"},
		{"unknown op", boardAppendArgs{Path: "a.md", Ops: []boardOp{{Op: "circle"}}}, "op must be"},
		{"node without label", boardAppendArgs{Path: "a.md", Ops: []boardOp{{Op: "node", ID: "x"}}}, "an id and a label"},
		{"link without to", boardAppendArgs{Path: "a.md", Ops: []boardOp{{Op: "link", From: "x"}}}, "from and to"},
		{"empty note", boardAppendArgs{Path: "a.md", Ops: []boardOp{{Op: "note"}}}, "needs text"},
		{"no path", boardAppendArgs{Ops: []boardOp{{Op: "note", Text: "x"}}}, "path is required"},
	}
	for _, tc := range cases {
		_, _, err := boardAppend(context.Background(), c, tc.in)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: want error containing %q, got %v", tc.name, tc.want, err)
		}
	}
}

func TestBoardAppendSendsOnlyTheFieldsEachOpTakes(t *testing.T) {
	var got map[string]any
	c, srv := newClient(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/board/append" {
			t.Errorf("wrong endpoint %s", r.URL.Path)
		}
		json.NewDecoder(r.Body).Decode(&got)
		w.Write([]byte(`{"ok":true,"batch":"b1","seqs":[1,2],"count":2,"cap":400}`))
	})
	defer srv.Close()
	_, out, err := boardAppend(context.Background(), c, boardAppendArgs{Path: "/ctf/x.md", Batch: "recon", Ops: []boardOp{
		{Op: "node", ID: "atk", Label: "attacker", Kind: "actor"},
		{Op: "link", From: "atk", To: "atk2", Step: 1, Kind: "failed"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if out.Batch != "b1" || len(out.Seqs) != 2 || got["path"] != "ctf/x.md" || got["batch"] != "recon" {
		t.Fatalf("out=%+v body=%v", out, got)
	}
	ops := got["ops"].([]any)
	node, link := ops[0].(map[string]any), ops[1].(map[string]any)
	if _, ok := node["from"]; ok {
		t.Errorf("a node carried a link field: %v", node)
	}
	if _, ok := link["rank"]; ok {
		t.Errorf("a link carried a node field: %v", link)
	}
	if link["step"] != float64(1) || link["kind"] != "failed" {
		t.Errorf("link lost its step or kind: %v", link)
	}
}

func TestThereIsNoToolThatCanClearABoard(t *testing.T) {
	// clearing is the owner's, from the board pane; the assistant takes off
	// its own drawing with board_undo, one batch at a time
	for _, name := range registeredNames(t) {
		if strings.Contains(name, "clear") || strings.Contains(name, "erase") || strings.Contains(name, "wipe") {
			t.Fatalf("tool %q can wipe a board", name)
		}
	}
}

func fakeSnapshot(t *testing.T, body string) *Snapshotter {
	t.Helper()
	dir := t.TempDir()
	script := filepath.Join(dir, "snap.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return &Snapshotter{Python: "/bin/sh", Script: script, Base: "http://127.0.0.1:1", Token: "secret-token", Timeout: 5 * time.Second}
}

func TestBoardSnapshotReturnsTheReportAndKeepsTheTokenOutOfArgv(t *testing.T) {
	// the fake echoes its argv into the report's path, so a token there would show
	s := fakeSnapshot(t, `test "$WRITER_TOKEN" = secret-token || exit 3
printf '{"path":"%s","problems":2,"shots":[{"width":390,"theme":"light","png":"/tmp/a.png","consoleErrors":[],"geometry":{"summary":{"overlaps":2}}}]}\n' "$*"
exit 1`)
	out, err := s.run(context.Background(), "a.md", "")
	if err != nil {
		t.Fatalf("exit 1 means problems were found, and the report is still the answer: %v", err)
	}
	if out.Problems != 2 || len(out.Shots) != 1 || out.Shots[0].PNG != "/tmp/a.png" {
		t.Fatalf("report not passed through: %+v", out)
	}
	if strings.Contains(out.Path, "secret-token") {
		t.Fatalf("the token was put in argv: %q", out.Path)
	}
}

func TestBoardSnapshotFailureIsAnErrorNotAnEmptyReport(t *testing.T) {
	for name, body := range map[string]string{
		"crashed":  `echo '{"error":"no chromium"}'; exit 2`,
		"garbage":  `echo 'not json'; exit 0`,
		"no shots": `echo '{"shots":[]}'; exit 0`,
	} {
		if _, err := fakeSnapshot(t, body).run(context.Background(), "a.md", ""); err == nil {
			t.Errorf("%s: returned no error", name)
		}
	}
}

func TestBoardNamesAreCheckedBeforeTheWriterIsCalled(t *testing.T) {
	c := toolsOnDeadWriter(t)
	for _, bad := range []string{"a/b", strings.Repeat("x", 25), "<script>", "über"} {
		if _, _, err := boardAppend(context.Background(), c, boardAppendArgs{Path: "a.md", Board: bad,
			Ops: []boardOp{{Op: "note", Text: "x"}}}); err == nil || !strings.Contains(err.Error(), "board name") {
			t.Errorf("append to %q: %v", bad, err)
		}
		if _, _, err := boardUndo(context.Background(), c, boardArgs{Path: "a.md", Board: bad}); err == nil {
			t.Errorf("undo on %q was sent", bad)
		}
		if _, _, err := boardRead(context.Background(), c, boardArgs{Path: "a.md", Board: bad}); err == nil {
			t.Errorf("read of %q was sent", bad)
		}
	}
}

func TestEveryBoardToolSendsTheBoardOnlyWhenOneIsNamed(t *testing.T) {
	type call struct {
		path, board string
		inBody      bool
	}
	var got []call
	c, srv := newClient(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		board, inBody := body["board"].(string)
		if q := r.URL.Query(); q.Has("board") {
			board, inBody = q.Get("board"), true
		}
		got = append(got, call{r.URL.Path, board, inBody})
		w.Write([]byte(`{"ok":true}`))
	})
	defer srv.Close()
	ctx := context.Background()
	op := []boardOp{{Op: "node", ID: "a", Label: "a"}}
	for _, board := range []string{"", "  attack   path "} {
		if _, _, err := boardAppend(ctx, c, boardAppendArgs{Path: "a.md", Board: board, Ops: op}); err != nil {
			t.Fatal(err)
		}
		boardUndo(ctx, c, boardArgs{Path: "a.md", Board: board})
		boardRead(ctx, c, boardArgs{Path: "a.md", Board: board})
	}
	want := []call{
		{"/api/board/append", "", false}, {"/api/board/undo", "", false}, {"/api/board", "", false},
		{"/api/board/append", "attack path", true}, {"/api/board/undo", "attack path", true}, {"/api/board", "attack path", true},
	}
	if len(got) != len(want) {
		t.Fatalf("calls: %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("call %d: got %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestBoardListReadsTheWritersList(t *testing.T) {
	c, srv := newClient(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/board/list" || r.URL.Query().Get("path") != "ctf/x.md" {
			t.Errorf("wrong call %s", r.URL)
		}
		w.Write([]byte(`{"path":"ctf/x.md","cap":12,"boards":[{"name":"main","count":0,"exists":false},{"name":"attack path","count":5,"exists":true}]}`))
	})
	defer srv.Close()
	_, out, err := boardList(context.Background(), c, pathArgs{Path: "/ctf/x.md"})
	if err != nil {
		t.Fatal(err)
	}
	if out.Cap != 12 || len(out.Boards) != 2 || out.Boards[1].Name != "attack path" || out.Boards[1].Count != 5 ||
		out.Boards[0].Exists {
		t.Fatalf("list not passed through: %+v", out)
	}
}

func TestBoardSnapshotNamesTheBoardOnlyWhenAsked(t *testing.T) {
	s := fakeSnapshot(t, `printf '{"path":"%s","shots":[{"width":390,"theme":"light","png":"/tmp/a.png","consoleErrors":[],"geometry":{}}]}\n' "$*"`)
	out, err := s.run(context.Background(), "a.md", "attack path")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(out.Path, "--board attack path") {
		t.Errorf("--board not passed: argv %q", out.Path)
	}
	out, _ = s.run(context.Background(), "a.md", "")
	if strings.Contains(out.Path, "--board") {
		t.Errorf("--board passed for main: argv %q", out.Path)
	}
}
