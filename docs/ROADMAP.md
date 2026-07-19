# Roadmap & TODO

Living checklist for finishing the consolidation. Phase 1 (foundation) is done
and on `main`; this file tracks what remains. See the top-level `README.md` for
the why, and `CLAUDE.md` for the non-negotiables.

Legend: `[ ]` todo · `[~]` partial · `[x]` done · ⚠️ correctness-sensitive.

---

## Phase 1 — foundation ✅ (done)

- [x] Normative `schema/flow.v1.schema.json` (JSON Schema draft 2020-12).
- [x] Cross-language conformance corpus `conformance/v1/` (valid + invalid) with
      the frozen-case backward-compat contract.
- [x] TS package generates model types from the schema
      (`json-schema-to-typescript`); corpus validated with `ajv`; green.
- [x] Rust crate generates model types from the schema at build (`typify`,
      `build.rs` rewrites `$defs`→`definitions`); corpus validated with
      `jsonschema` + deserialized into the generated model; green.
- [x] CI: drift guard + both test suites. Apache-2.0, README, per-dir READMEs.

---

## Phase 2 — full consolidation (move the hand-written logic in)

Goal: the validators, hours math, parser, mutator, and engine live here — one
copy per language, adapted to the **generated** types, covered by the corpus.
Nothing is migrated in the consumer repos yet (that's Phase 3).

### TypeScript — move from `wavekat-platform/packages/flow-schema/src`
- [x] `parse.ts` — safe-subset YAML decode (anchors/aliases/tags/dup-keys/
      implicit-typing rejection, `nodeRanges` source offsets).
- [x] `mutate.ts` — comment-preserving edits (stays TS-only; the daemon never
      edits). Works on the `yaml` CST, not the generated types; only import
      from the model is `ComponentKind`. 20-case suite ported.
- [x] `validate.ts` — reachability BFS, caller-trap, exit-set exactness, DTMF,
      prompt length. ⚠️ dangling-target code reconciled to the frozen corpus:
      `unknown_exit_target` → `unknown_target`.
- [x] `hours.ts` — `HH:MM`/date/IANA-tz checks, `open<close`, no overnight.
- [x] `check.ts` (parse+validate gate) and `issues.ts` (`Issue`, `hasErrors`,
      `MISSING_ASSET`).
- [x] Decide the fate of the model helpers currently in `model.ts`
      (`isTerminal`, `requiredExits`, `promptText`, `promptAudio`,
      `isGeneratedClipRef`, `requiredAssets`): kept as hand-written functions
      layered on the generated types in `src/model.ts` — they are logic, not shape.
- [x] Adapt every import from the old hand-written `model.ts` to
      `src/model.ts` (which re-exports `src/generated/model.ts`).
- [x] Port the existing `*.test.ts` suites (`parse`, `validate`, `refs`); the
      `mutate` suite waits on `mutate.ts` above.

### Rust — move from `wavekat-voice/crates/wavekat-flow/src`
- [x] `validate.rs` — the semantic twin of `validate.ts` (agrees via corpus);
      `ValidationError::code()` maps to the shared code vocabulary
      (`unknown_target`, matching the frozen corpus).
- [x] `hours.rs` — timezone/date math (`time`, `time-tz` deps came along).
      `validate_config` is piece-based (unchanged); `evaluate` takes `&Node`.
- [x] `engine.rs` — interpreter + the `FlowEffects` async trait **definition**
      (the daemon keeps its `CallFlowEffects` *impl* in `wavekat-voice`).
      Matches on the generated `Node` directly; `goto`/menu use `node.exits()`.
- [x] `trace.rs` — Serialize-only run trace (output format, not document
      shape); `flow_version` is `u64` to match the generated `Flow`.
- [x] ⚠️ Reconcile the generated `Node` shape. It was **worse** than the note
      assumed: typify emitted an `#[serde(untagged)]` enum with `kind:
      serde_json::Value`, which mis-discriminated (a `menu` deserialized as a
      `greeting`, silently dropping `options`) — the corpus only checked "does
      it deserialize at all", so it passed. Fixed in `build.rs` (Rust-only, no
      schema / generated-type hand-edits): inline the per-node `oneOf` `$ref`s
      and rewrite the `kind` `const`→single-value `enum`, so typify emits
      `#[serde(tag = "kind")]` with `exits` per variant. Hand-written helpers
      (`kind`, `is_terminal`, `required_exits`, `exits`, `Prompt::as_text`,
      `Flow::from_yaml`) live in `src/model_ext.rs` — the Rust twin of
      `model.ts` (logic, not shape).
- [x] Bring the `dev-dependency` on `tokio` for the engine's async scenario
      tests. (`anyhow` + `async-trait` also came along, as deps — the public
      `FlowEffects` trait signature uses them.)

### Corpus — turn on the semantic half
- [x] Wire the `semantic` field of each `*.expected.json` into **both** test
      suites (was: only `structurallyValid`). Subset match on both sides:
      acceptance matches (`valid === semantic.ok`) + every listed code reported,
      since a single defect can cascade (e.g. dangling→trapped). Rust maps serde
      parse failures to codes (`missing_field`, `unknown_kind`) alongside
      `ValidationError::code()`.
