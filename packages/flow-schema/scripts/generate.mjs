// Generate the TypeScript model from the normative JSON Schemas — the
// single source of truth lives at ../../../schema/flow.vN.schema.json.
// This script is the TS half of "generate types from schema": it copies
// every version's schema into the package (so the published artifact is
// self-contained) and emits src/generated/model.ts. The generated file
// is committed; CI runs `gen` and fails on any diff (drift guard).
//
// One model, many schemas. Each schema file describes exactly one
// `schema_version` and is what a document of that version is validated
// against (see src/structure.ts). The *types*, though, have to hold any
// supported version — a consumer reads v1 and v2 documents through one
// `Flow` — so codegen runs on the NEWEST schema only, which is a
// superset of its predecessors, with one mechanical relaxation applied
// (below). The Rust twin does the same in crates/wavekat-flow/build.rs.

import { compile } from 'json-schema-to-typescript';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const repoRoot = resolve(pkg, '..', '..');
const genDir = resolve(pkg, 'src', 'generated');

// Oldest first; the last entry is the one the model is generated from.
const VERSIONS = [1, 2];
const schemaPathFor = (v) => resolve(repoRoot, 'schema', `flow.v${v}.schema.json`);

await mkdir(genDir, { recursive: true });

// 1. Bundle every schema into the package so the validator and downstream
//    consumers don't reach outside the package at runtime.
for (const v of VERSIONS) {
  await copyFile(schemaPathFor(v), resolve(genDir, `flow.v${v}.schema.json`));
}

const banner =
  `// GENERATED from schema/flow.v{${VERSIONS.join(',')}}.schema.json by scripts/generate.mjs — do not edit.\n` +
  '// Run `pnpm gen` after changing a schema; CI fails on drift.\n';

// 2. Emit the schemas as a TS module. The runtime imports this instead of
//    the bundled JSON files: a JSON import needs `with { type: 'json' }`,
//    which older consumer bundlers (e.g. wrangler 3's pinned esbuild)
//    cannot parse in the published dist.
const sources = new Map();
for (const v of VERSIONS) {
  sources.set(v, JSON.parse(await readFile(schemaPathFor(v), 'utf8')));
}

const schemaTs =
  banner +
  VERSIONS.map(
    (v) =>
      `\nexport const flowV${v}Schema = ` +
      JSON.stringify(sources.get(v), null, 2) +
      ' as const;\n',
  ).join('') +
  `\n/** Newest supported version's schema. */\nexport default flowV${VERSIONS[VERSIONS.length - 1]}Schema;\n`;
await writeFile(resolve(genDir, 'schema.ts'), schemaTs);

// 3. Emit the model types from the newest schema.
//
//    The one rewrite: each schema pins `schema_version` with a `const`,
//    which json-schema-to-typescript faithfully renders as a literal
//    type (`schema_version: 2`). That is right for validation and wrong
//    for the model, which must be able to hold — and the parser to
//    *represent*, so the validator can reject — any version, including
//    one this build doesn't support. So the constant is relaxed to a
//    plain integer for codegen only; the schema files keep their `const`
//    and the structural validators keep enforcing it.
const modelSchema = structuredClone(sources.get(VERSIONS[VERSIONS.length - 1]));
const versionProp = modelSchema.properties.schema_version;
delete versionProp.const;
versionProp.description +=
  ' (Relaxed from a constant to a plain integer for type generation: one model type covers every supported version.)';

const ts = await compile(modelSchema, 'Flow', {
  bannerComment: banner,
  additionalProperties: true, // unknown fields are accepted (matches both twins)
  style: { singleQuote: true },
  cwd: resolve(repoRoot, 'schema'),
});

await writeFile(resolve(genDir, 'model.ts'), ts);

console.log(
  `generated src/generated/{model,schema}.ts and bundled flow.v{${VERSIONS.join(',')}}.schema.json`,
);
