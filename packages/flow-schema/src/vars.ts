// Placeholder syntax shared by validation and filling. Twin of
// `crates/wavekat-flow/src/vars.rs`; keep the two in lockstep.
//
// A template is text with `{{name}}` placeholders and `{{#name}}…{{/name}}`
// conditional blocks (kept only when the variable's value is non-empty).
// Blocks do not nest and have no else. Names are `[a-z][a-z0-9_]{0,31}`.
//
// `fill` gives each name an effective value: the caller's, cleaned, or the
// variable's default when the caller gives none or a blank one. So a blank
// value falls back to the default; it cannot clear a default. Only a menu
// option whose label is exactly a bare `{{name}}` is dropped when its
// effective value is empty; any other text that holds an empty placeholder is
// kept, with the placeholder filled as nothing.

import type { Flow } from './model.js';
import { DEFAULT_VARIABLE_MAX_LEN, MAX_PROMPT_CHARS, nodePromptSlots } from './model.js';

/** One piece of a parsed template. A block's body holds only text and vars. */
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'var'; name: string }
  | { kind: 'block'; name: string; body: Segment[] };

/** Why a template could not be parsed. */
export type TemplateError =
  | { kind: 'unclosed' }
  | { kind: 'nested' }
  | { kind: 'bad_name'; name: string }
  | { kind: 'mismatched'; name: string };

const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

/** Whether `name` fits `[a-z][a-z0-9_]{0,31}`. Twin: `is_variable_name`. */
export function isVariableName(name: string): boolean {
  return NAME_RE.test(name);
}

type Tok = { t: 'text'; v: string } | { t: 'var' | 'open' | 'close'; v: string };

/** Split `s` into tokens. `unclosed` is true when a `{{` has no `}}`. */
function tokens(s: string): { toks: Tok[]; unclosed: boolean } {
  const toks: Tok[] = [];
  let rest = s;
  for (;;) {
    const start = rest.indexOf('{{');
    if (start < 0) break;
    if (start > 0) toks.push({ t: 'text', v: rest.slice(0, start) });
    const after = rest.slice(start + 2);
    const end = after.indexOf('}}');
    if (end < 0) return { toks, unclosed: true };
    const inner = after.slice(0, end);
    if (inner.startsWith('#')) toks.push({ t: 'open', v: inner.slice(1) });
    else if (inner.startsWith('/')) toks.push({ t: 'close', v: inner.slice(1) });
    else toks.push({ t: 'var', v: inner });
    rest = after.slice(end + 2);
  }
  if (rest.length > 0) toks.push({ t: 'text', v: rest });
  return { toks, unclosed: false };
}

/** Parse `s`; the first defect, if any, comes back as `error`. */
export function tryParseTemplate(s: string): { segments: Segment[]; error: TemplateError | null } {
  const { toks, unclosed } = tokens(s);
  const segments: Segment[] = [];
  let open: { name: string; body: Segment[] } | null = null;
  const fail = (error: TemplateError) => ({ segments: [], error });
  for (const tok of toks) {
    const into = open ? open.body : segments;
    if (tok.t === 'text') {
      into.push({ kind: 'text', text: tok.v });
      continue;
    }
    if (!isVariableName(tok.v)) return fail({ kind: 'bad_name', name: tok.v });
    if (tok.t === 'var') {
      into.push({ kind: 'var', name: tok.v });
    } else if (tok.t === 'open') {
      if (open) return fail({ kind: 'nested' });
      open = { name: tok.v, body: [] };
    } else {
      if (!open || open.name !== tok.v) return fail({ kind: 'mismatched', name: tok.v });
      segments.push({ kind: 'block', name: open.name, body: open.body });
      open = null;
    }
  }
  if (unclosed || open) return fail({ kind: 'unclosed' });
  return { segments, error: null };
}

/** Parse `s` into segments; empty when the template is malformed. Throws nothing. */
export function parseTemplate(s: string): Segment[] {
  return tryParseTemplate(s).segments;
}

/** The validator code for a template defect. */
export function templateErrorCode(error: TemplateError): 'template_syntax' | 'variable_bad_name' {
  return error.kind === 'bad_name' ? 'variable_bad_name' : 'template_syntax';
}

/** Codes for what is wrong with `s`: empty when well formed, else one code. */
export function templateIssues(s: string): string[] {
  const { error } = tryParseTemplate(s);
  return error === null ? [] : [templateErrorCode(error)];
}

/** Every variable name `s` mentions, first-mention order, no repeats.
 * Best effort on a malformed template: the well-formed names it holds. */
export function templateNames(s: string): string[] {
  const names: string[] = [];
  for (const tok of tokens(s).toks) {
    if ((tok.t === 'var' || tok.t === 'open') && isVariableName(tok.v) && !names.includes(tok.v)) {
      names.push(tok.v);
    }
  }
  return names;
}

/** Why `fill` refused a value. */
export type FillError = {
  code: 'variable_unknown' | 'variable_too_long' | 'menu_without_options' | 'prompt_too_long';
  /** The variable, or for `menu_without_options` and `prompt_too_long` the
   * node id. */
  name: string;
};

