import { readFile, writeFile } from "fs/promises";
import { flattenSchema, type Leaf } from "./extract.ts";
import { ALL_SLOTS, inferService, isHumanParam, resolveSlot, slotNoun, type Service } from "./ontology.ts";

const SLOT_CACHE = new Set(ALL_SLOTS);

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
  requires: (Leaf & { slot: string | null; human: boolean })[];
  produces: (Leaf & { slot: string | null })[];
}

const DISCOVERY_VERBS = /^(LIST|SEARCH|FIND|QUERY|GET_ALL)/;
const GET_VERB = /^GET(?!_ALL)/;
const CREATE_VERB = /^(CREATE|ADD|INSERT)/;

function verbWeight(slug: string): number {
  if (DISCOVERY_VERBS.test(slug)) return 3;
  if (GET_VERB.test(slug)) return 2;
  if (CREATE_VERB.test(slug)) return 1;
  return 0;
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

  return { slug: t.slug, name: t.name, description, toolkit, service, requires, produces };
}

// when a tool has no declared outputParameters (common), infer it still
// "produces" a slot if its slug is a discovery/create verb and its
// description/slug mentions the slot's entity noun.
function heuristicProduces(tool: ToolInfo, slot: string): boolean {
  if (tool.produces.length > 0) return false; // schema-derived already covers it
  const noun = slotNoun(slot);
  if (!noun) return false;
  const hay = `${tool.slug} ${tool.description}`.toLowerCase();
  const verbOk = DISCOVERY_VERBS.test(tool.slug) || CREATE_VERB.test(tool.slug) || GET_VERB.test(tool.slug);
  return verbOk && hay.includes(noun.split(" ")[0]!);
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

async function main() {
  const googlesuper = await loadTools("data/googlesuper_tools.json");
  const github = await loadTools("data/github_tools.json");
  const rawTools = [...googlesuper, ...github];

  const tools = rawTools.map(buildToolInfo);
  const bySlug = new Map(tools.map((t) => [t.slug, t]));

  // producers index: slot -> [{tool, source}]
  const producers = new Map<string, { tool: string; source: "schema" | "heuristic" }[]>();
  for (const t of tools) {
    const producedSlots = new Set(t.produces.map((p) => p.slot).filter(Boolean) as string[]);
    for (const slot of producedSlots) {
      if (!producers.has(slot)) producers.set(slot, []);
      producers.get(slot)!.push({ tool: t.slug, source: "schema" });
    }
    // heuristic fallback only for ALL slots relevant to this tool's service
    if (producedSlots.size === 0) {
      for (const slot of ALL_SLOTS_FOR(t.service)) {
        if (heuristicProduces(t, slot)) {
          if (!producers.has(slot)) producers.set(slot, []);
          producers.get(slot)!.push({ tool: t.slug, source: "heuristic" });
        }
      }
    }
  }

  function ALL_SLOTS_FOR(service: Service): string[] {
    // avoid importing ALL_SLOTS filtered externally each call; cheap enough here
    return Array.from(SLOT_CACHE);
  }

  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  let edgeCounter = 0;

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

  const FAN_IN_CAP = 5;

  for (const consumer of tools) {
    for (const req of consumer.requires) {
      const slot = req.slot;
      const candidates = slot ? producers.get(slot) ?? [] : [];
      const validProducers = candidates.filter((p) => p.tool !== consumer.slug);

      if (slot && validProducers.length > 0) {
        const ranked = validProducers
          .map((p) => {
            const pt = bySlug.get(p.tool)!;
            const sameService = pt.service === consumer.service ? 1 : 0;
            const score =
              (p.source === "schema" ? 100 : 0) + verbWeight(pt.slug) * 10 + sameService * 5;
            return { ...p, score };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, FAN_IN_CAP);

        for (const p of ranked) {
          edges.push({
            id: `e${edgeCounter++}`,
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
      // inherently human-authored/free text.
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
        edges.push({
          id: `e${edgeCounter++}`,
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
      method: "slot-ontology-join + fan-in-cap(5) + heuristic-producer-fallback",
    },
    nodes: Array.from(nodes.values()),
    edges,
  };

  await writeFile("dependency_graph.json", JSON.stringify(graph, null, 2), "utf-8");

  const slotsOut: Record<string, { producers: string[]; consumers: string[] }> = {};
  for (const [slot, prods] of producers.entries()) {
    slotsOut[slot] = { producers: prods.map((p) => p.tool), consumers: [] };
  }
  for (const t of tools) {
    for (const req of t.requires) {
      if (!req.slot) continue;
      (slotsOut[req.slot] ??= { producers: [], consumers: [] }).consumers.push(`${t.slug}.${req.name}`);
    }
  }
  await writeFile("slots.json", JSON.stringify(slotsOut, null, 2), "utf-8");

  console.log(`tools: ${tools.length}, nodes: ${nodes.size}, edges: ${edges.length}`);
  console.log(`wrote dependency_graph.json, slots.json`);
}

await main();
