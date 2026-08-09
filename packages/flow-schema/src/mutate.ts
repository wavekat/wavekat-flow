// Structured, comment-preserving edits to a flow document's *source
// text*. The YAML text is the single source of truth (doc 48: "one
// document, many faces") — the form face and the API don't keep a
// parallel model, they rewrite the text through these ops, which go
// through the yaml Document API so comments, key order, and the
// engine-opaque `ui` block survive untouched.
//
// TS-only: the daemon never edits documents, so there is no Rust twin.
// These ops work on the `yaml` CST, not the generated model types.
//
// Every op is stateless: source in, source out. Documents are a few KB
// at most, so re-parsing per edit is well inside interaction budgets.

import { isMap, isScalar, parseDocument } from 'yaml';
import type { Document, Pair, Scalar, YAMLMap, YAMLSeq } from 'yaml';

import type { ComponentKind } from './model.js';

export type EditError = 'parse_failed' | 'invalid_node_id' | 'duplicate_node_id' | 'unknown_node';

export type EditResult = { ok: true; source: string } | { ok: false; error: EditError };

/**
 * What the editor accepts as a node id: plain-YAML-safe, so ids never
 * need quoting. (The schema itself allows any string; this constraint
 * is editorial, matching the doc 48 "human-meaningful node IDs" rule.)
 */
export const NODE_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

function withDoc(
  source: string,
  edit: (doc: Document) => EditError | undefined,
): EditResult {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) return { ok: false, error: 'parse_failed' };
  const error = edit(doc);
  if (error) return { ok: false, error };
  return { ok: true, source: doc.toString() };
}

function nodesMap(doc: Document): YAMLMap | undefined {
  const nodes = doc.get('nodes', true);
  return isMap(nodes) ? nodes : undefined;
}

function findPair(map: YAMLMap, key: string): Pair | undefined {
  return (map.items as Pair[]).find(
    (pair) => isScalar(pair.key) && pair.key.value === key,
  );
}

/** Rename a key in place (preserves the pair's comments and position). */
function renameKey(map: YAMLMap | undefined, from: string, to: string): void {
  if (!map) return;
  const pair = findPair(map, from);
  if (pair) (pair.key as Scalar).value = to;
}

/** The `ui` block spots that may be keyed by node id. Opaque to the
 * engine, but a rename/delete that leaves stale ids behind would leak
 * one node's position onto another once the id is reused. */
function uiMaps(doc: Document): YAMLMap[] {
  const ui = doc.get('ui', true);
  if (!isMap(ui)) return [];
  const maps = [ui];
  for (const key of ['nodes', 'positions']) {
    const sub = ui.get(key, true);
    if (isMap(sub)) maps.push(sub);
  }
  return maps;
}

/**
 * Rename a node and every reference to it: the `nodes` key, `entry`,
 * every exit target, and `ui` position keys.
 */
export function renameNode(source: string, from: string, to: string): EditResult {
  if (!NODE_ID_PATTERN.test(to)) return { ok: false, error: 'invalid_node_id' };
  return withDoc(source, (doc) => {
    const nodes = nodesMap(doc);
    const pair = nodes && findPair(nodes, from);
    if (!nodes || !pair) return 'unknown_node';
    if (from !== to && findPair(nodes, to)) return 'duplicate_node_id';

    (pair.key as Scalar).value = to;
    if (doc.get('entry') === from) doc.set('entry', to);
    for (const nodePair of nodes.items as Pair[]) {
      if (!isMap(nodePair.value)) continue;
      const exits = nodePair.value.get('exits', true);
      if (!isMap(exits)) continue;
      for (const exitPair of exits.items as Pair[]) {
        if (isScalar(exitPair.value) && exitPair.value.value === from) {
          exitPair.value.value = to;
        }
      }
    }
    for (const map of uiMaps(doc)) renameKey(map, from, to);
    return undefined;
  });
}

/**
 * Remove a node, every exit that pointed at it (their absence is then
 * reported by validation as a missing required exit — the author must
 * rewire, not silently fall through), and its `ui` position. A dangling
 * `entry` is left for validation to flag.
 */
