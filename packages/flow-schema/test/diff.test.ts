// diffFlows is structural, not textual: it compares decoded Flow objects,
// so comment/key-order churn and the flow-level stamps publish rewrites
// never register as changes — only added/removed nodes, real field edits,
// and a moved entry do. These tests pin exactly that boundary.

import { describe, expect, it } from 'vitest';

import { checkFlow } from '../src/check.js';
import { diffFlows } from '../src/diff.js';
import type { Flow } from '../src/model.js';

const parse = (src: string): Flow => {
  const flow = checkFlow(src).flow;
  if (!flow) throw new Error('fixture did not parse');
  return flow;
};

const BASE = `schema_version: 1
id: flow_1
name: Test
entry: welcome
nodes:
  welcome:
    kind: greeting
    prompt: Hi!
    exits: { next: ring }
  ring:
    kind: ring
    timeout_secs: 25
    exits: { no_answer: bye }
  bye:
    kind: hangup
`;

describe('diffFlows', () => {
  it('reports no change for the same document', () => {
    const diff = diffFlows(parse(BASE), parse(BASE));
    expect(diff.changed).toBe(false);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toEqual([]);
    expect(diff.nodes.ring.status).toBe('unchanged');
  });

  it('ignores comment and key-order churn (structural, not textual)', () => {
    const reordered = `# a fresh comment
schema_version: 1
name: Test
id: flow_1
entry: welcome
nodes:
  bye: { kind: hangup }
  ring:
    exits: { no_answer: bye }
    kind: ring
    timeout_secs: 25
  welcome:
    exits: { next: ring }
    prompt: Hi!
    kind: greeting
`;
    expect(diffFlows(parse(BASE), parse(reordered)).changed).toBe(false);
  });

  it('ignores flow-level stamps (version) that publish rewrites', () => {
    const stamped = BASE.replace('name: Test\n', 'name: Test\nversion: 7\n');
    expect(diffFlows(parse(BASE), parse(stamped)).changed).toBe(false);
  });

  it('flags an added node', () => {
    const withNode = BASE.replace(
      '  bye:\n    kind: hangup\n',
      '  bye:\n    kind: hangup\n  extra:\n    kind: hangup\n',
    );
    const diff = diffFlows(parse(BASE), parse(withNode));
    expect(diff.changed).toBe(true);
    expect(diff.added).toEqual(['extra']);
    expect(diff.nodes.extra.status).toBe('added');
    expect(diff.nodes.extra.kind).toBe('hangup');
  });

  it('flags a removed node from the published side', () => {
    const withNode = BASE.replace(
      '  bye:\n    kind: hangup\n',
      '  bye:\n    kind: hangup\n  extra:\n    kind: hangup\n',
    );
    // Publish had `extra`; the draft dropped it.
    const diff = diffFlows(parse(withNode), parse(BASE));
    expect(diff.removed).toEqual(['extra']);
    expect(diff.nodes.extra.status).toBe('removed');
    expect(diff.nodes.extra.kind).toBe('hangup');
  });

  it('reports a changed config field with before/after', () => {
    const edited = BASE.replace('timeout_secs: 25', 'timeout_secs: 30');
    const diff = diffFlows(parse(BASE), parse(edited));
    expect(diff.modified).toEqual(['ring']);
    expect(diff.nodes.ring.status).toBe('modified');
    expect(diff.nodes.ring.changes).toEqual([{ path: 'timeout_secs', before: 25, after: 30 }]);
  });

  it('reports a rewired exit per exit name', () => {
    const edited = BASE.replace('no_answer: bye', 'no_answer: welcome');
    const diff = diffFlows(parse(BASE), parse(edited));
    expect(diff.nodes.ring.changes).toEqual([
      { path: 'exits.no_answer', before: 'bye', after: 'welcome' },
    ]);
  });

  it('reports a changed prompt', () => {
    const edited = BASE.replace('prompt: Hi!', 'prompt: Hello there');
    const diff = diffFlows(parse(BASE), parse(edited));
    expect(diff.nodes.welcome.changes).toEqual([
      { path: 'prompt', before: 'Hi!', after: 'Hello there' },
    ]);
  });

  it('reports a relabelled menu option per digit', () => {
    const menu = `schema_version: 1
id: flow_1
name: Test
entry: m
nodes:
  m:
    kind: menu
    prompt: Pick
    options: { "1": Sales, "2": Support }
    exits: { "1": bye, "2": bye, no_input: bye, invalid: bye }
  bye: { kind: hangup }
`;
    const edited = menu.replace('"1": Sales', '"1": New Sales');
    const diff = diffFlows(parse(menu), parse(edited));
    expect(diff.nodes.m.changes).toEqual([
      { path: 'options.1', before: 'Sales', after: 'New Sales' },
    ]);
  });

  it('flags a moved entry as a change on both nodes', () => {
    const edited = BASE.replace('entry: welcome', 'entry: ring');
    const diff = diffFlows(parse(BASE), parse(edited));
    expect(diff.entryChanged).toBe(true);
    expect(diff.entryBefore).toBe('welcome');
    expect(diff.entryAfter).toBe('ring');
    expect(diff.modified).toEqual(['ring', 'welcome']);
    expect(diff.nodes.welcome.changes).toContainEqual({ path: 'entry', before: true, after: false });
    expect(diff.nodes.ring.changes).toContainEqual({ path: 'entry', before: false, after: true });
  });

  it('treats an added optional field as a change', () => {
    // hangup gains a goodbye prompt.
    const edited = BASE.replace('  bye:\n    kind: hangup\n', '  bye:\n    kind: hangup\n    prompt: Bye now\n');
    const diff = diffFlows(parse(BASE), parse(edited));
    expect(diff.nodes.bye.changes).toEqual([{ path: 'prompt', before: undefined, after: 'Bye now' }]);
  });
});
