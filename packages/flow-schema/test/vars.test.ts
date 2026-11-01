import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { checkFlow } from '../src/check.js';
import type { Flow } from '../src/model.js';
import { parseFlow } from '../src/parse.js';
import { serializeFlow } from '../src/serialize.js';
import { validateOutbound } from '../src/validate.js';
import {
  fill,
  parseTemplate,
  templateIssues,
  templateNames,
  tryParseTemplate,
} from '../src/vars.js';

describe('parseTemplate', () => {
  it('parses text, vars and blocks', () => {
    expect(parseTemplate('Hi {{a}}.{{#b}} B={{b}}{{/b}}')).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'var', name: 'a' },
      { kind: 'text', text: '.' },
      {
        kind: 'block',
        name: 'b',
        body: [
          { kind: 'text', text: ' B=' },
          { kind: 'var', name: 'b' },
        ],
      },
    ]);
  });

  it('passes plain text and stray closers through', () => {
    expect(parseTemplate('')).toEqual([]);
    expect(parseTemplate('a }} b')).toEqual([{ kind: 'text', text: 'a }} b' }]);
  });

  it('rejects nested and unclosed blocks', () => {
    expect(tryParseTemplate('{{#a}}{{#b}}{{/b}}{{/a}}').error).toEqual({
      kind: 'nested',
    });
    expect(tryParseTemplate('{{#a}} x').error).toEqual({ kind: 'unclosed' });
    expect(tryParseTemplate('{{a').error).toEqual({ kind: 'unclosed' });
  });

  it('rejects mismatched closers', () => {
    expect(tryParseTemplate('{{/a}}').error).toEqual({
      kind: 'mismatched',
      name: 'a',
    });
    expect(tryParseTemplate('{{#a}}{{/b}}').error).toEqual({
      kind: 'mismatched',
      name: 'b',
    });
  });

  it('rejects bad names', () => {
    expect(tryParseTemplate('{{A}}').error).toEqual({
      kind: 'bad_name',
      name: 'A',
    });
    expect(tryParseTemplate('{{1a}}').error).toEqual({
      kind: 'bad_name',
      name: '1a',
    });
    expect(tryParseTemplate('{{}}').error).toEqual({
      kind: 'bad_name',
      name: '',
    });
    expect(tryParseTemplate(`{{${'a'.repeat(32)}}}`).error).toBeNull();
    expect(tryParseTemplate(`{{${'a'.repeat(33)}}}`).error).not.toBeNull();
  });

  it('handles brace edge cases like the Rust twin', () => {
    expect(tryParseTemplate('{{{a}}}').error).toEqual({
      kind: 'bad_name',
      name: '{a',
    });
    expect(parseTemplate('{ {a} }')).toEqual([{ kind: 'text', text: '{ {a} }' }]);
    expect(parseTemplate('}}')).toEqual([{ kind: 'text', text: '}}' }]);
    expect(tryParseTemplate('{{#a}} x {{').error).toEqual({ kind: 'unclosed' });
  });

  it('reports codes and names', () => {
    expect(templateIssues('{{a}}')).toEqual([]);
    expect(templateIssues('{{a')).toEqual(['template_syntax']);
    expect(templateIssues('{{A}}')).toEqual(['variable_bad_name']);
    expect(templateNames('{{b}} {{#a}}{{a}}{{/a}} {{b}}')).toEqual(['b', 'a']);
  });
});

const flow = (version: number, vars: string, body: string) =>
  `schema_version: ${version}\nid: f\nname: F\nentry: a\n${vars}nodes:\n${body}`;

function errorCodes(src: string): string[] {
  return checkFlow(src)
    .issues.filter((i) => i.severity === 'error')
    .map((i) => i.code);
}

const Q = 'variables:\n  q: { default: x }\n';
const HANGUP = (prompt: string) => `  a:\n    kind: hangup\n    prompt: ${prompt}\n`;

