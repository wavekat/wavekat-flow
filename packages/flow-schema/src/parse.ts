// Safe-subset YAML parsing + decoding into the typed flow model — the
// TypeScript twin of the Rust engine's `Flow::from_yaml` (serde). The
// YAML footguns doc 48 fences off are rejected here: duplicate keys
// (at any nesting level), anchors, aliases, and explicit tags all fail
// loudly instead of silently changing meaning. Every schema-typed
// string is checked as a string after parse, so implicit-typing
// surprises (`no` → boolean, unquoted `1:` menu digits → integer keys)
// are errors, not silent coercions.
//
// Divergence from the Rust twin, on purpose: unknown fields are
// *warnings* here (serde silently ignores them). A typo'd field name
// the engine would never read is exactly what an editor should point
// at; warnings don't block publish, so both sides still accept the
// same set of documents.

import { isMap, isScalar, isSeq, parseDocument, visit } from 'yaml';
import type { Pair, Scalar, YAMLMap } from 'yaml';

import type {
  Component,
  Flow,
  FlowNode,
  HoursException,
  MessageTone,
  Prompt,
  TimeRange,
  Weekday,
  WeeklySchedule,
} from './model.js';
import {
  DEFAULT_BOOK_BUFFER_MINS,
  DEFAULT_BOOK_HORIZON_DAYS,
  DEFAULT_BOOK_LEAD_MINS,
  DEFAULT_BOOK_MAX_OFFERS,
  DEFAULT_BOOK_RETRIES,
  DEFAULT_BOOK_TIMEOUT_SECS,
} from './book.js';
import {
  COMPONENT_KINDS,
  DEFAULT_MENU_RETRIES,
  DEFAULT_MENU_TIMEOUT_SECS,
  DEFAULT_MESSAGE_MAX_SECS,
  DEFAULT_MESSAGE_TONE,
  MESSAGE_TONES,
  WEEKDAYS,
} from './model.js';
import type { Issue } from './issues.js';
import { hasErrors } from './issues.js';

export type ParseResult = {
  /** The decoded document, or `null` when it failed to parse/decode. */
  flow: Flow | null;
  issues: Issue[];
  /** Source range of each node's definition, for editor highlighting. */
  nodeRanges: Record<string, [number, number]>;
};

type Field = { key: Scalar; value: unknown };

function rangeOf(node: unknown): [number, number] | undefined {
  const r = (node as { range?: [number, number, number] | null } | null | undefined)?.range;
  return r ? [r[0], r[1]] : undefined;
}

function error(issues: Issue[], code: string, message: string, at?: unknown): void {
  issues.push({ severity: 'error', code, message, range: rangeOf(at) });
}

function warning(issues: Issue[], code: string, message: string, at?: unknown): void {
  issues.push({ severity: 'warning', code, message, range: rangeOf(at) });
}

/**
 * The string-keyed fields of a mapping. Non-string keys (an unquoted
 * `1:` menu digit parses as an integer) are schema errors — the Rust
 * side's `BTreeMap<String, _>` rejects them the same way.
 */
function fieldsOf(map: YAMLMap, context: string, issues: Issue[]): Map<string, Field> {
  const out = new Map<string, Field>();
  for (const pair of map.items as Pair[]) {
    const key = pair.key;
    if (!isScalar(key) || typeof key.value !== 'string') {
      error(
        issues,
        'non_string_key',
        `${context}: mapping keys must be strings (quote digits: "1")`,
        key ?? map,
      );
      continue;
    }
    out.set(key.value, { key, value: pair.value });
  }
  return out;
}

function asString(value: unknown, label: string, issues: Issue[]): string | undefined {
  if (isScalar(value) && typeof value.value === 'string') return value.value;
  error(issues, 'expected_string', `${label} must be a string`, value);
  return undefined;
}

