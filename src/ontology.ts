// Canonical "slot" ontology: maps tool input/output leaf param names onto a
// small shared vocabulary of entity identifiers, namespaced by service, so
// dependency edges are found by joining on slots instead of raw param names.
// This keeps googlesuper's merged services (gmail/drive/calendar/sheets/docs/
// people) from cross-matching, and keeps generic names (id, name, query) from
// exploding into a fully-connected graph.

export type Service =
  | "gmail"
  | "drive"
  | "calendar"
  | "sheets"
  | "docs"
  | "people"
  | "github"
  | "unknown";

export function inferService(toolSlug: string, toolkitSlug: string, description: string): Service {
  // replace slug separators with spaces so \b word-boundary regexes actually
  // match tokens like "GMAIL" inside "GOOGLESUPER_GMAIL_SEND_EMAIL" — "_" is
  // a \w character, so \bgmail\b never matches "..._gmail_..." otherwise.
  const s = `${toolSlug.replace(/_/g, " ")} ${description}`.toLowerCase();
  if (toolkitSlug.toLowerCase() === "github") return "github";

  // googlesuper merges multiple google products under one toolkit; infer the
  // underlying product from slug/description keywords.
  if (/\b(thread|message|label|draft|inbox|gmail)\b/.test(s)) return "gmail";
  if (/\b(spreadsheet|sheet|cell|worksheet)\b/.test(s)) return "sheets";
  if (/\b(calendar|event|meeting|attendee)\b/.test(s)) return "calendar";
  if (/\b(document|docs?)\b/.test(s) && !/\bspreadsheet\b/.test(s)) return "docs";
  if (/\b(file|folder|drive)\b/.test(s)) return "drive";
  if (/\b(contact|people|person)\b/.test(s)) return "people";
  return "unknown";
}

// leaf param names that carry no entity-identifying meaning on their own —
// matching on these alone across unrelated tools would explode the graph.
export const STOPLIST = new Set([
  "id",
  "name",
  "type",
  "value",
  "query",
  "q",
  "body",
  "text",
  "content",
  "page",
  "page_token",
  "page_size",
  "per_page",
  "cursor",
  "limit",
  "offset",
  "since",
  "until",
  "sort",
  "order",
  "direction",
  "state",
  "status",
  "format",
  "fields",
  "filter",
  "max_results",
  "include",
  "kind",
  "key",
  "index",
]);

// free-text / human-authored fields: these should surface as "ask the user"
// nodes rather than as things another tool could have produced.
const HUMAN_LEAF_PATTERNS: RegExp[] = [
  /^subject$/,
  /^(message_)?body$/,
  /^comment_body$/,
  /^title$/,
  /^description$/,
  /^summary$/,
  /^message$/,
  /^text$/,
  /^content$/,
  /^start_time$/,
  /^end_time$/,
  /^due_(on|date)$/,
  /^recipient(_name)?$/,
  /^to_name$/,
  /^person_name$/,
  /^name$/, // "name" as a value the user provides (e.g. a contact's name)
];

export function isHumanParam(leafName: string): boolean {
  const n = normalizeLeaf(leafName);
  return HUMAN_LEAF_PATTERNS.some((re) => re.test(n));
}

export function normalizeLeaf(raw: string): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2") // camelCase -> camel_Case
    .toLowerCase()
    .replace(/^(target_|source_|parent_|base_|head_|new_|old_)/, "")
    .replace(/s$/, (m, offset, str) => (str.endsWith("ss") ? m : "")); // naive singularize, keep "ss" endings
}

interface SlotDef {
  slot: string;
  service: Service;
  patterns: RegExp[];
  // entity noun used by the heuristic producer fallback when a tool has no
  // declared outputParameters (search slug+description for this noun).
  noun: string;
}

