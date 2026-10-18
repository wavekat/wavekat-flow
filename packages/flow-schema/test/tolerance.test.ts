// Older readers must keep reading newer documents. A daemon built from an
// older release parses whatever the platform writes today, so the schema must
// never close an object to unknown keys: no `additionalProperties: false` and
// no `unevaluatedProperties: false` anywhere. The Rust crate has the same test
// (crates/wavekat-flow/tests/tolerance.rs).
//
// There is no intentional exception: the opaque `ui` block is simply
// unconstrained, and the `additionalProperties` that do exist are sub-schemas
// (node map, option labels), not `false`.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const schemaDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'schema');

function closedObjects(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => closedObjects(v, `${path}/${i}`, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if ((key === 'additionalProperties' || key === 'unevaluatedProperties') && v === false) {
        out.push(`${path}/${key}`);
      }
      closedObjects(v, `${path}/${key}`, out);
    }
  }
}

const schemas = readdirSync(schemaDir).filter((f) => /^flow\.v\d+\.schema\.json$/.test(f));

describe('schema tolerates unknown keys', () => {
  it('finds the schema files', () => {
    expect(schemas.length).toBeGreaterThan(0);
  });

  it.each(schemas)('%s closes no object to unknown keys', (file) => {
    const schema = JSON.parse(readFileSync(resolve(schemaDir, file), 'utf8'));
    const closed: string[] = [];
    closedObjects(schema, '', closed);
    expect(closed, 'closing an object would break older readers of newer documents').toEqual([]);
  });
});
