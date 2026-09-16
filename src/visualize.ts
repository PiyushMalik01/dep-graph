import { readFile, writeFile } from "fs/promises";

const graph = JSON.parse(await readFile("dependency_graph.json", "utf-8"));

// curated showcase: readme's two worked examples, always included regardless
// of which toolkit slugs happened to fetch, plus everything directly
// connected to them (1-hop neighborhood) so the reviewer sees real edges the
// instant the page opens.
const SHOWCASE_SEEDS = [
  "GOOGLESUPER_GMAIL_LIST_THREADS",
  "GOOGLESUPER_GMAIL_REPLY_TO_THREAD",
  "GOOGLESUPER_PEOPLE_SEARCH_CONTACTS",
  "GOOGLESUPER_GMAIL_SEND_EMAIL",
];

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Composio Tool Dependency Graph</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/vis-network/9.1.9/standalone/umd/vis-network.min.js"></script>
<style>
  :root { color-scheme: light; }
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
  <div>solid edge = structural &nbsp; dashed = heuristic &nbsp; dotted = user input</div>
</div>
<script>
const DATA = ${JSON.stringify(graph)};
const SHOWCASE_SEEDS = ${JSON.stringify(SHOWCASE_SEEDS)};

function colorFor(n) {
  if (n.kind === "user_input") return "#e8d24f";
  if (n.toolkit === "github") return "#e8944f";
  return "#4f8fe8";
}

function edgeStyle(e) {
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
    title: n.description || n.prompt || n.id,
  }));
}

function toVisEdges(edgeList) {
  return edgeList.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    arrows: "to",
    ...edgeStyle(e),
    title: e.slot ? (e.slot + " (" + e.param + ")" + (e.reason ? " — " + e.reason : "")) : e.param,
  }));
}

const network = new vis.Network(
  document.getElementById("network"),
  { nodes: new vis.DataSet([]), edges: new vis.DataSet([]) },
  { physics: { stabilization: true, barnesHut: { gravitationalConstant: -4000, springLength: 140 } }, interaction: { hover: true } }
);

function activeTypes() {
  const t = [];
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
  network.setData({ nodes: new vis.DataSet(toVisNodes(nodeList)), edges: new vis.DataSet(toVisEdges(filteredEdges)) });
  document.getElementById("meta").textContent = nodeList.length + " nodes, " + filteredEdges.length + " edges (of " + DATA.meta.nodeCount + " / " + DATA.meta.edgeCount + " total)";
}

function showcase() {
  const seeds = new Set(SHOWCASE_SEEDS.filter((id) => DATA.nodes.some((n) => n.id === id)));
  const relevantEdges = DATA.edges.filter((e) => seeds.has(e.from) || seeds.has(e.to));
  const nodeIds = new Set(seeds);
  for (const e of relevantEdges) { nodeIds.add(e.from); nodeIds.add(e.to); }
  render(Array.from(nodeIds), relevantEdges);
}

function full() {
  render(DATA.nodes.map((n) => n.id), DATA.edges);
}

function searchFocus(q) {
  if (!q) return;
  const match = DATA.nodes.find((n) => n.id.toLowerCase().includes(q.toLowerCase()));
  if (!match) return;
  const relevantEdges = DATA.edges.filter((e) => e.from === match.id || e.to === match.id);
  const nodeIds = new Set([match.id]);
  for (const e of relevantEdges) { nodeIds.add(e.from); nodeIds.add(e.to); }
  render(Array.from(nodeIds), relevantEdges);
}

let mode = "showcase";
function rerender() {
  if (mode === "full") full();
  else showcase();
}

document.getElementById("btnShowcase").onclick = () => { mode = "showcase"; rerender(); };
document.getElementById("btnFull").onclick = () => { mode = "full"; rerender(); };
document.getElementById("chkStructural").onchange = rerender;
document.getElementById("chkHeuristic").onchange = rerender;
document.getElementById("chkUserInput").onchange = rerender;
document.getElementById("search").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") searchFocus(ev.target.value);
});

rerender();
</script>
</body>
</html>
`;

await writeFile("graph.html", html, "utf-8");
console.log("wrote graph.html");
