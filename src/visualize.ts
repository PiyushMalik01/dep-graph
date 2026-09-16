import { readFile, writeFile } from "fs/promises";

interface GNode {
  id: string;
  kind: "tool" | "user_input";
  toolkit?: string;
  name: string;
  description?: string;
  prompt?: string;
}
interface GEdge { id: string; from: string; to: string; slot: string; param: string; type: string; reason?: string; confidence?: number }

const graph: { meta: Record<string, unknown>; nodes: GNode[]; edges: GEdge[] } = JSON.parse(
  await readFile("dependency_graph.json", "utf-8")
);

/**
 * Showcase seeds for the default view: the readme's two worked examples.
 *
 * These are selected by *semantics*, not by hardcoded slugs. Composio's real
 * slugs are e.g. GOOGLESUPER_LIST_THREADS / GOOGLESUPER_REPLY_TO_EMAIL_THREAD —
 * note there is no per-service segment — so any list of literal slugs written
 * ahead of a real fetch is a guess that silently renders an empty page when it
 * misses. Instead we look for an edge carrying the right *slot* into a consumer
 * with the right verb, which holds regardless of how the slugs are spelled.
 */
const EXAMPLES = [
  { label: "thread_id precursor", slot: "gmail.thread_id", consumer: /REPLY|RESPOND/i },
  { label: "name -> contact -> email", slot: "people.email_address", consumer: /SEND|COMPOSE|CREATE_?DRAFT|INVITE/i },
];

