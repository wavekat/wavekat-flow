# Claude Code Context — wavekat-flow

## What this repo is

The **single source of truth** for the WaveKat call-flow ("Receptionist")
document format. The normative JSON Schema lives in `schema/`; the
`@wavekat/flow-schema` npm package and the `wavekat-flow` Rust crate both
**generate their model types from it**; the `conformance/` corpus is run by
both languages to guarantee they agree.

It replaces the previous arrangement where `wavekat-platform` (TS) and
`wavekat-voice` (Rust) each hand-maintained a twin of the model + validator
with no shared tests. See `README.md` for the full design and the phased
roadmap.

## Non-negotiables

- **The schema is authoritative.** Never hand-edit generated model types.
  Change `schema/flow.v1.schema.json`, then regenerate:
  - TS: `pnpm --filter @wavekat/flow-schema gen` (commit `src/generated/*`).
  - Rust: no generated types to commit — `build.rs` regenerates from the
    schema every build, so the crate can't drift. It also syncs the committed
    crate-local copy `crates/wavekat-flow/schema/flow.v1.schema.json` (shipped
    so the packaged crate is self-contained); commit that too — CI fails if
    it's stale. Never edit the copy by hand.
- **The corpus is frozen.** A case in `conformance/vN/` is a permanent
  contract. You may add cases; you may not silently change a case's expected
  outcome to make a build pass. Incompatible format changes get a new
  `schema_version` and a new `conformance/vN/` directory. This is the
  backward-compatibility guarantee.
- **Both languages must stay green** on any schema change: `pnpm --filter
  @wavekat/flow-schema test` and `cargo test -p wavekat-flow`.
- **Structure vs. semantics.** The schema owns shape only. Reachability, exit
  wiring, hours math, DTMF/prompt rules, YAML footgun rejection, and the engine
  are hand-written per language (Phase 2) and pinned by the corpus — not
  encoded in the schema. See `schema/README.md`.

## Layout

- `schema/flow.v1.schema.json` — the source of truth (JSON Schema draft 2020-12).
- `conformance/v1/{valid,invalid}/*.{yaml,expected.json}` — the shared corpus.
- `packages/flow-schema/` — TS package; types generated into `src/generated/`.
- `crates/wavekat-flow/` — Rust crate; types generated at build via `build.rs`
  (which rewrites 2020-12 `$defs`/`$ref` into the draft-07 shape typify reads).
- `docs/` — format spec pointer (doc 48 migrates here in a later phase).

## Toolchain

- Node 22 + pnpm (workspace). Rust stable (edition 2021, MSRV 1.88).
- TS codegen: `json-schema-to-typescript`. Rust codegen: `typify` (build dep).
- Structural validation: `ajv` (TS) / `jsonschema` (Rust) — both draft 2020-12.

## Release posture

Both packages are publish-*shaped* (real `dist/` build, self-contained crate,
`cargo package` verified in CI) but **unpublished**, versioned `0.0.x`. They go
to the public registries only when the repo itself goes public (Phase 3, via
the release automation — not by hand). Do not `npm publish` / `cargo publish`
manually.

## Conventions

- Commits & PR titles: Conventional Commits (`feat:`, `fix:`, `docs:`, …),
  under 50 chars.
- License: Apache-2.0 (matches the other public WaveKat crates).
- **Docs naming**: numbered `NN-name.md` (e.g. `48-ivr-call-flows.md`) for
  design docs / feature plans that progress over a lifecycle; `UPPERCASE.md`
  (e.g. `ROADMAP.md`) for persistent meta docs that evolve in place.
