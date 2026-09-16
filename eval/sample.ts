// Draws a fixed, stratified random sample of edges for hand labelling and prints
// what a reviewer needs to judge each one. Labels live in eval/labels.json.
import { readFile } from "fs/promises";
import { flattenSchema } from "../src/extract.ts";

// --holdout draws a second, disjoint sample from the current graph (after fixes)
const HOLDOUT = process.argv.includes("--holdout");
const PLANS = {
  development: { seed: 20260916, perType: { documented: 25, structural: 60, heuristic: 40 } as Record<string, number> },
  holdout: { seed: 777001, perType: { documented: 20, structural: 60, heuristic: 30 } as Record<string, number> },
};

const graph = JSON.parse(await readFile("dependency_graph.json", "utf-8"));
const raw = [
  ...JSON.parse(await readFile("data/googlesuper_tools.json", "utf-8")),
  ...JSON.parse(await readFile("data/github_tools.json", "utf-8")),
];
const bySlug = new Map(raw.map((t: any) => [t.slug, t]));

// mulberry32: deterministic so the same sample is drawn on every run
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleEdges(edges: any[], exclude: Set<string> = new Set(), holdout = false) {
  const { seed, perType: PER_TYPE } = holdout ? PLANS.holdout : PLANS.development;
  const rand = rng(seed);
  edges = edges.filter((e) => !exclude.has(`${e.from}|${e.to}|${e.param}`));
  const out: any[] = [];
  for (const [type, n] of Object.entries(PER_TYPE)) {
    const pool = edges.filter((e) => e.type === type);
    const picked = new Set<number>();
    while (picked.size < Math.min(n, pool.length)) picked.add(Math.floor(rand() * pool.length));
    for (const i of [...picked].sort((a, b) => a - b)) out.push(pool[i]);
  }
  return out;
}

if (import.meta.main) {
  const exclude = new Set<string>();
  if (HOLDOUT) {
    for (const l of JSON.parse(await readFile("eval/labels.json", "utf-8"))) exclude.add(`${l.from}|${l.to}|${l.param}`);
  }
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
  for (const e of sampleEdges(graph.edges, exclude, HOLDOUT)) {
    const c: any = bySlug.get(e.to);
    const p: any = bySlug.get(e.from);
    const leaf = flattenSchema(c.inputParameters).find((l) => l.path === e.paramPath);
    const pReq = flattenSchema(p.inputParameters).filter((l) => l.required).map((l) => l.name);
    console.log(`## ${e.from} -> ${e.to} [${e.param}] ${e.type} slot=${e.slot}`);
    console.log(`  param: ${clip(leaf?.description ?? "", 220)}`);
    console.log(`  source: ${p.name}: ${clip(p.description ?? "", 200)} | requires: ${pReq.join(", ") || "-"}`);
  }
}