const SLOT_TABLE: SlotDef[] = [
  // gmail
  { slot: "gmail.thread_id", service: "gmail", patterns: [/^thread_id$/, /^thread$/], noun: "thread" },
  { slot: "gmail.message_id", service: "gmail", patterns: [/^message_id$/, /^msg_id$/], noun: "message" },
  { slot: "gmail.label_id", service: "gmail", patterns: [/^label_id$/], noun: "label" },
  { slot: "gmail.draft_id", service: "gmail", patterns: [/^draft_id$/], noun: "draft" },
  { slot: "gmail.attachment_id", service: "gmail", patterns: [/^attachment_id$/], noun: "attachment" },

  // drive
  { slot: "drive.file_id", service: "drive", patterns: [/^file_id$/], noun: "file" },
  { slot: "drive.folder_id", service: "drive", patterns: [/^folder_id$/], noun: "folder" },

  // calendar
  { slot: "calendar.calendar_id", service: "calendar", patterns: [/^calendar_id$/], noun: "calendar" },
  { slot: "calendar.event_id", service: "calendar", patterns: [/^event_id$/], noun: "event" },

  // sheets
  { slot: "sheets.spreadsheet_id", service: "sheets", patterns: [/^spreadsheet_id$/], noun: "spreadsheet" },
  { slot: "sheets.sheet_id", service: "sheets", patterns: [/^sheet_id$/, /^gid$/], noun: "sheet" },

  // docs
  { slot: "docs.document_id", service: "docs", patterns: [/^document_id$/, /^doc_id$/], noun: "document" },

  // people / contacts (also used from other services for name->email resolution)
  { slot: "people.contact_id", service: "people", patterns: [/^contact_id$/, /^person_id$/, /^resource_name$/], noun: "contact" },
  { slot: "people.email_address", service: "people", patterns: [/^email(_address)?$/, /^to$/, /^recipient_email$/], noun: "email" },

  // github
  { slot: "github.owner", service: "github", patterns: [/^owner$/, /^org(anization)?$/], noun: "owner" },
  { slot: "github.repo", service: "github", patterns: [/^repo(sitory)?$/], noun: "repo" },
  { slot: "github.issue_number", service: "github", patterns: [/^issue_number$/], noun: "issue" },
  { slot: "github.pull_number", service: "github", patterns: [/^pull_number$/, /^pr_number$/], noun: "pull request" },
  { slot: "github.commit_sha", service: "github", patterns: [/^(commit_)?sha$/, /^ref$/], noun: "commit" },
  { slot: "github.branch", service: "github", patterns: [/^branch$/, /^ref_branch$/], noun: "branch" },
  { slot: "github.gist_id", service: "github", patterns: [/^gist_id$/], noun: "gist" },
  { slot: "github.comment_id", service: "github", patterns: [/^comment_id$/], noun: "comment" },
  { slot: "github.release_id", service: "github", patterns: [/^release_id$/], noun: "release" },
  { slot: "github.workflow_id", service: "github", patterns: [/^workflow_id$/], noun: "workflow" },
  { slot: "github.run_id", service: "github", patterns: [/^run_id$/], noun: "run" },
  { slot: "github.check_run_id", service: "github", patterns: [/^check_run_id$/], noun: "check run" },
  { slot: "github.team_slug", service: "github", patterns: [/^team_slug$/], noun: "team" },
  { slot: "github.username", service: "github", patterns: [/^username$/, /^user_id$/], noun: "user" },
  { slot: "github.installation_id", service: "github", patterns: [/^installation_id$/], noun: "installation" },
  { slot: "github.asset_id", service: "github", patterns: [/^asset_id$/], noun: "asset" },
  { slot: "github.discussion_number", service: "github", patterns: [/^discussion_number$/], noun: "discussion" },
  { slot: "github.label", service: "github", patterns: [/^label$/], noun: "label" },
];

export function resolveSlot(service: Service, leafName: string): string | null {
  const n = normalizeLeaf(leafName);
  if (STOPLIST.has(n)) return null;
  for (const def of SLOT_TABLE) {
    if (def.service !== service && def.service !== "people") continue; // people slots are cross-service resolvable
    if (def.patterns.some((re) => re.test(n))) return def.slot;
  }
  return null;
}

export function slotNoun(slot: string): string | undefined {
  return SLOT_TABLE.find((d) => d.slot === slot)?.noun;
}

export const ALL_SLOTS = SLOT_TABLE.map((d) => d.slot);
