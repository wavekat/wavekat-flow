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
- [ ] `mutate.ts` — comment-preserving edits (stays TS-only; the daemon never
      edits). Depends on the `yaml` CST, not the generated types.
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
- [ ] `validate.rs` — the semantic twin of `validate.ts` (must agree via corpus).
- [ ] `hours.rs` — timezone/date math (`time`, `time-tz` deps come along).
- [ ] `engine.rs` — interpreter + the `FlowEffects` async trait **definition**
      (the daemon keeps its `CallFlowEffects` *impl* in `wavekat-voice`).
- [ ] `trace.rs` — Serialize-only run trace (output format, not document shape).
- [ ] ⚠️ Reconcile the generated `Node` shape with the code. typify emits an
      internally-tagged enum with `exits` per variant; the current crate uses
      `Node { #[flatten] config: Component, exits }`. The wire format is
      identical (proven by the corpus), but `validate.rs`/`engine.rs` reference
      `node.config` / `Component::*` — adapt them to the generated names, or add
      a thin hand-written façade over the generated enum.
- [ ] Bring the `dev-dependency` on `tokio` for the engine's async scenario tests.

### Corpus — turn on the semantic half
- [~] Wire the `semantic` field of each `*.expected.json` into **both** test
      suites (today only `structurallyValid` is asserted). **TS done** (subset
      match: `valid === semantic.ok` + every listed code reported, since a single
      defect can cascade e.g. dangling→trapped); Rust pending (Phase 2 step 4).
- [ ] Add regression cases for the reachability/trap/exit-exactness rules and the
      hours edge cases (overnight rejected, DST, holiday exception override).
- [ ] ⚠️ Encode the one deliberate divergence: unknown fields are a
      non-blocking `unknown_field` **warning** in TS and silently ignored by
      Rust serde — both still *accept* the document. The corpus must treat these
      as accepted, with the TS-only warning asserted separately.

### Housekeeping
- [ ] Source shared constants (`SUPPORTED_SCHEMA_VERSIONS`, `MAX_PROMPT_CHARS`,
      `VALID_DIGITS`, defaults) from one place instead of re-declaring per language.
- [ ] Add reciprocal cross-language pointers (the Rust crate currently has no
      "check the TS side" note; the TS side already points at Rust).

---

## Phase 3 — publish & adopt

Trigger: the format is stable enough and the repo is ready to be public.

### Make the packages publishable
- [ ] TS: add a real build (emit `dist/` with `.d.ts`, drop `noEmit`), point
      `main`/`module`/`types` at `dist/`, add `exports` + `files`, remove
      `"private": true`, set `publishConfig.access: "public"`, add
      `prepublishOnly`. (Today `main` points at `src/index.ts` for workspace use.)
- [ ] Rust: flip `publish = false` → publishable; inline the
      workspace-inherited manifest fields as needed; choose real semver pins for
      deps currently `*`.
- [ ] Decide package/crate semver vs `schema_version`: version the artifacts on
      their own semver; advertise supported doc versions via
      `SUPPORTED_SCHEMA_VERSIONS`.

### Release automation (match house style)
- [ ] Rust: `release-plz` (as in `wavekat-platform-client`).
- [ ] TS: `release-please`.
- [ ] Add the publish workflows (npm + crates.io tokens) — currently omitted so
      nothing can publish before this phase.
- [ ] Add README badges (crates.io + docs.rs, and an npm badge for the TS
      package) once published — omitted now because they would 404 for an
      unpublished, private repo. Match the banner+badges header of the sibling
      crates (`wavekat-core`, `wavekat-turn`).

### Flip public + migrate consumers
- [ ] Make the GitHub repo public.
- [ ] Publish `@wavekat/flow-schema` (npm) and `wavekat-flow` (crates.io).
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