describe('placeholders in a flow', () => {
  it('v4 placeholder must be declared', () => {
    expect(errorCodes(flow(4, Q, HANGUP('"Hi {{q}} {{ghost}}"')))).toEqual(['unknown_variable']);
    expect(errorCodes(flow(4, Q, HANGUP('"Hi {{q}}"')))).toEqual([]);
  });

  it('scans menu labels and templates', () => {
    const body =
      '  a:\n    kind: menu\n    prompt: { audio: vprompt_ab12, template: "{{nope}}" }\n    options: { "1": "{{q}}", "2": "{{bad}}" }\n    exits: { "1": b, "2": b, no_input: b, invalid: b }\n  b:\n    kind: hangup\n    prompt: bye\n';
    expect(errorCodes(flow(4, Q, body))).toEqual(['unknown_variable', 'unknown_variable']);
  });

  it('reports bad syntax and names', () => {
    expect(errorCodes(flow(4, Q, HANGUP('"{{#q}} open"')))).toEqual(['template_syntax']);
    expect(errorCodes(flow(4, Q, HANGUP('"{{Q}}"')))).toEqual(['variable_bad_name']);
  });

  it('checks declared names and max_len', () => {
    const body = HANGUP('bye');
    expect(errorCodes(flow(4, 'variables:\n  Bad: { default: "" }\n', body))).toEqual([
      'variable_bad_name',
    ]);
    expect(errorCodes(flow(4, 'variables:\n  q: { default: "", max_len: 501 }\n', body))).toContain(
      'variable_max_len_out_of_range',
    );
  });

  it('refuses placeholders in a transfer target and a transcript', () => {
    expect(errorCodes(flow(4, Q, '  a:\n    kind: transfer\n    target: "{{q}}"\n'))).toEqual([
      'placeholder_not_allowed',
    ]);
    expect(
      errorCodes(flow(4, Q, HANGUP('{ audio: vprompt_ab12, transcript: "Hi {{q}}" }'))),
    ).toEqual(['placeholder_not_allowed']);
  });

  it('treats braces as plain text before v4', () => {
    expect(errorCodes(flow(3, '', HANGUP('"Press {{1}} now }} {{#x"')))).toEqual([]);
  });

  it('warns about a variable nothing uses', () => {
    const issues = checkFlow(flow(4, Q, HANGUP('bye'))).issues;
    expect(issues.filter((i) => i.code === 'unused_variable')).toMatchObject([
      { severity: 'warning', params: { name: 'q' } },
    ]);
    expect(
      checkFlow(flow(4, Q, HANGUP('"{{#q}}x{{/q}}"'))).issues.some(
        (i) => i.code === 'unused_variable',
      ),
    ).toBe(false);
  });
});

const ASK_PATH = fileURLToPath(
  new URL('../../../conformance/v4/valid/ask-question.yaml', import.meta.url),
);

function load(source: string): Flow {
  const { flow, issues } = parseFlow(source);
  if (!flow) throw new Error(JSON.stringify(issues));
  return flow;
}

const ask = (): Flow => load(readFileSync(ASK_PATH, 'utf8'));

function filled(flow: Flow, values: Record<string, string>): Flow {
  const result = fill(flow, values);
  if (!('flow' in result)) throw new Error(JSON.stringify(result.errors));
  return result.flow;
}

function askMenu(flow: Flow) {
  const node = flow.nodes.ask;
  if (node?.kind !== 'menu') throw new Error('ask is a menu');
  return node;
}

const VOICED: Flow = load(
  [
    'schema_version: 4',
    'id: f',
    'name: F',
    'entry: a',
    'variables:',
    '  name: { default: there }',
    'nodes:',
    '  a:',
    '    kind: hangup',
    '    prompt: { audio: vprompt_a, template: "Hi {{name}}" }',
    '',
  ].join('\n'),
);

