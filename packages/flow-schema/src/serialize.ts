// The canonical text of a flow (docs/01-canonical-document.md §4).
//
// One document has one text, the same in every language: the Rust twin is
// `crates/wavekat-flow/src/canonical.rs`, and the corpus under
// `conformance/canonical/` pins both byte for byte. The emitter is written
// by hand, because YAML libraries choose layout and quoting their own way,
// and it is guided by the bundled schema: property order, which properties
// are required, and their defaults all come from there, so a schema change
// needs no change here.

import { flowV2Schema } from './generated/schema.js';
import type { Flow } from './model.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = { [key: string]: unknown };

const ROOT = flowV2Schema as unknown as Schema;

/** Follow `$ref` (and a single-entry `allOf`, the schema's way of putting
 * a default next to a ref) to the schema that describes a value. */
function resolve(s: Schema): Schema {
  for (;;) {
    const ref = s['$ref'];
    if (typeof ref === 'string') {
      const name = ref.replace(/^#\/\$defs\//, '');
      s = (ROOT['$defs'] as Record<string, Schema>)[name] as Schema;
      continue;
    }
    const allOf = s['allOf'];
    if (Array.isArray(allOf) && allOf.length === 1) {
      s = allOf[0] as Schema;
      continue;
    }
    return s;
  }
}

function isObject(v: unknown): v is { [key: string]: Json } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The schema for `value`, picking a `oneOf` branch: by `kind` for a node,
 * by JSON type otherwise (a text or audio prompt). */
export function describe(s: Schema | undefined, value: unknown): Schema | undefined {
  if (!s) return undefined;
  const resolved = resolve(s);
  const branches = resolved['oneOf'];
  if (!Array.isArray(branches)) return resolved;
  return (branches as Schema[]).map(resolve).find((b) => {
    const kind = (b['properties'] as Record<string, Schema> | undefined)?.['kind']?.['const'];
    if (kind !== undefined) return isObject(value) && value['kind'] === kind;
    switch (b['type']) {
      case 'string':
        return typeof value === 'string';
      case 'object':
        return isObject(value);
      case 'array':
        return Array.isArray(value);
      case 'integer':
      case 'number':
        return typeof value === 'number';
      case 'boolean':
        return typeof value === 'boolean';
      default:
        return false;
    }
  });
}

/** The root schema, for walkers outside this module. */
export function flowSchemaRoot(): Schema {
  return ROOT;
}

/** The canonical text of `flow`. */
export function serializeFlow(flow: Flow): string {
  const value = JSON.parse(JSON.stringify(flow)) as Json;
  const out: string[] = [];
  // The document, `nodes` and each node are block mappings, whatever they
  // hold.
  writeBlockMap(out, entries(value, ROOT), 0, 'document', false);
  return out.join('');
}

type Level = 'document' | 'nodes' | 'node' | 'other';

function child(level: Level, key: string): Level {
  if (level === 'document' && key === 'nodes') return 'nodes';
  if (level === 'nodes') return 'node';
  return 'other';
}

type Entry = [key: string, value: Json, schema: Schema | undefined];

/** A mapping's entries in canonical order, with omitted ones left out.
 * Object key order is already the canonical map order (§3): integer keys
 * first, ascending, then the rest as written. */
function entries(value: Json, s: Schema | undefined): Entry[] {
  const map = value as { [key: string]: Json };
  const described = describe(s, value);
  const props = described?.['properties'] as Record<string, Schema> | undefined;
  if (!props) {
    const extra = described?.['additionalProperties'];
    const items = isObject(extra) ? (extra as Schema) : undefined;
    return Object.entries(map).map(([k, v]) => [k, v, items]);
  }
  const required = (described?.['required'] as string[] | undefined) ?? [];
  const out: Entry[] = [];
  for (const [key, prop] of Object.entries(props)) {
    if (!Object.hasOwn(map, key)) continue;
    const v = map[key] as Json;
    if (!required.includes(key) && omitted(v, defaultOf(prop))) continue;
    out.push([key, v, prop]);
  }
  // Keys the schema doesn't know follow, in map order. (A decoded flow
  // never has any; this keeps the output defined for any input.)
  for (const [k, v] of Object.entries(map)) {
    if (!Object.hasOwn(props, k)) out.push([k, v, undefined]);
  }
  return out;
}

/** A property's `default`, looking through a single-entry `allOf`. */
function defaultOf(prop: Schema): unknown {
  if ('default' in prop) return prop['default'];
  const allOf = prop['allOf'];
  if (Array.isArray(allOf) && allOf.length > 0) return (allOf[0] as Schema)['default'];
  return undefined;
}

/** Is an optional property left out: absent, its default, or empty? */
function omitted(value: Json, fallback: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isObject(value)) return Object.keys(value).length === 0;
  return fallback !== undefined && value === fallback;
}

function isScalar(v: Json): boolean {
  return v === null || typeof v !== 'object';
}

/** Is a collection written in flow style? When every entry it writes
 * (after omissions) is a scalar. */
