package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// boardOp is one drawing step. Which fields apply depends on Op; the writer
// checks every one and refuses the whole batch, naming the op, if any is wrong.
type boardOp struct {
	Op    string   `json:"op" jsonschema:"node, link, note, emphasize or zone"`
	ID    string   `json:"id,omitempty" jsonschema:"node or zone id: short, no spaces, unique on the board"`
	Label string   `json:"label,omitempty" jsonschema:"node, zone or link label, at most 28 characters"`
	Sub   string   `json:"sub,omitempty" jsonschema:"node subtitle, at most 32 characters"`
	Rank  int      `json:"rank,omitempty" jsonschema:"node or note row, 0 at the top"`
	Order int      `json:"order,omitempty" jsonschema:"node position in its row, left to right"`
	Kind  string   `json:"kind,omitempty" jsonschema:"node: actor (attacker), service, state (data), boundary. link: state, peer, attempt, failed. zone: segment, trust, container"`
	Zone  string   `json:"zone,omitempty" jsonschema:"node: the id of a zone already drawn that this node sits in"`
	From  string   `json:"from,omitempty" jsonschema:"link: the node it starts at"`
	To    string   `json:"to,omitempty" jsonschema:"link: the node it points at"`
	Step  int      `json:"step,omitempty" jsonschema:"link: its number in a sequence (1, 2, 3...), drawn as a small numbered marker"`
	Text  string   `json:"text,omitempty" jsonschema:"note: a line of text under a row, at most 90 characters"`
	IDs   []string `json:"ids,omitempty" jsonschema:"emphasize: the nodes to circle (replaces earlier emphasis). zone: the nodes inside it"`
}

type boardAppendArgs struct {
	Path  string    `json:"path" jsonschema:"the document whose board to draw on"`
	Ops   []boardOp `json:"ops" jsonschema:"drawing steps, applied as one batch, all or nothing; ids may refer to nodes earlier in the batch"`
	Batch string    `json:"batch,omitempty" jsonschema:"optional short label for this batch, e.g. step 3: foothold"`
}

type boardAppendOut struct {
	OK    bool   `json:"ok"`
	Batch string `json:"batch"`
	Seqs  []int  `json:"seqs"`
	Count int    `json:"count"`
	Cap   int    `json:"cap"`
}

type boardUndoOut struct {
	OK      bool   `json:"ok"`
	Batch   string `json:"batch"`
	Removed int    `json:"removed"`
	Count   int    `json:"count"`
}

type boardReadOut struct {
	Path  string           `json:"path"`
	Ops   []map[string]any `json:"ops"`
	Count int              `json:"count"`
	Cap   int              `json:"cap"`
}

type snapshotShot struct {
	Width         int            `json:"width"`
	Theme         string         `json:"theme"`
	PNG           string         `json:"png"`
	ConsoleErrors []string       `json:"consoleErrors"`
	Geometry      map[string]any `json:"geometry"`
}

type boardSnapshotOut struct {
	Path     string         `json:"path"`
	Problems int            `json:"problems"`
	Shots    []snapshotShot `json:"shots"`
}

var boardOpKinds = map[string]bool{"node": true, "link": true, "note": true, "emphasize": true, "zone": true}

// boardAppend refuses the obvious mistakes locally; everything else (sizes,
// kinds, references to nodes already on the board) is the writer's to check.
func boardAppend(ctx context.Context, c *Client, in boardAppendArgs) (*mcp.CallToolResult, boardAppendOut, error) {
	path, err := cleanPath(in.Path)
	if err != nil {
		return nil, boardAppendOut{}, err
	}
	if len(in.Ops) == 0 {
		return nil, boardAppendOut{}, fmt.Errorf("at least one op is required")
	}
	for i, op := range in.Ops {
		if !boardOpKinds[op.Op] {
			return nil, boardAppendOut{}, fmt.Errorf("op %d: op must be node, link, note, emphasize or zone, got %q", i+1, op.Op)
		}
		switch {
		case (op.Op == "node" || op.Op == "zone") && (op.ID == "" || op.Label == ""):
			return nil, boardAppendOut{}, fmt.Errorf("op %d: a %s needs an id and a label", i+1, op.Op)
		case op.Op == "link" && (op.From == "" || op.To == ""):
			return nil, boardAppendOut{}, fmt.Errorf("op %d: a link needs from and to", i+1)
		case op.Op == "note" && op.Text == "":
			return nil, boardAppendOut{}, fmt.Errorf("op %d: a note needs text", i+1)
		}
	}
	body := map[string]any{"path": path, "ops": wireOps(in.Ops)}
	if in.Batch != "" {
		body["batch"] = in.Batch
	}
	var out boardAppendOut
	err = c.do(ctx, "POST", "/api/board/append", body, &out)
	return nil, out, err
}

