// Client for graph.html. DATA and EXAMPLES are inlined above this script by
// src/visualize.ts. Edges are compact tuples: [from, to, slot, param, type, required].

const TYPE = { d: "documented", s: "structural", h: "heuristic", u: "user_input" };
const HOW = {
  documented: "named in its docs",
  structural: "returns it",
  heuristic: "likely returns it",
  user_input: "ask the user",
};
const RANK = { documented: 0, structural: 1, heuristic: 2, user_input: 3 };
const COLOR = {
  paper: "#f2f4f1", ink: "#1c2430", muted: "#5d6b7a", rule: "#d5dad3",
  google: "#2f6fdb", github: "#6b46c1", ask: "#b7791f", documented: "#1f8a5b",
};
const SERVICE_LABEL = {
  gmail: "Gmail", drive: "Drive", calendar: "Calendar", sheets: "Sheets", docs: "Docs", slides: "Slides",
  forms: "Forms", tasks: "Tasks", photos: "Photos", people: "Contacts", analytics: "Analytics", ads: "Ads",
  maps: "Maps", meet: "Meet", github: "GitHub", unknown: "Other Google",
};

// ---------- index ----------
const nodes = new Map();
for (const t of DATA.tools) nodes.set(t.id, { ...t, kind: "tool" });
for (const i of DATA.inputs) nodes.set(i.id, { ...i, kind: "input" });

// the 7th tuple element is the doc sentence behind a documented edge
const edges = DATA.edges.map(([from, to, slot, param, type, required, quote]) => ({ from, to, slot, param, type: TYPE[type], required: !!required, quote }));
const incoming = new Map();
const outgoing = new Map();
for (const e of edges) {
  (incoming.get(e.to) ?? incoming.set(e.to, []).get(e.to)).push(e);
  (outgoing.get(e.from) ?? outgoing.set(e.from, []).get(e.from)).push(e);
}

const settings = { heuristic: true, ask: true };
const allowed = (e) => (e.type !== "heuristic" || settings.heuristic) && (e.type !== "user_input" || settings.ask);

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const toolkitOf = (n) => (n.tk === "h" ? "github" : "google");

function nodeStyle(n, focus) {
  if (n.kind === "input") {
    return {
      label: "Ask: " + n.name, shape: "box",
      color: { background: "#fff4de", border: COLOR.ask, highlight: { background: "#ffe9bf", border: COLOR.ask } },
      font: { face: "IBM Plex Mono", size: 12, color: COLOR.ink },
      borderWidth: 1, margin: 8, shapeProperties: { borderDashes: [3, 3] },
    };
  }
  const hue = toolkitOf(n) === "github" ? COLOR.github : COLOR.google;
  if (focus) {
    return {
      label: n.name, shape: "box",
      color: { background: COLOR.ink, border: COLOR.ink, highlight: { background: COLOR.ink, border: COLOR.ink } },
      font: { face: "IBM Plex Sans", size: 15, color: "#ffffff", bold: { color: "#ffffff" } },
      borderWidth: 0, margin: 12,
    };
  }
  return {
    label: n.name, shape: "box",
    color: { background: "#ffffff", border: hue, highlight: { background: "#f4f7fd", border: hue }, hover: { background: "#f4f7fd", border: hue } },
    font: { face: "IBM Plex Sans", size: 13, color: COLOR.ink },
    borderWidth: 1.5, margin: 10,
  };
}

function edgeStyle(type) {
  if (type === "documented") return { color: COLOR.documented, width: 3 };
  if (type === "structural") return { color: COLOR.muted, width: 1.5 };
  if (type === "heuristic") return { color: "#9aa5b1", width: 1.5, dashes: [6, 5] };
  return { color: COLOR.ask, width: 1.5, dashes: [2, 4] };
}

// best edge per (from, to), with every param it carries
function mergeEdges(list) {
  const byPair = new Map();
  for (const e of list) {
    const key = e.from + ">" + e.to;
    const cur = byPair.get(key);
    if (!cur) byPair.set(key, { ...e, params: [e.param] });
    else {
      if (!cur.params.includes(e.param)) cur.params.push(e.param);
      if (RANK[e.type] < RANK[cur.type]) cur.type = e.type;
    }
  }
  return [...byPair.values()];
}

// ---------- network ----------
let network = null;

