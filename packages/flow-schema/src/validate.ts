// Publish-time validation — the platform-side gate that keeps a bad
// document from ever becoming a live phone line (doc 48). The daemon
// re-runs the same checks on load (`crates/wavekat-flow/validate.rs`),
// so a corrupted cache or version mismatch fails safe. Keep the two in
// lockstep: every rule here has a Rust twin, and both are pinned by the
// shared conformance corpus.
//
// Structural guarantees: the schema version is one the engine runs;
// every exit is wired to an existing node and matches the component's
// exit set; every node is reachable from `entry`; **no caller can be
// trapped** — every reachable node can reach a terminal; prompt-length
// and menu/hours sanity caps. All problems are collected (not
// fail-fast) so the editor can show every one at once.

import type { BookNode, ComponentKind, Flow, Node, Prompt, TransferNode } from './model.js';
import {
  DEFAULT_VARIABLE_MAX_LEN,
  KIND_MIN_SCHEMA_VERSION,
  MAX_PROMPT_CHARS,
  MAX_VARIABLE_LEN,
  MAX_TRANSFER_TIMEOUT_SECS,
  MIN_TRANSFER_TIMEOUT_SECS,
  SUPPORTED_SCHEMA_VERSIONS,
  TRANSFER_FIELDS_MIN_SCHEMA_VERSION,
  TEMPLATE_MIN_SCHEMA_VERSION,
  VARIABLES_MIN_SCHEMA_VERSION,
  hasVariables,
  VALID_DIGITS,
  isScreenedTransfer,
  isTerminal,
  nodePromptSlots,
  nodePrompts,
  promptTemplate,
  promptText,
  requiredExits,
} from './model.js';
import {
  DEFAULT_BOOK_BUFFER_MINS,
  DEFAULT_BOOK_HORIZON_DAYS,
  DEFAULT_BOOK_LEAD_MINS,
  DEFAULT_BOOK_MAX_OFFERS,
  MAX_BOOK_BUFFER_MINS,
  MAX_BOOK_DURATION_MINS,
  MAX_BOOK_HORIZON_DAYS,
  MAX_BOOK_LEAD_MINS,
  MAX_BOOK_OFFERS,
  MIN_BOOK_DURATION_MINS,
  bookVocabularyRefs,
  parseBookVocabularyRef,
} from './book.js';
import type { Issue } from './issues.js';
import { isVariableName, templateNames, tryParseTemplate } from './vars.js';
import { validateHours } from './hours.js';

type NodeRanges = Record<string, [number, number]>;

/**
 * Validate a parsed flow. An empty result means safe to publish;
 * otherwise every problem found, each pointing at its node (and its
 * source range when `nodeRanges` from `parseFlow` is provided).
 */
