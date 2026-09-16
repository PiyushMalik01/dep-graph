# Composio Dependency Graph — Plan & Progress

Task: build tool dependency graph for Google Super + GitHub toolkits (Composio hiring task).
Spec: C:\code\dep-graph\readme.md. Submit email: arpit13walia@gmail.com

## Findings (verified, don't re-derive)
- `upload.sh` has NO `--skip-session` flag and NO session-collection code (readme is wrong about this). Only working call: `sh upload.sh arpit13walia@gmail.com`. Do NOT pass extra flags.
- Scale: googlesuper ~473 tools, github ~893 tools → ~1366 nodes total. Naive all-pairs/per-tool-LLM matching won't fit budget or stay legible — need slot-based join + fan-in caps.
- `outputParameters` may be missing/sparse on many raw tools — structural matching needs a heuristic producer fallback (verb+noun in slug/description) for tools with no output schema.
- `@composio/core` is imported by `src/index.ts` but was missing from package.json deps — being added now.
- `.env` created via `sh scaffold.sh` (COMPOSIO_API_KEY + OPENROUTER_API_KEY). Never commit `.env` (upload.sh already excludes `.env*`; make sure git also ignores it).
- Repo root originally: package.json, readme.md, scaffold.sh, src/index.ts, tsconfig.json, upload.sh. No .gitignore existed — created one.

## Plan (phases)

- [x] Phase 0 — Setup
  - [x] Got COMPOSIO_API_KEY, ran scaffold.sh → .env written (key rotated twice by user so far, both rejected 401 by Composio API — see BLOCKER below)
  - [x] `bun add @composio/core` (first attempt failed: corrupt cache/integrity error; fixed with `bun pm cache rm` then retry)
  - [x] `bun install`
  - [x] git repo initialized, .gitignore added (node_modules/.env excluded), initial commit made

- [~] Phase 1 — Fetch tools (CODE DONE, BLOCKED ON VALID API KEY)
  - [x] `src/fetch-tools.ts` written: loops ["googlesuper","github"], calls `composio.tools.getRawComposioTools`, caches to `data/<toolkit>_tools.json`, skips refetch unless `--force`, throws if 0 tools returned (catches slug/casing issues)
  - [ ] **BLOCKER**: both API keys given so far return `401 Invalid API key` directly from Composio's server (not a local/env-loading bug — verified `.env` has correct key each time). Need a working key from https://dashboard.composio.dev before this can run for real.
  - [ ] Once unblocked: verify counts (~473 googlesuper / ~893 github), watch for silent pagination caps
  - [ ] CHECKPOINT: inspect one real tool object's shape (input/output schema richness) — decide how much weight structural vs heuristic vs LLM pass gets. NOTE: confirmed via SDK source (`node_modules/@composio/core/src/types/tool.types.ts` ToolSchema) that real shape is `{slug, name, description, inputParameters, outputParameters, toolkit:{slug,name}, tags, version, ...}` — inputParameters/outputParameters are optional JSON-Schema objects, normalized to `undefined` when empty. Code already built against this exact shape.

- [x] Phase 2 — Slot ontology (`src/ontology.ts`) — DONE, tested
  - [x] Normalizer (camelCase split, strip prefixes, naive singularize)
  - [x] Service inference for googlesuper's merged services (gmail/drive/calendar/sheets/docs/people) — **bug fixed**: word-boundary regex `\bgmail\b` doesn't match inside `_`-joined slugs like `GOOGLESUPER_GMAIL_SEND_EMAIL` because `_` counts as a word char; fixed by replacing `_` with space before matching.
  - [x] Canonical slot table (~30 entries), namespaced by service
  - [x] Stoplist for generic param names
  - [x] `isHumanParam` for free-text fields → user-input nodes