export function removeNode(source: string, id: string): EditResult {
  return withDoc(source, (doc) => {
    const nodes = nodesMap(doc);
    if (!nodes || !findPair(nodes, id)) return 'unknown_node';
    nodes.delete(id);
    for (const nodePair of nodes.items as Pair[]) {
      if (!isMap(nodePair.value)) continue;
      const exits = nodePair.value.get('exits', true);
      if (!isMap(exits)) continue;
      const stale = (exits.items as Pair[])
        .filter((exitPair) => isScalar(exitPair.value) && exitPair.value.value === id)
        .map((exitPair) => (exitPair.key as Scalar).value);
      for (const name of stale) exits.delete(name);
      if (exits.items.length === 0) nodePair.value.delete('exits');
    }
    for (const map of uiMaps(doc)) map.delete(id);
    return undefined;
  });
}

/** Insert a new node built from a plain JS shape (see `defaultNode`). */
export function addNode(source: string, id: string, node: Record<string, unknown>): EditResult {
  if (!NODE_ID_PATTERN.test(id)) return { ok: false, error: 'invalid_node_id' };
  return withDoc(source, (doc) => {
    const nodes = nodesMap(doc);
    if (nodes && findPair(nodes, id)) return 'duplicate_node_id';
    const created = doc.createNode(node);
    // Inline the small maps the same way the documented examples write
    // them: `exits: { next: bye }`, `prompt: { audio: welcome }`.
    if (isMap(created)) {
      for (const key of ['exits', 'options', 'prompt']) {
        const sub = created.get(key, true);
        if (isMap(sub)) sub.flow = true;
      }
    }
    doc.setIn(['nodes', id], created);
    return undefined;
  });
}

/** Point the flow's `entry` at an existing node. */
export function setEntry(source: string, id: string): EditResult {
  return withDoc(source, (doc) => {
    const nodes = nodesMap(doc);
    if (!nodes || !findPair(nodes, id)) return 'unknown_node';
    doc.set('entry', id);
    return undefined;
  });
}

/** Wire (or rewire) one exit of a node. */
export function setExit(source: string, id: string, exit: string, target: string): EditResult {
  return withDoc(source, (doc) => {
    const nodes = nodesMap(doc);
    if (!nodes || !findPair(nodes, id)) return 'unknown_node';
    doc.setIn(['nodes', id, 'exits', exit], target);
    return undefined;
  });
}

/** Remove one exit of a node (dropping an empty `exits` map entirely). */
export function removeExit(source: string, id: string, exit: string): EditResult {
  return withDoc(source, (doc) => {
    const nodes = nodesMap(doc);
    const pair = nodes && findPair(nodes, id);
    if (!nodes || !pair) return 'unknown_node';
    doc.deleteIn(['nodes', id, 'exits', exit]);
    if (isMap(pair.value)) {
      const exits = pair.value.get('exits', true);
      if (isMap(exits) && exits.items.length === 0) pair.value.delete('exits');
    }
    return undefined;
  });
}

/**
 * Set (or with `value === undefined`, delete) one config field of a
 * node — `['prompt']`, `['options', '2']`, `['schedule', 'mon']`, …
 */
export function setNodeValue(
  source: string,
  id: string,
  path: (string | number)[],
  value: unknown,
): EditResult {
  return withDoc(source, (doc) => {
    const nodes = nodesMap(doc);
    if (!nodes || !findPair(nodes, id)) return 'unknown_node';
    if (value === undefined) {
      doc.deleteIn(['nodes', id, ...path]);
    } else {
      const wrapped =
        value !== null && typeof value === 'object' ? doc.createNode(value) : value;
      doc.setIn(['nodes', id, ...path], wrapped);
    }
    return undefined;
  });
}

/**
 * Where the editor's drag-to-arrange puts a node on the map, stored in
 * the engine-opaque `ui` block as `ui.positions.<id>: [x, y]` so a
 * hand-arranged map survives save/publish and travels with the
 * document. The engine never reads it; renameNode/removeNode keep the
 * keys in sync.
 */
export function setNodePosition(source: string, id: string, x: number, y: number): EditResult {
  return withDoc(source, (doc) => {
    const nodes = nodesMap(doc);
    if (!nodes || !findPair(nodes, id)) return 'unknown_node';
    const position = doc.createNode([Math.round(x), Math.round(y)]) as YAMLSeq;
    position.flow = true;
    doc.setIn(['ui', 'positions', id], position);
    return undefined;
  });
}