export function validateFlow(flow: Flow, nodeRanges: NodeRanges = {}): Issue[] {
  const issues: Issue[] = [];
  const at = (node: string): Pick<Issue, 'severity' | 'node' | 'range'> => ({
    severity: 'error',
    node,
    range: nodeRanges[node],
  });

  if (!SUPPORTED_SCHEMA_VERSIONS.includes(flow.schema_version)) {
    issues.push({
      severity: 'error',
      code: 'unsupported_schema_version',
      message: `schema_version ${flow.schema_version} is not supported`,
      params: { version: flow.schema_version },
    });
  }

  // Flow-level, so it carries no node. Same code as a transfer field on an
  // older document: the field needs a newer version than the one declared.
  if (hasVariables(flow) && flow.schema_version < VARIABLES_MIN_SCHEMA_VERSION) {
    issues.push({
      severity: 'error',
      code: 'field_requires_newer_schema',
      message: `variables needs schema_version ${VARIABLES_MIN_SCHEMA_VERSION} (this document declares ${flow.schema_version})`,
      params: {
        field: 'variables',
        required: VARIABLES_MIN_SCHEMA_VERSION,
        declared: flow.schema_version,
      },
    });
  }

  const mentioned = new Set<string>();
  checkVariables(flow, issues);

  const nodeIds = Object.keys(flow.nodes);
  if (nodeIds.length === 0) {
    issues.push({
      severity: 'error',
      code: 'empty_flow',
      message: 'flow has no nodes',
    });
    return issues; // graph checks below would be meaningless
  }

  const entryExists = flow.entry in flow.nodes;
  if (!entryExists) {
    issues.push({
      severity: 'error',
      code: 'missing_entry',
      message: `entry "${flow.entry}" is not a node`,
      params: { entry: flow.entry },
    });
  }

  for (const [id, node] of Object.entries(flow.nodes)) {
    const exits = node.exits ?? {};
    // Exit keys must be exactly the set the component defines, and
    // every target must exist.
    const requiredNames = new Set(requiredExits(node));
    const presentNames = new Set(Object.keys(exits));
    const missing = [...requiredNames].filter((name) => !presentNames.has(name)).sort();
    if (missing.length > 0) {
      issues.push({
        ...at(id),
        code: 'missing_exits',
        message: `node "${id}" (${node.kind}) is missing required exits: ${missing.join(', ')}`,
        params: { kind: node.kind, missing },
      });
    }
    const unexpected = [...presentNames].filter((name) => !requiredNames.has(name)).sort();
    if (unexpected.length > 0) {
      issues.push({
        ...at(id),
        code: 'unexpected_exits',
        message: `node "${id}" (${node.kind}) has exits it does not define: ${unexpected.join(', ')}`,
        params: { kind: node.kind, unexpected },
      });
    }
    for (const [exit, target] of Object.entries(exits)) {
      if (!(target in flow.nodes)) {
        issues.push({
          ...at(id),
          // NOTE: code is `unknown_target` to match the frozen conformance
          // corpus (conformance/v1/invalid/dangling-exit). The platform's
          // pre-consolidation copy emitted `unknown_exit_target`; the corpus
          // is authoritative, so the code is reconciled here.
          code: 'unknown_target',
          message: `node "${id}" exit "${exit}" points at "${target}", which is not a node`,
          params: { exit, target },
        });
      }
    }

    // Per-component config sanity.
    switch (node.kind) {
      case 'greeting':
      case 'message':
        checkPrompt(id, node.prompt, issues, at);
        break;
      case 'menu': {
        checkPrompt(id, node.prompt, issues, at);
        const digits = Object.keys(node.options);
        if (digits.length === 0) {
          issues.push({
            ...at(id),
            code: 'empty_menu',
            message: `menu node "${id}" offers no options`,
          });
        }
        for (const digit of digits) {
          if (!VALID_DIGITS.includes(digit)) {
            issues.push({
              ...at(id),
              code: 'bad_digit',
              message: `menu node "${id}" option key "${digit}" is not a DTMF digit (0-9, *, #)`,
              params: { key: digit },
            });
          }
        }
        break;
      }
      case 'hours':
        issues.push(
          ...validateHours(id, node.schedule, node.timezone, node.exceptions ?? []).map(
            (issue) => ({
              ...issue,
              range: nodeRanges[id],
            }),
          ),
        );
        break;
      case 'transfer':
        if (node.target.trim() === '') {
          issues.push({
            ...at(id),
            code: 'empty_transfer_target',
            message: `transfer node "${id}" has an empty target`,
          });
        }
        checkTransferFields(id, node, flow.schema_version, issues, at);
        break;
      case 'hangup':
        if (node.prompt !== undefined) checkPrompt(id, node.prompt, issues, at);
        break;
      case 'book':
        checkPrompt(id, node.prompt, issues, at);
        checkPrompt(id, node.confirm_prompt, issues, at);
        issues.push(
          ...validateHours(id, node.schedule, node.timezone, node.exceptions ?? []).map(
            (issue) => ({
              ...issue,
              range: nodeRanges[id],
            }),
          ),
        );
        checkBookBounds(id, node, issues, at);
        break;
      case 'ring':
        break;
    }

    if (
      flow.schema_version < TEMPLATE_MIN_SCHEMA_VERSION &&
      nodePrompts(node).some((p) => promptTemplate(p) !== null)
    ) {
      issues.push({
        ...at(id),
        code: 'field_requires_newer_schema',
        message: `node "${id}" gives a prompt a template, which needs schema_version ${TEMPLATE_MIN_SCHEMA_VERSION} (this document declares ${flow.schema_version})`,
        params: {
          field: 'template',
          required: TEMPLATE_MIN_SCHEMA_VERSION,
          declared: flow.schema_version,
        },
      });
    }
    checkPlaceholders(id, node, flow, issues, at, mentioned);

    // A component the document's own version doesn't have. Checked per
    // node rather than once per flow so the editor points at the step
    // that has to change, and separate from `unknown_kind` (which a
    // build that predates the component reports for the same document)
    // because the fix is different: bump the version, not fix the typo.
    const minVersion = KIND_MIN_SCHEMA_VERSION[node.kind as ComponentKind];
    if (minVersion !== undefined && flow.schema_version < minVersion) {
      issues.push({
        ...at(id),
        code: 'kind_requires_newer_schema',
        message: `node "${id}" is a ${node.kind} step, which needs schema_version ${minVersion} (this document declares ${flow.schema_version})`,
        params: {
          kind: node.kind,
          required: minVersion,
          declared: flow.schema_version,
        },
      });
    }
  }

  // Reachability and trap analysis need a real entry to walk from.
  // TS-only: a declared variable no placeholder mentions is dead weight.
  if (flow.schema_version >= VARIABLES_MIN_SCHEMA_VERSION) {
    for (const name of Object.keys(flow.variables ?? {})) {
      if (!mentioned.has(name)) {
        issues.push({
          severity: 'warning',
          code: 'unused_variable',
          message: `variable "${name}" is declared but no prompt or menu label uses it`,
          params: { name },
        });
      }
    }
  }

  if (entryExists) checkGraph(flow, issues, at);

  return issues;
}

