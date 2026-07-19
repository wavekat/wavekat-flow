// The structured edit ops must preserve what the engine ignores but
// humans rely on — comments, key order, the `ui` block — while keeping
// every reference (entry, exits, ui positions) consistent. A rename
// that misses one exit target silently reroutes a caller; these tests
// are the fence.
//
// Migrated from wavekat-platform/packages/flow-schema/src/mutate.test.ts.

import { describe, expect, it } from 'vitest';

import { checkFlow } from '../src/check.js';
import {
  addNode,
  clearNodePositions,
  defaultNode,
  nodePositions,
  removeExit,
  removeNode,
  renameNode,
  setEntry,
  setExit,
  setNodePosition,
  setNodeValue,
  stampIdentity,
} from '../src/mutate.js';
import { COMPONENT_KINDS } from '../src/model.js';

const SOURCE = `schema_version: 1
id: flow_1
name: Test
entry: welcome
# The welcome message — swap this for your own greeting.
nodes:
  welcome:
    kind: greeting
    prompt: Hi!
    exits: { next: menu }
  menu:
    kind: menu
    prompt: Press 1 to loop.
    options: { "1": Loop }
    exits: { "1": welcome, no_input: bye, invalid: bye }
  bye:
    kind: hangup
ui:
  welcome: { x: 10, y: 20 }
`;

function edited(result: ReturnType<typeof renameNode>): string {
  if (!result.ok) throw new Error(`edit failed: ${result.error}`);
  return result.source;
}

describe('renameNode', () => {
  it('renames the node and every reference to it', () => {
    const source = edited(renameNode(SOURCE, 'welcome', 'greet'));
    const { flow } = checkFlow(source) ?? {};
    expect(flow?.entry).toBe('greet');
    expect(flow?.nodes['greet']?.kind).toBe('greeting');
    expect(flow?.nodes['welcome']).toBeUndefined();
    const menu = flow?.nodes['menu'];
    expect(menu?.exits?.['1']).toBe('greet');
    expect(flow?.ui).toEqual({ greet: { x: 10, y: 20 } });
    expect(checkFlow(source).valid).toBe(true);
  });

  it('preserves comments', () => {
    const source = edited(renameNode(SOURCE, 'welcome', 'greet'));
    expect(source).toContain('swap this for your own greeting');
  });

  it('refuses a duplicate or invalid id', () => {
    expect(renameNode(SOURCE, 'welcome', 'menu')).toEqual({
      ok: false,
      error: 'duplicate_node_id',
    });
    expect(renameNode(SOURCE, 'welcome', 'bad id!')).toEqual({
      ok: false,
      error: 'invalid_node_id',
    });
    expect(renameNode(SOURCE, 'ghost', 'x')).toEqual({ ok: false, error: 'unknown_node' });
  });
});

describe('removeNode', () => {
  it('removes the node, exits pointing at it, and its ui position', () => {
    const source = edited(removeNode(SOURCE, 'welcome'));
    const { flow } = checkFlow(source);
    expect(flow?.nodes['welcome']).toBeUndefined();
    // The menu's "1" exit pointed at welcome — gone, so validation now
    // reports the menu's missing exit instead of a dangling target.
    expect(flow?.nodes['menu']?.exits?.['1']).toBeUndefined();
    expect(flow?.ui).toEqual({});
    const issueCodes = checkFlow(source).issues.map((issue) => issue.code);
    expect(issueCodes).toContain('missing_exits');
    expect(issueCodes).toContain('missing_entry');
  });

  it('drops an exits map emptied by the removal', () => {
    const source = edited(removeNode(SOURCE, 'menu'));
    expect(source).not.toContain('exits: {}');
  });
});

describe('addNode', () => {
  it('adds a default node of every kind', () => {
    for (const kind of COMPONENT_KINDS) {
      const source = edited(addNode(SOURCE, `new_${kind}`, defaultNode(kind)));
      const { flow } = checkFlow(source);
      expect(flow?.nodes[`new_${kind}`]?.kind).toBe(kind);
    }
  });

  it('writes small maps inline, matching the documented style', () => {
    const source = edited(addNode(SOURCE, 'extra', defaultNode('menu')));
    expect(source).toContain('options: { "1": Option 1 }');
  });

  it('refuses duplicates and bad ids', () => {
    expect(addNode(SOURCE, 'menu', defaultNode('hangup'))).toEqual({
      ok: false,
      error: 'duplicate_node_id',
    });
    expect(addNode(SOURCE, 'a b', defaultNode('hangup'))).toEqual({
      ok: false,
      error: 'invalid_node_id',
    });
  });
});

describe('exit and entry edits', () => {
  it('wires, rewires, and removes exits', () => {
    let source = edited(addNode(SOURCE, 'voicemail', defaultNode('message')));
    source = edited(setExit(source, 'menu', 'no_input', 'voicemail'));
    expect(checkFlow(source).flow?.nodes['menu']?.exits?.['no_input']).toBe('voicemail');

    source = edited(removeExit(source, 'menu', 'no_input'));
    expect(checkFlow(source).flow?.nodes['menu']?.exits?.['no_input']).toBeUndefined();
  });

  it('moves entry only to an existing node', () => {
    const source = edited(setEntry(SOURCE, 'menu'));
    expect(checkFlow(source).flow?.entry).toBe('menu');
    expect(setEntry(SOURCE, 'ghost')).toEqual({ ok: false, error: 'unknown_node' });
  });
});

