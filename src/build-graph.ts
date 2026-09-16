import { readFile, writeFile } from "fs/promises";
import { flattenSchema, type Leaf } from "./extract.ts";
import {
  inferService,
  isHumanParam,
  resolveOutputSlot,
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

type Requirement = Leaf & { slot: string | null; human: boolean; docRefs: string[] };
type Production = Leaf & { slot: string | null; primary: boolean };

interface ToolInfo {
  slug: string;
  name: string;
  description: string;
  toolkit: string;
  service: Service;
  slugTokens: string[];
  requires: Requirement[];
  produces: Production[];
}

const DISCOVERY_VERBS = /^(LIST|SEARCH|FIND|QUERY|FETCH|GET_ALL|BATCH_GET)/;
const GET_VERB = /^(GET|READ|LOOKUP)(?!_ALL)/;
const CREATE_VERB = /^(CREATE|ADD|INSERT|UPLOAD|COPY)/;
// tools whose job is to change state; they often echo ids back in their
// response, but nobody should call ADD_LABEL_TO_EMAIL to obtain a thread_id.
const MUTATION_VERB = /^(UPDATE|MODIFY|DELETE|REMOVE|MOVE|TRASH|UNTRASH|PATCH|SET|BATCH_(MODIFY|DELETE|UPDATE)|REPLY|SEND|STOP|CANCEL|CLOSE|REOPEN|LOCK|UNLOCK|MERGE|ARCHIVE|UNARCHIVE|ENABLE|DISABLE|RENAME|REPLACE|RERUN|APPROVE|DISMISS|STAR|UNSTAR|FOLLOW|UNFOLLOW|MARK|CLEAR|EMPTY|RESET|REVOKE|TRANSFER|SYNC|CONVERT)/;

// verb of the tool, ignoring the toolkit prefix (real slugs look like
// GOOGLESUPER_LIST_THREADS / GITHUB_LIST_REPOSITORY_ISSUES).
function verbOf(slug: string): string {
  return slug.replace(/^(GOOGLESUPER|GITHUB)_/, "");
}

function verbWeight(slug: string): number {
  const v = verbOf(slug);
  if (DISCOVERY_VERBS.test(v)) return 3;
  if (GET_VERB.test(v)) return 2;
  if (CREATE_VERB.test(v)) return 1;
  if (MUTATION_VERB.test(v)) return -3;
  return 0;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// the entity a tool's slug is about: GET_EVENT -> event, FETCH_MESSAGE_BY_THREAD_ID
// -> message, LIST_REPOSITORY_ISSUES -> issue. Used to name `data.id`-style outputs.
function slugHead(slug: string): string[] {
  const tokens = tokenize(verbOf(slug)).slice(1);
  const stop = tokens.findIndex((t) => ["by", "for", "in", "from", "of", "with", "on", "to"].includes(t));
  return stop === -1 ? tokens : tokens.slice(0, stop);
}

function slugEntity(slug: string): string | null {
  return slugHead(slug).at(-1) ?? null;
}

async function loadTools(path: string): Promise<RawTool[]> {
  return JSON.parse(await readFile(path, "utf-8"));
}

// Composio's descriptions still use the per-app toolkit names (GMAIL_LIST_THREADS,
// GOOGLEDRIVE_FIND_FILE, GOOGLECALENDAR_LIST_CALENDARS); inside googlesuper
// those tools exist without the app segment.
const APP_PREFIX = /^(GMAIL|GOOGLEDRIVE|GOOGLECALENDAR|GOOGLESHEETS|GOOGLEDOCS|GOOGLESLIDES|GOOGLEFORMS|GOOGLETASKS|GOOGLEPHOTOS|GOOGLECONTACTS|GOOGLEMEET|GOOGLE_ANALYTICS|GOOGLEADS|GOOGLE_MAPS|GOOGLEMAPS|PEOPLE)_/;
const SOURCE_VERB = /^(LIST|SEARCH|FIND|QUERY|FETCH|GET|READ|LOOKUP|CREATE|ADD|INSERT|UPLOAD)/;

function docRefsIn(text: string, self: string, slugs: Set<string>): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+){2,})\b/g)) {
    const raw = m[1]!;
    // "do NOT use GMAIL_X", "instead of GMAIL_X" name the wrong tool, not a precursor
    const before = text.slice(Math.max(0, m.index! - 30), m.index).toLowerCase();
    if (/\b(not|instead of|rather than|unlike|avoid)\b/.test(before)) continue;
    const candidates = [raw, `GOOGLESUPER_${raw}`, `GOOGLESUPER_${raw.replace(APP_PREFIX, "")}`, `GITHUB_${raw.replace(/^GITHUB_/, "")}`];
    const hit = candidates.find((c) => c !== self && slugs.has(c));
    if (hit && SOURCE_VERB.test(verbOf(hit))) out.add(hit);
  }
  return [...out];
}