function draw(visNodes, visEdges, mode) {
  if (network) network.destroy();
  const options =
    mode === "flow"
      ? {
          layout: { hierarchical: { enabled: true, direction: "LR", levelSeparation: 240, nodeSpacing: 58, treeSpacing: 120, sortMethod: "directed", shakeTowards: "roots" } },
          physics: false,
          edges: { smooth: { type: "cubicBezier", forceDirection: "horizontal", roundness: 0.55 }, arrows: { to: { enabled: true, scaleFactor: 0.6 } } },
        }
      : {
          layout: { improvedLayout: true },
          physics: { solver: "forceAtlas2Based", forceAtlas2Based: { gravitationalConstant: -160, springLength: 170 }, stabilization: { iterations: 400 } },
          edges: { smooth: { type: "continuous" }, arrows: { to: { enabled: true, scaleFactor: 0.5 } } },
        };
  network = new vis.Network(
    $("#network"),
    { nodes: new vis.DataSet(visNodes), edges: new vis.DataSet(visEdges) },
    {
      ...options,
      interaction: { hover: true, tooltipDelay: 150, navigationButtons: false, keyboard: false },
      nodes: { widthConstraint: { maximum: 190 } },
    }
  );
  network.once("afterDrawing", () => {
    network.fit({ animation: false });
    // small neighbourhoods would otherwise be blown up to fill the canvas
    if (network.getScale() > 1.15) network.moveTo({ scale: 1.15 });
  });
  network.on("click", (ev) => {
    const id = ev.nodes[0];
    if (!id) return;
    if (mode === "services") showService(id);
    else if (id.startsWith("P:")) return;
    else if (nodes.get(id)?.kind === "tool") go({ tool: id });
    else showInput(id);
  });
}

// Parameter nodes sit between a tool and its sources, one per slot, so the
// "which value" label is drawn once instead of on every converging edge.
function paramNodeStyle(p) {
  return {
    label: p.params.join(", ") + (p.required ? "" : "\n(optional)"),
    shape: "box",
    color: { background: COLOR.paper, border: COLOR.rule, highlight: { background: COLOR.paper, border: COLOR.muted } },
    font: { face: "IBM Plex Mono", size: 12, color: p.required ? COLOR.ink : COLOR.muted, multi: false },
    borderWidth: 1, margin: 7, shapeProperties: { borderRadius: 12 },
  };
}

function toVis(graph, focusIds) {
  const visNodes = [...graph.levels].map(([id, level]) => {
    const synth = graph.params.get(id);
    if (synth) return { id, level, title: synth.params.join(", "), ...paramNodeStyle(synth) };
    const n = nodes.get(id);
    return { id, level, title: n.kind === "tool" ? n.id : n.prompt, ...nodeStyle(n, focusIds.has(id)) };
  });
  const visEdges = mergeEdges(graph.chosen).map((e, i) => ({
    id: "e" + i,
    from: e.from,
    to: e.to,
    title: e.to.startsWith("P:") ? HOW[e.type] : e.params.join(", ") + " (" + HOW[e.type] + ")",
    ...edgeStyle(e.type),
  }));
  return { visNodes, visEdges };
}

function paramKey(e) {
  return e.slot || e.param;
}

// Upstream of a tool: its parameters, what fills each one, and what those
// precursor tools themselves need (best source per required param).
// Downstream: the tools its output unlocks.
function neighbourhood(targetId, { downstream }) {
  const levels = new Map([[targetId, 0]]);
  const params = new Map();
  const chosen = [];
  const place = (id, level) => { if (!levels.has(id)) levels.set(id, level); };

  const direct = (incoming.get(targetId) ?? []).filter(allowed);
  for (const e of direct) {
    const pid = "P:" + targetId + ":" + paramKey(e);
    const p = params.get(pid) ?? { params: [], required: false, best: "user_input" };
    if (!p.params.includes(e.param)) p.params.push(e.param);
    // most specific name first: "recipient_email, bcc, cc", not "cc, bcc, recipient_email"
    p.params.sort((x, y) => y.length - x.length || x.localeCompare(y));
    p.required ||= e.required;
    if (RANK[e.type] < RANK[p.best]) p.best = e.type;
    params.set(pid, p);
    place(pid, -1);
    place(e.from, -2);
    chosen.push({ ...e, to: pid });
  }
  for (const [pid, p] of params) chosen.push({ from: pid, to: targetId, param: p.params[0], type: p.best === "user_input" ? "user_input" : "structural" });

  let secondHop = 0;
  const precursors = [...new Set(direct.map((e) => e.from))].filter((id) => nodes.get(id).kind === "tool");
  for (const p of precursors) {
    const byParam = new Map();
    for (const e of (incoming.get(p) ?? []).filter((e) => allowed(e) && e.required)) {
      const best = byParam.get(e.param);
      if (!best || RANK[e.type] < RANK[best.type]) byParam.set(e.param, e);
    }
    for (const e of byParam.values()) {
      if (secondHop >= 24 || e.from === targetId || levels.get(e.from) === -2) continue;
      place(e.from, -3);
      chosen.push(e);
      secondHop++;
    }
  }

  if (downstream) {
    const out = mergeEdges((outgoing.get(targetId) ?? []).filter(allowed)).sort((a, b) => RANK[a.type] - RANK[b.type]).slice(0, 14);
    for (const e of out) {
      if (levels.has(e.to)) continue;
      place(e.to, 1);
      chosen.push(e);
    }
  }
  return { levels, params, chosen };
}

