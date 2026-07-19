// Ports of the Rust twin's `model.rs` tests (the canonical doc 48
// example must parse, defaults apply, prompts take both forms, dup
// keys are rejected, `ui` is preserved) plus the safe-subset and
// strict-typing rules the TS side enforces at parse time.
//
// Migrated from the platform repo's packages/flow-schema/src/parse.test.ts.

import { describe, expect, it } from 'vitest';

import { parseFlow } from '../src/parse.js';
import { requiredAssets } from '../src/model.js';

// The doc 48 "flow document, sketched" example — kept in sync with the
// Rust side's `model::tests::LUIGIS` on purpose: both must stay valid.
const LUIGIS = `
schema_version: 1
id: flow_9f2
name: Luigi's — after hours
version: 3
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
    prompt: >-
      We're closed right now. Press 1 for our opening hours,
      or stay on the line to leave a message.
    options: { "1": Opening hours }
    retries: 1
    exits: { "1": say_hours, no_input: take_message, invalid: take_message }
  say_hours:
    kind: greeting
    prompt: We're open Tuesday to Sunday, eleven to ten.
    exits: { next: take_message }
  take_message:
    kind: message
    prompt: Please leave your name and number after the tone.
`;

describe('parseFlow', () => {
  it('parses the documented example', () => {
    const { flow, issues } = parseFlow(LUIGIS);
    expect(issues).toEqual([]);
    expect(flow).not.toBeNull();
    expect(flow?.schema_version).toBe(1);
    expect(flow?.entry).toBe('welcome');
    expect(Object.keys(flow?.nodes ?? {})).toHaveLength(6);
    expect(flow?.nodes['welcome']?.kind).toBe('greeting');
    expect(flow?.nodes['check_hours']?.kind).toBe('hours');
    expect(flow?.nodes['night_menu']?.kind).toBe('menu');
    expect(flow?.nodes['take_message']?.kind).toBe('message');
    expect(flow?.nodes['welcome']?.exits?.['next']).toBe('check_hours');
    expect(flow?.nodes['check_hours']?.exits?.['closed']).toBe('night_menu');
  });

  it('applies menu and message defaults when omitted', () => {
    const { flow } = parseFlow(LUIGIS);
    const menu = flow?.nodes['night_menu'];
    expect(menu?.kind === 'menu' && menu.retries).toBe(1); // set in the doc
    expect(menu?.kind === 'menu' && menu.timeout_secs).toBe(5); // defaulted
    const message = flow?.nodes['take_message'];
    expect(message?.kind === 'message' && message.max_secs).toBe(120);
    // The record-start cue defaults on — a prompt saying "after the
    // tone" is true with zero configuration.
    expect(message?.kind === 'message' && message.tone).toBe('beep');
    expect(flow?.version).toBe(3);
  });

  it('accepts tone: none and rejects unknown tones', () => {
    const doc = (tone: string) => `
schema_version: 1
id: f
name: n
entry: vm
nodes:
  vm:
    kind: message
    prompt: Start speaking now.
    tone: ${tone}
`;
    const { flow } = parseFlow(doc('none'));
    const node = flow?.nodes['vm'];
    expect(node?.kind === 'message' && node.tone).toBe('none');

    // Closed enum, like the Rust twin: an unknown cue style is an
    // error, not a silent fallback to the beep.
    const { flow: bad, issues } = parseFlow(doc('chime'));
    expect(bad).toBeNull();
    expect(issues.some((issue) => issue.code === 'bad_tone')).toBe(true);
  });

  it('defaults version to 1 when omitted', () => {
    const { flow } = parseFlow(LUIGIS.replace('version: 3\n', ''));
    expect(flow?.version).toBe(1);
  });

  it('accepts the text shorthand and the audio form of prompts', () => {
    const { flow } = parseFlow(`
schema_version: 1
id: f
name: n
entry: g
nodes:
  g:
    kind: hangup
    prompt: { audio: bye.wav }
`);
    const node = flow?.nodes['g'];
    expect(node?.kind === 'hangup' && node.prompt).toEqual({ audio: 'bye.wav' });
    expect(flow ? requiredAssets(flow) : []).toEqual(['bye.wav']);
  });

  it('rejects duplicate keys at any nesting level', () => {
    const { flow, issues } = parseFlow(`
schema_version: 1
id: f
name: n
entry: g
nodes:
  g:
    kind: hangup
  g:
    kind: hangup
`);
    expect(flow).toBeNull();
    expect(issues.some((issue) => issue.severity === 'error')).toBe(true);
  });

  it('preserves the ui block as opaque data', () => {
    const { flow } = parseFlow(`
schema_version: 1
id: f
name: n
entry: g
nodes:
  g:
    kind: hangup
ui:
  g: { x: 10, y: 20 }
`);
    expect(flow?.ui).toEqual({ g: { x: 10, y: 20 } });
  });

  it('rejects aliases, anchors, and tags (safe subset)', () => {
    for (const source of [
      'schema_version: 1\nid: &a f\nname: *a\nentry: g\nnodes: { g: { kind: hangup } }',
      'schema_version: 1\nid: &a f\nname: n\nentry: g\nnodes: { g: { kind: hangup } }',
      'schema_version: 1\nid: !!str f\nname: n\nentry: g\nnodes: { g: { kind: hangup } }',
      'schema_version: 1\nid: !custom f\nname: n\nentry: g\nnodes: { g: { kind: hangup } }',
    ]) {
      const { flow, issues } = parseFlow(source);
      expect(flow, source).toBeNull();
      expect(issues.some((issue) => issue.severity === 'error'), source).toBe(true);
    }
  });

  it('rejects non-string mapping keys (unquoted menu digits)', () => {
    const { flow, issues } = parseFlow(`
schema_version: 1
id: f
name: n
entry: m
nodes:
  m:
    kind: menu
    prompt: hi
    options: { 1: Sales }
    exits: { "1": bye, no_input: bye, invalid: bye }
  bye:
    kind: hangup
`);
    expect(flow).toBeNull();
    expect(issues.some((issue) => issue.code === 'non_string_key')).toBe(true);
  });

  it('rejects non-string schema-typed values instead of coercing', () => {
    const { flow, issues } = parseFlow(`
schema_version: 1
id: f
name: no
entry: g
nodes:
  g:
    kind: greeting
    prompt: 42
    exits: { next: g }
`);
    // `name: no` stays a string under YAML 1.2 core; the numeric prompt
    // is the error.
    expect(flow).toBeNull();
    expect(issues.some((issue) => issue.code === 'bad_prompt')).toBe(true);
  });

  it('rejects an unknown component kind, naming the catalog', () => {
    const { flow, issues } = parseFlow(`
schema_version: 1
id: f
name: n
entry: g
nodes:
  g:
    kind: teleport
`);
    expect(flow).toBeNull();
    const issue = issues.find((entry) => entry.code === 'unknown_kind');
    expect(issue?.message).toContain('teleport');
    expect(issue?.message).toContain('greeting');
  });

  it('rejects missing required config (ring without timeout_secs)', () => {
    const { flow, issues } = parseFlow(`
schema_version: 1
id: f
name: n
entry: r
nodes:
  r:
    kind: ring
    exits: { no_answer: r }
`);
    expect(flow).toBeNull();
    expect(issues.some((issue) => issue.code === 'missing_field')).toBe(true);
  });

  it('warns (not errors) on unknown fields, mirroring serde ignoring them', () => {
    const { flow, issues } = parseFlow(`
schema_version: 1
id: f
name: n
entry: g
color: purple
nodes:
  g:
    kind: hangup
    volume: 11
`);
    expect(flow).not.toBeNull();
    const warnings = issues.filter((issue) => issue.code === 'unknown_field');
    expect(warnings).toHaveLength(2);
    expect(warnings.every((issue) => issue.severity === 'warning')).toBe(true);
  });

  it('reports node source ranges for editor highlighting', () => {
    const source = LUIGIS;
    const { nodeRanges } = parseFlow(source);
    const range = nodeRanges['night_menu'];
    expect(range).toBeDefined();
    expect(source.slice(range![0], range![0] + 'night_menu'.length)).toBe('night_menu');
  });
});
