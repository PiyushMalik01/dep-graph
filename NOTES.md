# Tool dependency graph: Google Super + GitHub

For every Composio tool in Google Super (492) and GitHub (896), the graph answers: **what must an agent look up, or ask the user, before it can call this tool?**

Open `graph.html` in a browser (it needs internet access for the vis-network and font CDNs).

- **Examples** (default): the readme's two chains. The graph reads left to right (questions and lookups, then the parameter they fill, then the tool), and the panel gives each tool's step-by-step run plan.
- **Tool**: search for any tool by name or slug, or click a node. The panel shows a numbered **How to run it** plan, every source for each parameter (with the doc sentence when the docs name it), and the tools this one unlocks. `#tool=SLUG` links can be shared.
- **Service map**: the 16 services as nodes. Only hand-offs between services are drawn; each node shows how many links stay inside it.

Example plan, generated from the graph for `GITHUB_CREATE_AN_ISSUE_COMMENT`:

1. Ask the user for `body`
2. Call List repositories, to get `repo` and `owner`
3. Call List repository issues, to get `issue_number`
4. Call Create an issue comment

## Re-run

```sh
bun install
bun run fetch --force   # needs COMPOSIO_API_KEY in .env -> data/*.json
bun run graph           # -> dependency_graph.json, slots.json
bun run eval            # -> eval/results.json (precision on hand labels + readme-example checks)
bun run viz             # -> graph.html (self-contained; shows eval results)
```

No LLM calls are made. The whole pipeline is deterministic and runs in seconds.

## Accuracy

The graph was measured, not just built. Edges were checked by hand: "is calling this tool a realistic way for an agent to get a valid value for that parameter?"

**Held-out sample** (`eval/holdout_labels.json`): 110 edges drawn at random, stratified by type, *after* all tuning. Labelled once, with no changes to the code afterwards.

| Link type | Precision | Labelled | Edges in graph |
|---|---|---|---|
| documented (param docs name the tool) | 100% | 20/20 | 89 |
| structural (output schema returns it) | 80% | 48/60 | 5,815 |
| heuristic (tool name implies it) | 73% | 22/30 | 188 |
| **all tool-to-tool links, weighted** | **~80%** | | 6,092 |

**Development sample** (`eval/labels.json`): 125 edges drawn from the first real-data graph. The fixes below were designed from its errors, so its "after" column is optimistic. The "before" column is a fair baseline: about **55%** weighted precision.

| Link type | Before | After (edges kept) | Wrong edges removed / correct edges removed |
|---|---|---|---|
| documented | 88% (22/25) | 100% (22/22) | 3 / 0 |
| structural | 57% (34/60) | 92% (34/37) | 23 / 0 |
| heuristic | 30% (12/40) | 90% (9/10) | 27 / 3 |

**Doc agreement:** the parameter docs name a precursor tool for 58 inputs that also have a schema slot. Without using the docs, the schema join already has that tool among its candidates for 46/58 (79%) and ranks it in its kept top sources for 34/58 (59%). These are two independent signals that mostly agree.

`bun run eval` also fails if either readme example disappears from the graph:
- `LIST_THREADS → REPLY_TO_THREAD.thread_id`
- `GET_CONTACTS` / `SEARCH_PEOPLE → SEND_EMAIL.recipient_email`
- ask the user → `SEARCH_PEOPLE.query`

### What the labelling found, and the fix for each