function asU32(value: unknown, label: string, issues: Issue[]): number | undefined {
  if (
    isScalar(value) &&
    typeof value.value === 'number' &&
    Number.isInteger(value.value) &&
    value.value >= 0 &&
    value.value <= 0xffff_ffff
  ) {
    return value.value;
  }
  error(issues, 'expected_integer', `${label} must be a non-negative integer`, value);
  return undefined;
}

function asBool(value: unknown, label: string, issues: Issue[]): boolean | undefined {
  if (isScalar(value) && typeof value.value === 'boolean') return value.value;
  error(issues, 'expected_boolean', `${label} must be true or false`, value);
  return undefined;
}

function required(
  fields: Map<string, Field>,
  name: string,
  context: string,
  issues: Issue[],
  at: unknown,
): Field | undefined {
  const field = fields.get(name);
  if (!field) error(issues, 'missing_field', `${context} is missing "${name}"`, at);
  return field;
}

function warnUnknownFields(
  fields: Map<string, Field>,
  known: readonly string[],
  context: string,
  issues: Issue[],
): void {
  for (const [name, field] of fields) {
    if (!known.includes(name)) {
      warning(
        issues,
        'unknown_field',
        `${context}: unknown field "${name}" is ignored by the engine`,
        field.key,
      );
    }
  }
}

function decodePrompt(value: unknown, label: string, issues: Issue[]): Prompt | undefined {
  if (isScalar(value) && typeof value.value === 'string') return value.value;
  if (isMap(value)) {
    const fields = fieldsOf(value, label, issues);
    // `transcript` is the words the clip speaks, carried for display and
    // traces (model `Audio.transcript`); advisory only — playback still uses
    // `audio`. Known here so it neither warns nor gets dropped on decode.
    warnUnknownFields(fields, ['audio', 'transcript'], label, issues);
    const audio = fields.get('audio');
    if (audio) {
      const ref = asString(audio.value, `${label} audio`, issues);
      if (ref === undefined) return undefined;
      const transcriptField = fields.get('transcript');
      if (!transcriptField) return { audio: ref };
      const transcript = asString(transcriptField.value, `${label} transcript`, issues);
      return transcript === undefined ? undefined : { audio: ref, transcript };
    }
  }
  error(issues, 'bad_prompt', `${label} must be text or { audio: ref }`, value);
  return undefined;
}

function decodeRange(value: unknown, context: string, issues: Issue[]): TimeRange | undefined {
  if (!isMap(value)) {
    error(issues, 'expected_map', `${context} must be a { open, close } mapping`, value);
    return undefined;
  }
  const fields = fieldsOf(value, context, issues);
  warnUnknownFields(fields, ['open', 'close'], context, issues);
  const open = required(fields, 'open', context, issues, value);
  const close = required(fields, 'close', context, issues, value);
  const openValue = open && asString(open.value, `${context} open`, issues);
  const closeValue = close && asString(close.value, `${context} close`, issues);
  if (openValue === undefined || closeValue === undefined) return undefined;
  return { open: openValue, close: closeValue };
}

function decodeSchedule(value: unknown, node: string, issues: Issue[]): WeeklySchedule | undefined {
  if (!isMap(value)) {
    error(issues, 'expected_map', `node "${node}" schedule must be a mapping of weekdays`, value);
    return undefined;
  }
  const fields = fieldsOf(value, `node "${node}" schedule`, issues);
  const schedule: WeeklySchedule = {};
  for (const [name, field] of fields) {
    if (!(WEEKDAYS as readonly string[]).includes(name)) {
      warning(
        issues,
        'unknown_field',
        `node "${node}" schedule: unknown day "${name}" is ignored (use mon…sun)`,
        field.key,
      );
      continue;
    }
    if (!isSeq(field.value)) {
      error(
        issues,
        'expected_list',
        `node "${node}" schedule ${name} must be a list of { open, close } ranges`,
        field.value,
      );
      continue;
    }
    const ranges: TimeRange[] = [];
    for (const item of field.value.items) {
      const range = decodeRange(item, `node "${node}" schedule ${name}`, issues);
      if (range) ranges.push(range);
    }
    schedule[name as Weekday] = ranges;
  }
  return schedule;
}