/** Drop every stored position — the map falls back to auto layout. */
export function clearNodePositions(source: string): EditResult {
  return withDoc(source, (doc) => {
    doc.deleteIn(['ui', 'positions']);
    const ui = doc.get('ui', true);
    if (isMap(ui) && ui.items.length === 0) doc.delete('ui');
    return undefined;
  });
}

/**
 * The stored positions of a parsed flow's `ui` block, dropping anything
 * that isn't a `[number, number]` pair — the block is author-editable
 * text, so junk shapes are expected, not errors.
 */
export function nodePositions(ui: unknown): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  if (ui === null || typeof ui !== 'object') return out;
  const positions = (ui as { positions?: unknown }).positions;
  if (positions === null || typeof positions !== 'object' || Array.isArray(positions)) return out;
  for (const [id, value] of Object.entries(positions as Record<string, unknown>)) {
    if (!Array.isArray(value) || value.length !== 2) continue;
    const [x, y] = value as unknown[];
    if (typeof x !== 'number' || !Number.isFinite(x)) continue;
    if (typeof y !== 'number' || !Number.isFinite(y)) continue;
    out[id] = { x, y };
  }
  return out;
}

/**
 * Stamp platform-assigned identity into the document — the row id at
 * create time, the bumped `version` at publish (doc 48: both are
 * platform-assigned; authors never maintain them by hand).
 */
export function stampIdentity(
  source: string,
  identity: { id?: string; version?: number; name?: string },
): EditResult {
  return withDoc(source, (doc) => {
    if (identity.id !== undefined) doc.set('id', identity.id);
    if (identity.version !== undefined) doc.set('version', identity.version);
    if (identity.name !== undefined) doc.set('name', identity.name);
    return undefined;
  });
}

/**
 * Restate the document's declared `schema_version`.
 *
 * Machine-managed, like the identity fields above: an authoring tool sets
 * it from {@link requiredSchemaVersion} so the number tracks the steps the
 * author actually placed, rather than being a thing they have to know
 * about. It lowers as readily as it raises — a draft that no longer needs
 * the newer component goes back to the widest version that can run it.
 *
 * This does not migrate a document. Nothing here rewrites a stored flow's
 * *contents* to suit another version; the format's promise that an old
 * document keeps working is untouched.
 */
export function setSchemaVersion(source: string, version: number): EditResult {
  return withDoc(source, (doc) => {
    doc.set('schema_version', version);
    return undefined;
  });
}

/**
 * A freshly-added node's starting shape, per kind. English placeholder
 * copy — the web editor passes its own localized shape instead; this is
 * the fallback and the tests' fixture. Exits are deliberately unwired:
 * validation's "missing required exits" is what walks the author
 * through connecting the new node.
 */
export function defaultNode(kind: ComponentKind): Record<string, unknown> {
  switch (kind) {
    case 'greeting':
      return { kind, prompt: 'Hello!' };
    case 'hours':
      return { kind, timezone: 'UTC', schedule: {} };
    case 'menu':
      return { kind, prompt: 'Press 1.', options: { '1': 'Option 1' } };
    case 'ring':
      return { kind, timeout_secs: 25 };
    case 'message':
      return { kind, prompt: 'Please leave a message after the tone.' };
    case 'transfer':
      return { kind, target: '' };
    case 'hangup':
      return { kind };
    // Opens with a plausible working week rather than an empty schedule:
    // `book`'s empty state is a node that can never offer anything, and
    // an author who has just added a booking step should hear the
    // validator complain about wiring, not about arithmetic.
    case 'book':
      return {
        kind,
        prompt: 'I can book you in. Here are the next available times.',
        confirm_prompt: "You're booked for",
        timezone: 'UTC',
        schedule: {
          mon: [{ open: '09:00', close: '17:00' }],
          tue: [{ open: '09:00', close: '17:00' }],
          wed: [{ open: '09:00', close: '17:00' }],
          thu: [{ open: '09:00', close: '17:00' }],
          fri: [{ open: '09:00', close: '17:00' }],
        },
        duration_mins: 30,
      };
  }
}
