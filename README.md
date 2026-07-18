<p align="center">
  <a href="https://github.com/wavekat/wavekat-flow">
    <img src="https://github.com/wavekat/wavekat-brand/raw/main/assets/banners/wavekat-flow-narrow.svg" alt="WaveKat Flow">
  </a>
</p>

Single source of truth for the [WaveKat](https://wavekat.com) call-flow
("Receptionist") document format.

A *flow* is the declarative IVR document that powers WaveKat voice lines — a
greeting, an hours check, a menu, voicemail, a transfer — authored as YAML,
validated against one schema, and executed by the daemon. Two codebases need
to read and write it:

| Consumer | Language | What it does with a flow |
|---|---|---|
| [`wavekat-platform`](https://github.com/wavekat/wavekat-platform) | TypeScript | authors, edits, validates, freezes on publish |
| [`wavekat-voice`](https://github.com/wavekat/voice) | Rust | parses, validates, runs the flow on a live call |

Historically each maintained a **hand-ported twin** of the model and validator,
kept in sync by convention (`schema_version` negotiation + "check the other
side" comments) with **no shared test corpus**. This repo removes that drift
risk by making the format's definition live in exactly one place.

## What lives here

```
schema/flow.v1.schema.json     # THE source of truth — the normative document shape
conformance/v1/                # the cross-language contract: docs + expected outcomes
packages/flow-schema/          # @wavekat/flow-schema  (npm)   — types GENERATED from the schema
crates/wavekat-flow/           # wavekat-flow          (crate) — types GENERATED from the schema
```

- **The schema is authoritative.** Both the TypeScript package and the Rust
  crate *generate their model types from `schema/flow.v1.schema.json`*
  (`json-schema-to-typescript` and `typify` respectively). Neither hand-writes
  the model; CI fails on drift.
- **The corpus is the contract.** Every document in `conformance/` carries its
  expected outcome, and **both languages run it** — TS with `ajv`, Rust with
  `jsonschema` — so structural validity means the identical thing on both
  sides. This is also the **backward-compatibility guarantee**: a corpus case
  is frozen once added, so a schema change that would reject a previously-valid
  document fails CI. See [`conformance/README.md`](./conformance/README.md).

## What a schema *cannot* own

A JSON Schema defines the document **shape** (types, enums, required fields,
the `kind` discriminated union, defaults). It cannot express the format's
**semantic rules** — graph reachability, exit-set exactness, hours/timezone
math, DTMF digit validity, prompt length, safe-subset YAML parsing,
comment-preserving edits, or the interpreter. Those are hand-written per
language and **pinned by the shared corpus**, not generated. See
[`schema/README.md`](./schema/README.md) for the exact boundary.

## Versioning

- `schema_version` is a property of the **document** (currently `1`). Each
  version gets its own `schema/flow.vN.schema.json` and its own frozen
  `conformance/vN/` corpus. Growth is additive; an unsupported version is
  rejected, never silently migrated.
- The npm package and the Rust crate version **independently** of
  `schema_version` (they track implementation releases). A given package
  release advertises which `schema_version`s it understands via
  `SUPPORTED_SCHEMA_VERSIONS`.

## Roadmap

This repo is being stood up in phases. Consumers are **not** migrated until
the repo is public (decision on record), so phases 1–2 are self-contained here.
The detailed, checkbox-level task list lives in
**[`docs/ROADMAP.md`](./docs/ROADMAP.md)**.

- **Phase 1 — foundation (this milestone).** The normative schema, the
  conformance corpus + back-compat runner, and both packages generating their
  **model types** from the schema with the corpus green in TS and Rust. Semantic
  logic still lives in the consumer repos.
- **Phase 2 — full consolidation.** Move the hand-written logic in (TS:
  safe-subset parse, comment-preserving mutation, semantic validation, hours;
  Rust: validation, hours, engine, trace), each adapted to the generated types
  and covered by the corpus. Retire the duplicated test suites in favour of the
  shared corpus.
- **Phase 3 — publish & adopt.** Flip the repo public, publish
  `@wavekat/flow-schema` to npm and `wavekat-flow` to crates.io, and switch
  `wavekat-platform` / `wavekat-voice` from their in-repo copies to the
  published artifacts.

This extends [doc 48 "Placement"](https://github.com/wavekat/voice) (the
`wavekat-voice` design doc), which had planned only to publish the JSON Schema
and extract the Rust engine crate — it had not planned the shared codegen +
conformance corpus this repo adds.

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

After editing `schema/flow.v1.schema.json`, run `pnpm --filter
@wavekat/flow-schema gen` and commit the regenerated files — CI rejects drift.

## License

Licensed under [Apache 2.0](LICENSE).

Copyright 2026 WaveKat.