/**
 * What a `transfer` may say about screening: the whisper is a prompt like
 * any other, `timeout_secs` means nothing without one and is bounded, and
 * both need a document that declares a version that has them.
 */
function checkTransferFields(
  id: string,
  node: TransferNode,
  declared: number,
  issues: Issue[],
  at: (node: string) => Pick<Issue, 'severity' | 'node' | 'range'>,
): void {
  if (node.whisper !== undefined) checkPrompt(id, node.whisper, issues, at);
  const timeout = node.timeout_secs;
  if (timeout !== undefined) {
    if (node.whisper === undefined) {
      issues.push({
        ...at(id),
        code: 'timeout_without_whisper',
        message: `transfer node "${id}" sets timeout_secs but has no whisper to screen with`,
      });
    }
    if (timeout < MIN_TRANSFER_TIMEOUT_SECS || timeout > MAX_TRANSFER_TIMEOUT_SECS) {
      issues.push({
        ...at(id),
        code: 'transfer_timeout_out_of_range',
        message: `transfer node "${id}" timeout_secs is ${timeout} (allowed: ${MIN_TRANSFER_TIMEOUT_SECS}–${MAX_TRANSFER_TIMEOUT_SECS})`,
        params: {
          value: timeout,
          min: MIN_TRANSFER_TIMEOUT_SECS,
          max: MAX_TRANSFER_TIMEOUT_SECS,
        },
      });
    }
  }
  if (declared < TRANSFER_FIELDS_MIN_SCHEMA_VERSION) {
    for (const field of ['whisper', 'timeout_secs'] as const) {
      if (node[field] === undefined) continue;
      issues.push({
        ...at(id),
        code: 'field_requires_newer_schema',
        message: `transfer node "${id}" sets ${field}, which needs schema_version ${TRANSFER_FIELDS_MIN_SCHEMA_VERSION} (this document declares ${declared})`,
        params: {
          field,
          required: TRANSFER_FIELDS_MIN_SCHEMA_VERSION,
          declared,
        },
      });
    }
  }
}