function buildToolInfo(t: RawTool, slugs: Set<string>): ToolInfo {
  const toolkit = t.toolkit?.slug ?? "unknown";
  const description = t.description ?? "";
  const inputLeaves = flattenSchema(t.inputParameters as never);
  const service = inferService(t.slug, toolkit, description, inputLeaves.map((l) => l.name));
  const entity = slugEntity(t.slug);

  // every input leaf that resolves to a slot is a dependency, required or not:
  // SEND_EMAIL's recipient_email is optional only because "one of to/cc/bcc" is.
  // required-but-unresolvable leaves are kept too, as ask-the-user inputs.
  const requires = inputLeaves
    .map((l) => ({
      ...l,
      slot: resolveSlot(service, l.name),
      human: isHumanParam(l.name),
      docRefs: docRefsIn(l.description, t.slug, slugs),
    }))
    .filter((l) => l.required || l.slot || l.docRefs.length > 0);

  const produces = flattenSchema(t.outputParameters as never).map((l) => {
    const r = resolveOutputSlot(service, l.path, l.name, entity);
    return { ...l, slot: r?.slot ?? null, primary: r?.primary ?? false };
  });

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
 * Fallback for tools whose output schema yields no slot at all: infer that a
 * discovery/get/create tool produces a slot when the slot's entity noun is one
 * of its *slug tokens*. Slug tokens only — matching descriptions made nearly
 * every GitHub tool a producer of github.owner / github.repo.
 */
function heuristicProduces(tool: ToolInfo, slot: string): boolean {
  if (tool.produces.some((p) => p.slot)) return false;
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

type EdgeType = "documented" | "structural" | "heuristic" | "user_input";

interface Edge {
  id: string;
  from: string;
  to: string;
  slot: string;
  param: string;
  paramPath: string;
  required: boolean;
  type: EdgeType;
  confidence: number;
  reason: string;
}

interface Producer {
  tool: string;
  source: "schema" | "heuristic";
  primary: boolean;
}

const FAN_IN_CAP = 5;
// repo coordinates (owner/repo) are consumed by ~600 GitHub tools; five sources
// each would make them ~40% of all edges without adding information.
const UBIQUITOUS_CONSUMERS = 100;
const UBIQUITOUS_FAN_IN_CAP = 2;

// which tools are the *natural* source of a slot, by the entity their slug is
// about. github.owner is echoed by nearly every GitHub response (issues, gists,
// forks, search hits); the tools you'd actually call to discover it list repos/orgs.
const SOURCE_ENTITIES: Record<string, string[]> = {
  "github.owner": ["repository", "repo", "organization", "org", "user"],
  "github.repo": ["repository", "repo"],
  "github.repository_id": ["repository", "repo"],
  "github.username": ["user", "member", "collaborator", "contributor", "assignee"],
  "people.email_address": ["contact", "people", "person", "connection"],
};

// does the tool's slug (before any by/for/in qualifier) name the slot's entity?
// any head token counts: LIST_PULL_REQUESTS is about "pull" requests.
function entityMatches(tool: ToolInfo, slot: string): boolean {
  const nouns = SOURCE_ENTITIES[slot] ?? slotNouns(slot);
  return slugHead(tool.slug).some((tok) => nouns.some((n) => tokenNamesNoun(tok, n)));
}

function lastEntityMatches(tool: ToolInfo, slot: string): boolean {
  const entity = slugEntity(tool.slug);
  const nouns = SOURCE_ENTITIES[slot] ?? slotNouns(slot);
  return entity !== null && nouns.some((n) => tokenNamesNoun(entity, n));
}

async function main() {
  const raw = [...(await loadTools("data/googlesuper_tools.json")), ...(await loadTools("data/github_tools.json"))];
  const slugs = new Set(raw.map((t) => t.slug));
  const tools = raw.map((t) => buildToolInfo(t, slugs));
  const bySlug = new Map(tools.map((t) => [t.slug, t]));

  // inverted index: slot -> producing tools (primary beats incidental)
  const producers = new Map<string, Producer[]>();
  const addProducer = (slot: string, p: Producer) => {
    const list = producers.get(slot) ?? [];
    const existing = list.find((x) => x.tool === p.tool);
    if (!existing) list.push(p);
    else existing.primary ||= p.primary;
    producers.set(slot, list);
  };

  for (const t of tools) {
    let declared = false;
    for (const p of t.produces) {
      if (!p.slot) continue;
      declared = true;
      addProducer(p.slot, { tool: t.slug, source: "schema", primary: p.primary });
    }
    if (declared) continue;
    for (const slot of slotsForService(t.service)) {
      if (heuristicProduces(t, slot)) addProducer(slot, { tool: t.slug, source: "heuristic", primary: true });
    }
  }

  const consumerCount = new Map<string, number>();
  for (const t of tools) for (const r of t.requires) if (r.slot) consumerCount.set(r.slot, (consumerCount.get(r.slot) ?? 0) + 1);

  const nodes = new Map<string, Node>();
  for (const t of tools) {
    nodes.set(t.slug, { id: t.slug, kind: "tool", toolkit: t.toolkit, service: t.service, name: t.name, description: t.description });
  }

  const edges: Edge[] = [];
  const seenPairs = new Set<string>();
  let edgeCounter = 0;
  const pushEdge = (e: Omit<Edge, "id">) => {
    const key = `${e.from}->${e.to}|${e.paramPath}`;
    if (seenPairs.has(key)) return; // documented edges are pushed first and win
    seenPairs.add(key);
    edges.push({ id: `e${edgeCounter++}`, ...e });
  };

  for (const consumer of tools) {
    for (const req of consumer.requires) {
      const slot = req.slot;
      let satisfied = false;

      // 1. the consumer's own docs name the precursor tool
      for (const ref of req.docRefs) {
        satisfied = true;
        pushEdge({
          from: ref,
          to: consumer.slug,
          slot: slot ?? `${consumer.service}.${req.name}`,
          param: req.name,
          paramPath: req.path,
          required: req.required,
          type: "documented",
          confidence: 0.95,
          reason: `${consumer.slug}.${req.name} description names ${ref}`,
        });
      }

      // 2. slot join, ranked and capped
      const candidates = (slot ? producers.get(slot) ?? [] : []).filter((p) => p.tool !== consumer.slug);
      if (slot && candidates.length > 0) {
        satisfied = true;
        const scored = candidates.map((p) => {
          const pt = bySlug.get(p.tool)!;
          const mutation = MUTATION_VERB.test(verbOf(pt.slug));
          const score =
            (p.primary ? 100 : 0) +
            (p.source === "schema" ? 40 : 0) +
            // LIST_REPOSITORIES (entity is the last head token) over LIST_REPO_CODESPACES
            (entityMatches(pt, slot) ? (lastEntityMatches(pt, slot) ? 30 : 10) : 0) +
            verbWeight(pt.slug) * 10 +
            (pt.service === consumer.service ? 5 : 0);
          return { ...p, score, mutation };
        });
        // incidental mentions and state-changing tools are only offered as a last
        // resort, when no clean source for the slot exists.
        const firstNonEmpty = <T,>(...lists: T[][]): T[] => lists.find((l) => l.length > 0) ?? [];
        const clean = scored.filter((p) => p.primary && !p.mutation);
        const slotService = slot.split(".")[0];
        // a drive tool's labels[].id resolves to gmail.label_id through the google
        // fallback tier; only use cross-service sources when the home service has none.
        // tiers: tools *about* the entity in its home service (LIST_PULL_REQUESTS for
        // pull_number) before tools that merely return it nested in something else
        // (LIST_CHECK_RUNS_FOR_A_REF's pull_requests[].number).
        const home = clean.filter((p) => bySlug.get(p.tool)!.service === slotService);
        const pool = firstNonEmpty(
          home.filter((p) => entityMatches(bySlug.get(p.tool)!, slot)),
          home,
          clean,
          scored.filter((p) => !p.mutation),
          scored
        );
        const cap = (consumerCount.get(slot) ?? 0) > UBIQUITOUS_CONSUMERS ? UBIQUITOUS_FAN_IN_CAP : FAN_IN_CAP;
        const ranked = pool
          .sort((a, b) => b.score - a.score || a.tool.length - b.tool.length || a.tool.localeCompare(b.tool))
          .slice(0, cap);

        for (const p of ranked) {
          pushEdge({
            from: p.tool,
            to: consumer.slug,
            slot,
            param: req.name,
            paramPath: req.path,
            required: req.required,
            type: p.source === "schema" ? "structural" : "heuristic",
            confidence: p.source === "schema" ? (p.primary ? 0.85 : 0.6) : 0.45,
            reason:
              p.source === "schema"
                ? `${p.tool} output ${p.primary ? "returns" : "mentions"} ${slot}`
                : `${p.tool} slug names the ${slot} entity (no output schema match)`,
          });
        }
      }

      // 3. ask the user: required values nothing produces, or human-authored text
      if (req.required && (!satisfied || req.human)) {
        const inputId = `INPUT:${slot ?? `${consumer.service}.${req.name}`}`;
        if (!nodes.has(inputId)) {
          nodes.set(inputId, { id: inputId, kind: "user_input", name: req.name, prompt: req.description || `Provide ${req.name}` });
        }
        pushEdge({
          from: inputId,
          to: consumer.slug,
          slot: slot ?? "",
          param: req.name,
          paramPath: req.path,
          required: true,
          type: "user_input",
          confidence: 1,
          reason: req.human ? "human-authored value" : "no tool in these toolkits produces this value",
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
      method: `documented-refs + path-aware-slot-join + fan-in-cap(${FAN_IN_CAP}) + heuristic-producer-fallback`,
    },
    nodes: Array.from(nodes.values()),
    edges,
  };

  await writeFile("dependency_graph.json", JSON.stringify(graph, null, 2), "utf-8");

  const slotsOut: Record<string, { producers: string[]; consumers: string[] }> = {};
  for (const [slot, prods] of [...producers.entries()].sort()) {
    slotsOut[slot] = {
      producers: prods
        .sort((a, b) => Number(b.primary) - Number(a.primary))
        .map((p) => `${p.tool}${p.source === "heuristic" ? " (heuristic)" : p.primary ? "" : " (incidental)"}`),
      consumers: [],
    };
  }
  for (const t of tools) {
    for (const req of t.requires) {
      if (!req.slot) continue;
      (slotsOut[req.slot] ??= { producers: [], consumers: [] }).consumers.push(`${t.slug}.${req.name}${req.required ? "" : "?"}`);
    }
  }
  await writeFile("slots.json", JSON.stringify(slotsOut, null, 2), "utf-8");

  const unresolved = tools.filter((t) => t.service === "unknown").length;
  const byType = edges.reduce<Record<string, number>>((a, e) => ((a[e.type] = (a[e.type] ?? 0) + 1), a), {});
  console.log(`tools: ${tools.length} (service=unknown: ${unresolved}), nodes: ${nodes.size}, edges: ${edges.length}`, byType);
  console.log("wrote dependency_graph.json, slots.json");
}

await main();
