// Scores dependency_graph.json against hand-labelled edges.
//
//   bun run eval
//
// eval/labels.json          125 edges drawn from the first real-data graph
//                           (stratified by type). The fixes in build-graph.ts
//                           were designed from the errors in this set, so
//                           treat it as a development set.
// eval/holdout_labels.json  a second sample drawn *after* the fixes, labelled
//                           without further tuning: the honest precision number.
import { readFile, writeFile } from "fs/promises";

interface Label { from: string; to: string; param: string; type: string; correct: boolean }

const graph = JSON.parse(await readFile("dependency_graph.json", "utf-8"));
const key = (e: { from: string; to: string; param: string }) => `${e.from}|${e.to}|${e.param}`;
const present = new Map<string, string>(graph.edges.map((e: any) => [key(e), e.type]));
const TYPES = ["documented", "structural", "heuristic"];
const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${Math.round((100 * a) / b)}%`);

async function load(path: string): Promise<Label[] | null> {
  try { return JSON.parse(await readFile(path, "utf-8")); } catch { return null; }
}

const report: string[] = [];
const out: Record<string, unknown> = {};

const dev = await load("eval/labels.json");
if (dev) {
  report.push("Development set (eval/labels.json, drawn from the pre-fix graph)");
  report.push("type        before            after (edges still in graph)   removed: wrong / correct");
  const rows: Record<string, unknown> = {};
  for (const t of TYPES) {
    const ls = dev.filter((l) => l.type === t);
    const kept = ls.filter((l) => present.has(key(l)));
    const removed = ls.filter((l) => !present.has(key(l)));
    const before = ls.filter((l) => l.correct).length;
    const after = kept.filter((l) => l.correct).length;
    rows[t] = { before: [before, ls.length], after: [after, kept.length], removedWrong: removed.filter((l) => !l.correct).length, removedCorrect: removed.filter((l) => l.correct).length };
    report.push(
      `${t.padEnd(11)} ${pct(before, ls.length).padStart(4)} (${before}/${ls.length})`.padEnd(30) +
        `${pct(after, kept.length).padStart(4)} (${after}/${kept.length})`.padEnd(33) +
        `${removed.filter((l) => !l.correct).length} / ${removed.filter((l) => l.correct).length}`
    );
  }
  out.development = rows;
}

const holdout = await load("eval/holdout_labels.json");
if (holdout) {
  report.push("", "Held-out set (eval/holdout_labels.json, drawn after the fixes)");
  const rows: Record<string, unknown> = {};
  let weightedCorrect = 0;
  let weightedTotal = 0;
  for (const t of TYPES) {
    const ls = holdout.filter((l) => l.type === t && present.has(key(l)));
    const ok = ls.filter((l) => l.correct).length;
    const count = graph.edges.filter((e: any) => e.type === t).length;
    rows[t] = { correct: ok, labelled: ls.length, edgesInGraph: count };
    if (ls.length) { weightedCorrect += (ok / ls.length) * count; weightedTotal += count; }
    report.push(`${t.padEnd(11)} ${pct(ok, ls.length).padStart(4)} (${ok}/${ls.length})   ${count} edges in graph`);
  }
  const overall = weightedTotal ? weightedCorrect / weightedTotal : 0;
  out.holdout = { ...rows, estimatedPrecision: Math.round(overall * 100) / 100 };
  report.push(`estimated precision over all tool->tool edges: ${pct(weightedCorrect, weightedTotal)}`);
}

// The readme's two examples must survive every change.
const has = (from: string, to: string, param: string) => graph.edges.some((e: any) => e.from === from && e.to === to && e.param === param);
const checks = {
  "LIST_THREADS -> REPLY_TO_THREAD.thread_id": has("GOOGLESUPER_LIST_THREADS", "GOOGLESUPER_REPLY_TO_THREAD", "thread_id"),
  "GET_CONTACTS -> SEND_EMAIL.recipient_email": has("GOOGLESUPER_GET_CONTACTS", "GOOGLESUPER_SEND_EMAIL", "recipient_email"),
  "SEARCH_PEOPLE -> SEND_EMAIL.recipient_email": has("GOOGLESUPER_SEARCH_PEOPLE", "GOOGLESUPER_SEND_EMAIL", "recipient_email"),
  "ask user -> SEARCH_PEOPLE.query": graph.edges.some((e: any) => e.type === "user_input" && e.to === "GOOGLESUPER_SEARCH_PEOPLE" && e.param === "query"),
};
out.readmeExamples = checks;
report.push("", "Readme examples", ...Object.entries(checks).map(([k, v]) => `${v ? "ok  " : "FAIL"} ${k}`));

// Agreement with the tool docs: of the precursor tools the docs name, how many
// does the schema join find on its own? Computed in build-graph.ts.
if (graph.meta.docAgreement) {
  const d = graph.meta.docAgreement;
  out.docAgreement = d;
  report.push("", `Doc agreement: the schema join independently ranks ${d.foundRanked}/${d.refs} (${pct(d.foundRanked, d.refs)}) of doc-named precursors, and has ${d.foundAnywhere}/${d.refs} (${pct(d.foundAnywhere, d.refs)}) among its candidates`);
}

console.log(report.join("\n"));
await writeFile("eval/results.json", JSON.stringify(out, null, 2), "utf-8");
if (Object.values(checks).some((v) => !v)) process.exit(1);
