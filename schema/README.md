# schema/ — the normative source of truth

`flow.v1.schema.json` is the authoritative definition of the WaveKat call-flow
document shape for `schema_version: 1`. It is JSON Schema **draft 2020-12**.

Everything downstream is generated or checked against this file:

- `packages/flow-schema` runs `json-schema-to-typescript` over it →
  `src/generated/model.ts` (committed, drift-guarded).
- `crates/wavekat-flow` runs `typify` over it at build time → the `model`
  module (regenerated every build, so it can never drift). `build.rs`
  mechanically rewrites draft-2020-12 `$defs`/`$ref` into the draft-07 shape
  `typify` reads — one source file, deterministic rewrite.

## What the schema owns vs. what it does not

The schema owns **structure only**:

- the field set and types of `Flow` and every node kind,
- the `kind` discriminated union (`greeting`, `hours`, `menu`, `ring`,
  `message`, `transfer`, `hangup`),
- enums (`MessageTone`), the `Prompt` = `string | { audio, transcript? }` shape
  (`transcript` is the optional text an audio clip was synthesized from),
- required vs. optional fields and their defaults,
- `schema_version` pinned to `1` (a document declaring another version does not
  validate against *this* file — it validates against that version's file).

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
| Safe-subset YAML (reject anchors, aliases, tags, duplicate keys) | concrete-syntax concern; anchors don't survive parsing |

## Unknown fields

The schema keeps `additionalProperties` permissive, matching **both**
implementations' accept set: Rust `serde` silently ignores unknown fields; the
TypeScript parser accepts them and surfaces a non-blocking `unknown_field`
warning. A stray field is never a hard structural error.

## Changing the schema

1. Edit `flow.v1.schema.json` (additive changes only within a version).
2. `pnpm --filter @wavekat/flow-schema gen` and commit the regenerated files.
3. `pnpm --filter @wavekat/flow-schema test` and `cargo test -p wavekat-flow` —
   the corpus must stay green, including every previously-valid document.
4. A breaking change is a **new** `schema_version`: add `flow.v2.schema.json`
   and a new `conformance/v2/` corpus; leave v1 frozen.
