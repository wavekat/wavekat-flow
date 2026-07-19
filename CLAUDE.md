# Claude Code Context — wavekat-flow

## What this repo is

The **single source of truth** for the WaveKat call-flow ("Receptionist")
document format. The normative JSON Schema lives in `schema/`; the
`@wavekat/flow-schema` npm package and the `wavekat-flow` Rust crate both
**generate their model types from it**; the `conformance/` corpus is run by
both languages to guarantee they agree.

It replaces the previous arrangement where the platform (TS) and the voice
daemon (Rust) each hand-maintained a twin of the model + validator with no
shared tests. See `README.md` for the full design and the phased roadmap.

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

Both packages are **published** (`@wavekat/flow-schema` on npm, `wavekat-flow`
on crates.io) and stay `0.0.x` until the consumer repos have adopted them. Do
not `npm publish` / `cargo publish` manually — releases are cut by the
automation: `release-please` (TS, tags `flow-schema-vX.Y.Z`) and `release-plz`
(Rust, tags `wavekat-flow-vX.Y.Z`) maintain release PRs; merging a release PR
publishes. Publish jobs are gated on the `RELEASE_ENABLED` repo variable
(set). npm auth is trusted publishing (OIDC — no token; the npm package trusts
`release-please.yml` in this repo, so renaming that file breaks publishing);
crates.io auth is the org-level `CARGO_REGISTRY_TOKEN` secret.

## Conventions

- Commits & PR titles: Conventional Commits (`feat:`, `fix:`, `docs:`, …),
  under 50 chars.
- **No private repo names.** The consumer repos are private; this repo (and
  its published packages) is public-facing. Refer to them generically — "the
  platform" (TS) and "the voice daemon" (Rust) — never by repo name or GitHub
  URL, anywhere: docs, code comments, commit messages.
- License: Apache-2.0 (matches the other public WaveKat crates).
- **Docs naming**: numbered `NN-name.md` (e.g. `48-ivr-call-flows.md`) for
  design docs / feature plans that progress over a lifecycle; `UPPERCASE.md`
  (e.g. `ROADMAP.md`) for persistent meta docs that evolve in place.
