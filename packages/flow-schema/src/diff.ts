// Structural diff between two flows — "what changed since the last
// publish?". Authoring-only, like `mutate.ts`: the engine never diffs two
// flows, so (unlike the model helpers) there is no Rust twin. A consumer
// (the platform editor's per-node change highlight) parses the last
// published version and the working draft, then asks which nodes were
// added, removed, or edited, and — for edits — which fields moved.
//
// The comparison is *structural*, not textual: it works on decoded `Flow`
// objects, so it ignores comment/key-order churn and the flow-level stamps
// publish rewrites (`id`, `name`, `version`, the opaque `ui` block). A node
// that is byte-different in YAML but identical in meaning reads as
// unchanged — which is exactly what an author wants to see.

import type { Flow, Node } from './generated/model.js';

/** A node's fate between the two flows. */
export type FlowDiffStatus = 'added' | 'removed' | 'modified' | 'unchanged';

/**
 * One field that differs on a node present in both flows. `path` is a
 * dot-path within the node — a top-level field (`prompt`, `timeout_secs`),
 * a single exit (`exits.no_answer`), a single menu option (`options.1`), or
 * the synthetic `entry` pseudo-field when this node gained or lost the
 * start marker. `before`/`after` are the raw values, `undefined` when the
 * field was absent on that side.
 */
export interface FieldChange {
  path: string;
  before: unknown;
  after: unknown;
}

export interface NodeDiff {
  status: FlowDiffStatus;
  /** The node's kind — from the draft, or from the published side when removed. */
  kind: string;
  /** Field-level changes; empty unless `status === 'modified'`. */
  changes: FieldChange[];
}

export interface FlowDiff {
  /** Every node id present in either flow, mapped to its diff. */
  nodes: Record<string, NodeDiff>;
  /** Node ids only in the draft (sorted). */
  added: string[];
  /** Node ids only in the published version (sorted). */
  removed: string[];
  /** Node ids in both but structurally changed (sorted). */
  modified: string[];
  /** The entry node id moved between the two flows. */
  entryChanged: boolean;
  entryBefore: string;
  entryAfter: string;
  /** True when anything differs — nodes added/removed/modified, or entry moved. */
  changed: boolean;
}

// Fields that are string→string maps and read best diffed per key rather
// than as one opaque blob: a rewired exit or a relabelled menu option is a
// per-entry edit, so `exits.no_answer` / `options.1` beats "exits changed".
const MAP_FIELDS = ['exits', 'options'] as const;

/**
 * Structurally diff two flows. `before` is the baseline (typically the last
 * published version), `after` the candidate (the working draft). Order of
 * object keys and array-free churn does not affect the result.
 */
export function diffFlows(before: Flow, after: Flow): FlowDiff {
  const nodes: Record<string, NodeDiff> = {};
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];

  const ids = new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)]);
  for (const id of ids) {
    const b = before.nodes[id];
    const a = after.nodes[id];
    if (!b && a) {
      nodes[id] = { status: 'added', kind: a.kind, changes: [] };
      added.push(id);
    } else if (b && !a) {
      nodes[id] = { status: 'removed', kind: b.kind, changes: [] };
      removed.push(id);
    } else if (b && a) {
      const changes = diffNode(b, a);
      // Moving the start marker onto/off this node is a change to the
      // node's role even when its config is untouched.
      const wasEntry = before.entry === id;
      const isEntry = after.entry === id;
      if (wasEntry !== isEntry) changes.push({ path: 'entry', before: wasEntry, after: isEntry });
      if (changes.length > 0) {
        nodes[id] = { status: 'modified', kind: a.kind, changes };
        modified.push(id);
      } else {
        nodes[id] = { status: 'unchanged', kind: a.kind, changes: [] };
      }
    }
  }

  const entryChanged = before.entry !== after.entry;
  return {
    nodes,
    added: added.sort(),
    removed: removed.sort(),
    modified: modified.sort(),
    entryChanged,
    entryBefore: before.entry,
    entryAfter: after.entry,
    changed: added.length > 0 || removed.length > 0 || modified.length > 0 || entryChanged,
  };
}

// The field-level changes between two nodes sharing an id. Map-typed fields
// (`exits`, `options`) diff per key; every other field is compared whole.
function diffNode(before: Node, after: Node): FieldChange[] {
  const changes: FieldChange[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of keys) {
    const b = (before as Record<string, unknown>)[key];
    const a = (after as Record<string, unknown>)[key];
    if ((MAP_FIELDS as readonly string[]).includes(key)) {
      changes.push(...diffMap(key, asRecord(b), asRecord(a)));
    } else if (!deepEqual(b, a)) {
      changes.push({ path: key, before: b, after: a });
    }
  }

  // Stable, readable order: plain fields first (kind, prompt, …), then the
  // per-key map entries, each group alphabetical.
  return changes.sort((x, y) => x.path.localeCompare(y.path));
}

function diffMap(
  field: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (!deepEqual(before[key], after[key])) {
      changes.push({ path: `${field}.${key}`, before: before[key], after: after[key] });
    }
  }
  return changes;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Order-insensitive for object keys (YAML round-trips don't preserve key
// order and it carries no meaning), order-sensitive for arrays (a schedule's
// ranges and a flow's exceptions are ordered).
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr || bArr) {
    if (!aArr || !bArr || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}
