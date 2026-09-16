// Canonical "slot" ontology: maps tool input/output leaf param names onto a
// small shared vocabulary of entity identifiers, namespaced by service, so
// dependency edges are found by joining on slots instead of raw param names.
// This keeps googlesuper's merged services (gmail/drive/calendar/sheets/docs/
// people/tasks/photos/...) from cross-matching on generic names, and keeps
// generic names (id, name, query, token) from exploding into a dense graph.

export type Service =
  | "gmail"
  | "drive"
  | "calendar"
  | "sheets"
  | "docs"
  | "slides"
  | "forms"
  | "tasks"
  | "photos"
  | "people"
  | "github"
  | "unknown";

// Keyword votes per google service. Slug tokens count double: the slug is a
// far stronger signal than prose in the description, which routinely name-drops
// unrelated products ("...attach a Drive file to a Gmail message").
const SERVICE_KEYWORDS: Record<Exclude<Service, "github" | "unknown">, string[]> = {
  gmail: ["gmail", "thread", "threads", "message", "messages", "email", "emails", "mail", "label", "labels", "draft", "drafts", "inbox", "attachment", "attachments"],
  sheets: ["spreadsheet", "spreadsheets", "sheet", "sheets", "cell", "cells", "worksheet", "range", "row", "rows", "column", "columns"],
  calendar: ["calendar", "calendars", "event", "events", "meeting", "attendee", "attendees", "freebusy", "acl", "recurrence"],
  docs: ["document", "documents", "doc", "docs", "paragraph", "textrun"],
  slides: ["presentation", "presentations", "slide", "slides"],
  forms: ["form", "forms", "response", "responses", "quiz"],
  drive: ["drive", "file", "files", "folder", "folders", "permission", "permissions", "revision", "revisions"],
  tasks: ["task", "tasks", "tasklist", "tasklists", "todo"],
  photos: ["photo", "photos", "album", "albums", "mediaitem", "media"],
  people: ["contact", "contacts", "people", "person", "connection", "connections", "othercontact"],
};