// ---------- run plans ----------
// A concrete order of questions and calls that fills every required parameter
// of a tool: documented and schema-backed sources first, then the shortest chain.
const MAX_PLAN_DEPTH = 3;

function paramGroups(toolId) {
  const groups = new Map();
  for (const e of incoming.get(toolId) ?? []) {
    const k = paramKey(e);
    const g = groups.get(k) ?? { names: [], required: false, edges: [] };
    if (!g.names.includes(e.param)) g.names.push(e.param);
    g.required ||= e.required;
    g.edges.push(e);
    groups.set(k, g);
  }
  for (const g of groups.values()) g.names.sort((x, y) => y.length - x.length || x.localeCompare(y));
  return [...groups.values()];
}

// Ways to produce a value for one parameter group, cheapest first.
const stepKey = (st) => (st.kind === "call" ? "call:" + st.tool : "ask:" + st.param);

// `have` holds steps already in the plan: a route that reuses them is cheaper,
// so once List repositories is planned for `repo`, List repository issues beats
// an unrelated issue listing for `issue_number`.
// Set only while rendering a readme example: the route the brief describes
// (name -> Search People -> Send Email) leads, even though a schema-backed
// list-all-contacts route is cheaper by link type.
let preferredSource = null;

function fillOptions(g, depth, visiting, have = new Set()) {
  const ask = g.edges.find((e) => e.type === "user_input");
  // a required value with both an ask node and tool sources is human-authored
  // (subject, body): the agent asks rather than looking it up.
  if (ask) return [{ steps: [{ kind: "ask", param: g.names[0], prompt: nodes.get(ask.from).prompt }], cost: 1 }];
  const options = [];
  if (depth < MAX_PLAN_DEPTH) {
    for (const e of g.edges) {
      if (visiting.has(e.from) || !allowed(e) || options.some((o) => o.from === e.from)) continue;
      const sub = planSteps(e.from, depth + 1, new Set([...visiting, e.from]));
      options.push({
        from: e.from,
        steps: sub.map((st, i) => (i === sub.length - 1 ? { ...st, gives: [g.names[0]], how: e.type } : st)),
        cost: RANK[e.type] * 2 + sub.filter((st) => !have.has(stepKey(st))).length - (preferredSource?.test(e.from) ? 5 : 0),
      });
    }
  }
  options.sort((a, b) => a.cost - b.cost);
  return options.length ? options : [{ steps: [{ kind: "ask", param: g.names[0], prompt: "" }], cost: 1 }];
}

function fillGroup(g, depth, visiting, have) {
  return fillOptions(g, depth, visiting, have)[0];
}

// `alsoFill`: slots to treat as required at the top level. Send Email's
// recipient is optional in the schema (one of to/cc/bcc), but it is the point of the example.
function planSteps(toolId, depth = 0, visiting = new Set([toolId]), alsoFill = new Set()) {
  const steps = [];
  const byKey = new Map();
  const add = (st) => {
    const existing = byKey.get(stepKey(st));
    // one call can supply several values (List repositories gives repo and owner)
    if (existing) {
      if (st.gives && !existing.gives.includes(st.gives)) existing.gives.push(st.gives);
      return;
    }
    const copy = { ...st, gives: st.gives ? [st.gives] : [] };
    byKey.set(stepKey(st), copy);
    steps.push(copy);
  };
  for (const g of paramGroups(toolId).filter((g) => g.required || g.edges.some((e) => alsoFill.has(e.slot)))) {
    for (const st of fillGroup(g, depth, visiting, new Set(byKey.keys())).steps) add({ ...st, gives: st.gives?.[0] ?? st.gives });
  }
  add({ kind: "call", tool: toolId });
  return steps;
}