function isFlow(v: Json, s: Schema | undefined): boolean {
  if (Array.isArray(v)) return v.every(isScalar);
  if (isObject(v)) return entries(v, s).every(([, x]) => isScalar(x));
  return false;
}

function isEmpty(v: Json): boolean {
  if (Array.isArray(v)) return v.length === 0;
  if (isObject(v)) return Object.keys(v).length === 0;
  return false;
}

/** Write a block mapping at `indent`. When `onDashLine`, the first entry
 * continues the current `- ` line of a list item. */
function writeBlockMap(
  out: string[],
  list: Entry[],
  indent: number,
  level: Level,
  onDashLine: boolean,
): void {
  list.forEach(([key, value, s], i) => {
    if (i > 0 || !onDashLine) out.push(' '.repeat(indent));
    out.push(scalarString(key, false), ':');
    writeValue(out, value, s, indent, child(level, key));
  });
}

/** Write `value` after `key:`, then end the line. */
function writeValue(
  out: string[],
  value: Json,
  s: Schema | undefined,
  indent: number,
  level: Level,
): void {
  const alwaysBlock = level === 'nodes' || level === 'node';
  if (isObject(value) && isEmpty(value)) {
    out.push(' {}\n');
  } else if (Array.isArray(value) && value.length === 0) {
    out.push(' []\n');
  } else if (isObject(value) && (alwaysBlock || !isFlow(value, s))) {
    out.push('\n');
    writeBlockMap(out, entries(value, s), indent + 2, level, false);
  } else if (Array.isArray(value) && !isFlow(value, s)) {
    out.push('\n');
    writeBlockList(out, value, itemsOf(s), indent + 2);
  } else {
    out.push(' ');
    writeInline(out, value, s);
    out.push('\n');
  }
}

/** The schema of a list's items. */
function itemsOf(s: Schema | undefined): Schema | undefined {
  return s ? (resolve(s)['items'] as Schema | undefined) : undefined;
}

function writeBlockList(out: string[], items: Json[], s: Schema | undefined, indent: number): void {
  for (const item of items) {
    out.push(' '.repeat(indent));
    if (isObject(item) && !isEmpty(item) && !isFlow(item, s)) {
      out.push('- ');
      writeBlockMap(out, entries(item, s), indent + 2, 'other', true);
    } else if (Array.isArray(item) && item.length > 0 && !isFlow(item, s)) {
      out.push('-\n');
      writeBlockList(out, item, itemsOf(s), indent + 2);
    } else {
      out.push('- ');
      writeInline(out, item, s);
      out.push('\n');
    }
  }
}

/** A scalar, or a flow collection of scalars, on one line. */
function writeInline(out: string[], value: Json, s: Schema | undefined): void {
  if (isObject(value)) {
    if (isEmpty(value)) {
      out.push('{}');
      return;
    }
    out.push('{ ');
    entries(value, s).forEach(([k, v], i) => {
      if (i > 0) out.push(', ');
      out.push(scalarString(k, true), ': ', scalarText(v, true));
    });
    out.push(' }');
  } else if (Array.isArray(value)) {
    out.push('[', value.map((v) => scalarText(v, true)).join(', '), ']');
  } else {
    out.push(scalarText(value, false));
  }
}

function scalarText(value: Json, flow: boolean): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return scalarString(value, flow);
  throw new Error('only scalars are written inline');
}

/** Words some YAML readers take for booleans, null or numbers. */
const RESERVED = new Set([
  'true', 'false', 'yes', 'no', 'on', 'off', 'y', 'n', 'null', 'inf', 'nan', 'infinity',
]);

/** Code points a double-quoted string writes as `\uXXXX`. Lone surrogates
 * (possible only in JavaScript strings) are escaped too. */
function needsUnicodeEscape(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0xfeff ||
    (cp >= 0xd800 && cp <= 0xdfff)
  );
}

/** Can `s` be written as a plain scalar (§4)? */
export function isPlain(s: string, flow: boolean): boolean {
  const first = s.codePointAt(0);
  if (first === undefined) return false;
  const firstOk =
    (first >= 0x41 && first <= 0x5a) ||
    (first >= 0x61 && first <= 0x7a) ||
    first === 0x5f || // _
    first === 0x2f || // /
    first > 0x7f;
  if (!firstOk) return false;
  if (s.endsWith(' ') || s.endsWith(':')) return false;
  if (s.includes(': ') || s.includes(' #')) return false;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x09 || needsUnicodeEscape(cp)) return false;
  }
  if (flow && /[,[\]{}:]/.test(s)) return false;
  return !RESERVED.has(s.replace(/[A-Z]/g, (c) => c.toLowerCase()));
}

const ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\n': '\\n',
  '\t': '\\t',
  '\r': '\\r',
  '\b': '\\b',
  '\f': '\\f',
};

/** `s` as a plain scalar when it can be one, double-quoted otherwise. */
export function scalarString(s: string, flow: boolean): string {
  if (isPlain(s, flow)) return s;
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    const named = ESCAPES[ch];
    if (named !== undefined) out += named;
    else if (needsUnicodeEscape(cp)) out += `\\u${cp.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}
