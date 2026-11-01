import { describe, expect, it } from 'vitest';

import { checkFlow } from '../src/check.js';
import { parseTemplate, templateIssues, templateNames, tryParseTemplate } from '../src/vars.js';

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
    expect(tryParseTemplate('{{#a}}{{#b}}{{/b}}{{/a}}').error).toEqual({ kind: 'nested' });
    expect(tryParseTemplate('{{#a}} x').error).toEqual({ kind: 'unclosed' });
    expect(tryParseTemplate('{{a').error).toEqual({ kind: 'unclosed' });
  });

  it('rejects mismatched closers', () => {
    expect(tryParseTemplate('{{/a}}').error).toEqual({ kind: 'mismatched', name: 'a' });
    expect(tryParseTemplate('{{#a}}{{/b}}').error).toEqual({ kind: 'mismatched', name: 'b' });
  });

  it('rejects bad names', () => {
    expect(tryParseTemplate('{{A}}').error).toEqual({ kind: 'bad_name', name: 'A' });
    expect(tryParseTemplate('{{1a}}').error).toEqual({ kind: 'bad_name', name: '1a' });
    expect(tryParseTemplate('{{}}').error).toEqual({ kind: 'bad_name', name: '' });
    expect(tryParseTemplate(`{{${'a'.repeat(32)}}}`).error).toBeNull();
    expect(tryParseTemplate(`{{${'a'.repeat(33)}}}`).error).not.toBeNull();
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
    expect(
      errorCodes(flow(4, 'variables:\n  q: { default: "", max_len: 501 }\n', body)),
    ).toContain('variable_max_len_out_of_range');
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
      checkFlow(flow(4, Q, HANGUP('"{{#q}}x{{/q}}"'))).issues.some((i) => i.code === 'unused_variable'),
    ).toBe(false);
  });
});