| Error pattern | Example | Fix |
|---|---|---|
| Source needs the value it supposedly provides | `GET_AN_ISSUE(issue_number)` offered as a way to get an `issue_number` | Drop producers that require the same slot (or their own entity's `id`/`name`), except tools that make a new one (`COPY_DOCUMENT`) |
| Name guess on an incidental word | `GET_PAGES_DNS_HEALTH_CHECK` as a source of check runs | The entity at the end of the slug must name the slot; two-word entities (`check_run`, `media_item`) handled |
| Scope mismatch | org webhooks → `TEST_REPOSITORY_WEBHOOK`; issue reactions → PR comment reactions | Scope qualifiers (org / repo / issue / pull / team / environment / deploy …) must overlap |
| Global listing as source | `LIST_PUBLIC_REPOSITORIES` (all of GitHub) for *your* repo | Ranked below focused sources |
| Docs name an alternative, not a precursor | "To search PRs across all repos, use GITHUB_FIND_PULL_REQUESTS instead" | Skip sentences with *instead*, *to check*, *to add/remove* |
| Attach tools echo ids | `ADD_LABEL_TO_EMAIL` as a source of label ids | `ADD_*_TO_*` treated as a mutation |

Remaining error classes seen in the held-out set: team slugs taken from branch-protection responses, analytics "key events" matched to calendar event ids, and user lists offered for "outside collaborator" (someone who must already be one).

## Output

`dependency_graph.json`: 1,705 nodes (1,388 tools + 317 ask-the-user inputs) and 6,744 edges, with 1,164 tools connected to another tool. Each edge records:
- `from → to`
- the canonical `slot` it carries (`gmail.thread_id`)
- the consumer `param` / `paramPath`, and whether it is `required`
- `type`, `confidence`, and `reason`. For documented edges the reason is the doc sentence itself.

`slots.json` is the inverted index: for every slot, its producers (primary / incidental / heuristic) and its consumers (`?` marks an optional param).

## Method

1. **Flatten schemas** (`src/extract.ts`). Each input/output JSON Schema becomes leaf params with dotted paths (`data.threads[].id`). This resolves local `$ref`/`$defs`, `anyOf`/`allOf`, nullable types and arrays. A param only counts as required if every enclosing object is required too.
2. **Service inference** (`src/ontology.ts`). Google Super bundles 14 Google products. The tool's own ID inputs decide first (taking `spreadsheet_id` means Sheets), then slug keywords, then the description.
3. **Slot ontology.** About 90 canonical slots, namespaced by service, plus a stoplist of generic names.
   - Output leaves resolve **by path**, because responses name the entity in the parent: `threads[].id` → `thread_id`, `repositories[].owner.login` → `owner`. A top-level `data.id` takes the entity from the tool's slug.
   - Generic input names (`parent`, `resource_name`, `range`) only match inside their own service.
4. **Documented edges.** Tool names cited in a parameter's own description, mapped from the per-app names (`GMAIL_LIST_THREADS` → `GOOGLESUPER_LIST_THREADS`) and filtered as described above.
5. **Join, filter, rank** (`src/build-graph.ts`).
   - Every input that resolves to a slot is a dependency, optional ones included: `SEND_EMAIL.recipient_email` is optional only because one of to/cc/bcc is required.
   - Candidates go through the filters from the table above.
   - Ranking tiers: the slot's home service and a tool about the entity, then other primary sources, then anything that isn't a mutation. The top 5 are kept, or 2 for slots with more than 100 consumers (GitHub `owner`/`repo`).
6. **Ask the user.** Required values that nothing produces, or that are human-authored (subject, body), get an input node.
7. **Viewer** (`src/visualize.ts`, `src/viewer/`). Run plans are computed in the browser from the graph. For each required parameter the plan picks the cheapest route: docs- and schema-backed sources first, and routes that reuse steps already in the plan preferred.

## Known limitations

- About 20% of structural links are still wrong. They are mostly entities that share a name across GitHub sub-APIs in ways the scope check doesn't catch.
- GitHub `owner`/`repo` edges are correct but ubiquitous: about a third of all edges, even capped at 2 sources each.
- `CREATE_*` tools count as sources (create an issue, then comment on it). That's right for workflows, but noisy when only lookups are wanted.
- Composite values (`properties/123`, A1 ranges) are treated as opaque slots.
- Precision is measured on 235 hand labels in total. The held-out structural estimate (60 labels) has a 95% interval of roughly ±10 points.