function pickShowcaseSeeds(): { seeds: string[]; notes: string[] } {
  const seeds = new Set<string>();
  const notes: string[] = [];

  for (const ex of EXAMPLES) {
    const onSlot = graph.edges.filter((e) => e.slot === ex.slot && e.type !== "user_input");
    const preferred = onSlot.filter((e) => ex.consumer.test(e.to));
    // documented edges first: they are the ones the tool docs themselves vouch for
    const rank = (e: GEdge) => (e.type === "documented" ? 0 : e.type === "structural" ? 1 : 2);
    const chosen = [...(preferred.length > 0 ? preferred : onSlot)].sort((a, b) => rank(a) - rank(b)).slice(0, 3);
    if (chosen.length === 0) {
      notes.push(`no edge found for "${ex.label}" (slot ${ex.slot})`);
      continue;
    }
    if (preferred.length === 0) notes.push(`"${ex.label}": no ${ex.consumer} consumer, showing other ${ex.slot} edges`);
    for (const e of chosen) { seeds.add(e.from); seeds.add(e.to); }
  }

  // fallback so the default view is never empty: the busiest tool nodes.
  if (seeds.size === 0) {
    const degree = new Map<string, number>();
    for (const e of graph.edges) {
      if (e.type === "user_input") continue;
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    notes.push("neither readme example matched — falling back to highest-degree tools");
    for (const [id] of [...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) seeds.add(id);
  }

  return { seeds: [...seeds], notes };
}

const { seeds: SHOWCASE_SEEDS, notes } = pickShowcaseSeeds();
for (const n of notes) console.warn(`showcase: ${n}`);

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Composio Tool Dependency Graph</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/vis-network/9.1.9/standalone/umd/vis-network.min.js"></script>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font-family: system-ui, sans-serif; background: #0f1115; color: #eee; }
  #toolbar { position: fixed; top: 0; left: 0; right: 0; z-index: 10; padding: 10px 14px; background: #14161c; border-bottom: 1px solid #2a2d36; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  #toolbar label { font-size: 13px; display: flex; align-items: center; gap: 4px; }
  #toolbar input[type=text] { padding: 4px 8px; border-radius: 4px; border: 1px solid #333; background: #1c1e26; color: #eee; }
  #meta { font-size: 12px; color: #999; margin-left: auto; }
  #network { position: absolute; top: 46px; left: 0; right: 0; bottom: 0; }
  button { background: #2a2d36; color: #eee; border: 1px solid #3a3d46; border-radius: 4px; padding: 5px 10px; cursor: pointer; font-size: 13px; }
  button:hover { background: #363943; }
  #legend { position: fixed; bottom: 10px; left: 10px; font-size: 12px; background: #14161cdd; padding: 8px 12px; border-radius: 6px; line-height: 1.6; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; }
</style>
</head>
<body>
<div id="toolbar">
  <button id="btnShowcase">Showcase (readme examples)</button>
  <button id="btnFull">Full graph</button>
  <label><input type="checkbox" id="chkDocumented" checked /> documented</label>
  <label><input type="checkbox" id="chkStructural" checked /> structural</label>
  <label><input type="checkbox" id="chkHeuristic" checked /> heuristic</label>
  <label><input type="checkbox" id="chkUserInput" checked /> user input</label>
  <input type="text" id="search" placeholder="search tool slug..." />
  <div id="meta"></div>
</div>
<div id="network"></div>
<div id="legend">
  <div><span class="dot" style="background:#4f8fe8"></span>googlesuper tool</div>
  <div><span class="dot" style="background:#e8944f"></span>github tool</div>
  <div><span class="dot" style="background:#e8d24f"></span>user input</div>
  <div><b style="color:#5fd38a">thick green</b> = documented (param docs name the tool) &nbsp; solid = structural (schema slot join)</div>
  <div>dashed = heuristic (slug noun) &nbsp; dotted = user input &nbsp; hover edges for slot + reason</div>
</div>
<script>
const DATA = ${JSON.stringify(graph)};
const SHOWCASE_SEEDS = ${JSON.stringify(SHOWCASE_SEEDS)};
// above this many rendered edges, physics stabilization becomes the bottleneck
// (the real dataset is ~1366 tools), so lay out once without the force sim.
const PHYSICS_LIMIT = 800;

function colorFor(n) {
  if (n.kind === "user_input") return "#e8d24f";
  if (n.toolkit === "github") return "#e8944f";
  return "#4f8fe8";
}

function edgeStyle(e) {
  if (e.type === "documented") return { dashes: false, color: "#5fd38a", width: 2.5 };
  if (e.type === "structural") return { dashes: false, color: "#7aa8e8" };
  if (e.type === "heuristic") return { dashes: [4, 3], color: "#e8b04f" };
  return { dashes: [1, 3], color: "#888" };
}

function toVisNodes(nodeList) {
  return nodeList.map((n) => ({
    id: n.id,
    label: n.kind === "user_input" ? "ASK: " + n.name : n.name,
    shape: n.kind === "user_input" ? "box" : "ellipse",
    color: colorFor(n),
    title: n.id + (n.description ? " — " + n.description : n.prompt ? " — " + n.prompt : ""),
  }));
}

function toVisEdges(edgeList) {
  return edgeList.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    arrows: "to",
    ...edgeStyle(e),
    title: (e.slot ? e.slot + " (" + e.param + ")" : e.param) + (e.reason ? " — " + e.reason : ""),
  }));
}

const network = new vis.Network(
  document.getElementById("network"),
  { nodes: new vis.DataSet([]), edges: new vis.DataSet([]) },
  { interaction: { hover: true } }
);

function activeTypes() {
  const t = [];
  if (document.getElementById("chkDocumented").checked) t.push("documented");
  if (document.getElementById("chkStructural").checked) t.push("structural");
  if (document.getElementById("chkHeuristic").checked) t.push("heuristic");
  if (document.getElementById("chkUserInput").checked) t.push("user_input");
  return t;
}

function render(nodeIds, edgeList) {
  const types = new Set(activeTypes());
  const filteredEdges = edgeList.filter((e) => types.has(e.type));
  const keepIds = new Set(nodeIds);
  const nodeList = DATA.nodes.filter((n) => keepIds.has(n.id));
  const heavy = filteredEdges.length > PHYSICS_LIMIT;
  network.setOptions(
    heavy
      ? { physics: { enabled: false }, layout: { improvedLayout: false } }
      : { physics: { enabled: true, stabilization: true, barnesHut: { gravitationalConstant: -4000, springLength: 140 } }, layout: { improvedLayout: true } }
  );
  network.setData({ nodes: new vis.DataSet(toVisNodes(nodeList)), edges: new vis.DataSet(toVisEdges(filteredEdges)) });
  document.getElementById("meta").textContent =
    nodeList.length + " nodes, " + filteredEdges.length + " edges (of " + DATA.meta.nodeCount + " / " + DATA.meta.edgeCount + " total)" +
    (heavy ? " — physics off for speed" : "");
}

function neighborhood(seedIds) {
  const seeds = new Set(seedIds.filter((id) => DATA.nodes.some((n) => n.id === id)));
  const relevantEdges = DATA.edges.filter((e) => seeds.has(e.from) || seeds.has(e.to));
  const nodeIds = new Set(seeds);
  for (const e of relevantEdges) { nodeIds.add(e.from); nodeIds.add(e.to); }
  render([...nodeIds], relevantEdges);
}

function showcase() { neighborhood(SHOWCASE_SEEDS); }
function full() { render(DATA.nodes.map((n) => n.id), DATA.edges); }

function searchFocus(q) {
  if (!q) return;
  const needle = q.toLowerCase();
  const matches = DATA.nodes.filter((n) => n.id.toLowerCase().includes(needle)).slice(0, 10);
  if (matches.length === 0) return;
  mode = "search";
  neighborhood(matches.map((n) => n.id));
}

let mode = "showcase";
let lastSearch = "";
function rerender() {
  if (mode === "full") full();
  else if (mode === "search") searchFocus(lastSearch);
  else showcase();
}

document.getElementById("btnShowcase").onclick = () => { mode = "showcase"; rerender(); };
document.getElementById("btnFull").onclick = () => { mode = "full"; rerender(); };
document.getElementById("chkDocumented").onchange = rerender;
document.getElementById("chkStructural").onchange = rerender;
document.getElementById("chkHeuristic").onchange = rerender;
document.getElementById("chkUserInput").onchange = rerender;
document.getElementById("search").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") { lastSearch = ev.target.value; searchFocus(lastSearch); }
});

rerender();
</script>
</body>
</html>
`;

await writeFile("graph.html", html, "utf-8");
console.log(`wrote graph.html (showcase seeds: ${SHOWCASE_SEEDS.join(", ") || "none"})`);
