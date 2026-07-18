# conformance/ — the cross-language contract

This corpus is the single mechanism that keeps the TypeScript and Rust
implementations honest. Before this repo, each side hand-ported the other's
test suite and re-embedded the same example YAML by hand, with nothing
guaranteeing they agreed. Here, one corpus is run by **both** languages.

## Layout

```
conformance/
  v1/                       # one directory per schema_version
    valid/
      <case>.yaml           # a flow document
      <case>.expected.json  # its expected outcome
    invalid/
      <case>.yaml
      <case>.expected.json
```

Every `<case>.yaml` has a sibling `<case>.expected.json`:

```json
{
  "description": "human note on what the case exercises",
  "structurallyValid": true,
  "semantic": { "ok": true, "errors": ["error_code", "..."] }
}
```

- **`structurallyValid`** — whether the document passes the JSON Schema. Checked
  today by both sides: TypeScript via `ajv` (`packages/flow-schema`), Rust via
  `jsonschema` (`crates/wavekat-flow`). Because both use a real draft-2020-12
  validator over the *same* schema, this verdict is identical across languages.
- **`semantic`** — the expected result of the full semantic validator
  (reachability, exit wiring, hours, …). Wired into both test suites in Phase 2,
  when the validators move into this repo. `errors` lists the expected error
  codes. A document can be `structurallyValid: true` but `semantic.ok: false`
  (see `invalid/dangling-exit`), which is exactly the class of bug a JSON Schema
  cannot catch.

## The backward-compatibility rule

**A case, once added, is frozen.** A document in `valid/` must validate for the
life of its `schema_version`; a change to the schema or validators that would
reject it, or flip an `invalid/` verdict, fails CI. This is what enforces
"changes must not break previous configs": to evolve the format incompatibly
you cut a new `schema_version` with its own corpus directory, never mutate an
existing one.

When you add a real-world flow that surfaced a bug, add it here as a permanent
regression case.