/**
 * The `book` node's numeric bounds, and the one structural question a
 * schedule can fail: whether it leaves room for a single appointment.
 *
 * A node that can never offer anything is worth an error rather than a
 * shrug — "we're open 9:00 to 9:30 and appointments run an hour" is a
 * flow whose every caller falls out the `no_slots` exit, and the author
 * will read that as a broken calendar connection, not as arithmetic.
 * `bookVocabularyRefs` answers it for free: no time refs, no times.
 */
function checkBookBounds(
  id: string,
  node: BookNode,
  issues: Issue[],
  at: (node: string) => Pick<Issue, 'severity' | 'node' | 'range'>,
): void {
  const range = (field: string, value: number, min: number, max: number): void => {
    if (value < min || value > max) {
      issues.push({
        ...at(id),
        code: 'book_out_of_range',
        message: `book node "${id}" ${field} is ${value} (allowed: ${min}–${max})`,
        params: { field, value, min, max },
      });
    }
  };

  range('duration_mins', node.duration_mins, MIN_BOOK_DURATION_MINS, MAX_BOOK_DURATION_MINS);
  range('buffer_mins', node.buffer_mins ?? DEFAULT_BOOK_BUFFER_MINS, 0, MAX_BOOK_BUFFER_MINS);
  range('lead_mins', node.lead_mins ?? DEFAULT_BOOK_LEAD_MINS, 0, MAX_BOOK_LEAD_MINS);
  range('horizon_days', node.horizon_days ?? DEFAULT_BOOK_HORIZON_DAYS, 1, MAX_BOOK_HORIZON_DAYS);
  range('max_offers', node.max_offers ?? DEFAULT_BOOK_MAX_OFFERS, 1, MAX_BOOK_OFFERS);

  const speaksATime = bookVocabularyRefs(node).some(
    (ref) => parseBookVocabularyRef(ref)?.kind === 'time',
  );
  if (!speaksATime) {
    issues.push({
      ...at(id),
      code: 'book_never_open',
      message: `book node "${id}" can never offer an appointment: no opening leaves room for ${node.duration_mins} minutes`,
      params: { duration: node.duration_mins },
    });
  }
}

/** Declared variable names, `max_len`s and defaults, and placeholder-looking
 * text in the flow's own `id` and `name` (its `note` is a comment and never
 * scanned). Only on a v4 document: before that `{{` is ordinary text and
 * `variables` is refused as a whole. Twin: `check_variables`. */
function checkVariables(flow: Flow, issues: Issue[]): void {
  if (flow.schema_version < VARIABLES_MIN_SCHEMA_VERSION) return;
  for (const name of Object.keys(flow.variables ?? {}).sort()) {
    if (!isVariableName(name)) {
      issues.push({
        severity: 'error',
        code: 'variable_bad_name',
        message: `variable name "${name}" must be a lowercase letter, then up to 31 lowercase letters, digits or underscores`,
        params: { name },
      });
    }
    const maxLen = flow.variables?.[name]?.max_len;
    if (
      maxLen !== undefined &&
      (!Number.isInteger(maxLen) || maxLen < 1 || maxLen > MAX_VARIABLE_LEN)
    ) {
      issues.push({
        severity: 'error',
        code: 'variable_max_len_out_of_range',
        message: `variable "${name}" max_len is ${maxLen} (allowed: 1-${MAX_VARIABLE_LEN})`,
        params: { name, value: maxLen },
      });
    }
    // A default is held to the same limit as a caller's value.
    const max = maxLen ?? DEFAULT_VARIABLE_MAX_LEN;
    const len = [...(flow.variables?.[name]?.default ?? '')].length;
    if (len > max) {
      issues.push({
        severity: 'error',
        code: 'variable_default_too_long',
        message: `variable "${name}" default is ${len} characters; its max_len is ${max}`,
        params: { name, max, len },
      });
    }
  }
  const fields = (['id', 'name'] as const).filter((k) => flow[k].includes('{{')).sort();
  if (fields.length > 0) {
    issues.push({
      severity: 'error',
      code: 'placeholder_not_allowed',
      message: `${JSON.stringify(fields)} holds a {{ placeholder, which is only allowed in a prompt, a prompt template or a menu label`,
      params: { fields },
    });
  }
}

