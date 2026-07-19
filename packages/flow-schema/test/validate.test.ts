// Port of the Rust twin's `validate.rs` test suite — every rule the
// daemon enforces at load time must reject/accept the same documents
// here, or the platform would publish flows a device then refuses.
//
// Migrated from wavekat-platform/packages/flow-schema/src/validate.test.ts.
// The dangling-target code is `unknown_target` (reconciled to the frozen
// conformance corpus; see src/validate.ts).

import { describe, expect, it } from 'vitest';

import { checkFlow } from '../src/check.js';
import { MAX_PROMPT_CHARS } from '../src/model.js';

const LUIGIS = `
schema_version: 1
id: flow_9f2
name: Luigi's
entry: welcome
nodes:
  welcome:
    kind: greeting
    prompt: Thanks for calling Luigi's!
    exits: { next: check_hours }
  check_hours:
    kind: hours
    timezone: America/New_York
    schedule:
      tue: [{ open: "11:00", close: "22:00" }]
    exits: { open: front_desk, closed: night_menu }
  front_desk:
    kind: ring
    timeout_secs: 25
    exits: { no_answer: take_message }
  night_menu:
    kind: menu
    prompt: We're closed. Press 1 for hours.
    options: { "1": Hours }
    exits: { "1": say_hours, no_input: take_message, invalid: take_message }
  say_hours:
    kind: greeting
    prompt: Open Tuesday to Sunday.
    exits: { next: take_message }
  take_message:
    kind: message
    prompt: Leave a message after the tone.
`;

function codes(source: string): string[] {
  return checkFlow(source)
    .issues.filter((issue) => issue.severity === 'error')
    .map((issue) => issue.code);
}