function decodeExceptions(
  value: unknown,
  node: string,
  issues: Issue[],
): HoursException[] | undefined {
  if (!isSeq(value)) {
    error(issues, 'expected_list', `node "${node}" exceptions must be a list`, value);
    return undefined;
  }
  const exceptions: HoursException[] = [];
  for (const item of value.items) {
    const context = `node "${node}" exception`;
    if (!isMap(item)) {
      error(issues, 'expected_map', `${context} must be a mapping`, item);
      continue;
    }
    const fields = fieldsOf(item, context, issues);
    warnUnknownFields(fields, ['date', 'closed', 'ranges'], context, issues);
    const dateField = required(fields, 'date', context, issues, item);
    const date = dateField && asString(dateField.value, `${context} date`, issues);
    const closedField = fields.get('closed');
    const closed = closedField ? asBool(closedField.value, `${context} closed`, issues) : false;
    const rangesField = fields.get('ranges');
    let ranges: TimeRange[] = [];
    if (rangesField) {
      if (!isSeq(rangesField.value)) {
        error(issues, 'expected_list', `${context} ranges must be a list`, rangesField.value);
      } else {
        for (const rangeItem of rangesField.value.items) {
          const range = decodeRange(rangeItem, `${context} range`, issues);
          if (range) ranges.push(range);
        }
      }
    }
    if (date !== undefined && closed !== undefined) {
      exceptions.push({ date, closed, ranges });
    }
  }
  return exceptions;
}

const NODE_CONFIG_FIELDS: Record<string, readonly string[]> = {
  greeting: ['prompt'],
  hours: ['schedule', 'timezone', 'exceptions'],
  menu: ['prompt', 'options', 'retries', 'timeout_secs'],
  ring: ['timeout_secs'],
  message: ['prompt', 'max_secs', 'tone'],
  transfer: ['target'],
  hangup: ['prompt'],
  book: [
    'prompt',
    'confirm_prompt',
    'schedule',
    'timezone',
    'exceptions',
    'duration_mins',
    'buffer_mins',
    'lead_mins',
    'horizon_days',
    'max_offers',
    'retries',
    'timeout_secs',
  ],
};

