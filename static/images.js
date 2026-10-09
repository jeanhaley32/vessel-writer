// Pasted and dropped images, for the editor and for chat.
//
// An image is uploaded once (api/upload names it by content hash) and the
// document keeps only a markdown link to it. The link stays visible and
// editable; a block widget under its line shows the picture.

import { Decoration, StateField, EditorView, WidgetType }
  from "./vendor/editor/vessel-editor.bundle.mjs";

const IMAGE_LINE = /^!\[[^\]\n]*\]\((api\/upload\/[0-9a-f]{20}\.(?:png|jpg|gif|webp))\)\s*$/;

export const imageFiles = (items) =>
  [...(items || [])].filter((f) => f && /^image\/(png|jpeg|gif|webp)$/.test(f.type));

export async function uploadImage(file) {
  const r = await fetch("api/upload", { method: "POST", body: file });
  if (!r.ok) throw new Error(r.status === 413 ? "image too large" : "upload failed (" + r.status + ")");
  return r.json();
}

class PictureWidget extends WidgetType {
  constructor(url) { super(); this.url = url; }
  eq(other) { return other.url === this.url; }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-picture";
    const img = document.createElement("img");
    img.src = this.url;
    img.alt = "";
    img.loading = "lazy";
    wrap.append(img);
    return wrap;
  }
  ignoreEvent() { return true; }
}

function pictures(state) {
  const widgets = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const m = IMAGE_LINE.exec(line.text);
    if (m) widgets.push(Decoration.widget({ widget: new PictureWidget(m[1]), block: true, side: 1 }).range(line.to));
  }
  return Decoration.set(widgets);
}

const pictureField = StateField.define({
  create: pictures,
  update: (value, tr) => (tr.docChanged ? pictures(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f),
});

async function insertImages(view, files, notify) {
  for (const file of files) {
    try {
      const { url } = await uploadImage(file);
      const { from, to } = view.state.selection.main;
      const line = view.state.doc.lineAt(from);
      const lead = from > line.from ? "\n" : "";
      const text = `${lead}![](${url})\n`;
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
    } catch (e) { notify(e.message); }
  }
}

export function imageExtensions(notify = () => {}) {
  return [
    pictureField,
    EditorView.domEventHandlers({
      paste(event, view) {
        const files = imageFiles(event.clipboardData && event.clipboardData.files);
        if (!files.length) return false;
        event.preventDefault();
        insertImages(view, files, notify);
        return true;
      },
      drop(event, view) {
        const files = imageFiles(event.dataTransfer && event.dataTransfer.files);
        if (!files.length) return false;
        event.preventDefault();
        const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (at != null) view.dispatch({ selection: { anchor: at } });
        insertImages(view, files, notify);
        return true;
      },
    }),
  ];
}