function renderSteps(steps, target) {
  return `<ol class="plan">${steps.map((st) => {
    if (st.kind === "ask") {
      return `<li><span class="step-ask">Ask the user for <span class="param-name">${esc(st.param)}</span></span>${st.prompt ? `<span class="step-note">${esc(truncate(st.prompt, 120))}</span>` : ""}</li>`;
    }
    const n = nodes.get(st.tool);
    const isTarget = st.tool === target;
    return `<li>Call <button class="link${isTarget ? " target" : ""}" data-tool="${esc(st.tool)}">${esc(n.name)}</button>${st.gives?.length ? `<span class="step-note">to get ${st.gives.map((g) => `<span class="param-name">${esc(g)}</span>`).join(" and ")}${st.how === "documented" ? ", as its docs direct" : ""}</span>` : ""}</li>`;
  }).join("")}</ol>`;
}

// optional parameters that a lookup can fill, shown as a one-line chain
function optionalChains(toolId, alsoFill = new Set()) {
  return paramGroups(toolId)
    .filter((g) => !g.required && !g.edges.some((e) => alsoFill.has(e.slot)) && g.edges.some((e) => e.type !== "user_input"))
    .map((g) => {
      // the two cheapest routes, so a lookup-by-name route shows next to a list-everything one
      const chain = fillOptions(g, 0, new Set([toolId]))
        .slice(0, 3)
        .map((o) => o.steps.map((st) => (st.kind === "ask" ? `ask for ${st.param}` : nodes.get(st.tool).name)).join(" → "))
        .join(", or ");
      return { names: g.names, chain };
    });
}

// other ways to fill the example's value, so name -> Search People shows next to Get contacts
function routesFor(toolId, slot) {
  const g = paramGroups(toolId).find((g) => g.edges.some((e) => e.slot === slot));
  if (!g) return "";
  const routes = fillOptions(g, 0, new Set([toolId])).slice(1, 4);
  if (!routes.length) return "";
  return `<p class="plan-optional-head">Other ways to get <span class="param-name">${esc(g.names[0])}</span></p>
    <ul class="sources">${routes.map((o) => `<li class="chain"><span class="step-note">${esc(o.steps.map((st) => (st.kind === "ask" ? `ask the user for ${st.param}` : nodes.get(st.tool).name)).join(" → ").replace(/^./, (c) => c.toUpperCase()))}</span></li>`).join("")}</ul>`;
}

function examplePlan(ex) {
  preferredSource = ex.prefer ? new RegExp(ex.prefer) : null;
  try {
    return planBlock(ex.target, new Set([ex.slot])) + (ex.slot ? routesFor(ex.target, ex.slot) : "");
  } finally {
    preferredSource = null;
  }
}

function planBlock(toolId, alsoFill = new Set()) {
  const steps = planSteps(toolId, 0, new Set([toolId]), alsoFill);
  const optional = optionalChains(toolId, alsoFill);
  return `${renderSteps(steps, toolId)}${optional.length ? `
    <p class="plan-optional-head">Optional values a lookup can fill</p>
    <ul class="sources">${optional.slice(0, 8).map((o) => `<li class="chain"><span class="param-name">${esc(o.names.join(", "))}</span><span class="step-note">${esc(o.chain)}</span></li>`).join("")}</ul>` : ""}`;
}