describe('setNodeValue', () => {
  it('sets scalar config, nested paths, and deletes on undefined', () => {
    let source = edited(setNodeValue(SOURCE, 'welcome', ['prompt'], 'Welcome to Luigi’s!'));
    let flow = checkFlow(source).flow;
    const welcome = flow?.nodes['welcome'];
    expect(welcome?.kind === 'greeting' && welcome.prompt).toBe('Welcome to Luigi’s!');

    source = edited(setNodeValue(source, 'menu', ['options', '2'], 'Hours'));
    flow = checkFlow(source).flow;
    const menu = flow?.nodes['menu'];
    expect(menu?.kind === 'menu' && menu.options).toEqual({ '1': 'Loop', '2': 'Hours' });

    source = edited(setNodeValue(source, 'menu', ['options', '2'], undefined));
    flow = checkFlow(source).flow;
    const trimmed = flow?.nodes['menu'];
    expect(trimmed?.kind === 'menu' && trimmed.options).toEqual({ '1': 'Loop' });
  });

  it('sets an audio prompt object', () => {
    const source = edited(setNodeValue(SOURCE, 'welcome', ['prompt'], { audio: 'welcome' }));
    const flow = checkFlow(source).flow;
    const welcome = flow?.nodes['welcome'];
    expect(welcome?.kind === 'greeting' && welcome.prompt).toEqual({ audio: 'welcome' });
  });
});

describe('node positions', () => {
  it('stores a rounded [x, y] pair under ui.positions, preserving comments', () => {
    const source = edited(setNodePosition(SOURCE, 'menu', 220.6, 96.2));
    expect(source).toContain('menu: [ 221, 96 ]');
    expect(source).toContain('swap this for your own greeting');
    const { flow } = checkFlow(source);
    expect(nodePositions(flow?.ui)).toEqual({ menu: { x: 221, y: 96 } });
    expect(checkFlow(source).valid).toBe(true);
  });

  it('overwrites an existing position and refuses an unknown node', () => {
    let source = edited(setNodePosition(SOURCE, 'menu', 10, 10));
    source = edited(setNodePosition(source, 'menu', 30, 40));
    expect(nodePositions(checkFlow(source).flow?.ui)).toEqual({ menu: { x: 30, y: 40 } });
    expect(setNodePosition(SOURCE, 'ghost', 0, 0)).toEqual({ ok: false, error: 'unknown_node' });
  });

  it('renameNode and removeNode keep ui.positions keys in sync', () => {
    let source = edited(setNodePosition(SOURCE, 'menu', 30, 40));
    source = edited(renameNode(source, 'menu', 'main_menu'));
    expect(nodePositions(checkFlow(source).flow?.ui)).toEqual({ main_menu: { x: 30, y: 40 } });
    source = edited(removeNode(source, 'main_menu'));
    expect(nodePositions(checkFlow(source).flow?.ui)).toEqual({});
  });

  it('clearNodePositions drops the block but keeps unrelated ui keys', () => {
    let source = edited(setNodePosition(SOURCE, 'menu', 30, 40));
    source = edited(clearNodePositions(source));
    expect(source).not.toContain('positions');
    // The fixture's pre-existing ui content is untouched.
    expect(checkFlow(source).flow?.ui).toEqual({ welcome: { x: 10, y: 20 } });
  });

  it('clearNodePositions removes a ui block it leaves empty', () => {
    const bare = SOURCE.replace('ui:\n  welcome: { x: 10, y: 20 }\n', '');
    let source = edited(setNodePosition(bare, 'menu', 30, 40));
    source = edited(clearNodePositions(source));
    expect(source).not.toContain('ui:');
    expect(checkFlow(source).flow?.ui).toBeUndefined();
  });

  it('nodePositions ignores junk shapes instead of throwing', () => {
    expect(nodePositions(undefined)).toEqual({});
    expect(nodePositions('text')).toEqual({});
    expect(nodePositions({ positions: [1, 2] })).toEqual({});
    expect(
      nodePositions({
        positions: { a: [1, 2], b: [1], c: ['x', 2], d: null, e: [Infinity, 0] },
      }),
    ).toEqual({ a: { x: 1, y: 2 } });
  });
});

describe('stampIdentity', () => {
  it('stamps platform-assigned id and version without touching the rest', () => {
    const source = edited(stampIdentity(SOURCE, { id: 'flow_abc123', version: 4 }));
    const { flow } = checkFlow(source);
    expect(flow?.id).toBe('flow_abc123');
    expect(flow?.version).toBe(4);
    expect(source).toContain('swap this for your own greeting');
  });

  it('fails cleanly on unparseable text', () => {
    expect(stampIdentity('nodes: [', { id: 'x' })).toEqual({ ok: false, error: 'parse_failed' });
  });
});
