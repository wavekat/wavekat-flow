// Generate the TypeScript model from the normative JSON Schema — the
// single source of truth lives at ../../../schema/flow.v1.schema.json.
// This script is the TS half of "generate types from schema": it copies
// the schema into the package (so the published artifact is
// self-contained) and emits src/generated/model.ts. The generated file
// is committed; CI runs `gen` and fails on any diff (drift guard).

import { compileFromFile } from 'json-schema-to-typescript';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const repoRoot = resolve(pkg, '..', '..');
const schemaPath = resolve(repoRoot, 'schema', 'flow.v1.schema.json');
const genDir = resolve(pkg, 'src', 'generated');

await mkdir(genDir, { recursive: true });

// 1. Bundle the schema into the package so the validator and downstream
//    consumers don't reach outside the package at runtime.
await copyFile(schemaPath, resolve(genDir, 'flow.v1.schema.json'));

const banner =
  '// GENERATED from schema/flow.v1.schema.json by scripts/generate.mjs — do not edit.\n' +
  '// Run `pnpm gen` after changing the schema; CI fails on drift.\n';

// 2. Emit the schema as a TS module. The runtime imports this instead of
//    the bundled JSON file: a JSON import needs `with { type: 'json' }`,
//    which older consumer bundlers (e.g. wrangler 3's pinned esbuild)
//    cannot parse in the published dist.
const schemaSource = JSON.parse(await readFile(schemaPath, 'utf8'));
const schemaTs =
  banner +
  '\nconst schema = ' +
  JSON.stringify(schemaSource, null, 2) +
  ' as const;\n\nexport default schema;\n';
await writeFile(resolve(genDir, 'schema.ts'), schemaTs);

// 3. Emit the model types from the schema.

const ts = await compileFromFile(schemaPath, {
  bannerComment: banner,
  additionalProperties: true, // unknown fields are accepted (matches both twins)
  style: { singleQuote: true },
});

await writeFile(resolve(genDir, 'model.ts'), ts);

console.log('generated src/generated/{model,schema}.ts and bundled flow.v1.schema.json');
