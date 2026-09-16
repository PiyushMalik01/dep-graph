# Tool dependency graph: Google Super + GitHub

Open `graph.html` in a browser. The default "Showcase" view shows the readme's two examples; "Full graph" shows everything; the search box focuses on any tool slug and its neighbours.

## Re-run

```sh
bun install
bun run fetch --force   # needs COMPOSIO_API_KEY in .env -> data/*.json (492 googlesuper + 896 github tools)
bun run graph           # -> dependency_graph.json, slots.json
bun run viz             # -> graph.html (self-contained, data inlined)
```

## Output

`dependency_graph.json` has 1702 nodes (1388 tools + 314 "ask the user" inputs) and ~8k edges. Each edge records `from -> to`, the canonical `slot` it carries (e.g. `gmail.thread_id`), the consumer `param`/`paramPath`, whether that param is `required`, a `type`, a `confidence`, and a human-readable `reason`.

Edge types, strongest first:

| type | meaning | count |
|---|---|---|
| `documented` | the consumer's own param description names the precursor tool ("Use GMAIL_LIST_THREADS … to retrieve valid thread IDs") | ~100 |
| `structural` | a tool's output schema returns the slot the consumer's input needs | ~6.6k |
| `heuristic` | tool has no usable output slot, but its slug names the entity (`SEARCH_PEOPLE` -> contact email) | ~0.7k |
| `user_input` | required value no tool produces, or human-authored text (subject, body) | ~0.6k |

`slots.json` is the inverted index: for every slot, its producers (primary / incidental / heuristic) and its consumers (`?` = optional param).

Readme examples, as they appear in the graph:
- `GOOGLESUPER_LIST_THREADS -> GOOGLESUPER_REPLY_TO_THREAD` on `gmail.thread_id` (documented), plus `FETCH_EMAILS`.
- `GOOGLESUPER_GET_CONTACTS` / `SEARCH_PEOPLE` / `GET_PEOPLE -> GOOGLESUPER_SEND_EMAIL` on `people.email_address`, i.e. name -> contacts lookup -> send email.

## Method

1. **Flatten schemas** (`extract.ts`): walk each tool's input/output JSON Schema, resolving local `$ref`/`$defs`, `anyOf`/`allOf`, nullable types and arrays, into leaf params with dotted paths (`data.threads[].id`). A param only counts as required if every enclosing object is required too.
2. **Service inference** (`ontology.ts`): googlesuper merges ~14 Google products. Keywords in the slug decide the service; the description only breaks ties. 7 tools stay `unknown`.
3. **Slot ontology**: about 90 canonical slots, namespaced by service (`drive.file_id`, `github.pull_number`), plus a stoplist of generic names (`id`, `page_token`, `query`, …) so they never join on their own.
   - Input leaves resolve by name.
   - Output leaves resolve **by path**, because real responses put the entity in the parent: `threads[].id` -> `thread_id`, `repositories[].owner.login` -> `owner`, `emailAddresses[].value` -> `email_address`. A top-level `data.id` uses the entity named in the tool's slug (`GET_EVENT` -> `event_id`).
   - Each producer is marked **primary** (it returns the entity itself) or **incidental** (the value just appears inside some other object).
4. **Join + rank** (`build-graph.ts`): every input that resolves to a slot is a dependency, optional ones included, since `SEND_EMAIL.recipient_email` is optional only because of a "one of to/cc/bcc" rule. Producers are picked in tiers:
   - First tier: primary, non-mutating producers in the slot's home service whose slug names the entity (`LIST_PULL_REQUESTS` for `pull_number`).
   - Fallback: broader producers, used only when that tier is empty.
   - The top 5 are kept, or 2 for `github.owner`/`github.repo`, which ~600 tools consume.
   - Documented references are added first and take precedence over the slot join.
5. **Visualize** (`visualize.ts`): vis-network. The showcase seeds are chosen by slot and verb, not hardcoded slugs.

No LLM is used. The pipeline is deterministic and re-runs in seconds.

## Known limitations / false positives

- Resolution is by name, so any leaf that normalizes to a slot name counts. For example, some Drive tools' `labels[].id` are Drive labels but can resolve to `gmail.label_id` through the shared Google tier. Home-service preference keeps these out of the top ranks in most cases, but not all.
- GitHub's `github.owner` and `github.repo` are ubiquitous. They are capped at 2 producers per consumer and still make up about 25% of edges.
- `CREATE_*` tools count as producers (create issue -> comment on it), which is correct for workflows but noisy when you only want lookups.
- Documented references are regex-extracted, and only a small negation guard ("not", "instead of") filters out references that name the wrong tool.
- Composite values (Analytics `parent = "properties/123"`, Sheets A1 ranges) are treated as opaque slots.
- A possible next step is an LLM pass (OpenRouter key in `.env`) that scores sampled structural edges and finds name->id resolver tools. It would add annotations only and never create the join.