function decodeComponent(
  kind: string,
  id: string,
  fields: Map<string, Field>,
  at: unknown,
  issues: Issue[],
): Component | undefined {
  const context = `node "${id}"`;
  const reqPrompt = (): Prompt | undefined => {
    const field = required(fields, 'prompt', context, issues, at);
    return field && decodePrompt(field.value, `${context} prompt`, issues);
  };
  switch (kind) {
    case 'greeting': {
      const prompt = reqPrompt();
      return prompt === undefined ? undefined : { kind, prompt };
    }
    case 'hours': {
      const timezoneField = required(fields, 'timezone', context, issues, at);
      const timezone = timezoneField && asString(timezoneField.value, `${context} timezone`, issues);
      const scheduleField = required(fields, 'schedule', context, issues, at);
      const schedule = scheduleField && decodeSchedule(scheduleField.value, id, issues);
      const exceptionsField = fields.get('exceptions');
      const exceptions = exceptionsField
        ? decodeExceptions(exceptionsField.value, id, issues)
        : [];
      if (timezone === undefined || schedule === undefined || exceptions === undefined) {
        return undefined;
      }
      return { kind, schedule, timezone, exceptions };
    }
    case 'menu': {
      const prompt = reqPrompt();
      const optionsField = required(fields, 'options', context, issues, at);
      let options: Record<string, string> | undefined;
      if (optionsField) {
        if (!isMap(optionsField.value)) {
          error(issues, 'expected_map', `${context} options must be a mapping`, optionsField.value);
        } else {
          options = {};
          for (const [digit, field] of fieldsOf(
            optionsField.value,
            `${context} options`,
            issues,
          )) {
            const label = asString(field.value, `${context} option "${digit}" label`, issues);
            if (label !== undefined) options[digit] = label;
          }
        }
      }
      const retriesField = fields.get('retries');
      const retries = retriesField
        ? asU32(retriesField.value, `${context} retries`, issues)
        : DEFAULT_MENU_RETRIES;
      const timeoutField = fields.get('timeout_secs');
      const timeout = timeoutField
        ? asU32(timeoutField.value, `${context} timeout_secs`, issues)
        : DEFAULT_MENU_TIMEOUT_SECS;
      if (
        prompt === undefined ||
        options === undefined ||
        retries === undefined ||
        timeout === undefined
      ) {
        return undefined;
      }
      return { kind, prompt, options, retries, timeout_secs: timeout };
    }
    case 'ring': {
      const timeoutField = required(fields, 'timeout_secs', context, issues, at);
      const timeout = timeoutField && asU32(timeoutField.value, `${context} timeout_secs`, issues);
      return timeout === undefined ? undefined : { kind, timeout_secs: timeout };
    }
    case 'message': {
      const prompt = reqPrompt();
      const maxField = fields.get('max_secs');
      const maxSecs = maxField
        ? asU32(maxField.value, `${context} max_secs`, issues)
        : DEFAULT_MESSAGE_MAX_SECS;
      // A closed enum, like the Rust twin: an unknown cue style is an
      // error, not a silent fallback to the beep.
      const toneField = fields.get('tone');
      let tone: MessageTone | undefined = DEFAULT_MESSAGE_TONE;
      if (toneField) {
        const raw = asString(toneField.value, `${context} tone`, issues);
        if (raw === undefined) {
          tone = undefined;
        } else if ((MESSAGE_TONES as readonly string[]).includes(raw)) {
          tone = raw as MessageTone;
        } else {
          error(
            issues,
            'bad_tone',
            `${context} tone must be one of: ${MESSAGE_TONES.join(', ')}`,
            toneField.value,
          );
          tone = undefined;
        }
      }
      if (prompt === undefined || maxSecs === undefined || tone === undefined) return undefined;
      return { kind, prompt, max_secs: maxSecs, tone };
    }
    case 'transfer': {
      const targetField = required(fields, 'target', context, issues, at);
      const target = targetField && asString(targetField.value, `${context} target`, issues);
      return target === undefined ? undefined : { kind, target };
    }
    case 'hangup': {
      const promptField = fields.get('prompt');
      if (!promptField) return { kind };
      const prompt = decodePrompt(promptField.value, `${context} prompt`, issues);
      return prompt === undefined ? undefined : { kind, prompt };
    }
    case 'book': {
      const prompt = reqPrompt();
      const confirmField = required(fields, 'confirm_prompt', context, issues, at);
      const confirmPrompt =
        confirmField && decodePrompt(confirmField.value, `${context} confirm_prompt`, issues);

      const timezoneField = required(fields, 'timezone', context, issues, at);
      const timezone = timezoneField && asString(timezoneField.value, `${context} timezone`, issues);
      const scheduleField = required(fields, 'schedule', context, issues, at);
      const schedule = scheduleField && decodeSchedule(scheduleField.value, id, issues);
      const exceptionsField = fields.get('exceptions');
      const exceptions = exceptionsField ? decodeExceptions(exceptionsField.value, id, issues) : [];

      const durationField = required(fields, 'duration_mins', context, issues, at);
      const duration =
        durationField && asU32(durationField.value, `${context} duration_mins`, issues);

      // Every remaining number is optional with a documented default —
      // a missing one is not a defect, a malformed one is.
      const optionalU32 = (name: string, fallback: number): number | undefined => {
        const field = fields.get(name);
        return field ? asU32(field.value, `${context} ${name}`, issues) : fallback;
      };
      const buffer = optionalU32('buffer_mins', DEFAULT_BOOK_BUFFER_MINS);
      const lead = optionalU32('lead_mins', DEFAULT_BOOK_LEAD_MINS);
      const horizon = optionalU32('horizon_days', DEFAULT_BOOK_HORIZON_DAYS);
      const maxOffers = optionalU32('max_offers', DEFAULT_BOOK_MAX_OFFERS);
      const retries = optionalU32('retries', DEFAULT_BOOK_RETRIES);
      const timeout = optionalU32('timeout_secs', DEFAULT_BOOK_TIMEOUT_SECS);

      if (
        prompt === undefined ||
        confirmPrompt === undefined ||
        timezone === undefined ||
        schedule === undefined ||
        exceptions === undefined ||
        duration === undefined ||
        buffer === undefined ||
        lead === undefined ||
        horizon === undefined ||
        maxOffers === undefined ||
        retries === undefined ||
        timeout === undefined
      ) {
        return undefined;
      }
      return {
        kind,
        prompt,
        confirm_prompt: confirmPrompt,
        schedule,
        timezone,
        exceptions,
        duration_mins: duration,
        buffer_mins: buffer,
        lead_mins: lead,
        horizon_days: horizon,
        max_offers: maxOffers,
        retries,
        timeout_secs: timeout,
      };
    }
    default:
      return undefined;
  }
}

