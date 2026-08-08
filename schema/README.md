# schema/ — the normative source of truth

One file per format version. `flow.vN.schema.json` is the authoritative
definition of the WaveKat call-flow document shape for `schema_version: N`, in
JSON Schema **draft 2020-12**. A document validates against the file for the
version it declares, and no other.

| file | describes | new in it |
|---|---|---|
| `flow.v1.schema.json` | `schema_version: 1` | the original seven components |
| `flow.v2.schema.json` | `schema_version: 2` | `book` — appointment booking over the phone |

Version 2 is version 1 plus one component: every v1 document is a valid v2
document once its `schema_version` is bumped, and nothing else changed.

Everything downstream is generated or checked against these files:

- `packages/flow-schema` runs `json-schema-to-typescript` over the **newest**
  schema → `src/generated/model.ts` (committed, drift-guarded).
- `crates/wavekat-flow` runs `typify` over the newest schema at build time →
  the `model` module (regenerated every build, so it can never drift).
  `build.rs` mechanically rewrites draft-2020-12 `$defs`/`$ref` into the
  draft-07 shape `typify` reads — one source file, deterministic rewrite.
- Structural validation compiles **every** version's schema and dispatches on
  the document's own `schema_version` (`src/structure.ts`,
  `wavekat_flow::flow_schema`).

**One model, many schemas.** Types are generated only from the newest version,
because a consumer reads every supported version through one `Flow`. The single
mechanical concession: each schema pins `schema_version` with a `const`, which
both generators relax to a plain integer, so the model can hold — and a parser
can *represent*, so a validator can reject — a version this build doesn't
support. The schema files themselves keep the `const`, and the structural
validators keep enforcing it.

## What the schema owns vs. what it does not

The schema owns **structure only**:

- the field set and types of `Flow` and every node kind,
- the `kind` discriminated union (`greeting`, `hours`, `menu`, `ring`,
  `message`, `transfer`, `hangup`, and `book` from v2),
- enums (`MessageTone`), the `Prompt` = `string | { audio, transcript? }` shape
  (`transcript` is the optional text an audio clip was synthesized from),
- required vs. optional fields and their defaults,
- `schema_version` pinned to that file's version (a document declaring another
  version does not validate against it — it validates against that version's
  file).

The schema deliberately does **not** encode the format's semantic rules,
because a JSON Schema cannot express them. These live in each language's
validator and are pinned by the shared `conformance/` corpus:

| Rule | Why the schema can't own it |
|---|---|
| Exit-set exactness (a `menu` must wire exactly its digits + `no_input` + `invalid`) | depends on the node's own `options` |
| Dangling exit targets / graph reachability / caller-trap | cross-node graph analysis |
| DTMF digit validity of `menu.options` keys | reported as a specific validator error, kept single-owned |
| Hours: `HH:MM` format, `open < close`, no overnight, IANA timezone resolves | procedural / calendar math |
| Prompt length (≤ 2000 chars) | grapheme-aware count |
| `book` numeric bounds, and whether its schedule leaves room for one appointment | arithmetic over the node's own schedule |
| Which components a `schema_version` may carry | a rule *about* versions, not expressible inside one |
| Safe-subset YAML (reject anchors, aliases, tags, duplicate keys) | concrete-syntax concern; anchors don't survive parsing |

## Unknown fields

The schema keeps `additionalProperties` permissive, matching **both**
implementations' accept set: Rust `serde` silently ignores unknown fields; the
TypeScript parser accepts them and surfaces a non-blocking `unknown_field`
warning. A stray field is never a hard structural error.

## Changing the schema

1. Edit the newest `flow.vN.schema.json` (additive changes only within a
   version — a released version's file is frozen the moment a document
   declaring it exists in the wild).
2. `pnpm --filter @wavekat/flow-schema gen` and commit the regenerated files.
3. `pnpm --filter @wavekat/flow-schema test` and `cargo test -p wavekat-flow` —
   the corpus must stay green, including every previously-valid document.
4. **A new component is a new `schema_version`**, even though it is additive in
   shape: a device running an older build has no code for it, and must be told
   so rather than handed a document it will fail to parse. Add
   `flow.vN+1.schema.json` and a `conformance/vN+1/` corpus, leave the previous
   version's file and corpus alone, extend `SUPPORTED_SCHEMA_VERSIONS` and the
   per-kind minimum version in both validators, and add the new version to
   `VERSIONS` in `scripts/generate.mjs` and `build.rs`.
