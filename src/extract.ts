// Flattens Composio's JSON-schema-shaped inputParameters/outputParameters
// into leaf param records, so ontology.resolveSlot can be applied per-leaf.

export interface Leaf {
  path: string; // dotted path from root, e.g. "threads.thread_id"
  name: string; // final leaf key, e.g. "thread_id"
  type: string;
  description: string;
  required: boolean;
}

interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  required?: string[];
  description?: string;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  [k: string]: unknown;
}

const MAX_DEPTH = 3;

export function flattenSchema(schema: JsonSchemaNode | undefined | null): Leaf[] {
  if (!schema) return [];
  const leaves: Leaf[] = [];
  walk(schema, "", true, 0, leaves);
  return leaves;
}

function walk(
  node: JsonSchemaNode,
  pathPrefix: string,
  parentRequiredHere: boolean,
  depth: number,
  out: Leaf[]
) {
  if (depth > MAX_DEPTH) return;

  const variants = node.anyOf ?? node.oneOf;
  if (variants) {
    for (const v of variants) walk(v, pathPrefix, parentRequiredHere, depth, out);
    return;
  }

  const props = node.properties;
  if (!props) return;

  const requiredSet = new Set(node.required ?? []);

  for (const [key, child] of Object.entries(props)) {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    const required = requiredSet.has(key);
    const childType = normalizeType(child.type);

    if (childType === "object" && child.properties) {
      walk(child, path, required, depth + 1, out);
      continue;
    }

    if (childType === "array" && child.items?.properties) {
      walk(child.items, `${path}[]`, false, depth + 1, out);
      continue;
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

function normalizeType(t: string | string[] | undefined): string {
  if (!t) return "unknown";
  return Array.isArray(t) ? t[0] ?? "unknown" : t;
}