/** Check every place a node may hold a placeholder (string prompts, an audio
 * prompt's `template`, menu option labels) against the declared variables,
 * and refuse `{{` in any other string field. A v1-v3 document is skipped:
 * there `{{` is text to be spoken as written. Twin: `check_placeholders`. */
function checkPlaceholders(
  id: string,
  node: Node,
  flow: Flow,
  issues: Issue[],
  at: (node: string) => Pick<Issue, 'severity' | 'node' | 'range'>,
  mentioned: Set<string>,
): void {
  if (flow.schema_version < VARIABLES_MIN_SCHEMA_VERSION) return;
  const scan = (field: string, text: string) => {
    const { error } = tryParseTemplate(text);
    for (const name of templateNames(text)) mentioned.add(name);
    if (error === null) {
      for (const name of templateNames(text)) {
        if (!Object.hasOwn(flow.variables ?? {}, name)) {
          issues.push({
            ...at(id),
            code: 'unknown_variable',
            message: `node "${id}" ${field} uses "${name}", which the flow does not declare under variables`,
            params: { field, name },
          });
        }
      }
    } else if (error.kind === 'bad_name') {
      issues.push({
        ...at(id),
        code: 'variable_bad_name',
        message: `variable name "${error.name}" must be a lowercase letter, then up to 31 lowercase letters, digits or underscores`,
        params: { name: error.name },
      });
    } else {
      issues.push({
        ...at(id),
        code: 'template_syntax',
        message: `node "${id}" ${field} has a malformed placeholder: ${TEMPLATE_REASONS[error.kind]}`,
        params: { field, reason: TEMPLATE_REASONS[error.kind] },
      });
    }
  };
  for (const [field, prompt] of nodePromptSlots(node)) {
    if (typeof prompt === 'string') scan(field, prompt);
    else if (typeof prompt.template === 'string') scan(`${field}.template`, prompt.template);
  }
  if (node.kind === 'menu') {
    for (const key of Object.keys(node.options).sort()) {
      scan(`options.${key}`, node.options[key] ?? '');
    }
  }

  // Everything else: any string value holding `{{` is out of place. A
  // `note` is a comment for people, never read by the engine, so it is
  // never scanned (nor is the flow's own note, see `checkVariables`).
  const bad: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'exits' && key !== 'kind' && key !== 'note') collectStrayBraces(key, value, bad);
  }
  bad.sort();
  if (bad.length > 0) {
    issues.push({
      ...at(id),
      code: 'placeholder_not_allowed',
      message: `node "${id}" ${JSON.stringify(bad)} holds a {{ placeholder, which is only allowed in a prompt, a prompt template or a menu label`,
      params: { fields: bad },
    });
  }
}

const TEMPLATE_REASONS = {
  unclosed: 'a `{{` or block is never closed',
  nested: 'blocks cannot be nested',
  mismatched: 'a block close does not match an open block',
} as const;

/** Paths of string values under `value` that hold `{{`, apart from the slots
 * where a placeholder is allowed: a plain-string `prompt`, `confirm_prompt`
 * or `whisper`, any `.template`, and menu `options`. */
function collectStrayBraces(path: string, value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    const allowed =
      path === 'prompt' ||
      path === 'confirm_prompt' ||
      path === 'whisper' ||
      path.endsWith('.template') ||
      path.startsWith('options.');
    if (value.includes('{{') && !allowed) out.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => collectStrayBraces(`${path}.${i}`, item, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value))
      collectStrayBraces(`${path}.${key}`, item, out);
  }
}

