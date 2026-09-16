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
  - [x] Got COMPOSIO_API_KEY, ran scaffold.sh → .env written
  - [ ] `bun add @composio/core` (running in background as of last update)
  - [ ] `bun install`

- [ ] Phase 1 — Fetch tools
  - [ ] `src/fetch-tools.ts`: generalize src/index.ts, loop toolkits ["googlesuper","github"], fetch via `composio.tools.getRawComposioTools`, cache to `data/googlesuper_tools.json`, `data/github_tools.json`
  - [ ] Verify counts (~473 / ~893), watch for silent pagination caps
  - [ ] CHECKPOINT: inspect one real tool object's shape (input/output schema richness) before building the matcher — decide how much weight structural vs heuristic vs LLM pass gets

- [ ] Phase 2 — Slot ontology (`src/ontology.ts`)
  - [ ] Normalizer (case/snake/camel split, strip prefixes/suffixes, singularize)
  - [ ] Service inference for googlesuper's merged services (gmail/drive/calendar/sheets/docs/people)
  - [ ] Canonical slot table (~30 entries), namespaced by service (e.g. gmail.thread_id, github.owner, people.email_address)
  - [ ] Stoplist for generic param names (id, name, query, page, cursor, etc.) — critical to avoid edge explosion
  - [ ] Tag human-authored/free-text params as `human` class → become user-input nodes

- [ ] Phase 3 — Deterministic edges (`src/extract.ts`, `src/build-graph.ts`)
  - [ ] Extract requires[]/produces[] per tool (flatten JSON schema, depth-limited)
  - [ ] Map leaves through ontology → slot or null
  - [ ] Build producer/consumer inverted indexes per slot
  - [ ] Producer fallback heuristic when outputParameters missing (verb+noun match)
  - [ ] Emit edges with fan-in cap (top 5 producers per consumer+slot), ranked by schema>heuristic, discovery verbs > GET > CREATE, same-service preferred
  - [ ] Emit `user_input` nodes/edges for slots with no producer or human-classed params
  - [ ] Output: `dependency_graph.json` (nodes/edges) + `slots.json`

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
