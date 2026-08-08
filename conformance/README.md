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
  v2/                       # `book` — same layout, its own frozen cases
```

Every `<case>.yaml` has a sibling `<case>.expected.json`:

```json
{
  "description": "human note on what the case exercises",
  "structurallyValid": true,
  "semantic": { "ok": true, "errors": ["error_code", "..."] },
  "tsWarnings": ["unknown_field"]
}
```

- **`structurallyValid`** — whether the document passes the JSON Schema. Checked
  today by both sides: TypeScript via `ajv` (`packages/flow-schema`), Rust via
  `jsonschema` (`crates/wavekat-flow`). Because both use a real draft-2020-12
  validator over the *same* schema, this verdict is identical across languages.
- **`semantic`** — the expected result of the full semantic validator
  (reachability, exit wiring, hours, …), wired into **both** test suites. `ok`
  is the acceptance verdict; `errors` lists the *characteristic* error codes.
  The match is a **subset**, not exact-set: `accepted === semantic.ok` and every
  listed code is reported, because one defect can cascade (a dangling exit also
  traps the caller) and the frozen corpus should not have to enumerate incidental
  cascade codes. A document can be `structurallyValid: true` but
  `semantic.ok: false` (see `invalid/dangling-exit`), which is exactly the class
  of bug a JSON Schema cannot catch.
- **`tsWarnings`** (optional, TS-only) — non-blocking warning codes the
  TypeScript parser must surface. This encodes the one deliberate cross-language
  divergence: an unknown field is a `unknown_field` **warning** in TS but is
  silently ignored by Rust serde — both still *accept* the document
  (`semantic.ok: true`). The Rust suite ignores this field. See
  `valid/unknown-field`.

## The backward-compatibility rule

**A case, once added, is frozen.** A document in `valid/` must validate for the
life of its `schema_version`; a change to the schema or validators that would
reject it, or flip an `invalid/` verdict, fails CI. This is what enforces
"changes must not break previous configs": to evolve the format incompatibly
you cut a new `schema_version` with its own corpus directory, never mutate an
existing one.

The one thing that legitimately forces a case to change is a case whose
*premise* the format outgrew, as opposed to its verdict. `v1/invalid/
bad-schema-version` said "version 2 is unsupported", which stopped being true
the day version 2 shipped; the number moved out of reach and the expectation
stayed exactly where it was. That is the allowed shape of an edit: keep what
the case pins, remove the accident it depended on, and say so in its
`description`. Weakening an expectation to make a build pass is not.

A case lives under the version its document **declares**, not the version that
can read it. `v1/invalid/book-needs-v2` uses a component that arrived in v2 —
it belongs to v1, because what it pins is how a *version-1 document* is
treated.

When you add a real-world flow that surfaced a bug, add it here as a permanent
regression case.
