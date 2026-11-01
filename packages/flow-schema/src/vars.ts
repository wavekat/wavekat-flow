// Placeholder syntax shared by validation and filling. Twin of
// `crates/wavekat-flow/src/vars.rs`; keep the two in lockstep.
//
// A template is text with `{{name}}` placeholders and `{{#name}}…{{/name}}`
// conditional blocks (kept only when the variable's value is non-empty).
// Blocks do not nest and have no else. Names are `[a-z][a-z0-9_]{0,31}`.

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
