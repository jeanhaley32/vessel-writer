// Resource launcher — renders the list the server hands it. The list is the
// only source of truth: no tool name, URL or icon is hardcoded here.
const grid = document.getElementById("grid");
const empty = document.getElementById("empty");

// A bare ":3000" means "same host, that port" so nothing hardcodes the tailnet
// address; anything else is used as written.
const resolve = (url) => {
  if (url.startsWith(":")) return `${location.protocol}//${location.hostname}${url}`;
  return /^(javascript|data|vbscript):/i.test(url.trim()) ? "#" : url;
};

function card(item) {
  const a = document.createElement("a");
  a.className = "res";
  a.href = resolve(item.url);
  if (item.pinned) a.classList.add("pinned");
  const icon = document.createElement("span");
  icon.className = "res-icon";
  icon.dataset.icon = item.icon || "dot";
  const name = document.createElement("span");
  name.className = "res-name";
  name.textContent = item.name;
  const note = document.createElement("span");
  note.className = "res-note";
  note.textContent = item.note || "";
  a.append(icon, name, note);
  return a;
}

async function load() {
  let items = [];
  try {
    const r = await fetch("api/resources");
    items = (await r.json()).resources || [];
  } catch (e) {
    console.error("resource list unavailable", e);
  }
  grid.replaceChildren(...items.map(card));
  grid.setAttribute("aria-busy", "false");
  empty.hidden = items.length > 0;
}

load();