// ---------- views ----------
function showExamples() {
  const merged = { levels: new Map(), params: new Map(), chosen: [] };
  for (const ex of EXAMPLES) {
    const n = neighbourhood(ex.target, { downstream: false });
    for (const [id, lvl] of n.levels) if (!merged.levels.has(id)) merged.levels.set(id, lvl);
    for (const [id, p] of n.params) merged.params.set(id, p);
    merged.chosen.push(...n.chosen);
  }
  const focus = new Set(EXAMPLES.map((e) => e.target));
  const { visNodes, visEdges } = toVis(merged, focus);
  draw(visNodes, visEdges, "flow");
  caption("What has to happen before these tools can run", "Read left to right: questions and lookups, then the tool");
  $("#panel").innerHTML = `
    <div class="intro">
      <h2>Tool dependency graph</h2>
      <p>${DATA.meta.toolCount.toLocaleString()} Google Super and GitHub tools. An arrow means a tool's output, or the user's answer, fills a parameter the next tool needs.</p>
      ${EXAMPLES.map((ex) => `
        <h3><button class="link" data-tool="${esc(ex.target)}">${esc(nodes.get(ex.target).name)}</button> <span>${esc(ex.label)}</span></h3>
        ${examplePlan(ex)}`).join("")}
      ${evalBlock()}
      <h3>How links were found</h3>
      <ul class="sources">
        <li><span><span class="swatch documented"></span> Named in the tool's own docs</span><span class="how">${count("documented")}</span></li>
        <li><span><span class="swatch structural"></span> Output schema returns the value</span><span class="how">${count("structural")}</span></li>
        <li><span><span class="swatch heuristic"></span> Tool name suggests it returns the value</span><span class="how">${count("heuristic")}</span></li>
        <li><span><span class="swatch ask"></span> Nothing produces it, so ask the user</span><span class="how">${count("user_input")}</span></li>
      </ul>
      <p class="empty">Click any tool in the graph, or search above, to see what it needs and what it unlocks.</p>
    </div>`;
}

function evalBlock() {
  const ev = DATA.meta.eval;
  if (!ev?.holdout) return "";
  const row = (label, t) => {
    const r = ev.holdout[t];
    return `<tr><td>${label}</td><td>${Math.round((100 * r.correct) / r.labelled)}%</td><td>${r.correct}/${r.labelled}</td><td>${r.edgesInGraph.toLocaleString()}</td></tr>`;
  };
  return `
    <h3>How accurate the links are</h3>
    <table class="eval">
      <thead><tr><th>Link type</th><th>Precision</th><th>Labelled</th><th>In graph</th></tr></thead>
      <tbody>${row("Named in docs", "documented")}${row("Schema returns it", "structural")}${row("Name suggests it", "heuristic")}</tbody>
    </table>
    <p class="note">Hand-checked on a random held-out sample drawn after tuning. About ${Math.round(ev.holdout.estimatedPrecision * 100)}% of tool-to-tool links are correct overall, up from about 55% before the eval-driven fixes. Details in NOTES.md.</p>`;
}

function count(type) {
  return edges.filter((e) => e.type === type).length.toLocaleString();
}

function showTool(id) {
  const n = nodes.get(id);
  if (!n || n.kind !== "tool") return showExamples();
  const { visNodes, visEdges } = toVis(neighbourhood(id, { downstream: true }), new Set([id]));
  draw(visNodes, visEdges, "flow");
  caption(`${n.name}`, "Needs on the left, unlocks on the right");

  // params carrying the same value (cc, bcc, recipient_email) share one block
  const groups = new Map();
  for (const e of incoming.get(id) ?? []) {
    const g = groups.get(paramKey(e)) ?? { names: [], required: false, sources: [] };
    if (!g.names.includes(e.param)) g.names.push(e.param);
    g.required ||= e.required;
    if (!g.sources.some((s) => s.from === e.from)) g.sources.push(e);
    groups.set(paramKey(e), g);
  }
  const sortedParams = [...groups.values()]
    .map((g) => [g.names.sort((x, y) => y.length - x.length || x.localeCompare(y)).join(", "), g])
    .sort((a, b) => Number(b[1].required) - Number(a[1].required) || a[0].localeCompare(b[0]));
  const unlocks = mergeEdges(outgoing.get(id) ?? []).sort((a, b) => RANK[a.type] - RANK[b.type]);

  $("#panel").innerHTML = `
    <h2>${esc(n.name)}</h2>
    <div class="slug">${esc(n.id)}</div>
    <div class="toolkit"><span class="dot ${toolkitOf(n)}"></span>${toolkitOf(n) === "github" ? "GitHub" : `Google Super, ${esc(SERVICE_LABEL[n.svc] ?? n.svc)}`}</div>
    ${n.desc ? `<p class="desc clamped" id="desc">${esc(n.desc)}</p>${n.desc.length > 220 ? '<button class="more" id="more">Show full description</button>' : ""}` : ""}
    <h3>How to run it</h3>
    ${planBlock(id)}
    <h3>Every source, by parameter</h3>
    ${sortedParams.length === 0 ? '<p class="empty">No parameters that another tool or the user has to supply.</p>' : sortedParams.map(([param, p]) => paramBlock(param, p)).join("")}
    <h3>What it unlocks <span>${unlocks.length ? `${unlocks.length} tool${unlocks.length === 1 ? "" : "s"}` : ""}</span></h3>
    ${unlocks.length === 0 ? '<p class="empty">No other tool uses its output.</p>' : `<ul class="sources">${unlocks.slice(0, 40).map((e) => `<li><button class="link" data-tool="${esc(e.to)}">${esc(nodes.get(e.to).name)}</button><span class="how ${e.type === "documented" ? "documented" : ""}">${esc(e.params.join(", "))}</span></li>`).join("")}</ul>${unlocks.length > 40 ? `<p class="empty">and ${unlocks.length - 40} more</p>` : ""}`}
  `;
  $("#more")?.addEventListener("click", (ev) => { $("#desc").classList.remove("clamped"); ev.target.remove(); });
}

