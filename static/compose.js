// The box for writing a comment of your own on the selected text.
//
// Kept apart from comments.js on purpose: that file's rule is that nothing
// arriving may move focus, and this box takes focus only because Jean asked for
// it by selecting text and choosing Comment.

export function openComposer({ view, path, post, onPosted, onClose }) {
  const { from, to } = view.state.selection.main;
  if (from === to) return null;
  const doc = view.state.doc;
  const quote = doc.sliceString(from, to).slice(0, 500);
  const line = doc.lineAt(from).number;

  const host = document.querySelector("#main") || document.body;
  const box = document.createElement("div");
  box.className = "vw-thread vw-compose";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "New comment");
  const head = document.createElement("div");
  head.className = "vw-thread-head";
  const label = document.createElement("span");
  label.textContent = "Comment on the selection";
  head.append(label);
  const input = document.createElement("textarea");
  input.rows = 3; input.placeholder = "What do you want to ask or say about this?";
  input.setAttribute("aria-label", "Your comment");
  const form = document.createElement("div");
  form.className = "vw-thread-form";
  const send = document.createElement("button");
  send.type = "button"; send.className = "vw-thread-send"; send.textContent = "Comment";
  const cancel = document.createElement("button");
  cancel.type = "button"; cancel.className = "vw-thread-dismiss"; cancel.textContent = "Cancel";
  form.append(input, send, cancel);
  box.append(head, form);
  host.appendChild(box);

  const close = () => { box.remove(); onClose(); };

  const h = host.getBoundingClientRect();
  const at = view.coordsAtPos(to) || view.coordsAtPos(from);
  if (at) {
    box.style.top = Math.max(8, at.bottom - h.top + 6) + "px";
    box.style.left = Math.max(8, Math.min(at.left - h.left, h.width - box.offsetWidth - 8)) + "px";
  }

  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      const res = await post("api/comments", { path, quote, line, text, kind: "note", author: "jean" });
      onPosted(res);
      close();
    } catch (_) { send.disabled = false; label.textContent = "Could not post. Try again."; }
  };
  send.onclick = submit;
  cancel.onclick = close;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
  });
  input.focus();
  return { close };
}