- [x] Phase 3 — Deterministic edges (`src/extract.ts`, `src/build-graph.ts`) — DONE, tested against fixture data
  - [x] `extract.ts`: flattenSchema walks JSON Schema (objects/arrays, depth-limited to 3, handles anyOf/oneOf)
  - [x] Map leaves through ontology → slot or null
  - [x] Producer/consumer inverted index per slot
  - [x] Heuristic producer fallback when outputParameters missing/empty (verb+noun match)
  - [x] Fan-in cap (top 5 producers per consumer+slot), ranked by schema>heuristic, discovery verbs>GET>CREATE, same-service preferred
  - [x] `user_input` nodes/edges for slots with no producer or human-classed params — **bug fixed**: node id was double-prefixing (`INPUT:github.github.owner`) when a slot was already namespaced; fixed template to use slot directly when present.
  - [x] Output: `dependency_graph.json` + `slots.json` — verified against hand-written fixture data (`data/*.json`, 6 tools) that BOTH readme examples appear as real edges: `GOOGLESUPER_GMAIL_LIST_THREADS → GOOGLESUPER_GMAIL_REPLY_TO_THREAD` (thread_id) and `GOOGLESUPER_PEOPLE_SEARCH_CONTACTS → GOOGLESUPER_GMAIL_SEND_EMAIL` (email_address, the semantic name→contacts→send-email chain).
  - **IMPORTANT**: `data/googlesuper_tools.json` and `data/github_tools.json` currently contain HAND-WRITTEN FIXTURE DATA (6 fake tools total), not real Composio API data — used only to validate the pipeline logic end-to-end while blocked on Phase 1's API key issue. MUST re-run `bun run fetch --force` once a valid key exists, then re-run `bun run graph` and `bun run viz` on the real ~1366-tool dataset before submitting. Do not submit with fixture data in place.

- [x] Phase 5 — Visualization (`src/visualize.ts` → `graph.html`) — DONE, opened and smoke-tested
  - [x] Self-contained HTML, data inlined as `const DATA = {...}`
  - [x] vis-network via CDN (cdnjs), color by toolkit/kind, edge style by type
  - [x] Showcase mode (readme's 2 examples + 1-hop neighborhood) vs Full graph toggle, edge-type checkboxes, search-by-slug — **bug fixed**: checkbox handlers always called `showcase()` even in full-graph mode; added `mode` tracking so toggles re-render whichever view is active.
  - [x] npm/bun scripts added: `fetch`, `graph`, `viz`, `all` (in package.json)

- [ ] Phase 4 — LLM semantic pass (`src/semantic.ts`, `--llm` flag, optional/additive)
  - [ ] Resolver discovery: pre-filter candidate lookup tools, batch-prompt via OpenRouter to find name→canonical-value resolvers (covers readme's dense example)
  - [ ] Edge validation: sample deterministic edges, score plausibility, attach reason string
  - [ ] Cache all LLM responses to `cache/llm/<hash>.json`
  - [ ] Pipeline must still fully work with `--no-llm`

- [ ] Phase 5 — Visualization (`src/visualize.ts` → `graph.html`)
  - [ ] Self-contained HTML, data inlined as `const DATA = {...}` (NOT fetch — CORS breaks under file://)
  - [ ] vis-network via CDN, color by toolkit/node kind, edge style by type (structural/semantic/user_input)
  - [ ] Default curated ~25-node subset showing both readme examples (Gmail thread_id chain, name→contacts→send-email chain), toggle to full graph
  - [ ] npm/bun scripts: fetch, graph, viz, all

- [ ] Phase 6 — Write-up + submission
  - [ ] NOTES.md: method, tradeoffs, known false positives, how to re-run
  - [ ] Sanity checks: graph non-empty, both readme examples present as real edges, graph.html opens standalone, data/*.json trimmed if too large for zip
  - [ ] **USER RUNS**: `sh upload.sh arpit13walia@gmail.com` — agent does NOT run this

## Open risks
- Output schemas may be sparse → gate design on Phase 1 checkpoint
- Toolkit slug casing (docs say GOOGLESUPER/GITHUB, scaffold lowercase) — assert non-empty fetch results
- Edge explosion on generic slots (github.owner/repo) — fan-in cap + stoplist mandatory
- OpenRouter rate limits — cache + batch, keep --no-llm path solid
- Cross-service false positives inside googlesuper's merged 473 tools — service-namespaced slots mitigate

## Progress log
- 2026-09-16: Repo read, plan drafted (Opus Plan agent), scaffold.sh run, .env created, bun add @composio/core kicked off.
- 2026-09-16 (later): bun add fixed (cache clear). Git repo initialized + first commit. Both real API keys rejected (401) — Phase 1 blocked on a valid Composio dashboard key. Built full backbone (ontology.ts, extract.ts, build-graph.ts, visualize.ts) and validated it end-to-end against hand-written fixture data standing in for the real tool JSON — both readme examples (thread_id precursor chain, name→contacts→email semantic chain) show up correctly as edges. graph.html opens and renders. Fixed 3 bugs along the way (word-boundary regex on snake_case slugs, doubled input-node id prefix, checkbox mode-tracking in viewer). NEXT: get valid API key → `bun run fetch --force` → `bun run graph` → `bun run viz` on real ~1366-tool data → Phase 4 (LLM semantic pass, optional) → Phase 6 (NOTES.md + submit).