export function inferService(toolSlug: string, toolkitSlug: string, description: string): Service {
  // toolkit wins outright: a GitHub tool is never reclassified just because its
  // description mentions "file" or "calendar".
  if (toolkitSlug.toLowerCase() === "github") return "github";
  if (toolSlug.toUpperCase().startsWith("GITHUB_")) return "github";

  const slugTokens = tokenize(toolSlug).filter((t) => t !== "googlesuper");
  const descTokens = tokenize(description);
  const slugSet = new Set(slugTokens);
  const descSet = new Set(descTokens);

  let best: Service = "unknown";
  let bestScore = 0;
  for (const [service, keywords] of Object.entries(SERVICE_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (slugSet.has(kw)) score += 2;
      else if (descSet.has(kw)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = service as Service;
    }
  }
  return bestScore > 0 ? best : "unknown";
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// leaf param names that carry no entity-identifying meaning on their own —
// matching on these alone across unrelated tools would explode the graph.
export const STOPLIST = new Set([
  // identity-less generics
  "id", "name", "type", "value", "kind", "key", "index", "item", "object", "resource", "data",
  "payload", "params", "parameter", "option", "config", "setting", "metadata", "property", "field",
  // pagination / paging
  "page", "page_token", "next_page_token", "page_size", "per_page", "cursor", "limit", "offset",
  "max_result", "max_record", "count", "size", "start", "end", "start_index", "end_index", "top", "skip",
  // auth / connection plumbing (never produced by another tool in the graph)
  "token", "access_token", "refresh_token", "id_token", "api_key", "auth", "authorization",
  "client_id", "client_secret", "secret", "credential", "connected_account_id", "user_id_or_me",
  // query / filter / sort
  "query", "q", "search", "filter", "sort", "order", "order_by", "direction", "field_mask", "mask",
  "include", "exclude", "expand", "select", "projection", "scope", "criteria",
  // free-form payload-ish
  "body", "text", "content", "message", "note", "comment", "html", "markdown", "raw", "input", "output",
  // status / flags / formatting
  "state", "status", "format", "mime_type", "encoding", "charset", "enabled", "disabled", "active",
  "visibility", "private", "public", "draft_flag", "force", "dry_run", "verbose", "flag",
  // time
  "since", "until", "date", "time", "timestamp", "created_at", "updated_at", "created", "updated",
  "start_date", "end_date", "timezone", "time_zone", "locale", "language", "version",
  // misc noise
  "url", "uri", "link", "href", "color", "icon", "image", "emoji", "locale_code", "region", "country",
]);

// free-text / human-authored fields: these should surface as "ask the user"
// nodes rather than as things another tool could have produced.
const HUMAN_LEAF_PATTERNS: RegExp[] = [
  /^subject$/,
  /^(message_)?body$/,
  /^(comment|issue|pr|review)_body$/,
  /^title$/,
  /^description$/,
  /^summary$/,
  /^message$/,
  /^text$/,
  /^content$/,
  /^note$/,
  /^commit_message$/,
  /^start_time$/,
  /^end_time$/,
  /^due_(on|date)$/,
  /^recipient(_name)?$/,
  /^to_name$/,
  /^person_name$/,
  /^display_name$/,
  /^name$/, // "name" as a value the user provides (e.g. a contact's name)
];

export function isHumanParam(leafName: string): boolean {
  const n = normalizeLeaf(leafName);
  return HUMAN_LEAF_PATTERNS.some((re) => re.test(n));
}

// words whose trailing "s" is part of the stem, not a plural marker.
const NON_PLURAL_ENDINGS = ["ss", "us", "is", "as", "os"];

export function normalizeLeaf(raw: string): string {
  const snake = raw
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2") // HTTPStatus -> HTTP_Status, URLId -> URL_Id
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2") // camelCase -> camel_Case
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .replace(/^(target_|source_|parent_|base_|head_|new_|old_|the_)/, "");
  return singularize(snake);
}

function singularize(w: string): string {
  if (w.length <= 3 || !w.endsWith("s")) return w;
  if (NON_PLURAL_ENDINGS.some((suf) => w.endsWith(suf))) return w; // address, status, analysis, alias
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`; // properties -> property
  return w.slice(0, -1);
}

interface SlotDef {
  slot: string;
  service: Service;
  patterns: RegExp[];
  // entity noun(s) used by the heuristic producer fallback when a tool has no
  // declared outputParameters — matched against slug tokens (singular form;
  // plurals are derived automatically). Pipe-separate genuine synonyms.
  noun: string;
}

const SLOT_TABLE: SlotDef[] = [
  // ---- gmail ----
  { slot: "gmail.thread_id", service: "gmail", patterns: [/^thread_id$/, /^thread$/], noun: "thread" },
  { slot: "gmail.message_id", service: "gmail", patterns: [/^message_id$/, /^msg_id$/, /^email_id$/], noun: "message" },
  { slot: "gmail.label_id", service: "gmail", patterns: [/^label_id$/, /^(add|remove)_label_id$/], noun: "label" },
  { slot: "gmail.draft_id", service: "gmail", patterns: [/^draft_id$/], noun: "draft" },
  { slot: "gmail.attachment_id", service: "gmail", patterns: [/^attachment_id$/], noun: "attachment" },
  { slot: "gmail.filter_id", service: "gmail", patterns: [/^filter_id$/], noun: "filter" },

  // ---- drive ----
  { slot: "drive.file_id", service: "drive", patterns: [/^file_id$/, /^drive_file_id$/], noun: "file" },
  { slot: "drive.folder_id", service: "drive", patterns: [/^folder_id$/], noun: "folder" },
  { slot: "drive.drive_id", service: "drive", patterns: [/^drive_id$/, /^shared_drive_id$/], noun: "drive" },
  { slot: "drive.permission_id", service: "drive", patterns: [/^permission_id$/], noun: "permission" },
  { slot: "drive.revision_id", service: "drive", patterns: [/^revision_id$/], noun: "revision" },

  // ---- calendar ----
  { slot: "calendar.calendar_id", service: "calendar", patterns: [/^calendar_id$/], noun: "calendar" },
  { slot: "calendar.event_id", service: "calendar", patterns: [/^event_id$/], noun: "event" },
  { slot: "calendar.acl_rule_id", service: "calendar", patterns: [/^rule_id$/, /^acl_id$/], noun: "acl" },

  // ---- sheets ----
  { slot: "sheets.spreadsheet_id", service: "sheets", patterns: [/^spreadsheet_id$/], noun: "spreadsheet" },
  { slot: "sheets.sheet_id", service: "sheets", patterns: [/^sheet_id$/, /^gid$/], noun: "sheet" },
  { slot: "sheets.range", service: "sheets", patterns: [/^range$/, /^a1_range$/, /^cell_range$/], noun: "range" },

  // ---- docs / slides / forms ----
  { slot: "docs.document_id", service: "docs", patterns: [/^document_id$/, /^doc_id$/], noun: "document" },
  { slot: "slides.presentation_id", service: "slides", patterns: [/^presentation_id$/], noun: "presentation" },
  { slot: "slides.page_object_id", service: "slides", patterns: [/^page_object_id$/, /^slide_id$/], noun: "slide" },
  { slot: "forms.form_id", service: "forms", patterns: [/^form_id$/], noun: "form" },
  { slot: "forms.response_id", service: "forms", patterns: [/^response_id$/], noun: "response" },

  // ---- tasks ----
  { slot: "tasks.tasklist_id", service: "tasks", patterns: [/^tasklist_id$/, /^task_list_id$/], noun: "tasklist" },
  { slot: "tasks.task_id", service: "tasks", patterns: [/^task_id$/], noun: "task" },

  // ---- photos ----
  { slot: "photos.album_id", service: "photos", patterns: [/^album_id$/], noun: "album" },
  { slot: "photos.media_item_id", service: "photos", patterns: [/^media_item_id$/], noun: "mediaitem|media" },

  // ---- people / contacts (cross-service: name -> email resolution) ----
  { slot: "people.contact_id", service: "people", patterns: [/^contact_id$/, /^person_id$/, /^resource_name$/], noun: "contact" },
  {
    slot: "people.email_address",
    service: "people",
    patterns: [/^email(_address)?$/, /^to$/, /^cc$/, /^bcc$/, /^recipient_email$/, /^to_email$/, /^attendee_email$/],
    noun: "email",
  },

  // ---- github: repo coordinates ----
  { slot: "github.owner", service: "github", patterns: [/^owner$/, /^org(anization)?$/, /^org_name$/, /^owner_name$/], noun: "owner" },
  { slot: "github.repo", service: "github", patterns: [/^repo(sitory)?$/, /^repo(sitory)?_name$/], noun: "repo|repository" },
  { slot: "github.branch", service: "github", patterns: [/^branch$/, /^branch_name$/, /^ref_branch$/], noun: "branch" },
  { slot: "github.ref", service: "github", patterns: [/^ref$/, /^git_ref$/], noun: "ref" },
  { slot: "github.commit_sha", service: "github", patterns: [/^(commit_)?sha$/, /^commit_id$/, /^commit$/], noun: "commit" },
  { slot: "github.tag", service: "github", patterns: [/^tag$/, /^tag_name$/], noun: "tag" },
  { slot: "github.path", service: "github", patterns: [/^path$/, /^file_path$/], noun: "path" },
  { slot: "github.tree_sha", service: "github", patterns: [/^tree_sha$/], noun: "tree" },

  // ---- github: issues / PRs / discussions ----
  { slot: "github.issue_number", service: "github", patterns: [/^issue_number$/, /^issue_id$/], noun: "issue" },
  { slot: "github.pull_number", service: "github", patterns: [/^pull_number$/, /^pr_number$/, /^pull_request_number$/], noun: "pull|pr" },
  { slot: "github.review_id", service: "github", patterns: [/^review_id$/], noun: "review" },
  { slot: "github.review_comment_id", service: "github", patterns: [/^review_comment_id$/], noun: "review" },
  { slot: "github.comment_id", service: "github", patterns: [/^comment_id$/], noun: "comment" },
  { slot: "github.discussion_number", service: "github", patterns: [/^discussion_number$/, /^discussion_id$/], noun: "discussion" },
  { slot: "github.milestone_number", service: "github", patterns: [/^milestone_number$/, /^milestone$/, /^milestone_id$/], noun: "milestone" },
  { slot: "github.label", service: "github", patterns: [/^label$/, /^label_name$/], noun: "label" },
  { slot: "github.assignee", service: "github", patterns: [/^assignee$/], noun: "assignee" },

  // ---- github: actions / CI ----
  { slot: "github.workflow_id", service: "github", patterns: [/^workflow_id$/, /^workflow$/], noun: "workflow" },
  { slot: "github.run_id", service: "github", patterns: [/^run_id$/, /^workflow_run_id$/], noun: "run" },
  { slot: "github.job_id", service: "github", patterns: [/^job_id$/], noun: "job" },
  { slot: "github.artifact_id", service: "github", patterns: [/^artifact_id$/], noun: "artifact" },
  { slot: "github.check_run_id", service: "github", patterns: [/^check_run_id$/], noun: "check" },
  { slot: "github.check_suite_id", service: "github", patterns: [/^check_suite_id$/], noun: "check" },
  { slot: "github.runner_id", service: "github", patterns: [/^runner_id$/], noun: "runner" },
  { slot: "github.environment_name", service: "github", patterns: [/^environment_name$/, /^environment$/], noun: "environment" },
  { slot: "github.deployment_id", service: "github", patterns: [/^deployment_id$/], noun: "deployment" },
  { slot: "github.secret_name", service: "github", patterns: [/^secret_name$/], noun: "secret" },
  { slot: "github.variable_name", service: "github", patterns: [/^variable_name$/], noun: "variable" },

  // ---- github: releases / packages / gists ----
  { slot: "github.release_id", service: "github", patterns: [/^release_id$/], noun: "release" },
  { slot: "github.asset_id", service: "github", patterns: [/^asset_id$/], noun: "asset" },
  { slot: "github.package_name", service: "github", patterns: [/^package_name$/], noun: "package" },
  { slot: "github.gist_id", service: "github", patterns: [/^gist_id$/], noun: "gist" },

  // ---- github: projects ----
  { slot: "github.project_id", service: "github", patterns: [/^project_id$/, /^project_number$/], noun: "project" },
  { slot: "github.column_id", service: "github", patterns: [/^column_id$/], noun: "column" },
  { slot: "github.card_id", service: "github", patterns: [/^card_id$/], noun: "card" },

  // ---- github: org / users / access ----
  { slot: "github.username", service: "github", patterns: [/^username$/, /^user$/, /^login$/, /^collaborator$/, /^user_id$/], noun: "user" },
  { slot: "github.team_slug", service: "github", patterns: [/^team_slug$/, /^team_id$/, /^team$/], noun: "team" },
  { slot: "github.invitation_id", service: "github", patterns: [/^invitation_id$/], noun: "invitation" },
  { slot: "github.installation_id", service: "github", patterns: [/^installation_id$/], noun: "installation" },
  { slot: "github.app_id", service: "github", patterns: [/^app_id$/, /^app_slug$/], noun: "app" },
  { slot: "github.hook_id", service: "github", patterns: [/^hook_id$/, /^webhook_id$/], noun: "webhook" },
  { slot: "github.key_id", service: "github", patterns: [/^key_id$/, /^deploy_key_id$/], noun: "key" },
  { slot: "github.alert_number", service: "github", patterns: [/^alert_number$/, /^alert_id$/], noun: "alert" },
  { slot: "github.migration_id", service: "github", patterns: [/^migration_id$/], noun: "migration" },
  { slot: "github.notification_thread_id", service: "github", patterns: [/^thread_id$/], noun: "notification" },
];

const GOOGLE_SERVICES = new Set<Service>([
  "gmail", "drive", "calendar", "sheets", "docs", "slides", "forms", "tasks", "photos", "people",
]);

/**
 * Resolve a raw leaf param name to a canonical slot for a tool of `service`.
 *
 * Matching is tiered: same-service slots first, then the cross-service `people`
 * slots (name -> email resolution is legitimately used from gmail/calendar),
 * then — for google services only — any other google slot. That last tier is
 * what lets a Gmail tool consume `drive.file_id` for an attachment; it is safe
 * because the surviving patterns are all specific, entity-qualified ids
 * (`spreadsheet_id`, `event_id`), never bare generics, which the stoplist eats.
 * GitHub slots are never reachable from a google tool and vice versa.
 */
export function resolveSlot(service: Service, leafName: string): string | null {
  const n = normalizeLeaf(leafName);
  if (STOPLIST.has(n) || STOPLIST.has(leafName.toLowerCase())) return null;

  const tiers: ((d: SlotDef) => boolean)[] = [
    (d) => d.service === service,
    (d) => d.service === "people" && service !== "github",
    (d) => GOOGLE_SERVICES.has(d.service) && (GOOGLE_SERVICES.has(service) || service === "unknown"),
  ];

  for (const inTier of tiers) {
    for (const def of SLOT_TABLE) {
      if (!inTier(def)) continue;
      if (def.patterns.some((re) => re.test(n))) return def.slot;
    }
  }
  return null;
}

/** Entity nouns for a slot, used by the heuristic producer fallback. */
export function slotNouns(slot: string): string[] {
  return SLOT_TABLE.find((d) => d.slot === slot)?.noun.split("|") ?? [];
}

/** Does a slug token name this slot's entity? Compares singular forms so
 *  "issues" matches "issue" without "username" matching "user". */
export function tokenNamesNoun(token: string, noun: string): boolean {
  return token === noun || singularize(token) === noun;
}

/** Slots a tool of this service could plausibly produce — the search space for
 *  the heuristic producer fallback. Mirrors resolveSlot's tiering so a Gmail
 *  tool is never credited as a producer of `github.repo`. */
export function slotsForService(service: Service): string[] {
  if (service === "github") return SLOT_TABLE.filter((d) => d.service === "github").map((d) => d.slot);
  return SLOT_TABLE.filter((d) => GOOGLE_SERVICES.has(d.service)).map((d) => d.slot);
}
