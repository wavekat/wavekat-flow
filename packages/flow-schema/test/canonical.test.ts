// The TypeScript half of the canonical-text contract
// (docs/01-canonical-document.md §4). The Rust crate runs the same cases
// (crates/wavekat-flow/tests/canonical.rs), so the two serializers agree
// byte for byte.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { findComments, parseFlow } from '../src/parse.js';
import { serializeFlow } from '../src/serialize.js';

const corpus = fileURLToPath(new URL('../../../conformance', import.meta.url));
const canonicalDir = join(corpus, 'canonical');

const cases = readdirSync(canonicalDir)
  .filter((f) => f.endsWith('.input.yaml'))
  .map((f) => f.slice(0, -'.input.yaml'.length))
  .sort();

function decode(source: string, label: string) {
  const { flow, issues } = parseFlow(source);
  if (!flow) throw new Error(`${label}: ${JSON.stringify(issues)}`);
  return flow;
}

describe('canonical corpus', () => {
  it('has cases', () => expect(cases.length).toBeGreaterThan(0));

  for (const name of cases) {
    const read = (ext: string) => readFileSync(join(canonicalDir, `${name}.${ext}`), 'utf8');
    it(name, () => {
      const input = read('input.yaml');
      const canonical = read('canonical.yaml');
      const expected = JSON.parse(read('expected.json')) as { comments: number };

      expect(serializeFlow(decode(input, name))).toBe(canonical);
      expect(serializeFlow(decode(canonical, name))).toBe(canonical);
      expect(findComments(input)).toHaveLength(expected.comments);
      expect(findComments(canonical)).toHaveLength(0);
    });
  }
});

function validDocuments(): string[] {
  const out: string[] = [];
  for (const version of readdirSync(corpus)) {
    for (const bucket of ['valid', 'outbound/valid']) {
      const dir = join(corpus, version, bucket);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) if (f.endsWith('.yaml')) out.push(join(dir, f));
    }
  }
  return out.sort();
}

describe('serializing loses nothing', () => {
  for (const path of validDocuments()) {
    it(path.slice(corpus.length + 1), () => {
      const flow = decode(readFileSync(path, 'utf8'), path);
      const text = serializeFlow(flow);
      const back = decode(text, path);
      expect(back).toEqual(flow);
      expect(serializeFlow(back)).toBe(text);
    });
  }
});
