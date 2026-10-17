// Board mode: the blackboard beside a document.
//
// The board is a function of its ops. Placement is semantic (rank = row,
// order = position in the row), so every render lays the whole board out
// again from the ops at the pane's real width. Nothing is pinned to pixels,
// and the SVG is drawn at 1:1 so text is real size on a phone.
//
// The layout makes three promises the geometry report checks:
//   - no two boxes overlap, and no zone takes in a node that is not its own:
//     zones are laid out as blocks of their own, side by side when they fit
//     and stacked when they do not;
//   - text fits its box: boxes are sized from measured text, labels wrap;
//   - arrows end on box edges and are routed through the gaps between rows.
// window.__boardGeometry reports what was actually drawn, measured from the DOM.
//
// A document can hold several named boards, shown as tabs; "main" is the one
// every caller that names none means. All of the open document's boards are
// held here, so a live op lands on its own board whichever tab is showing.
(() => {
  const SVGNS = "http://www.w3.org/2000/svg";
  const M = 14;                 // outer margin
  const GX = 26, GY = 66;       // gaps between boxes, between rows
  const PADX = 12, PADY = 9;    // text inset in a box
  const LINE = 16, SUBLINE = 14;
  const BOX_MIN = 92, BOX_MAX = 210;
  const ZPAD = 12, ZLABEL = 17; // zone padding, room for its label
  const TAG_H = 16;

  const RENDER_ONLY = typeof window.boardRenderPath === "string";
  let pane, canvas, measurer;
  const MAIN = "main", BOARD_CAP = 12, NAME = /^[A-Za-z0-9 _-]{1,24}$/, TABS_KEY = "vw_board_tabs";
  let path = null, ops = [], seen = 0, open = false, es = null, ro = null;
  // name -> { ops, exists, unseen }; exists is false for a tab made here and not yet drawn on
  let boards = new Map([[MAIN, { ops: [], exists: false }]]), active = MAIN, loading = 0;

  function el(name, attrs, parent) {
    const n = document.createElementNS(SVGNS, name);
    for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  // --- text measurement, with the same classes the board draws with ---
  function measure(text, cls) {
    if (!measurer) {
      measurer = el("svg", { class: "board-measure", width: 10, height: 10, "aria-hidden": "true" });
      (canvas || document.body).appendChild(measurer);
    }
    const t = el("text", { class: cls }, measurer);
    t.textContent = text;
    const w = t.getComputedTextLength();
    t.remove();
    return w;
  }

  function wrap(text, cls, max) {
    const words = text.split(" ");
    const lines = [];
    let line = "";
    const pushWord = (word) => {
      if (measure(word, cls) <= max) return word;
      // a single word wider than the box: break it by characters
      let part = "";
      for (const ch of word) {
        if (part && measure(part + ch, cls) > max) { lines.push(part); part = ""; }
        part += ch;
      }
      return part;
    };
    for (const word of words) {
      const next = line ? line + " " + word : word;
      if (measure(next, cls) <= max) { line = next; continue; }
      if (line) lines.push(line);
      line = pushWord(word);
    }
    if (line) lines.push(line);
    return lines;
  }

  // --- the ops folded into a model ---
  function model() {
    const nodes = new Map(), links = [], notes = [], zones = new Map();
    let marked = new Set();
    for (const op of ops) {
      if (op.op === "node") nodes.set(op.id, { ...op, rank: op.rank || 0, order: op.order || 0 });
      else if (op.op === "link") links.push({ ...op });
      else if (op.op === "note") notes.push({ ...op, rank: op.rank || 0 });
      else if (op.op === "emphasize") marked = new Set(op.ids || []);
      else if (op.op === "zone") zones.set(op.id, { ...op, members: [...(op.ids || [])] });
    }
    for (const n of nodes.values()) {
      if (n.zone && zones.has(n.zone)) zones.get(n.zone).members.push(n.id);
    }
    for (const z of zones.values()) {
      z.members = z.members.filter((id) => nodes.has(id));
      for (const id of z.members) nodes.get(id).group = z.id;
    }
    return { nodes, links, notes, zones, marked };
  }

  // --- layout ---
  function sizeNodes(nodes, avail) {
    const max = Math.max(BOX_MIN, Math.min(BOX_MAX, avail - 2 * ZPAD));
    for (const n of nodes.values()) {
      const inner = max - 2 * PADX;
      n.lines = wrap(n.label, "bn-label", inner);
      n.sublines = n.sub ? wrap(n.sub, "bn-sub", inner) : [];
      const wide = Math.max(...n.lines.map((l) => measure(l, "bn-label")),
                            ...n.sublines.map((l) => measure(l, "bn-sub")), 0);
      n.w = Math.max(BOX_MIN, Math.min(max, Math.ceil(wide) + 2 * PADX));
      n.h = 2 * PADY + n.lines.length * LINE + n.sublines.length * SUBLINE;
    }
  }

  // Blocks: each zone is one, and the nodes in no zone are one. Ordered by the
  // lowest order of their members, so "attacker, then the DMZ, then the LAN"
  // reads left to right when it fits.
  function blocksOf(m) {
    const groups = new Map();
    for (const n of m.nodes.values()) {
      const key = n.group || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(n);
    }
    const blocks = [...groups.entries()].map(([key, members]) => ({
      zone: key ? m.zones.get(key) : null, members,
      key: Math.min(...members.map((n) => n.order)),
      rank: Math.min(...members.map((n) => n.rank)),
    }));
    blocks.sort((a, b) => a.key - b.key || a.rank - b.rank || (a.zone ? 1 : 0) - (b.zone ? 1 : 0));
    return blocks;
  }

  function rowsOf(members) {
    const byRank = new Map();
    for (const n of members) {
      if (!byRank.has(n.rank)) byRank.set(n.rank, []);
      byRank.get(n.rank).push(n);
    }
    for (const list of byRank.values()) list.sort((a, b) => a.order - b.order || (a.seq || 0) - (b.seq || 0));
    return byRank;
  }

  const rowWidth = (list) => list.reduce((s, n) => s + n.w, 0) + GX * Math.max(0, list.length - 1);

  function layout(m, W) {
    const avail = W - 2 * M;
    sizeNodes(m.nodes, avail);
    const blocks = blocksOf(m);
    const ranks = [...new Set([...m.nodes.values()].map((n) => n.rank).concat(m.notes.map((n) => n.rank)))]
      .sort((a, b) => a - b);
    const notesAt = (r) => m.notes.filter((n) => n.rank === r);
    const noteLines = (note, width) => wrap(note.text, "bn-note", width);
    const bands = [];       // {top, bottom} of every row of boxes, for routing
    const placedNotes = [];
    const anyZone = blocks.some((b) => b.zone);

    for (const b of blocks) {
      b.rows = rowsOf(b.members);
      b.inset = b.zone ? ZPAD : 0;
      b.width = Math.max(0, ...[...b.rows.values()].map(rowWidth)) + 2 * b.inset;
    }
    const sideBySide = blocks.reduce((s, b) => s + b.width, 0) + GX * Math.max(0, blocks.length - 1) <= avail;

    let y = M + (anyZone ? ZLABEL + ZPAD : 0);
    const placeRow = (list, left, width, top) => {
      const used = rowWidth(list);
      let x = left + (width - used) / 2;
      for (const n of list) { n.x = x; n.y = top; x += n.w + GX; }
    };
    const placeNotes = (rank, top) => {
      let t = top;
      for (const note of notesAt(rank)) {
        const lines = noteLines(note, avail);
        placedNotes.push({ ...note, lines, x: W / 2, y: t });
        t += lines.length * LINE;
      }
      return t;
    };

    if (sideBySide) {
      // rows shared across blocks; blocks laid left to right, centred
      const total = blocks.reduce((s, b) => s + b.width, 0) + GX * Math.max(0, blocks.length - 1);
      let x = M + (avail - total) / 2;
      for (const b of blocks) { b.left = x; x += b.width + GX; }
      for (const r of ranks) {
        const inRow = blocks.flatMap((b) => b.rows.get(r) || []);
        if (inRow.length) {
          const h = Math.max(...inRow.map((n) => n.h));
          for (const b of blocks) if (b.rows.get(r)) placeRow(b.rows.get(r), b.left + b.inset, b.width - 2 * b.inset, y);
          bands.push({ top: y, bottom: y + h });
          y += h;
        }
        const notesTop = y + (notesAt(r).length ? 10 + (anyZone ? ZPAD : 0) : 0);
        const after = placeNotes(r, notesTop + LINE - 4);
        y = (notesAt(r).length ? after : y) + GY;
      }
    } else {
      // stacked: each block takes the full width and wraps its own rows
      const doneNotes = new Set();
      blocks.forEach((b, bi) => {
        if (bi > 0 && (b.zone || blocks[bi - 1].zone)) y += ZLABEL + ZPAD;
        const inner = avail - 2 * b.inset;
        for (const r of [...b.rows.keys()].sort((a, c) => a - c)) {
          const list = b.rows.get(r);
          let line = [];
          const flush = () => {
            if (!line.length) return;
            const h = Math.max(...line.map((n) => n.h));
            placeRow(line, M + b.inset, inner, y);
            bands.push({ top: y, bottom: y + h });
            y += h + GY;
            line = [];
          };
          for (const n of list) {
            if (line.length && rowWidth([...line, n]) > inner) flush();
            line.push(n);
          }
          flush();
          if (!doneNotes.has(r) && notesAt(r).length) {
            doneNotes.add(r);
            y = placeNotes(r, y - GY + 10 + (b.zone ? ZPAD : 0) + LINE - 4) + GY;
          }
        }
        if (b.zone) y += ZPAD;
      });
      for (const r of ranks) if (!doneNotes.has(r) && notesAt(r).length) y = placeNotes(r, y + LINE) + GY / 2;
    }

    // zone rectangles around their members
    for (const b of blocks) {
      if (!b.zone) continue;
      const xs = b.members.map((n) => n.x), xe = b.members.map((n) => n.x + n.w);
      const ys = b.members.map((n) => n.y), ye = b.members.map((n) => n.y + n.h);
      b.zone.box = { x: Math.min(...xs) - ZPAD, y: Math.min(...ys) - ZPAD - ZLABEL,
                     w: Math.max(...xe) - Math.min(...xs) + 2 * ZPAD,
                     h: Math.max(...ye) - Math.min(...ys) + 2 * ZPAD + ZLABEL };
    }
    for (const n of m.nodes.values()) n.band = bands.find((bd) => n.y >= bd.top - 0.5 && n.y < bd.bottom + 0.5);
    const H = Math.ceil(Math.max(y - GY + M, ...[...m.zones.values()].filter((z) => z.box).map((z) => z.box.y + z.box.h + M), 2 * M));
    return { W, H: Math.max(H, 60), notes: placedNotes, bands };
  }

  // --- link routing: orthogonal, through the gaps between rows ---
  function route(m) {
    const ends = new Map();     // `${id}:${side}` -> [{link, end, other}]
    const sideOf = (a, b) => {
      if (a.band === b.band) return null;
      return b.y > a.y ? ["bottom", "top"] : ["top", "bottom"];
    };
    for (const l of m.links) {
      const a = m.nodes.get(l.from), b = m.nodes.get(l.to);
      if (!a || !b) continue;
      let sides = sideOf(a, b);
      if (!sides) {
        const between = [...m.nodes.values()].some((n) => n !== a && n !== b && n.band === a.band &&
          n.x > Math.min(a.x, b.x) && n.x < Math.max(a.x, b.x));
        // too short a span to carry its label: go round under the row instead
        const span = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
        const need = (l.label ? measure(l.label, "bn-llabel") : 0) + (l.step ? TAG_H + 4 : 0);
        const cramped = need > 0 && span < need + 16;
        sides = between || cramped ? ["bottom", "bottom"] : (b.x > a.x ? ["right", "left"] : ["left", "right"]);
      }
      l.sides = sides;
      for (const [node, side, other] of [[a, sides[0], b], [b, sides[1], a]]) {
        const key = node.id + ":" + side;
        if (!ends.has(key)) ends.set(key, []);
        ends.get(key).push({ l, node, side, other });
      }
    }
    for (const list of ends.values()) {
      list.sort((p, q) => (p.other.x + p.other.w / 2) - (q.other.x + q.other.w / 2));
      list.forEach((e, i) => {
        const n = e.node, f = (i + 1) / (list.length + 1);
        const pt = e.side === "top" ? { x: n.x + n.w * f, y: n.y }
          : e.side === "bottom" ? { x: n.x + n.w * f, y: n.y + n.h }
          : e.side === "left" ? { x: n.x, y: n.y + n.h * f } : { x: n.x + n.w, y: n.y + n.h * f };
        if (e.l.from === n.id && !e.l.p1) e.l.p1 = pt; else e.l.p2 = pt;
      });
    }
    const boxes = [...m.nodes.values()];
    const lanes = new Map();
    const laneY = (y) => { const k = Math.round(y); const i = lanes.get(k) || 0; lanes.set(k, i + 1);
      return y + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 7; };
    for (const l of m.links) {
      const a = m.nodes.get(l.from), b = m.nodes.get(l.to);
      if (!a || !b || !l.p1 || !l.p2) continue;
      const [s1, s2] = l.sides, p1 = l.p1, p2 = l.p2;
      if (s1 === "right" || s1 === "left") { l.pts = [p1, { x: p2.x, y: p1.y }]; if (Math.abs(p1.y - p2.y) > 1) l.pts = [p1, { x: (p1.x + p2.x) / 2, y: p1.y }, { x: (p1.x + p2.x) / 2, y: p2.y }, p2]; continue; }
      if (s1 === "bottom" && s2 === "bottom") {
        const g = laneY(a.band.bottom + GY / 2);
        l.pts = [p1, { x: p1.x, y: g }, { x: p2.x, y: g }, p2];
        continue;
      }
      const down = s1 === "bottom";
      const y1 = laneY(down ? a.band.bottom + GY / 2 : a.band.top - GY / 2);
      const y2 = laneY(down ? b.band.top - GY / 2 : b.band.bottom + GY / 2);
      const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
      const blockers = boxes.filter((n) => n !== a && n !== b && n.y < hi && n.y + n.h > lo);
      if (!blockers.length || Math.abs(y1 - y2) < 1) {
        const y = down ? y2 : y2;
        l.pts = [p1, { x: p1.x, y }, { x: p2.x, y }, p2];
        continue;
      }
      const free = (x) => blockers.every((n) => x < n.x - 6 || x > n.x + n.w + 6);
      const cands = [p1.x, p2.x];
      for (const n of blockers) cands.push(n.x - GX / 2, n.x + n.w + GX / 2);
      const x = cands.filter(free).sort((p, q) => (Math.abs(p - p1.x) + Math.abs(p - p2.x)) - (Math.abs(q - p1.x) + Math.abs(q - p2.x)))[0];
      if (x === undefined) { l.pts = [p1, { x: p1.x, y: y2 }, { x: p2.x, y: y2 }, p2]; continue; }
      l.pts = [p1, { x: p1.x, y: y1 }, { x, y: y1 }, { x, y: y2 }, { x: p2.x, y: y2 }, p2];
    }
  }

  // --- tags: link labels and step numbers, placed where they collide with nothing ---
  const hit = (a, b, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

  function placeTags(m, lay) {
    const obstacles = [...m.nodes.values()].map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
    for (const z of m.zones.values()) if (z.box) obstacles.push(zoneLabelBox(z));
    for (const note of lay.notes) obstacles.push(noteBox(note));
    for (const l of m.links) {
      if (!l.pts || (!l.label && !l.step)) continue;
      const tw = (l.label ? Math.ceil(measure(l.label, "bn-llabel")) : 0) + (l.step ? TAG_H + (l.label ? 4 : 0) : 0);
      const segs = [];
      for (let i = 0; i < l.pts.length - 1; i++) {
        const a = l.pts[i], b = l.pts[i + 1];
        segs.push({ a, b, len: Math.abs(a.x - b.x) + Math.abs(a.y - b.y), horiz: Math.abs(a.y - b.y) < 1 });
      }
      segs.sort((p, q) => (q.horiz - p.horiz) || q.len - p.len);
      let chosen = null;
      const tries = [];
      for (const s of segs) for (const f of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const px = s.a.x + (s.b.x - s.a.x) * f, py = s.a.y + (s.b.y - s.a.y) * f;
        if (s.horiz) tries.push({ x: px - tw / 2, y: py - TAG_H - 2 }, { x: px - tw / 2, y: py + 2 });
        else tries.push({ x: px + 5, y: py - TAG_H / 2 }, { x: px - tw - 5, y: py - TAG_H / 2 });
      }
      for (const t of tries) {
        const box = { x: t.x, y: t.y, w: tw, h: TAG_H };
        if (box.x < 2 || box.x + box.w > lay.W - 2 || box.y < 2 || box.y + box.h > lay.H - 2) continue;
        if (obstacles.some((o) => hit(box, o, 2))) continue;
        chosen = box; break;
      }
      l.tag = chosen || { x: tries[0].x, y: tries[0].y, w: tw, h: TAG_H };
      obstacles.push(l.tag);
    }
  }

  const zoneLabelBox = (z) => ({ x: z.box.x + 8, y: z.box.y + 3, w: Math.ceil(measure(z.label, "bn-zlabel")) + 2, h: ZLABEL - 4 });
  const noteBox = (note) => {
    const w = Math.max(...note.lines.map((l) => measure(l, "bn-note")));
    return { x: note.x - w / 2, y: note.y - LINE + 4, w, h: note.lines.length * LINE };
  };

  // --- draw ---
  function arrowHead(g, a, b, cls) {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, s = 7;
    const p = (k, w) => `${b.x - ux * k - uy * w},${b.y - uy * k + ux * w}`;
    el("path", { d: `M${p(s, s * 0.55)} L${b.x},${b.y} L${p(s, -s * 0.55)} z`, class: cls }, g);
  }

  function draw() {
    if (!canvas) return;
    const W = Math.max(300, Math.floor(canvas.clientWidth || 300));
    const m = model();
    const lay = layout(m, W);
    route(m);
    placeTags(m, lay);
    canvas.querySelectorAll("svg.board-svg").forEach((s) => s.remove());
    const svg = el("svg", { class: "board-svg", width: lay.W, height: lay.H, viewBox: `0 0 ${lay.W} ${lay.H}`, role: "img",
                            "aria-label": "board" });
    canvas.appendChild(svg);
    const fresh = (op) => (op.seq || 0) > seen ? " fresh" : "";
    const gz = el("g", { class: "layer-zones" }, svg), gl = el("g", { class: "layer-links" }, svg);
    const gn = el("g", { class: "layer-nodes" }, svg), gt = el("g", { class: "layer-tags" }, svg);

    for (const z of m.zones.values()) {
      if (!z.box) continue;
      const g = el("g", { class: "bzone" + (z.kind ? " z-" + z.kind : "") + fresh(z), "data-id": z.id }, gz);
      el("rect", { x: z.box.x, y: z.box.y, width: z.box.w, height: z.box.h, rx: 10, class: "bz-rect" }, g);
      const t = el("text", { x: z.box.x + 9, y: z.box.y + ZLABEL - 3, class: "bn-zlabel" }, g);
      t.textContent = z.label;
    }
    for (const l of m.links) {
      if (!l.pts) continue;
      const g = el("g", { class: "blink" + (l.kind ? " k-" + l.kind : "") + fresh(l), "data-from": l.from, "data-to": l.to }, gl);
      el("path", { d: "M" + l.pts.map((p) => `${p.x},${p.y}`).join(" L"), class: "bl-path" }, g);
      const a = l.pts[l.pts.length - 2], b = l.pts[l.pts.length - 1];
      if (l.kind === "failed") {
        const c = { x: b.x - (b.x - a.x) * 0, y: b.y };
        const k = 4.5, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        el("path", { d: `M${mx - k},${my - k} L${mx + k},${my + k} M${mx - k},${my + k} L${mx + k},${my - k}`, class: "bl-cross" }, g);
        void c;
      } else if (l.kind !== "peer") arrowHead(g, a, b, "bl-head");
    }
    for (const l of m.links) {
      if (!l.tag) continue;
      const g = el("g", { class: "btag" + (l.kind ? " k-" + l.kind : "") + fresh(l), "data-link": l.from + ">" + l.to }, gt);
      el("rect", { x: l.tag.x - 2, y: l.tag.y, width: l.tag.w + 4, height: l.tag.h, rx: 3, class: "bt-bg" }, g);
      let x = l.tag.x;
      if (l.step) {
        el("circle", { cx: x + TAG_H / 2, cy: l.tag.y + TAG_H / 2, r: TAG_H / 2 - 1, class: "bt-step" }, g);
        const s = el("text", { x: x + TAG_H / 2, y: l.tag.y + TAG_H / 2 + 3.5, class: "bn-step", "text-anchor": "middle" }, g);
        s.textContent = String(l.step);
        x += TAG_H + 4;
      }
      if (l.label) {
        const t = el("text", { x, y: l.tag.y + TAG_H - 4, class: "bn-llabel" }, g);
        t.textContent = l.label;
      }
    }
    for (const n of m.nodes.values()) {
      const g = el("g", { class: "bnode" + (n.kind ? " k-" + n.kind : "") + (m.marked.has(n.id) ? " marked" : "") + fresh(n),
                          "data-id": n.id }, gn);
      if (m.marked.has(n.id)) el("rect", { x: n.x - 5, y: n.y - 5, width: n.w + 10, height: n.h + 10, rx: 10, class: "bn-mark" }, g);
      el("rect", { x: n.x, y: n.y, width: n.w, height: n.h, rx: n.kind === "actor" ? Math.min(16, n.h / 2) : 5, class: "bn-box" }, g);
      let ty = n.y + PADY + LINE - 4;
      for (const line of n.lines) {
        const t = el("text", { x: n.x + n.w / 2, y: ty, class: "bn-label", "text-anchor": "middle" }, g);
        t.textContent = line; ty += LINE;
      }
      for (const line of n.sublines) {
        const t = el("text", { x: n.x + n.w / 2, y: ty - 1, class: "bn-sub", "text-anchor": "middle" }, g);
        t.textContent = line; ty += SUBLINE;
      }
    }
    for (const note of lay.notes) {
      let y = note.y;
      for (const line of note.lines) {
        const t = el("text", { x: note.x, y, class: "bn-note", "text-anchor": "middle" }, gt);
        t.textContent = line; y += LINE;
      }
    }
    seen = Math.max(seen, ...ops.map((o) => o.seq || 0), 0);
    window.__boardGeometry = { board: active, ...geometry(svg, m, lay) };
    if (pane) pane.classList.toggle("empty", !ops.length);
  }

  // --- the geometry report, measured from what is on screen ---
  function geometry(svg, m, lay) {
    const r = (b) => ({ x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.w.toFixed(1), h: +b.h.toFixed(1) });
    const bb = (node) => { const b = node.getBBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    const inside = (a, b, tol = 0.5) => a.x >= b.x - tol && a.y >= b.y - tol && a.x + a.w <= b.x + b.w + tol && a.y + a.h <= b.y + b.h + tol;
    const report = { width: lay.W, height: lay.H, nodes: [], zones: [], overlaps: [], clipped: [],
                     linkCrossings: [], tagOverlaps: [], outside: [] };
    const view = { x: 0, y: 0, w: lay.W, h: lay.H };
    const boxes = [];
    for (const g of svg.querySelectorAll(".bnode")) {
      const box = bb(g.querySelector(".bn-box"));
      const texts = [...g.querySelectorAll("text")].map(bb);
      const text = texts.length ? texts.reduce((u, t) => ({ x: Math.min(u.x, t.x), y: Math.min(u.y, t.y),
        w: Math.max(u.x + u.w, t.x + t.w) - Math.min(u.x, t.x), h: Math.max(u.y + u.h, t.y + t.h) - Math.min(u.y, t.y) })) : box;
      const clipped = !texts.every((t) => inside(t, box));
      const id = g.dataset.id;
      report.nodes.push({ id, box: r(box), text: r(text), clipped });
      if (clipped) report.clipped.push(id);
      if (!inside(bb(g), view)) report.outside.push({ what: "node", id });
      boxes.push({ id, box });
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      if (hit(boxes[i].box, boxes[j].box, -0.5)) report.overlaps.push({ a: boxes[i].id, b: boxes[j].id, what: "box/box" });
    }
    const zoneEls = [...svg.querySelectorAll(".bzone")];
    for (const g of zoneEls) {
      const z = m.zones.get(g.dataset.id), box = bb(g.querySelector(".bz-rect"));
      const label = bb(g.querySelector("text"));
      report.zones.push({ id: z.id, box: r(box), members: z.members, labelClipped: !inside(label, box) });
      if (!inside(label, box)) report.clipped.push("zone:" + z.id);
      if (!inside(box, view)) report.outside.push({ what: "zone", id: z.id });
      for (const b of boxes) {
        const member = z.members.includes(b.id);
        if (member && !inside(b.box, box)) report.overlaps.push({ a: "zone:" + z.id, b: b.id, what: "member outside its zone" });
        if (!member && hit(b.box, box, -0.5)) report.overlaps.push({ a: "zone:" + z.id, b: b.id, what: "zone/foreign box" });
        if (hit(b.box, label, 0)) report.overlaps.push({ a: "zone-label:" + z.id, b: b.id, what: "zone label/box" });
      }
    }
    for (let i = 0; i < zoneEls.length; i++) for (let j = i + 1; j < zoneEls.length; j++) {
      const a = bb(zoneEls[i].querySelector(".bz-rect")), b = bb(zoneEls[j].querySelector(".bz-rect"));
      if (hit(a, b, -0.5)) report.overlaps.push({ a: "zone:" + zoneEls[i].dataset.id, b: "zone:" + zoneEls[j].dataset.id, what: "zone/zone" });
    }
    for (const l of m.links) {
      if (!l.pts) { report.linkCrossings.push({ from: l.from, to: l.to, through: "(not routed)" }); continue; }
      for (let i = 0; i < l.pts.length - 1; i++) {
        const a = l.pts[i], c = l.pts[i + 1];
        const seg = { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.abs(a.x - c.x), h: Math.abs(a.y - c.y) };
        for (const b of boxes) {
          if (b.id === l.from || b.id === l.to) continue;
          const shrunk = { x: b.box.x + 1, y: b.box.y + 1, w: b.box.w - 2, h: b.box.h - 2 };
          if (hit(seg, shrunk, 0)) report.linkCrossings.push({ from: l.from, to: l.to, through: b.id });
        }
        if (!inside(seg, view)) report.outside.push({ what: "link", id: l.from + "->" + l.to });
      }
    }
    // a line passing behind a note or a tag: legible thanks to the halo, but reported
    report.textCrossings = [];
    const texts = [...svg.querySelectorAll(".bn-note, .btag .bt-bg, .bn-zlabel")].map((t) =>
      ({ b: bb(t), owner: t.closest(".btag") ? t.closest(".btag").dataset.link : null }));
    for (const l of m.links) for (let i = 0; l.pts && i < l.pts.length - 1; i++) {
      const a = l.pts[i], c = l.pts[i + 1];
      const seg = { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.abs(a.x - c.x), h: Math.abs(a.y - c.y) };
      for (const { b: t, owner } of texts) {
        if (owner === l.from + ">" + l.to) continue;
        if (hit(seg, { x: t.x + 2, y: t.y + 2, w: t.w - 4, h: t.h - 4 }, 0)) { report.textCrossings.push({ from: l.from, to: l.to }); break; }
      }
    }
    const tags = [...svg.querySelectorAll(".btag")].map((g) => bb(g.querySelector(".bt-bg")));
    const notes = [...svg.querySelectorAll(".bn-note")].map(bb);
    const labels = [...tags.map((b) => ({ b, what: "link tag" })), ...notes.map((b) => ({ b, what: "note" }))];
    // a note on a zone's border reads as part of the zone
    for (const g of zoneEls) {
      const z = bb(g.querySelector(".bz-rect"));
      const edges = [{ x: z.x, y: z.y - 1, w: z.w, h: 2 }, { x: z.x, y: z.y + z.h - 1, w: z.w, h: 2 },
                     { x: z.x - 1, y: z.y, w: 2, h: z.h }, { x: z.x + z.w - 1, y: z.y, w: 2, h: z.h }];
      for (const n of notes) if (edges.some((e) => hit(n, e, 0))) report.tagOverlaps.push({ what: "note/zone edge", box: "zone:" + g.dataset.id });
    }
    for (let i = 0; i < labels.length; i++) {
      const L = labels[i];
      if (!inside(L.b, view)) report.outside.push({ what: L.what });
      for (const b of boxes) if (hit(L.b, b.box, -0.5)) report.tagOverlaps.push({ what: L.what + "/box", box: b.id });
      for (let j = i + 1; j < labels.length; j++) if (hit(L.b, labels[j].b, -0.5)) report.tagOverlaps.push({ what: L.what + "/" + labels[j].what });
    }
    report.summary = { nodes: boxes.length, overlaps: report.overlaps.length, clipped: report.clipped.length,
                       linkCrossings: report.linkCrossings.length, tagOverlaps: report.tagOverlaps.length,
                       outside: report.outside.length, textCrossings: report.textCrossings.length };
    return report;
  }

  // --- data ---
  const q = (p, name) => "path=" + encodeURIComponent(p) + "&board=" + encodeURIComponent(name);
  async function getJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("board " + res.status);
    return res.json();
  }
  const load = async (p, name) => (await getJSON("api/board?" + q(p, name))).ops || [];

  // the tab each document was left on; only boards other than main are written
  function remembered(p) {
    try { return JSON.parse(localStorage.getItem(TABS_KEY) || "{}")[p] || MAIN; } catch { return MAIN; }
  }
  function remember(p, name) {
    try {
      const all = JSON.parse(localStorage.getItem(TABS_KEY) || "{}");
      if (name === MAIN) delete all[p]; else all[p] = name;
      if (Object.keys(all).length) localStorage.setItem(TABS_KEY, JSON.stringify(all));
      else localStorage.removeItem(TABS_KEY);
    } catch { /* storage off: the tab is just not remembered */ }
  }

  async function switchTo(p) {
    const gen = ++loading, same = p === path;
    const want = same ? active : remembered(p);
    const before = boards;
    path = p || null;
    let next = new Map([[MAIN, { ops: [], exists: false }]]);
    if (path && RENDER_ONLY) {
      try { next = new Map([[want, { ops: await load(path, want), exists: true }]]); }
      catch (e) { console.warn("board: could not load", e); }
    } else if (path) {
      try {
        const list = (await getJSON("api/board/list?path=" + encodeURIComponent(path))).boards || [];
        const loaded = await Promise.all(list.map(async (b) => [b.name, { ops: b.exists ? await load(path, b.name) : [], exists: b.exists }]));
        next = new Map(loaded);
        // a tab made here and not yet drawn on survives a reconnect
        if (same) for (const [n, b] of before) if (!b.exists && !next.has(n) && next.size < BOARD_CAP) next.set(n, b);
      } catch (e) { console.warn("board: could not load", e); }
    }
    if (gen !== loading) return;
    boards = next;
    active = boards.has(want) ? want : RENDER_ONLY ? [...boards.keys()][0] : MAIN;
    ops = boards.get(active).ops;
    seen = Infinity;              // a board opening is not new chalk: nothing fades in
    tabs();
    lit();
    if (open || RENDER_ONLY) draw();
    seen = Math.max(0, ...ops.map((o) => o.seq || 0));
  }

  function select(name) {
    if (!boards.has(name)) return;
    active = name;
    const b = boards.get(name);
    b.unseen = false;
    ops = b.ops;
    seen = Infinity;
    if (path) remember(path, name);
    tabs();
    if (open) draw();
    seen = Math.max(0, ...ops.map((o) => o.seq || 0));
  }

  function tabs() {
    const bar = pane && pane.querySelector(".board-tabs");
    if (!bar) return;
    bar.textContent = "";
    for (const [name, b] of boards) {
      const t = document.createElement("button");
      t.type = "button";
      t.className = "board-tab" + (name === active ? " active" : "") + (b.unseen ? " unseen" : "");
      t.setAttribute("role", "tab");
      t.setAttribute("aria-selected", String(name === active));
      t.dataset.board = name;
      t.textContent = name;
      t.title = b.exists ? `${b.ops.length} ops` : "nothing drawn yet";
      t.onclick = () => select(name);
      bar.appendChild(t);
    }
    const add = document.createElement("button");
    add.type = "button";
    add.className = "board-add";
    add.title = "New board";
    add.setAttribute("aria-label", "New board");
    add.textContent = "+";
    add.onclick = addBoard;
    bar.appendChild(add);
    const del = pane.querySelector(".board-delete");
    if (del) del.hidden = active === MAIN || !boards.get(active).exists;
  }

  function addBoard() {
    if (!path) return;
    const asked = window.prompt("Name the new board (letters, digits, spaces, - and _; up to 24)");
    if (asked === null) return;
    const name = asked.split(/\s+/).filter(Boolean).join(" ");
    if (!NAME.test(name)) { window.alert("A board name is 1 to 24 letters, digits, spaces, dashes or underscores."); return; }
    const twin = [...boards.keys()].find((n) => n.toLowerCase() === name.toLowerCase());
    if (twin) { select(twin); return; }
    if (boards.size >= BOARD_CAP) { window.alert(`A document holds at most ${BOARD_CAP} boards.`); return; }
    boards.set(name, { ops: [], exists: false });
    select(name);
  }

  function lit() {
    const btn = document.getElementById("board-btn");
    if (btn) btn.classList.toggle("has-board", [...boards.values()].some((b) => b.ops.length > 0));
  }

  function onEvent(ev) {
    let e; try { e = JSON.parse(ev.data); } catch { return; }
    if (e.type === "moved" && e.old === path) {
      path = e.path;
      if (active !== MAIN) { remember(e.old, MAIN); remember(path, active); }
      return;
    }
    if (e.path !== path) return;
    const name = e.board || MAIN;
    let b = boards.get(name);
    if (e.type === "deleted") {
      boards.delete(name);
      if (!boards.has(MAIN)) boards.set(MAIN, { ops: [], exists: false });
      if (active === name) { remember(path, MAIN); select(MAIN); } else tabs();
      lit();
      return;
    }
    if (!b) {
      if (e.type !== "append") return;
      b = { ops: [], exists: true };
      boards.set(name, b);
    }
    if (e.type === "append") {
      b.exists = true;
      b.ops = b.ops.concat(e.ops.filter((o) => !b.ops.some((p) => p.seq === o.seq)));
      if (name !== active) b.unseen = true;
    } else if (e.type === "undo") b.ops = b.ops.filter((o) => o.batch !== e.batch);
    else if (e.type === "clear") b.ops = [];
    if (name === active) ops = b.ops;
    tabs();
    lit();
    if (open && name === active) draw();
  }

  function connect() {
    if (es) return;
    es = new EventSource("api/board/stream");
    es.onmessage = onEvent;
    // EventSource retries by itself; on reopen the boards are reloaded in case frames were missed
    es.onopen = () => { if (path) switchTo(path); };
  }
  function disconnect() { if (es) { es.close(); es = null; } }

  function setOpen(on) {
    on = !!on;
    if (on === open) return;
    open = on;
    if (!pane) return;
    pane.hidden = !on;
    if (on) {
      connect();
      const p = window.vesselWriter && window.vesselWriter.currentPath();
      if (p !== path) switchTo(p); else draw();
    } else disconnect();
  }

  async function ownerCall(what, confirmText) {
    if (!path || !window.confirm(confirmText)) return;
    const res = await fetch("api/board/" + what, { method: "POST", headers: { "Content-Type": "application/json" },
                                                   body: JSON.stringify({ path, board: active, confirm: true }) });
    if (!res.ok) console.warn("board: " + what + " refused", res.status);
  }
  function clearBoard() {
    if (!ops.length) return;
    ownerCall("clear", `Clear the board "${active}" of ${path}? This cannot be undone.`);
  }
  function deleteBoard() {
    if (active === MAIN) return;
    ownerCall("delete", `Delete the board "${active}" of ${path}, tab and all? This cannot be undone.`);
  }

  function mount() {
    pane = document.getElementById("board-pane");
    if (!pane) return;
    canvas = pane.querySelector(".board-canvas");
    const clr = pane.querySelector(".board-clear");
    if (clr) clr.onclick = clearBoard;
    const del = pane.querySelector(".board-delete");
    if (del) del.onclick = deleteBoard;
    ro = new ResizeObserver(() => { if (open || RENDER_ONLY) draw(); });
    ro.observe(canvas);
    if (RENDER_ONLY) {
      active = typeof window.boardRenderBoard === "string" ? window.boardRenderBoard : MAIN;
      path = window.boardRenderPath;
      switchTo(window.boardRenderPath).then(() => {
        requestAnimationFrame(() => { draw(); window.__boardReady = true; });
      });
      return;
    }
    tabs();
    const w = window.vesselWriter;
    if (w) {
      w.onDocOpened((p) => { if (p !== path) switchTo(p); });
      if (w.currentPath()) switchTo(w.currentPath());
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();

  window.vesselBoard = { setOpen, redraw: draw, path: () => path, board: () => active, select,
                         boards: () => [...boards].map(([name, b]) => ({ name, count: b.ops.length, exists: b.exists })) };
})();
