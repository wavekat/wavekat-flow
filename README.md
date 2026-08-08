<p align="center">
  <a href="https://github.com/wavekat/wavekat-flow">
    <img src="https://github.com/wavekat/wavekat-brand/raw/main/assets/banners/wavekat-flow-narrow.svg" alt="WaveKat Flow">
  </a>
</p>

[![npm](https://img.shields.io/npm/v/%40wavekat%2Fflow-schema.svg)](https://www.npmjs.com/package/@wavekat/flow-schema)
[![Crates.io](https://img.shields.io/crates/v/wavekat-flow.svg)](https://crates.io/crates/wavekat-flow)
[![docs.rs](https://docs.rs/wavekat-flow/badge.svg)](https://docs.rs/wavekat-flow)

Single source of truth for the [WaveKat](https://wavekat.com) call-flow
("Receptionist") document format.

A *flow* is the declarative IVR document that powers WaveKat voice lines — a
greeting, an hours check, a menu, voicemail, a transfer, a booking — authored as YAML,
validated against one schema, and executed by the daemon. Two codebases need
to read and write it:

| Consumer | Language | What it does with a flow |
|---|---|---|
| The WaveKat platform | TypeScript | authors, edits, validates, freezes on publish |
| The voice daemon | Rust | parses, validates, runs the flow on a live call |

Historically each maintained a **hand-ported twin** of the model and validator,
kept in sync by convention (`schema_version` negotiation + "check the other
side" comments) with **no shared test corpus**. This repo removes that drift
risk by making the format's definition live in exactly one place.

## What lives here

```
schema/flow.vN.schema.json     # THE source of truth — the normative document shape, one file per version
conformance/vN/                # the cross-language contract: docs + expected outcomes, one dir per version
packages/flow-schema/          # @wavekat/flow-schema  (npm)   — generated types + authoring logic
crates/wavekat-flow/           # wavekat-flow          (crate) — generated types + validator + engine
```

- **The schema is authoritative.** Both the TypeScript package and the Rust
  crate *generate their model types from the newest `schema/flow.vN.schema.json`*
  (`json-schema-to-typescript` and `typify` respectively) — one model covers
  every supported version, while each version's schema still validates its own
  documents. Neither hand-writes the model; CI fails on drift.
- **The corpus is the contract.** Every document in `conformance/` carries its
  expected outcome — structural *and* semantic — and **both languages run
  it**, so a document means the identical thing on both sides. This is also
  the **backward-compatibility guarantee**: a corpus case is frozen once
  added, so a schema change that would reject a previously-valid document
  fails CI. See [`conformance/README.md`](./conformance/README.md).
- **The logic lives here too.** Beyond the generated model, each package
  carries its language's hand-written half of the format:
  [`@wavekat/flow-schema`](./packages/flow-schema/README.md) — safe-subset
  YAML parsing, semantic validation, hours math, comment-preserving source
  edits, and flow diffing (authoring side);
  [`wavekat-flow`](./crates/wavekat-flow/README.md) — semantic validation,
  hours math, and the flow interpreter with its run trace (execution side).

## What a schema *cannot* own

A JSON Schema defines the document **shape** (types, enums, required fields,
the `kind` discriminated union, defaults). It cannot express the format's
**semantic rules** — graph reachability, exit-set exactness, hours/timezone
math, DTMF digit validity, prompt length, safe-subset YAML parsing,
comment-preserving edits, or the interpreter. Those live here as hand-written
code per language — **pinned by the shared corpus**, not generated. See
[`schema/README.md`](./schema/README.md) for the exact boundary.

## Versioning

- `schema_version` is a property of the **document** (currently `2`). Each
  version gets its own `schema/flow.vN.schema.json` and its own frozen
  `conformance/vN/` corpus. Growth is additive; an unsupported version is
  rejected, never silently migrated.
- **A new component is a new version**, even though adding one is additive in
  shape. A device running an older build has no code for the component, so it
  has to be able to say "I don't run that version" — which is what makes it
  safe for the platform to hold back a document rather than hand over one that
  would fail to parse. `book` is why version 2 exists.
- The npm package and the Rust crate version **independently** of
  `schema_version` (they track implementation releases). A given package
  release advertises which `schema_version`s it understands via
  `SUPPORTED_SCHEMA_VERSIONS`.
- Both artifacts stay on `0.0.x` while the format settles: every release may
  break API, and nothing is promised beyond "the corpus is green". They move
  past `0.0.x` once the consumer repos have adopted the published packages.

## Status

The consolidation was staged in three phases; the checkbox-level detail lives
in **[`docs/ROADMAP.md`](./docs/ROADMAP.md)**.

- **Phase 1 — foundation. Done.** The normative schema, the conformance
  corpus + back-compat runner, and both packages generating their model types
  from the schema, corpus green in TS and Rust.
- **Phase 2 — full consolidation. Done.** The hand-written logic moved in
  (TS: safe-subset parse, comment-preserving mutation, semantic validation,
  hours; Rust: validation, hours, engine, trace), each adapted to the
  generated types, with the corpus extended to pin the semantic outcomes in
  both languages.
- **Phase 3 — publish & adopt. In progress.** The repo is public and both
  packages are published (releases are cut automatically by release-please
  from a single combined release PR). Remaining: switch the platform and the
  voice daemon from their in-repo copies to the published artifacts, and
  migrate the narrative format spec (doc 48) into `docs/`.

This extends the "Placement" section of doc 48 (the original call-flow design
doc), which had planned only to publish the JSON Schema and extract the Rust
engine crate — it had not planned the shared codegen + conformance corpus this
repo adds.

## Development

Requires Node 22 (`pnpm`) and a stable Rust toolchain.

```bash
# TypeScript package
pnpm install
pnpm --filter @wavekat/flow-schema gen        # regenerate model.ts from the schema
pnpm --filter @wavekat/flow-schema typecheck
pnpm --filter @wavekat/flow-schema test        # runs the conformance corpus

# Rust crate (types regenerate from the schema on every build)
cargo test -p wavekat-flow                      # runs the conformance corpus
```

After editing a `schema/flow.vN.schema.json`, run `pnpm --filter
@wavekat/flow-schema gen` and commit the regenerated files — CI rejects drift.

## License

Licensed under [Apache 2.0](LICENSE).

Copyright 2026 WaveKat.