// wireOps sends each op with only the fields its kind takes, so a zero value
// in a field that does not apply is never mistaken for one that was set.
func wireOps(ops []boardOp) []map[string]any {
	out := make([]map[string]any, 0, len(ops))
	for _, op := range ops {
		m := map[string]any{"op": op.Op}
		set := func(k, v string) {
			if v != "" {
				m[k] = v
			}
		}
		switch op.Op {
		case "node":
			set("id", op.ID)
			set("label", op.Label)
			set("sub", op.Sub)
			set("kind", op.Kind)
			set("zone", op.Zone)
			m["rank"], m["order"] = op.Rank, op.Order
		case "link":
			set("from", op.From)
			set("to", op.To)
			set("label", op.Label)
			set("kind", op.Kind)
			if op.Step != 0 {
				m["step"] = op.Step
			}
		case "note":
			set("text", op.Text)
			m["rank"] = op.Rank
		case "emphasize":
			m["ids"] = nonNil(op.IDs)
		case "zone":
			set("id", op.ID)
			set("label", op.Label)
			set("kind", op.Kind)
			m["ids"] = nonNil(op.IDs)
		}
		out = append(out, m)
	}
	return out
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// Snapshotter runs tools/board_snapshot.py. A field so a test can swap in a
// fake script without a browser.
type Snapshotter struct {
	Python  string
	Script  string
	Base    string
	Token   string
	Timeout time.Duration
}

func (s *Snapshotter) run(ctx context.Context, path string) (boardSnapshotOut, error) {
	ctx, cancel := context.WithTimeout(ctx, s.Timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.Python, s.Script, "--path", path, "--base", s.Base)
	// the token goes in the environment, never in argv where ps would show it
	cmd.Env = append(os.Environ(), "WRITER_TOKEN="+s.Token)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	// exit 1 means it ran and found problems; the report is still the answer
	if err != nil {
		if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 1 {
			return boardSnapshotOut{}, fmt.Errorf("board_snapshot failed (%v): %s %s", err,
				truncate(strings.TrimSpace(stdout.String()), 400), truncate(strings.TrimSpace(stderr.String()), 400))
		}
	}
	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	var out boardSnapshotOut
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &out); err != nil {
		return boardSnapshotOut{}, fmt.Errorf("board_snapshot printed something that is not its report (%w): %s",
			err, truncate(stdout.String(), 200))
	}
	if len(out.Shots) == 0 {
		return boardSnapshotOut{}, fmt.Errorf("board_snapshot returned no shots — this is not an empty board")
	}
	return out, nil
}

func registerBoardTools(s *mcp.Server, c *Client, snap *Snapshotter, add func(*mcp.Tool) *mcp.Tool) {
	mcp.AddTool(s, add(&mcp.Tool{
		Name: "board_append",
		Description: "Draw on a document's board, the live blackboard beside it in the writer. Ops are " +
			"placed by meaning, never pixels: a node has a rank (row, 0 at top) and an order (position in " +
			"the row). Kinds: node actor/service/state/boundary; link state/peer/attempt/failed (dashed); " +
			"zone segment/trust/container draws a labelled boundary round its nodes. A link's step numbers " +
			"a sequence (an attack chain reads 1, 2, 3). The batch is checked as a whole and refused, " +
			"naming the op, if anything is wrong. After drawing, run board_snapshot and look at the images.",
	}), func(ctx context.Context, _ *mcp.CallToolRequest, in boardAppendArgs) (*mcp.CallToolResult, boardAppendOut, error) {
		return boardAppend(ctx, c, in)
	})

	mcp.AddTool(s, add(&mcp.Tool{
		Name:        "board_undo",
		Description: "Take the most recent batch off a document's board, and only that batch. There is no tool to clear a board; that is the owner's.",
	}), func(ctx context.Context, _ *mcp.CallToolRequest, in pathArgs) (*mcp.CallToolResult, boardUndoOut, error) {
		path, err := cleanPath(in.Path)
		if err != nil {
			return nil, boardUndoOut{}, err
		}
		var out boardUndoOut
		err = c.do(ctx, "POST", "/api/board/undo", map[string]any{"path": path}, &out)
		return nil, out, err
	})

	mcp.AddTool(s, add(&mcp.Tool{
		Name:        "board_read",
		Description: "Read a document's board as data: every op with its seq and batch, so the meaning can be checked.",
	}), func(ctx context.Context, _ *mcp.CallToolRequest, in pathArgs) (*mcp.CallToolResult, boardReadOut, error) {
		path, err := cleanPath(in.Path)
		if err != nil {
			return nil, boardReadOut{}, err
		}
		var out boardReadOut
		err = c.do(ctx, "GET", query("/api/board", map[string]string{"path": path}), nil, &out)
		return nil, out, err
	})

	mcp.AddTool(s, add(&mcp.Tool{
		Name: "board_snapshot",
		Description: "Render a document's board in a headless browser at 390 and 1280 wide, light and dark. " +
			"Returns the PNG paths (read them) and a geometry report per image: overlapping boxes, clipped " +
			"text, links through boxes, labels on boxes, anything off the edge. problems counts them; fix " +
			"anything above zero with board_undo and a better drawing.",
	}), func(ctx context.Context, _ *mcp.CallToolRequest, in pathArgs) (*mcp.CallToolResult, boardSnapshotOut, error) {
		path, err := cleanPath(in.Path)
		if err != nil {
			return nil, boardSnapshotOut{}, err
		}
		out, err := snap.run(ctx, path)
		return nil, out, err
	})
}