function paramBlock(param, p) {
  const sources = [...p.sources].sort((a, b) => RANK[a.type] - RANK[b.type]);
  return `<div class="param">
    <div class="param-head"><span class="param-name">${esc(param)}</span><span class="req ${p.required ? "required" : ""}">${p.required ? "required" : "optional"}</span></div>
    <ul class="sources">${sources.map((e) => {
      const src = nodes.get(e.from);
      if (src.kind === "input") return `<li><span class="ask-text">${esc(truncate(src.prompt, 160))}</span><span class="how ask">ask the user</span></li>`;
      return `<li class="${e.quote ? "has-quote" : ""}"><button class="link" data-tool="${esc(src.id)}">${esc(src.name)}</button><span class="how ${e.type === "documented" ? "documented" : ""}">${HOW[e.type]}</span>${e.quote ? `<q class="quote">${esc(e.quote)}</q>` : ""}</li>`;
    }).join("")}</ul>
  </div>`;
}

function showInput(id) {
  const n = nodes.get(id);
  const users = mergeEdges(outgoing.get(id) ?? []);
  $("#panel").innerHTML = `
    <h2>Ask the user: <span class="param-name">${esc(n.name)}</span></h2>
    <div class="toolkit"><span class="dot ask"></span>No tool in these toolkits produces this value</div>
    <p class="desc">${esc(n.prompt)}</p>
    <h3>Needed by <span>${users.length} tool${users.length === 1 ? "" : "s"}</span></h3>
    <ul class="sources">${users.slice(0, 60).map((e) => `<li><button class="link" data-tool="${esc(e.to)}">${esc(nodes.get(e.to).name)}</button></li>`).join("")}</ul>`;
}

function showServices() {
  const tools = [...nodes.values()].filter((n) => n.kind === "tool");
  const size = new Map();
  for (const t of tools) size.set(t.svc, (size.get(t.svc) ?? 0) + 1);
  const pairs = new Map();
  const internal = new Map();
  for (const e of edges) {
    if (e.type === "user_input" || !allowed(e)) continue;
    const a = nodes.get(e.from).svc;
    const b = nodes.get(e.to).svc;
    if (a === b) { internal.set(a, (internal.get(a) ?? 0) + 1); continue; }
    pairs.set(a + ">" + b, (pairs.get(a + ">" + b) ?? 0) + 1);
  }
  const visNodes = [...size].map(([svc, n]) => ({
    id: svc,
    label: `${SERVICE_LABEL[svc] ?? svc}\n${n} tools, ${(internal.get(svc) ?? 0).toLocaleString()} links inside`,
    shape: "dot",
    size: 10 + Math.sqrt(n) * 2.6,
    color: { background: svc === "github" ? COLOR.github : COLOR.google, border: "#ffffff", highlight: { background: COLOR.ink, border: COLOR.ink } },
    borderWidth: 2,
    font: { face: "IBM Plex Sans", size: 14, color: COLOR.ink, strokeWidth: 4, strokeColor: COLOR.paper },
  }));
  const max = Math.max(1, ...pairs.values());
  const visEdges = [...pairs].map(([key, c]) => {
    const [from, to] = key.split(">");
    return { from, to, width: 1 + (c / max) * 7, color: { color: COLOR.muted, opacity: 0.55 }, title: `${c} links from ${SERVICE_LABEL[from]} to ${SERVICE_LABEL[to]}` };
  });
  draw(visNodes, visEdges, "services");
  caption("How services depend on each other", "Most links stay inside a service; only hand-offs between services are drawn. Click a service to list its tools");
  $("#panel").innerHTML = `
    <h2>Services</h2>
    <p class="desc">Google Super bundles ${[...size.keys()].filter((k) => k !== "github" && k !== "unknown").length} Google products. Most links stay inside one service. The ones that cross are hand-offs between products, mostly Contacts supplying email addresses.</p>
    <h3>Strongest cross-service links</h3>
    <ul class="sources">${[...pairs].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key, c]) => {
      const [from, to] = key.split(">");
      return `<li><span>${esc(SERVICE_LABEL[from])} to ${esc(SERVICE_LABEL[to])}</span><span class="how">${c}</span></li>`;
    }).join("")}</ul>`;
}

