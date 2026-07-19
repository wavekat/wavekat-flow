# docs/

- **[ROADMAP.md](./ROADMAP.md)** — the phased TODO list (Phase 2 consolidation,
  Phase 3 publish & adopt, open questions). Start here for what's left to do.

## Naming convention

- **`NN-name.md`** (numbered, e.g. `48-ivr-call-flows.md`) — design docs and
  feature plans that *progress* over a lifecycle. These get a sequence number.
- **`UPPERCASE.md`** (e.g. `ROADMAP.md`) — persistent meta docs that are always
  present and evolve in place rather than being versioned (roadmap, todo, etc.).

## The format spec

The prose specification of the call-flow format is **doc 48
("IVR call flows")**, which currently lives in the voice daemon's repo
(`docs/48-ivr-call-flows.md`). Its "Placement" section is the design basis for
this repo.

That document is the *narrative* spec (rationale, component catalog, execution
model, version-negotiation policy). This repo holds the *normative* spec — the
machine-checkable `schema/flow.v1.schema.json` and the `conformance/` corpus.

**Planned (Phase 2/3):** migrate doc 48 into this repo so the narrative and
normative specs live together, and leave a pointer behind in the daemon's
repo. Until then, treat doc 48 there as canonical for prose and the schema
here as canonical for the exact shape.