describe('fill', () => {
  it('fills_question_and_two_options', () => {
    const flow = filled(ask(), {
      question: 'Which database?',
      option1: 'Postgres',
      option2: 'SQLite',
    });
    const menu = askMenu(flow);
    expect(menu.prompt).toBe(
      'Claude has a question. Which database? Press 1 for Postgres. Press 2 for SQLite. Press 9 to hear this again.',
    );
    expect(menu.options).toEqual({ '1': 'Postgres', '2': 'SQLite', '9': 'Repeat' });
    expect(menu.exits).not.toHaveProperty('3');
    expect(menu.exits).not.toHaveProperty('4');
    expect(flow.variables).toBeUndefined();
    expect(flow.schema_version).toBe(4);
  });

  it('keeps_option3_when_given', () => {
    const menu = askMenu(filled(ask(), { option3: 'Both' }));
    expect(menu.prompt as string).toContain(' Press 3 for Both.');
    expect(menu.options['3']).toBe('Both');
    expect(menu.exits?.['3']).toBe('thanks');
    expect(menu.exits).not.toHaveProperty('4');
  });

  it('no_values_plays_the_defaults', () => {
    const menu = askMenu(filled(ask(), {}));
    expect(menu.prompt).toBe(
      'Claude has a question. Claude needs your input on screen. Press 1 for Yes. Press 2 for No. Press 9 to hear this again.',
    );
    expect(menu.options).toEqual({ '1': 'Yes', '2': 'No', '9': 'Repeat' });
    expect(menu.exits).not.toHaveProperty('3');
  });

  it('rendered_prompt_stays_audio_when_defaults_kept', () => {
    const kept = filled(VOICED, {}).nodes.a;
    expect(kept).toMatchObject({ prompt: { audio: 'vprompt_a' } });
    expect(kept).not.toHaveProperty('prompt.template');
    expect(filled(VOICED, { name: 'there' }).nodes.a).toMatchObject({
      prompt: { audio: 'vprompt_a' },
    });
    expect(filled(VOICED, { name: 'Ann' }).nodes.a).toMatchObject({ prompt: 'Hi Ann' });
  });

  it('blank_value_falls_back_to_default', () => {
    expect(askMenu(filled(ask(), { question: '  ' })).prompt as string).toContain(
      'Claude needs your input on screen.',
    );
  });

  it('strips control characters', () => {
    expect(askMenu(filled(ask(), { question: ' Hi\u0007\n there ' })).prompt as string).toContain(
      'Claude has a question. Hi there Press',
    );
  });

  it('unknown_value_is_an_error', () => {
    expect(fill(ask(), { colour: 'red' })).toEqual({
      errors: [{ code: 'variable_unknown', name: 'colour' }],
    });
  });

  it('values_are_not_expanded', () => {
    expect(askMenu(filled(ask(), { question: '{{option1}} {x}' })).prompt as string).toContain(
      '{{option1}} {x}',
    );
  });

  it('max_len_counts_characters', () => {
    const flow = ask();
    flow.variables!.question!.max_len = 300;
    expect('flow' in fill(flow, { question: '问'.repeat(150) })).toBe(true);
    expect('flow' in fill(flow, { question: '问'.repeat(300) })).toBe(true);
    expect(fill(flow, { question: '问'.repeat(301) })).toEqual({
      errors: [{ code: 'variable_too_long', name: 'question' }],
    });
    // Emoji outside the BMP are one character each, not two UTF-16 units.
    expect('flow' in fill(flow, { question: '😀'.repeat(300) })).toBe(true);
  });

  it('filled_flow_passes_validate_outbound', () => {
    const cases: Record<string, string>[] = [{}, { option3: 'Both', option4: 'Neither' }];
    for (const values of cases) {
      const issues = validateOutbound(filled(ask(), values));
      expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    }
  });

  it('does not touch the input and returns a flow without variables unchanged', () => {
    const flow = ask();
    const before = serializeFlow(flow);
    filled(flow, { option3: 'Both' });
    expect(serializeFlow(flow)).toBe(before);
    const plain = load(
      'schema_version: 3\nid: f\nname: F\nentry: a\nnodes:\n  a:\n    kind: hangup\n    prompt: Hi {{x}}\n',
    );
    expect(serializeFlow(filled(plain, {}))).toBe(serializeFlow(plain));
  });
});