function decodeNode(id: string, value: unknown, issues: Issue[]): FlowNode | undefined {
  if (!isMap(value)) {
    error(issues, 'expected_map', `node "${id}" must be a mapping`, value);
    return undefined;
  }
  const context = `node "${id}"`;
  const fields = fieldsOf(value, context, issues);

  const kindField = required(fields, 'kind', context, issues, value);
  const kind = kindField && asString(kindField.value, `${context} kind`, issues);
  if (kind === undefined) return undefined;
  if (!(COMPONENT_KINDS as readonly string[]).includes(kind)) {
    error(
      issues,
      'unknown_kind',
      `${context} has unknown kind "${kind}" (expected one of: ${COMPONENT_KINDS.join(', ')})`,
      kindField?.value,
    );
    return undefined;
  }

  warnUnknownFields(
    fields,
    ['kind', 'exits', ...(NODE_CONFIG_FIELDS[kind] ?? [])],
    context,
    issues,
  );

  const exits: Record<string, string> = {};
  const exitsField = fields.get('exits');
  if (exitsField) {
    if (!isMap(exitsField.value)) {
      error(issues, 'expected_map', `${context} exits must be a mapping`, exitsField.value);
      return undefined;
    }
    for (const [name, field] of fieldsOf(exitsField.value, `${context} exits`, issues)) {
      const target = asString(field.value, `${context} exit "${name}" target`, issues);
      if (target !== undefined) exits[name] = target;
    }
  }

  const component = decodeComponent(kind, id, fields, value, issues);
  return component === undefined ? undefined : { ...component, exits };
}

/**
 * Parse a flow document from YAML text. Parsing does **not** check
 * semantics (reachability, exit wiring, …) — that's `validateFlow`;
 * `checkFlow` runs both.
 */