describe('checkFlow', () => {
  it('validates the documented example', () => {
    const check = checkFlow(LUIGIS);
    expect(check.issues).toEqual([]);
    expect(check.valid).toBe(true);
    expect(check.requiredAssets).toEqual([]);
  });

  it('rejects an unsupported schema version', () => {
    expect(codes(LUIGIS.replace('schema_version: 1', 'schema_version: 99'))).toContain(
      'unsupported_schema_version',
    );
  });

  it('rejects a missing entry', () => {
    const check = checkFlow(LUIGIS.replace('entry: welcome', 'entry: nope'));
    expect(check.issues.map((issue) => issue.code)).toContain('missing_entry');
    // The rest of the document still decodes for the graph view.
    expect(check.flow).not.toBeNull();
  });

  it('rejects a dangling exit target, pointing at the node', () => {
    const check = checkFlow(LUIGIS.replace('next: check_hours', 'next: ghost'));
    const issue = check.issues.find((entry) => entry.code === 'unknown_target');
    expect(issue).toBeDefined();
    expect(issue?.node).toBe('welcome');
    expect(issue?.params?.['target']).toBe('ghost');
  });

  it('rejects a missing required exit', () => {
    expect(
      codes(`
schema_version: 1
id: f
name: n
entry: g
nodes:
  g:
    kind: greeting
    prompt: hi
  bye:
    kind: hangup
`),
    ).toContain('missing_exits');
  });

  it('rejects an unexpected exit on a terminal', () => {
    expect(
      codes(`
schema_version: 1
id: f
name: n
entry: g
nodes:
  g:
    kind: hangup
    exits: { next: g }
`),
    ).toContain('unexpected_exits');
  });

  it('rejects an unreachable node', () => {
    expect(
      codes(`
schema_version: 1
id: f
name: n
entry: g
nodes:
  g:
    kind: hangup
  orphan:
    kind: hangup
`),
    ).toContain('unreachable');
  });

  it('rejects a trapping cycle (no caller is ever trapped)', () => {
    expect(
      codes(`
schema_version: 1
id: f
name: n
entry: a
nodes:
  a:
    kind: greeting
    prompt: one
    exits: { next: b }
  b:
    kind: greeting
    prompt: two
    exits: { next: a }
`),
    ).toContain('trapped');
  });

  it('accepts a loop with an escape to a terminal', () => {
    expect(
      checkFlow(`
schema_version: 1
id: f
name: n
entry: m
nodes:
  m:
    kind: menu
    prompt: press one
    options: { "1": again }
    exits: { "1": g, no_input: bye, invalid: bye }
  g:
    kind: greeting
    prompt: again
    exits: { next: m }
  bye:
    kind: hangup
`).valid,
    ).toBe(true);
  });

  it('rejects an empty menu and a non-DTMF option key', () => {
    expect(
      codes(`
schema_version: 1
id: f
name: n
entry: m
nodes:
  m:
    kind: menu
    prompt: hi
    options: {}
    exits: { no_input: bye, invalid: bye }
  bye:
    kind: hangup
`),
    ).toContain('empty_menu');

    expect(
      codes(`
schema_version: 1
id: f
name: n
entry: m
nodes:
  m:
    kind: menu
    prompt: hi
    options: { A: nope }
    exits: { A: bye, no_input: bye, invalid: bye }
  bye:
    kind: hangup
`),
    ).toContain('bad_digit');
  });

  it('rejects an empty transfer target', () => {
    expect(
      codes(`
schema_version: 1
id: f
name: n
entry: t
nodes:
  t:
    kind: transfer
    target: "   "
`),
    ).toContain('empty_transfer_target');
  });

  it('rejects an overlong prompt', () => {
    const long = 'a'.repeat(MAX_PROMPT_CHARS + 1);
    expect(
      codes(`
schema_version: 1
id: f
name: n
entry: g
nodes:
  g:
    kind: greeting
    prompt: ${long}
    exits: { next: bye }
  bye:
    kind: hangup
`),
    ).toContain('prompt_too_long');
  });

  it('surfaces hours config errors', () => {
    expect(
      codes(`
schema_version: 1
id: f
name: n
entry: h
nodes:
  h:
    kind: hours
    timezone: Mars/Base
    schedule: {}
    exits: { open: bye, closed: bye }
  bye:
    kind: hangup
`),
    ).toContain('unknown_timezone');

    expect(
      codes(`
schema_version: 1
id: f
name: n
entry: h
nodes:
  h:
    kind: hours
    timezone: UTC
    schedule:
      mon: [{ open: "9:00", close: "17:00" }]
    exits: { open: bye, closed: bye }
  bye:
    kind: hangup
`),
      // Unpadded hour — the engine's HH:MM format rejects it too.
    ).toContain('bad_time');

    expect(
      codes(`
schema_version: 1
id: f
name: n
entry: h
nodes:
  h:
    kind: hours
    timezone: UTC
    schedule:
      mon: [{ open: "17:00", close: "09:00" }]
    exits: { open: bye, closed: bye }
  bye:
    kind: hangup
`),
      // Overnight ranges are not a v1 feature.
    ).toContain('non_positive_range');

    expect(
      codes(`
schema_version: 1
id: f
name: n
entry: h
nodes:
  h:
    kind: hours
    timezone: UTC
    schedule: {}
    exceptions:
      - date: 2026-02-30
        closed: true
    exits: { open: bye, closed: bye }
  bye:
    kind: hangup
`),
      // February 30th does not exist.
    ).toContain('bad_date');
  });

  it('collects every problem at once, not fail-fast', () => {
    const check = checkFlow(`
schema_version: 99
id: f
name: n
entry: nope
nodes:
  a:
    kind: greeting
    prompt: hi
    exits: { next: ghost }
  b:
    kind: hangup
`);
    const found = check.issues.map((issue) => issue.code);
    for (const code of ['unsupported_schema_version', 'missing_entry', 'unknown_target']) {
      expect(found).toContain(code);
    }
  });

  it('lists required audio assets across nodes, deduplicated', () => {
    const check = checkFlow(`
schema_version: 1
id: f
name: n
entry: g
nodes:
  g:
    kind: greeting
    prompt: { audio: welcome }
    exits: { next: bye }
  bye:
    kind: hangup
    prompt: { audio: welcome }
`);
    expect(check.valid).toBe(true);
    expect(check.requiredAssets).toEqual(['welcome']);
  });
});