function checkPrompt(
  id: string,
  prompt: Prompt,
  issues: Issue[],
  at: (node: string) => Pick<Issue, 'severity' | 'node' | 'range'>,
): void {
  const text = promptText(prompt);
  if (text !== null) {
    const len = [...text].length;
    if (len > MAX_PROMPT_CHARS) {
      issues.push({
        ...at(id),
        code: 'prompt_too_long',
        message: `node "${id}" prompt is ${len} chars (max ${MAX_PROMPT_CHARS})`,
        params: { len, max: MAX_PROMPT_CHARS },
      });
    }
  }
}

/** Reachability from `entry`, and the "no caller is trapped" guarantee. */
function checkGraph(
  flow: Flow,
  issues: Issue[],
  at: (node: string) => Pick<Issue, 'severity' | 'node' | 'range'>,
): void {
  const reachable = reachableFromEntry(flow);

  for (const id of Object.keys(flow.nodes)) {
    if (!reachable.has(id)) {
      issues.push({
        ...at(id),
        code: 'unreachable',
        message: `node "${id}" is unreachable from entry`,
      });
    }
  }

  // "Can reach a terminal" by backward fixpoint from terminal-capable
  // nodes: a node qualifies if it is itself terminal or any exit
  // target qualifies.
  const canEnd = new Set<string>();
  for (const [id, node] of Object.entries(flow.nodes)) {
    if (isTerminal(node)) canEnd.add(id);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, node] of Object.entries(flow.nodes)) {
      if (canEnd.has(id)) continue;
      if (Object.values(node.exits ?? {}).some((target) => canEnd.has(target))) {
        canEnd.add(id);
        grew = true;
      }
    }
  }

  // A reachable node that can never reach a terminal traps the caller.
  // (Only reachable ones — an unreachable trap is already flagged as
  // unreachable and would be noise.)
  for (const id of reachable) {
    if (!canEnd.has(id)) {
      issues.push({
        ...at(id),
        code: 'trapped',
        message: `node "${id}" can never reach a way to end the call (caller trapped)`,
      });
    }
  }
}

/** Node ids reachable from `entry` over exit edges (`entry` included when
 * it exists). */