export function parseFlow(source: string): ParseResult {
  const issues: Issue[] = [];
  const nodeRanges: Record<string, [number, number]> = {};
  const doc = parseDocument(source);

  for (const err of doc.errors) {
    issues.push({
      severity: 'error',
      code: 'yaml_error',
      message: err.message.split('\n')[0] ?? err.message,
      range: err.pos.length ? [err.pos[0] ?? 0, err.pos[1] ?? 0] : undefined,
    });
  }
  // The yaml library downgrades some problems (an unresolved `!tag`,
  // …) to warnings; in the safe subset they are errors.
  for (const warn of doc.warnings) {
    issues.push({
      severity: 'error',
      code: 'yaml_unsupported',
      message: warn.message.split('\n')[0] ?? warn.message,
      range: warn.pos.length ? [warn.pos[0] ?? 0, warn.pos[1] ?? 0] : undefined,
    });
  }
  const rejectUnsafe = (node: { anchor?: string; tag?: string }): void => {
    if (node.anchor !== undefined) {
      error(issues, 'anchor_not_allowed', 'anchors are not allowed in flow documents', node);
    }
    if (node.tag !== undefined) {
      error(issues, 'tag_not_allowed', 'tags are not allowed in flow documents', node);
    }
  };
  visit(doc, {
    Alias(_key, node) {
      error(issues, 'alias_not_allowed', 'aliases are not allowed in flow documents', node);
    },
    Scalar: (_key, node) => rejectUnsafe(node),
    Map: (_key, node) => rejectUnsafe(node),
    Seq: (_key, node) => rejectUnsafe(node),
  });
  if (hasErrors(issues)) return { flow: null, issues, nodeRanges };

  const root = doc.contents;
  if (!isMap(root)) {
    error(issues, 'expected_map', 'the flow document must be a YAML mapping', root);
    return { flow: null, issues, nodeRanges };
  }

  const errorsBeforeDecode = issues.filter((issue) => issue.severity === 'error').length;
  const fields = fieldsOf(root, 'flow document', issues);
  warnUnknownFields(
    fields,
    ['schema_version', 'id', 'name', 'version', 'entry', 'nodes', 'ui'],
    'flow document',
    issues,
  );

  const schemaVersionField = required(fields, 'schema_version', 'flow document', issues, root);
  const schemaVersion =
    schemaVersionField && asU32(schemaVersionField.value, 'schema_version', issues);
  const idField = required(fields, 'id', 'flow document', issues, root);
  const id = idField && asString(idField.value, 'id', issues);
  const nameField = required(fields, 'name', 'flow document', issues, root);
  const name = nameField && asString(nameField.value, 'name', issues);
  const versionField = fields.get('version');
  const version = versionField ? asU32(versionField.value, 'version', issues) : 1;
  const entryField = required(fields, 'entry', 'flow document', issues, root);
  const entry = entryField && asString(entryField.value, 'entry', issues);

  const nodes: Record<string, FlowNode> = {};
  const nodesField = required(fields, 'nodes', 'flow document', issues, root);
  if (nodesField) {
    if (!isMap(nodesField.value)) {
      error(issues, 'expected_map', '"nodes" must be a mapping of node ids', nodesField.value);
    } else {
      for (const [nodeId, field] of fieldsOf(nodesField.value, 'nodes', issues)) {
        const keyRange = rangeOf(field.key);
        const valueRange = rangeOf(field.value);
        if (keyRange) nodeRanges[nodeId] = [keyRange[0], valueRange?.[1] ?? keyRange[1]];
        const node = decodeNode(nodeId, field.value, issues);
        if (node) nodes[nodeId] = node;
      }
    }
  }

  const uiField = fields.get('ui');
  const ui = uiField
    ? (uiField.value as { toJSON?: () => unknown } | null)?.toJSON?.()
    : undefined;

  const decodeFailed =
    issues.filter((issue) => issue.severity === 'error').length > errorsBeforeDecode;
  if (
    decodeFailed ||
    schemaVersion === undefined ||
    id === undefined ||
    name === undefined ||
    version === undefined ||
    entry === undefined
  ) {
    return { flow: null, issues, nodeRanges };
  }

  return {
    flow: {
      // `schema_version` and `ui` are cast to the generated `Flow` shape:
      // the generated type pins `schema_version: 1` and `ui: {…}`, but the
      // parser must be able to *represent* an out-of-range version (so
      // `validateFlow` can reject it) and an arbitrary decoded `ui` blob.
      schema_version: schemaVersion as Flow['schema_version'],
      id,
      name,
      version,
      entry,
      nodes,
      ui: ui as Flow['ui'],
    },
    issues,
    nodeRanges,
  };
}