/** A caller's value with control characters stripped, then trimmed of Unicode
 * White_Space plus U+FEFF (JS `\s` covers FEFF but not U+0085). Twin: `clean`
 * in `vars.rs`. */
function clean(value: string): string {
  return value.replace(/\p{Cc}/gu, '').replace(/^[\s\u0085]+|[\s\u0085]+$/g, '');
}

function render(segments: Segment[], effective: (name: string) => string): string {
  let out = '';
  for (const seg of segments) {
    if (seg.kind === 'text') out += seg.text;
    else if (seg.kind === 'var') out += effective(seg.name);
    else if (effective(seg.name) !== '') out += render(seg.body, effective);
  }
  return out;
}

/**
 * Turn a flow with variables plus a caller's values into a plain flow the
 * engine can run: every placeholder replaced, `variables` and every audio
 * prompt's `template` gone, and a declared `schema_version` of 4 or more set
 * to 3. The input is not modified. Twin: `vars.rs` `fill`.
 *
 * A name's effective value is the caller's (trimmed, control characters
 * stripped) when that is non-empty, else the variable's default; so a blank
 * value falls back to the default and cannot clear it. Values are inserted as
 * text and never parsed again. A menu option whose label is exactly a bare
 * `{{name}}` with an empty effective value is removed, with its exit; any
 * other label is filled and kept. An audio prompt with a `template` stays
 * audio (dropping the template) unless a variable it names got a non-default
 * value; then it becomes the filled text. A v1-v3 flow without variables
 * comes back as a clone. A malformed template is left as written (validation
 * rejects those before fill is reached).
 *
 * Contract: validate the SOURCE flow first (`validateOutbound`). The result is
 * a v3 document that validates on its own: a value holding `{{` is plain text
 * in v3, and `fill` keeps options and exits consistent. Errors:
 * `variable_unknown`, `variable_too_long`, `menu_without_options` when every
 * option of a menu would be dropped, and `prompt_too_long` when a filled
 * prompt is longer than validation allows.
 */
export function fill(
  flow: Flow,
  values: Record<string, string>,
): { flow: Flow } | { errors: FillError[] } {
  const declared = flow.variables ?? {};
  const out = structuredClone(flow);
  if (
    Object.keys(declared).length === 0 &&
    Object.keys(values).length === 0 &&
    flow.schema_version < 4
  ) {
    return { flow: out };
  }

  const errors: FillError[] = [];
  const given = new Map<string, string>();
  for (const name of Object.keys(values).sort()) {
    const variable = Object.hasOwn(declared, name) ? declared[name] : undefined;
    if (variable === undefined) {
      errors.push({ code: 'variable_unknown', name });
      continue;
    }
    const value = clean(values[name] ?? '');
    if ([...value].length > (variable.max_len ?? DEFAULT_VARIABLE_MAX_LEN)) {
      errors.push({ code: 'variable_too_long', name });
    } else if (value !== '') {
      given.set(name, value);
    }
  }
  if (errors.length > 0) return { errors };

  const defaultOf = (name: string): string =>
    Object.hasOwn(declared, name) ? (declared[name]?.default ?? '') : '';
  const effective = (name: string): string => given.get(name) ?? defaultOf(name);
  const fillText = (text: string): string => {
    const { segments, error } = tryParseTemplate(text);
    return error === null ? render(segments, effective) : text;
  };

  delete out.variables;
  // Variables and templates are gone, so what is left is a v3 document.
  if (out.schema_version >= 4) out.schema_version = 3;
  for (const [id, node] of Object.entries(out.nodes)) {
    let tooLong = false;
    for (const [field, prompt] of nodePromptSlots(node)) {
      let next: typeof prompt = prompt;
      if (typeof prompt === 'string') {
        next = fillText(prompt);
      } else if (typeof prompt.template === 'string') {
        const { template, ...clip } = prompt;
        const overridden = templateNames(template).some(
          (n) => given.has(n) && given.get(n) !== defaultOf(n),
        );
        next = overridden ? fillText(template) : clip;
      }
      if (typeof next === 'string' && [...next].length > MAX_PROMPT_CHARS) tooLong = true;
      (node as unknown as Record<string, unknown>)[field] = next;
    }
    if (tooLong) errors.push({ code: 'prompt_too_long', name: id });
    if (node.kind === 'menu') {
      const dropped: string[] = [];
      for (const [key, label] of Object.entries(node.options)) {
        const bare = /^\{\{([^{}]*)\}\}$/.exec(label)?.[1];
        if (bare !== undefined && isVariableName(bare) && effective(bare) === '') {
          dropped.push(key);
        } else {
          node.options[key] = fillText(label);
        }
      }
      if (dropped.length > 0 && dropped.length === Object.keys(node.options).length) {
        errors.push({ code: 'menu_without_options', name: id });
        continue;
      }
      for (const key of dropped) {
        delete node.options[key];
        if (node.exits) delete node.exits[key];
      }
    }
  }
  return errors.length > 0 ? { errors } : { flow: out };
}