function reachableFromEntry(flow: Flow): Set<string> {
  const reachable = new Set<string>();
  if (!(flow.entry in flow.nodes)) return reachable;
  reachable.add(flow.entry);
  const queue = [flow.entry];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    const node = flow.nodes[id];
    if (!node) continue;
    for (const target of Object.values(node.exits ?? {})) {
      if (target in flow.nodes && !reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }
  return reachable;
}

// ── Outbound profile ─────────────────────────────────────────────────────

/**
 * The kinds a flow may use on a call the app *places*, as of
 * `schema_version` 2 and earlier: no person is standing by. Kept for
 * compatibility; {@link outboundKinds} is the version-aware list. Twin:
 * `validate.rs` `OUTBOUND_KINDS`.
 *
 * Left out: `ring` (there is nobody to hand the call to), `book` (it
 * books against the number that called in, which an outbound call does
 * not have), and `transfer` (not offered on outbound calls before
 * version 3).
 */
export const OUTBOUND_KINDS: readonly ComponentKind[] = [
  'greeting',
  'menu',
  'message',
  'hangup',
  'hours',
];

const OUTBOUND_KINDS_V3: readonly ComponentKind[] = [...OUTBOUND_KINDS, 'ring', 'transfer'];

/**
 * The kinds a flow declaring `schemaVersion` may use on an outbound call.
 * Version 2 and earlier get {@link OUTBOUND_KINDS}, so a frozen document
 * keeps its verdict; version 3 adds `ring` and `transfer`, because a
 * person can now be reached on purpose. `transfer` must be screened (see
 * {@link validateOutbound}). Twin: `validate.rs` `outbound_kinds`.
 */
export function outboundKinds(schemaVersion: number): readonly ComponentKind[] {
  return schemaVersion >= 3 ? OUTBOUND_KINDS_V3 : OUTBOUND_KINDS;
}

/**
 * Validate a flow for an **outbound** call: everything `validateFlow`
 * checks, plus the rules for a call the app places itself.
 *
 * This runs `validateFlow` first and adds to its issues, so it is the one
 * gate to call for an outbound flow — there is no need to call both.
 *
 * The outbound rules:
 *
 * - every node is one of `outboundKinds` for the document's version
 *   (`outbound_node_not_allowed`);
 * - a `transfer` must be screened, i.e. carry a `whisper`
 *   (`outbound_blind_transfer`) — the callee never lands on a person who
 *   did not know a call was coming;
 * - no loop reachable from `entry` is made only of moves that happen
 *   without the callee — any exit of a `greeting`, `hours` or `ring` step
 *   or a screened `transfer`, or a `menu`'s `no_input` exit. Such a loop, played into voicemail or to a
 *   callee who stays silent, would never end (`outbound_unbounded_loop`).
 *   A loop through a menu's digit or `invalid` exits is fine: only a
 *   callee pressing keys can take it.
 *
 * Twin: `validate.rs` `validate_outbound`.
 */
export function validateOutbound(flow: Flow, nodeRanges: NodeRanges = {}): Issue[] {
  const issues = validateFlow(flow, nodeRanges);
  const at = (node: string): Pick<Issue, 'severity' | 'node' | 'range'> => ({
    severity: 'error',
    node,
    range: nodeRanges[node],
  });

  const allowed = outboundKinds(flow.schema_version);
  for (const id of Object.keys(flow.nodes).sort()) {
    const node = flow.nodes[id];
    if (!node) continue;
    if (!allowed.includes(node.kind as ComponentKind)) {
      issues.push({
        ...at(id),
        code: 'outbound_node_not_allowed',
        message: `node "${id}" is a ${node.kind} step, which an outbound call cannot run`,
        params: { kind: node.kind },
      });
    } else if (node.kind === 'transfer' && !isScreenedTransfer(node)) {
      issues.push({
        ...at(id),
        code: 'outbound_blind_transfer',
        message: `transfer node "${id}" has no whisper: an outbound call must screen the person it hands the callee to`,
      });
    }
  }

  for (const id of unboundedLoopNodes(flow)) {
    issues.push({
      ...at(id),
      code: 'outbound_unbounded_loop',
      message: `node "${id}" is on a loop that never waits for the callee, so an outbound call could repeat it forever`,
    });
  }

  return issues;
}

/** The exits a node takes without the callee doing anything: every exit of
 * a `greeting` (always `next`), `hours` (picked by the clock), `ring` or
 * screened `transfer` step (`no_answer`: nobody picked up), and a
 * `menu`'s `no_input` (taken when nobody presses a key — voicemail, say). */
function silentExits(node: Flow['nodes'][string] | undefined): string[] {
  if (!node) return [];
  const exits = Object.entries(node.exits ?? {});
  switch (node.kind) {
    case 'greeting':
    case 'hours':
    case 'ring':
      return exits.map(([, target]) => target);
    case 'transfer':
      return isScreenedTransfer(node) ? exits.map(([, target]) => target) : [];
    case 'menu':
      return exits.filter(([key]) => key === 'no_input').map(([, target]) => target);
    default:
      return [];
  }
}

/** Every node reachable from `entry` that sits on a cycle made only of
 * silent exits (see `silentExits`), in id order. */
function unboundedLoopNodes(flow: Flow): string[] {
  const reachable = reachableFromEntry(flow);
  const successors = (id: string): string[] =>
    silentExits(flow.nodes[id]).filter((target) => reachable.has(target));

  const onLoop: string[] = [];
  for (const id of [...reachable].sort()) {
    // Does `id` lead back to itself within the subgraph?
    const seen = new Set<string>();
    const stack = successors(id);
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (next === id) {
        onLoop.push(id);
        break;
      }
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(...successors(next));
      }
    }
  }
  return onLoop;
}
