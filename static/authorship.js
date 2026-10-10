// Tints the text the assistant wrote, so the owner can tell his lines from its.
//
// Attribution comes from Yjs itself: every character in the shared text was
// created by one Yjs client. Each tab is its own client; every edit that is
// not a tab's (the assistant's anchored edits) is made by the server's session
// client, whose id the server hands over when the document opens. So a span is
// the assistant's exactly when its items carry that client id. Text the owner
// types over or around it is his own items, and is never tinted.
//
// Like the comment layer, this only styles text already on screen: marks, no
// widgets, effects only, never a selection.

import { Decoration, StateEffect, StateField, EditorView, ViewPlugin }
  from "./vendor/editor/vessel-editor.bundle.mjs";

const RECOMPUTE_MS = 120;
let lastSpans = [];   // the text of each tinted span, for the console/test seam
const setAuthorship = StateEffect.define();
const assistantMark = Decoration.mark({
  class: "cm-by-assistant",
  attributes: { title: "Written by " + ((window.vesselConfig || {}).assistant || "the assistant") },
});

// Walk the Y.Text item list and collect the live spans one client created.
export function spansBy(ytext, client) {
  const spans = [];
  let pos = 0;
  for (let item = ytext._start; item; item = item.right) {
    if (item.deleted || !item.countable) continue;
    const end = pos + item.length;
    if (item.id.client === client) {
      const last = spans[spans.length - 1];
      if (last && last.to === pos) last.to = end;
      else spans.push({ from: pos, to: end });
    }
    pos = end;
  }
  return spans;
}

const authorshipField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setAuthorship)) return effect.value;
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// getSource() returns {ytext, client} for the open document, or null.
export function authorshipExtension(getSource) {
  const plugin = ViewPlugin.fromClass(class {
    constructor(view) { this.view = view; this.timer = null; this.schedule(); }
    update(u) { if (u.docChanged) this.schedule(); }
    schedule() {
      clearTimeout(this.timer);
      // Deferred, so yCollab has finished syncing the Y.Text with the editor
      // before positions are read from it.
      this.timer = setTimeout(() => this.recompute(), RECOMPUTE_MS);
    }
    recompute() {
      const source = getSource();
      if (!source || source.client == null) return;
      const size = this.view.state.doc.length;
      const spans = spansBy(source.ytext, source.client).filter((s) => s.to <= size && s.to > s.from);
      const doc = this.view.state.doc;
      lastSpans = spans.map((s) => doc.sliceString(s.from, s.to));
      const ranges = spans.map((s) => assistantMark.range(s.from, s.to));
      this.view.dispatch({ effects: setAuthorship.of(Decoration.set(ranges, true)) });
    }
    destroy() { clearTimeout(this.timer); }
  });
  return [authorshipField, plugin];
}

// Console and test seam: the text of each span currently tinted.
window.vesselAuthorship = { spans: () => lastSpans.slice() };