function showService(svc) {
  const list = [...nodes.values()]
    .filter((n) => n.kind === "tool" && n.svc === svc)
    .map((n) => ({ n, degree: (incoming.get(n.id)?.length ?? 0) + (outgoing.get(n.id)?.length ?? 0) }))
    .sort((a, b) => b.degree - a.degree);
  $("#panel").innerHTML = `
    <h2>${esc(SERVICE_LABEL[svc] ?? svc)}</h2>
    <p class="desc">${list.length} tools, most connected first.</p>
    <ul class="sources">${list.slice(0, 120).map(({ n, degree }) => `<li><button class="link" data-tool="${esc(n.id)}">${esc(n.name)}</button><span class="how">${degree} links</span></li>`).join("")}</ul>`;
}

function caption(title, hint) {
  $("#caption").innerHTML = `<span><strong>${esc(title)}</strong></span><span>${esc(hint)}</span>`;
}

function truncate(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

// ---------- routing ----------
function go(state) {
  const hash = state.tool ? "#tool=" + encodeURIComponent(state.tool) : state.view ? "#view=" + state.view : "#";
  if (location.hash === hash) route();
  else location.hash = hash;
}

function route() {
  const params = new URLSearchParams(location.hash.slice(1));
  const tool = params.get("tool");
  const view = tool ? "tool" : params.get("view") ?? "examples";
  for (const b of document.querySelectorAll("nav button")) b.setAttribute("aria-selected", String(b.dataset.view === view));
  $("#tabTool").hidden = view !== "tool";
  if (tool) showTool(tool);
  else if (view === "services") showServices();
  else showExamples();
  $("#panel").scrollTop = 0;
}

document.addEventListener("click", (ev) => {
  const t = ev.target.closest("[data-tool]");
  if (t) go({ tool: t.dataset.tool });
  const v = ev.target.closest("nav button[data-view]");
  if (v && v.dataset.view !== "tool") go({ view: v.dataset.view });
});

// search: exact slug, then name/slug prefix, then substring
const toolList = [...nodes.values()].filter((n) => n.kind === "tool");
$("#toolOptions").innerHTML = toolList.map((t) => `<option value="${esc(t.name)}">${esc(t.id)}</option>`).join("");
function findTool(q) {
  const s = q.trim().toLowerCase();
  if (!s) return null;
  return (
    toolList.find((t) => t.id.toLowerCase() === s || t.name.toLowerCase() === s) ??
    toolList.find((t) => t.name.toLowerCase().startsWith(s)) ??
    toolList.find((t) => t.id.toLowerCase().includes(s.replace(/\s+/g, "_")) || t.name.toLowerCase().includes(s))
  );
}
$("#search").addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter") return;
  const hit = findTool(ev.target.value);
  if (hit) go({ tool: hit.id });
});
$("#search").addEventListener("change", (ev) => {
  const hit = toolList.find((t) => t.name === ev.target.value || t.id === ev.target.value);
  if (hit) go({ tool: hit.id });
});

$("#optHeuristic").addEventListener("change", (ev) => { settings.heuristic = ev.target.checked; route(); });
$("#optAsk").addEventListener("change", (ev) => { settings.ask = ev.target.checked; route(); });

window.addEventListener("hashchange", route);
// canvas text only uses a web font that is already loaded, so load both faces
// before the first draw.
Promise.all(["13px 'IBM Plex Sans'", "12px 'IBM Plex Mono'"].map((f) => document.fonts?.load(f)))
  .catch(() => {})
  .then(route);
