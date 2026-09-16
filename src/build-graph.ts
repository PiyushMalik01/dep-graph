import { readFile, writeFile } from "fs/promises";
import { flattenSchema, type Leaf } from "./extract.ts";
import {
  inferService,
  isHumanParam,
  resolveSlot,
  slotNouns,
  slotsForService,
  tokenNamesNoun,
  type Service,
} from "./ontology.ts";

interface RawTool {
  slug: string;
  name: string;
  description?: string;
  inputParameters?: unknown;
  outputParameters?: unknown;
  toolkit?: { slug?: string; name?: string };
}

interface ToolInfo {
  slug: string;
  name: string;
  description: string;
  toolkit: string;
  service: Service;
  slugTokens: string[];
  requires: (Leaf & { slot: string | null; human: boolean })[];
  produces: (Leaf & { slot: string | null })[];
}

const DISCOVERY_VERBS = /^(LIST|SEARCH|FIND|QUERY|GET_ALL)/;
const GET_VERB = /^GET(?!_ALL)/;
const CREATE_VERB = /^(CREATE|ADD|INSERT)/;

// verb of the tool, ignoring the toolkit prefix (real slugs look like
// GOOGLESUPER_LIST_THREADS / GITHUB_LIST_REPOSITORY_ISSUES, so the leading
// toolkit token has to come off before the verb is visible).
function verbOf(slug: string): string {
  return slug.replace(/^(GOOGLESUPER|GITHUB)_/, "");
}