- [x] Add regression cases for the reachability/trap/exit-exactness rules and the
      hours edge cases: `invalid/{unreachable,trapped,unexpected-exit,
      overnight-hours,bad-timezone}` and `valid/hours-holiday` (holiday exception
      override). Forced a cross-language fix: Rust wrapped all hours defects as
      one `hours` code; now `ValidationError::Hours` delegates to
      `HoursError::code()` so both languages report the specific code
      (`non_positive_range`, `unknown_timezone`, …). (DST-specific corpus cases
      still worth adding later; `hours.rs`'s DST math is unit-tested.)
- [x] ⚠️ Encode the one deliberate divergence: unknown fields are a
      non-blocking `unknown_field` **warning** in TS and silently ignored by
      Rust serde — both still *accept* the document. `valid/unknown-field` +
      an optional `tsWarnings` field in `*.expected.json`, asserted by the TS
      suite and ignored by Rust.

### Housekeeping
- [x] Source shared constants. Decision: keep the ~4 semantic constants
      (`SUPPORTED_SCHEMA_VERSIONS`, `MAX_PROMPT_CHARS`, `VALID_DIGITS`)
      per-language with reciprocal twin pointers rather than add a shared
      codegen step for so few values. Component **defaults** are already
      single-sourced — they live in the schema, so typify reads them for Rust.
- [x] Add reciprocal cross-language pointers. Each side's constants name their
      twin (`model.ts` ↔ `validate.rs`/`lib.rs`); the Rust modules' headers
      already point back at the TS files. Fixed stale `model.rs` references in
      `model.ts` (the Rust helpers live in `model_ext.rs`).

---

## Phase 3 — publish & adopt

Trigger: the format is stable enough and the repo is ready to be public.

### Make the packages publishable
- [x] TS: real build via `tsconfig.build.json` (ESM + `.d.ts` + maps into
      `dist/`, schema JSON copied in), `main`/`module`/`types`/`exports` point
      at `dist/`, `files: ["dist"]`, `private` dropped, `publishConfig.access:
      "public"`, `prepublishOnly` (typecheck + test + build), `repository` +
      bundled `LICENSE`. Workspace dev flow unchanged (tests import `src/`).
- [x] Rust: `publish = false` dropped; `cargo package` verify passes. The
      catch was self-containment, not manifest fields: `build.rs` and
      `FLOW_V1_SCHEMA`'s `include_str!` read `../../schema/…`, which doesn't
      exist in a packaged crate. Now a committed crate-local
      `schema/flow.v1.schema.json` copy ships in the package; `build.rs` syncs
      it from the root schema in workspace builds (CI fails on a stale copy)
      and builds from it when packaged. `tests/` excluded from the package
      (the conformance suite needs the repo checkout). Keywords/categories
      added; no `*` dep pins existed anymore. CI now runs the TS `build` and
      `cargo package` so neither artifact can regress.
- [x] Package/crate semver vs `schema_version`: independent semver; supported
      doc versions advertised via `SUPPORTED_SCHEMA_VERSIONS` (see README
      "Versioning"). Both artifacts sit at `0.0.1` and stay `0.0.x` until the
      consumer repos have adopted the published packages.

### Release automation (match house style)
- [x] Rust: `release-plz` (workflow shape from `wavekat-platform-client`, on
      hosted runners like the rest of this repo's CI). Tags
      `wavekat-flow-vX.Y.Z` (crate-name prefix so the two tag streams in this
      repo can't collide).
- [x] TS: `release-please` (manifest mode, as in `wavekat-brand`/`wavekat-lab`).
      Component `flow-schema`, tags `flow-schema-vX.Y.Z`; pre-major bump
      config keeps `feat:`/`fix:` on `0.0.x` patch bumps. Manifest starts at
      `0.0.0` so the first cut release is the as-yet-unpublished `0.0.1`.
- [x] Publish switches flipped (2026-07-19): `RELEASE_ENABLED` set, both
      `0.0.1` releases published — the `wavekat-flow` crates.io name and
      `@wavekat/flow-schema` npm scope are claimed. npm auth is trusted
      publishing (OIDC, no stored token; the npm package trusts
      `release-please.yml` in this repo); crates.io auth is the org-level
      `CARGO_REGISTRY_TOKEN` secret.
- [ ] Add README badges (crates.io + docs.rs, and an npm badge for the TS
      package) once published — omitted now because they would 404 for an
      unpublished, private repo. Match the banner+badges header of the sibling
      crates (`wavekat-core`, `wavekat-turn`).

### Flip public + migrate consumers
- [ ] Make the GitHub repo public.
- [x] Publish `@wavekat/flow-schema` (npm) and `wavekat-flow` (crates.io) —
      both at `0.0.1`, 2026-07-19 (published ahead of the repo going public).
- [ ] `wavekat-platform`: delete `packages/flow-schema`, depend on the published
      npm package. Import paths are unchanged, so this is a dependency swap.
- [ ] `wavekat-voice`: replace the `crates/wavekat-flow` path crate with the
      registry dependency; bump.
- [ ] Migrate doc 48 (`wavekat-voice/docs/48-ivr-call-flows.md`) into `docs/`
      here; leave a pointer behind in `wavekat-voice`.

---

## Open questions

- [ ] Engine placement/timing. doc 48 wanted the Rust engine extracted only
      after M2. It's coming in with Phase 2 here because the boundary is already
      clean (no SQLite/UI/sync deps; the sole `FlowEffects` impl is in the
      daemon). Confirm this is acceptable, or split the engine into a later step.
- [ ] Should the model **helpers** (`requiredExits`, `isTerminal`, …) be
      generated (via a schema extension / annotations) or stay hand-written
      twins? Leaning hand-written — they're small and are logic, not shape.
- [ ] `schema_version` 2 planning: the `assistant` node (doc 48 M3) will be the
      first additive bump — it lands as `schema/flow.v2.schema.json` + a frozen
      `conformance/v2/`, with v1 untouched.
