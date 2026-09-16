// Flattens Composio's JSON-schema-shaped inputParameters/outputParameters
// into leaf param records, so ontology.resolveSlot can be applied per-leaf.

export interface Leaf {
  path: string; // dotted path from root, e.g. "threads[].thread_id"
  name: string; // final leaf key, e.g. "thread_id"
  type: string;
  description: string;
  required: boolean; // required at its own level AND every level above it
}

interface JsonSchemaNode {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode | JsonSchemaNode[];
  required?: string[];
  description?: string;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  $defs?: Record<string, JsonSchemaNode>;
  definitions?: Record<string, JsonSchemaNode>;
  additionalProperties?: boolean | JsonSchemaNode;
  [k: string]: unknown;
}

const MAX_DEPTH = 4;

export function flattenSchema(schema: JsonSchemaNode | undefined | null): Leaf[] {
  if (!schema || typeof schema !== "object") return [];
  const leaves: Leaf[] = [];
  walk(schema, schema, "", true, 0, leaves, new Set());
  // two different branches of an anyOf can yield the same path; keep one.
  const seen = new Set<string>();
  return leaves.filter((l) => (seen.has(l.path) ? false : (seen.add(l.path), true)));
}

// Resolves local "#/$defs/Foo" / "#/definitions/Foo" / "#/properties/..." refs
// against the document root. Remote refs are not resolvable and yield null.
function deref(root: JsonSchemaNode, node: JsonSchemaNode, seen: Set<string>): JsonSchemaNode | null {
  let cur = node;
  let hops = 0;
  while (cur && typeof cur.$ref === "string" && hops++ < 10) {
    const ref = cur.$ref;
    if (!ref.startsWith("#") || seen.has(ref)) return null; // remote or cyclic
    seen.add(ref);
    let target: unknown = root;
    for (const rawSeg of ref.slice(1).split("/").filter(Boolean)) {
      const seg = rawSeg.replace(/~1/g, "/").replace(/~0/g, "~");
      if (target && typeof target === "object") target = (target as Record<string, unknown>)[seg];
      else return null;
    }
    if (!target || typeof target !== "object") return null;
    cur = target as JsonSchemaNode;
  }
  return cur;
}

// Schemas commonly write `type: ["string", "null"]` for nullable fields; the
// meaningful type is the non-null member.
function normalizeType(t: string | string[] | undefined): string {
  if (!t) return "unknown";
  if (!Array.isArray(t)) return t;
  return t.find((x) => x !== "null") ?? t[0] ?? "unknown";
}

function isContainer(node: JsonSchemaNode): boolean {
  return Boolean(node.properties || node.anyOf || node.oneOf || node.allOf || node.$ref || node.items);
}

function walk(
  root: JsonSchemaNode,
  rawNode: JsonSchemaNode,
  pathPrefix: string,
  requiredHere: boolean,
  depth: number,
  out: Leaf[],
  refSeen: Set<string>
) {
  if (depth > MAX_DEPTH) return;
  const node = deref(root, rawNode, refSeen);
  if (!node) return;

  // union / intersection branches: descend into each at the same path.
  const branches = node.anyOf ?? node.oneOf ?? node.allOf;
  if (branches && !node.properties) {
    for (const b of branches) walk(root, b, pathPrefix, requiredHere, depth, out, new Set(refSeen));
    return;
  }

  const props = node.properties;
  if (!props) return;
  const requiredSet = new Set(node.required ?? []);

  for (const [key, rawChild] of Object.entries(props)) {
    const child = deref(root, rawChild, new Set(refSeen));
    if (!child) continue;

    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    // a field is only truly required if every enclosing object was required too
    const required = requiredHere && requiredSet.has(key);
    const childType = normalizeType(child.type);

    // nested object — note we test for `properties` rather than `type: object`,
    // since plenty of real schemas omit `type` entirely.
    const objectish = child.properties ?? branchProps(root, child, refSeen);
    if (objectish) {
      walk(root, child, path, required, depth + 1, out, new Set(refSeen));
      continue;
    }

    // array: descend only when the items are themselves structured. an array of
    // primitives (e.g. `label_ids: string[]`) stays a leaf, which is what we want
    // — its own name is the slot-bearing token.
    const items = Array.isArray(child.items) ? child.items[0] : child.items;
    if (childType === "array" || items) {
      const resolvedItems = items ? deref(root, items, new Set(refSeen)) : null;
      if (resolvedItems && isContainer(resolvedItems)) {
        // array membership makes per-item fields non-required for our purposes
        walk(root, resolvedItems, `${path}[]`, false, depth + 1, out, new Set(refSeen));
        continue;
      }
    }

    out.push({
      path,
      name: key,
      type: childType,
      description: child.description ?? "",
      required,
    });
  }
}

// an object may hide its properties behind anyOf/oneOf/allOf; surface them so
// we descend rather than emitting a bogus leaf.
function branchProps(
  root: JsonSchemaNode,
  node: JsonSchemaNode,
  refSeen: Set<string>
): Record<string, JsonSchemaNode> | undefined {
  const branches = node.anyOf ?? node.oneOf ?? node.allOf;
  if (!branches) return undefined;
  for (const b of branches) {
    const r = deref(root, b, new Set(refSeen));
    if (r?.properties) return r.properties;
  }
  return undefined;
}