function verbWeight(slug: string): number {
  const v = verbOf(slug);
  if (DISCOVERY_VERBS.test(v)) return 3;
  if (GET_VERB.test(v)) return 2;
  if (CREATE_VERB.test(v)) return 1;
  return 0;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

async function loadTools(path: string): Promise<RawTool[]> {
  return JSON.parse(await readFile(path, "utf-8"));
}

function buildToolInfo(t: RawTool): ToolInfo {
  const toolkit = t.toolkit?.slug ?? "unknown";
  const description = t.description ?? "";
  const service = inferService(t.slug, toolkit, description);

  const requires = flattenSchema(t.inputParameters as never)
    .filter((l) => l.required)
    .map((l) => ({ ...l, slot: resolveSlot(service, l.name), human: isHumanParam(l.name) }));

  const produces = flattenSchema(t.outputParameters as never).map((l) => ({
    ...l,
    slot: resolveSlot(service, l.name),
  }));

  return {
    slug: t.slug,
    name: t.name,
    description,
    toolkit,
    service,
    slugTokens: tokenize(verbOf(t.slug)),
    requires,
    produces,
  };
}

/**
 * When a tool declares no output schema (common in the raw Composio dump), infer
 * that it still produces a slot from its slug: a discovery/get/create verb plus
 * the slot's entity noun appearing as a *slug token*.
 *
 * Matching is deliberately restricted to slug tokens, not the description. An
 * earlier version substring-matched slug+description, which at real scale makes
 * essentially every GitHub tool a producer of `github.owner` and `github.repo`
 * (both nouns appear in almost every GitHub description) — thousands of junk
 * edges. Slug tokens are a much higher-precision signal for what a tool returns.
 */
function heuristicProduces(tool: ToolInfo, slot: string): boolean {
  if (tool.produces.some((p) => p.slot)) return false; // schema already covers it
  const nouns = slotNouns(slot).filter((n) => n.length >= 3);
  if (nouns.length === 0) return false;
  const v = verbOf(tool.slug);
  if (!DISCOVERY_VERBS.test(v) && !CREATE_VERB.test(v) && !GET_VERB.test(v)) return false;
  return tool.slugTokens.some((tok) => nouns.some((n) => tokenNamesNoun(tok, n)));
}

interface Node {
  id: string;
  kind: "tool" | "user_input";
  toolkit?: string;
  service?: Service;
  name: string;
  description?: string;
  prompt?: string;
}

interface Edge {
  id: string;
  from: string;
  to: string;
  slot: string;
  param: string;
  paramPath: string;
  required: boolean;
  type: "structural" | "heuristic" | "user_input";
  source: "schema" | "heuristic" | "none";
  confidence: number;
}

const FAN_IN_CAP = 5;

async function main() {
  const googlesuper = await loadTools("data/googlesuper_tools.json");
  const github = await loadTools("data/github_tools.json");

  const tools = [...googlesuper, ...github].map(buildToolInfo);
  const bySlug = new Map(tools.map((t) => [t.slug, t]));

  // inverted index: slot -> producing tools
  const producers = new Map<string, { tool: string; source: "schema" | "heuristic" }[]>();
  const addProducer = (slot: string, tool: string, source: "schema" | "heuristic") => {
    const list = producers.get(slot) ?? [];
    if (!list.some((p) => p.tool === tool)) list.push({ tool, source });
    producers.set(slot, list);
  };

  for (const t of tools) {
    const declared = new Set(t.produces.map((p) => p.slot).filter(Boolean) as string[]);
    for (const slot of declared) addProducer(slot, t.slug, "schema");
    if (declared.size > 0) continue;
    // fallback, scoped to slots this tool's service could plausibly produce
    for (const slot of slotsForService(t.service)) {
      if (heuristicProduces(t, slot)) addProducer(slot, t.slug, "heuristic");
    }
  }

  const nodes = new Map<string, Node>();
  for (const t of tools) {
    nodes.set(t.slug, {
      id: t.slug,
      kind: "tool",
      toolkit: t.toolkit,
      service: t.service,
      name: t.name,
      description: t.description,
    });
  }

  const edges: Edge[] = [];
  const seenEdges = new Set<string>();
  let edgeCounter = 0;
  const pushEdge = (e: Omit<Edge, "id">) => {
    const key = `${e.from}->${e.to}|${e.slot}|${e.paramPath}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ id: `e${edgeCounter++}`, ...e });
  };

  for (const consumer of tools) {
    for (const req of consumer.requires) {
      const slot = req.slot;
      const validProducers = (slot ? producers.get(slot) ?? [] : []).filter((p) => p.tool !== consumer.slug);

      if (slot && validProducers.length > 0) {
        const ranked = validProducers
          .map((p) => {
            const pt = bySlug.get(p.tool)!;
            const sameService = pt.service === consumer.service ? 1 : 0;
            const score = (p.source === "schema" ? 100 : 0) + verbWeight(pt.slug) * 10 + sameService * 5;
            return { ...p, score };
          })
          .sort((a, b) => b.score - a.score || a.tool.localeCompare(b.tool))
          .slice(0, FAN_IN_CAP);

        for (const p of ranked) {
          pushEdge({
            from: p.tool,
            to: consumer.slug,
            slot,
            param: req.name,
            paramPath: req.path,
            required: req.required,
            type: p.source === "schema" ? "structural" : "heuristic",
            source: p.source,
            confidence: p.source === "schema" ? 0.8 : 0.5,
          });
        }
      }

      // "ask the user" side of the spec: no producer found, or the value is
      // inherently human-authored free text.
      if (!slot || validProducers.length === 0 || req.human) {
        const inputId = `INPUT:${slot ?? `${consumer.service}.${req.name}`}`;
        if (!nodes.has(inputId)) {
          nodes.set(inputId, {
            id: inputId,
            kind: "user_input",
            name: req.name,
            prompt: req.description || `Provide ${req.name}`,
          });
        }
        pushEdge({
          from: inputId,
          to: consumer.slug,
          slot: slot ?? "",
          param: req.name,
          paramPath: req.path,
          required: req.required,
          type: "user_input",
          source: "none",
          confidence: 1,
        });
      }
    }
  }

  const graph = {
    meta: {
      generatedAt: new Date().toISOString(),
      toolkits: ["googlesuper", "github"],
      toolCount: tools.length,
      nodeCount: nodes.size,
      edgeCount: edges.length,
      method: `slot-ontology-join + fan-in-cap(${FAN_IN_CAP}) + heuristic-producer-fallback`,
    },
    nodes: Array.from(nodes.values()),
    edges,
  };

  await writeFile("dependency_graph.json", JSON.stringify(graph, null, 2), "utf-8");

  const slotsOut: Record<string, { producers: string[]; consumers: string[] }> = {};
  for (const [slot, prods] of producers.entries()) {
    slotsOut[slot] = { producers: prods.map((p) => `${p.tool}${p.source === "heuristic" ? " (heuristic)" : ""}`), consumers: [] };
  }
  for (const t of tools) {
    for (const req of t.requires) {
      if (!req.slot) continue;
      (slotsOut[req.slot] ??= { producers: [], consumers: [] }).consumers.push(`${t.slug}.${req.name}`);
    }
  }
  await writeFile("slots.json", JSON.stringify(slotsOut, null, 2), "utf-8");

  const unresolved = tools.filter((t) => t.service === "unknown").length;
  const byType = edges.reduce<Record<string, number>>((a, e) => ((a[e.type] = (a[e.type] ?? 0) + 1), a), {});
  console.log(`tools: ${tools.length} (service=unknown: ${unresolved}), nodes: ${nodes.size}, edges: ${edges.length}`, byType);
  console.log("wrote dependency_graph.json, slots.json");
}

await main();
