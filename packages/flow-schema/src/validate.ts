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

import type { BookNode, ComponentKind, Flow, Prompt } from './model.js';
import {
  KIND_MIN_SCHEMA_VERSION,
  MAX_PROMPT_CHARS,
  SUPPORTED_SCHEMA_VERSIONS,
  VALID_DIGITS,
  isTerminal,
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

  const nodeIds = Object.keys(flow.nodes);
  if (nodeIds.length === 0) {
    issues.push({ severity: 'error', code: 'empty_flow', message: 'flow has no nodes' });
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
          ...validateHours(id, node.schedule, node.timezone, node.exceptions ?? []).map((issue) => ({
            ...issue,
            range: nodeRanges[id],
          })),
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
        break;
      case 'hangup':
        if (node.prompt !== undefined) checkPrompt(id, node.prompt, issues, at);
        break;
      case 'book':
        checkPrompt(id, node.prompt, issues, at);
        checkPrompt(id, node.confirm_prompt, issues, at);
        issues.push(
          ...validateHours(id, node.schedule, node.timezone, node.exceptions ?? []).map((issue) => ({
            ...issue,
            range: nodeRanges[id],
          })),
        );
        checkBookBounds(id, node, issues, at);
        break;
      case 'ring':
        break;
    }

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
        params: { kind: node.kind, required: minVersion, declared: flow.schema_version },
      });
    }
  }

  // Reachability and trap analysis need a real entry to walk from.
  if (entryExists) checkGraph(flow, issues, at);

  return issues;
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
  // BFS from entry over exit edges.
  const reachable = new Set<string>([flow.entry]);
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
    if (isTerminal(node.kind)) canEnd.add(id);
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
