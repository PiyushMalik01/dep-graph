import { readFile, writeFile } from "fs/promises";

interface GNode {
  id: string;
  kind: "tool" | "user_input";
  toolkit?: string;
  service?: string;
  name: string;
  description?: string;
  prompt?: string;
}
interface GEdge { from: string; to: string; slot: string; param: string; type: string; required: boolean; reason?: string }

const graph: { meta: { toolCount: number; nodeCount: number; edgeCount: number }; nodes: GNode[]; edges: GEdge[] } =
  JSON.parse(await readFile("dependency_graph.json", "utf-8"));

/**
 * The readme's two worked examples, picked by *semantics* rather than literal
 * slugs: the consumer of an edge carrying the slot into a tool with the right verb.
 */
const EXAMPLE_RULES = [
  { label: "needs a thread_id, which listing threads provides", slot: "gmail.thread_id", consumer: /REPLY/i },
  // prefer: the precursor the brief describes, so the example's plan leads with it
  { label: "needs an email address, which a contacts lookup by name provides", slot: "people.email_address", consumer: /SEND_EMAIL$/i, prefer: "SEARCH_PEOPLE$" },
];

const rank = (e: GEdge) => (e.type === "documented" ? 0 : e.type === "structural" ? 1 : 2);
const examples = EXAMPLE_RULES.flatMap((rule) => {
  const hit = graph.edges
    .filter((e) => e.slot === rule.slot && e.type !== "user_input" && rule.consumer.test(e.to))
    .sort((a, b) => rank(a) - rank(b) || a.to.length - b.to.length)[0];
  if (!hit) {
    console.warn(`example not found in graph: ${rule.slot} into ${rule.consumer}`);
    return [];
  }
  return [{ target: hit.to, label: rule.label, slot: rule.slot, prefer: rule.prefer }];
});

// eval/results.json is written by `bun run eval`; the viewer shows it when present
const evalResults = await readFile("eval/results.json", "utf-8").then(JSON.parse).catch(() => null);

// compact payload: the full dependency_graph.json is ~3.7MB of repeated keys
const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s ?? "");
const TYPE_CODE: Record<string, string> = { documented: "d", structural: "s", heuristic: "h", user_input: "u" };
const data = {
  meta: { toolCount: graph.meta.toolCount, eval: evalResults },
  tools: graph.nodes
    .filter((n) => n.kind === "tool")
    .map((n) => ({ id: n.id, name: n.name, tk: n.toolkit === "github" ? "h" : "g", svc: n.service, desc: clip(n.description, 900) })),
  inputs: graph.nodes.filter((n) => n.kind === "user_input").map((n) => ({ id: n.id, name: n.name, prompt: clip(n.prompt, 400) })),
  // documented edges carry the doc sentence that names the precursor
  edges: graph.edges.map((e) => {
    const row: (string | number)[] = [e.from, e.to, e.slot, e.param, TYPE_CODE[e.type]!, e.required ? 1 : 0];
    if (e.type === "documented" && e.reason) row.push(e.reason);
    return row;
  }),
};

const css = await readFile("src/viewer/style.css", "utf-8");
const app = await readFile("src/viewer/app.js", "utf-8");
// keep inlined JSON from terminating the script element
const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Tool dependency graph: Google Super and GitHub</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
<script src="https://cdnjs.cloudflare.com/ajax/libs/vis-network/9.1.9/standalone/umd/vis-network.min.js"></script>
<style>
${css}
</style>
</head>
<body>
<header>
  <h1>Tool dependency graph<small>What to look up, or ask the user, before running a tool</small></h1>
  <nav role="tablist" aria-label="Views">
    <button role="tab" data-view="examples" aria-selected="true">Examples</button>
    <button role="tab" data-view="tool" id="tabTool" hidden>Tool</button>
    <button role="tab" data-view="services" aria-selected="false">Service map</button>
  </nav>
  <div class="search">
    <input id="search" type="search" list="toolOptions" placeholder="Find a tool, e.g. Send Email or GITHUB_MERGE_A_PULL_REQUEST" aria-label="Find a tool" autocomplete="off" />
    <datalist id="toolOptions"></datalist>
  </div>
</header>
<main>
  <section id="stage" aria-label="Graph">
    <div id="network"></div>
    <div class="stage-caption" id="caption"></div>
    <div class="controls">
      <span class="key"><span class="swatch documented"></span>named in docs</span>
      <span class="key"><span class="swatch structural"></span>returns it</span>
      <label><input type="checkbox" id="optHeuristic" checked /><span class="swatch heuristic"></span>likely returns it</label>
      <label><input type="checkbox" id="optAsk" checked /><span class="swatch ask"></span>ask the user</label>
    </div>
  </section>
  <aside id="panel" aria-live="polite"></aside>
</main>
<script>
const DATA = ${json(data)};
const EXAMPLES = ${json(examples)};
</script>
<script>
${app}
</script>
</body>
</html>
`;

await writeFile("graph.html", html, "utf-8");
console.log(`wrote graph.html (${(html.length / 1e6).toFixed(1)}MB; examples: ${examples.map((e) => e.target).join(", ") || "none"})`);
