//! Publish-time / load-time validation — the gate that keeps a bad document
//! from ever becoming a live phone line (doc 48). The platform runs the same
//! checks before publish (`packages/flow-schema/src/validate.ts`); the daemon
//! re-runs them on load so a corrupted cache or a version mismatch fails safe
//! rather than executing undefined behavior. Every rule here has a TypeScript
//! twin, and both are pinned by the shared conformance corpus.
//!
//! Structural guarantees enforced here: the schema version is one this engine
//! runs; every exit is wired to an existing node and matches the node's exit
//! set; every node is reachable from `entry`; **no caller can be trapped** —
//! every reachable node can reach a terminal; prompt-length and menu/hours
//! sanity caps. All errors are collected (not fail-fast) so the editor can
//! show every problem at once.

use std::collections::{BTreeSet, VecDeque};

use crate::book::{self};
use crate::hours::{self, HoursError};
use crate::model::{Flow, Node, Prompt};
use crate::model_ext::NodeId;
use crate::SUPPORTED_SCHEMA_VERSIONS;

/// Longest a spoken (text) prompt may be. A backstop against a pasted-essay
/// prompt that would trap a caller under minutes of TTS; generous enough that
/// no real greeting hits it. Audio-asset prompts are unbounded here. Twin:
/// `packages/flow-schema/src/model.ts` `MAX_PROMPT_CHARS`.
const MAX_PROMPT_CHARS: usize = 2000;

/// The DTMF keys a `menu` option may be keyed by. Twin:
/// `packages/flow-schema/src/model.ts` `VALID_DIGITS`.
const VALID_DIGITS: &[&str] = &["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#"];

/// The shortest and longest a screened transfer may ring the person's
/// phone, in seconds. Twin: `model.ts` `MIN_TRANSFER_TIMEOUT_SECS` /
/// `MAX_TRANSFER_TIMEOUT_SECS`; the schema carries the same bounds.
const MIN_TRANSFER_TIMEOUT_SECS: i64 = 5;
const MAX_TRANSFER_TIMEOUT_SECS: i64 = 120;

/// The oldest `schema_version` that may put `whisper` or `timeout_secs`
/// on a `transfer`. Twin: `model.ts` `TRANSFER_FIELDS_MIN_SCHEMA_VERSION`.
const TRANSFER_FIELDS_MIN_SCHEMA_VERSION: u32 = 3;

/// One thing wrong with a flow document. Carries enough context (node id,
/// exit name, offending value) for the editor to point at it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ValidationError {
    #[error("schema_version {0} is not supported by this app")]
    UnsupportedSchemaVersion(i64),

    #[error("flow has no nodes")]
    EmptyFlow,

    #[error("entry {0:?} is not a node")]
    MissingEntry(NodeId),

    #[error("node {node:?} exit {exit:?} points at {target:?}, which is not a node")]
    UnknownExitTarget {
        node: NodeId,
        exit: String,
        target: NodeId,
    },

    #[error("node {node:?} ({kind}) is missing required exits {missing:?}")]
    MissingExits {
        node: NodeId,
        kind: &'static str,
        missing: Vec<String>,
    },

    #[error("node {node:?} ({kind}) has exits {unexpected:?} it does not define")]
    UnexpectedExits {
        node: NodeId,
        kind: &'static str,
        unexpected: Vec<String>,
    },

    #[error("menu node {node:?} offers no options")]
    EmptyMenu { node: NodeId },

    #[error("menu node {node:?} option key {key:?} is not a DTMF digit (0-9, *, #)")]
    BadDigit { node: NodeId, key: String },

    #[error("hours node {node:?}: {source}")]
    Hours { node: NodeId, source: HoursError },

    #[error("transfer node {node:?} has an empty target")]
    EmptyTransferTarget { node: NodeId },

    #[error("node {node:?} prompt is {len} chars (max {MAX_PROMPT_CHARS})")]
    PromptTooLong { node: NodeId, len: usize },

    #[error("node {node:?} is unreachable from entry")]
    Unreachable { node: NodeId },

    #[error("node {node:?} can never reach a way to end the call (caller trapped)")]
    Trapped { node: NodeId },

    #[error("book node {node:?} {field} is {value} (allowed: {min}–{max})")]
    BookOutOfRange {
        node: NodeId,
        field: &'static str,
        value: u64,
        min: u64,
        max: u64,
    },

    #[error(
        "book node {node:?} can never offer an appointment: no opening leaves room for {duration} minutes"
    )]
    BookNeverOpen { node: NodeId, duration: u64 },

    #[error(
        "node {node:?} is a {kind} step, which needs schema_version {required} (this document declares {declared})"
    )]
    KindRequiresNewerSchema {
        node: NodeId,
        kind: &'static str,
        required: i64,
        declared: i64,
    },

    #[error(
        "transfer node {node:?} sets {field}, which needs schema_version {required} (this document declares {declared})"
    )]
    FieldRequiresNewerSchema {
        node: NodeId,
        field: &'static str,
        required: u32,
        declared: i64,
    },

    #[error("transfer node {node:?} sets timeout_secs but has no whisper to screen with")]
    TimeoutWithoutWhisper { node: NodeId },

    #[error("transfer node {node:?} timeout_secs is {value} (allowed: {min}–{max})")]
    TransferTimeoutOutOfRange {
        node: NodeId,
        value: i64,
        min: i64,
        max: i64,
    },

    #[error("node {node:?} is a {kind} step, which an outbound call cannot run")]
    OutboundNodeNotAllowed { node: NodeId, kind: &'static str },

    #[error(
        "transfer node {node:?} has no whisper: an outbound call must screen the person it hands the callee to"
    )]
    OutboundBlindTransfer { node: NodeId },

    #[error(
        "node {node:?} is on a loop that never waits for the callee, so an outbound call could repeat it forever"
    )]
    OutboundUnboundedLoop { node: NodeId },
}

impl ValidationError {
    /// Stable snake_case code, shared with the TypeScript validator and the
    /// conformance corpus (`conformance/v1/**/*.expected.json` `semantic`).
    /// `unknown_target` matches the corpus (the pre-consolidation platform
    /// copy called it `unknown_exit_target`; the frozen corpus is
    /// authoritative, so both languages emit `unknown_target`).
    pub fn code(&self) -> &'static str {
        match self {
            ValidationError::UnsupportedSchemaVersion(_) => "unsupported_schema_version",
            ValidationError::EmptyFlow => "empty_flow",
            ValidationError::MissingEntry(_) => "missing_entry",
            ValidationError::UnknownExitTarget { .. } => "unknown_target",
            ValidationError::MissingExits { .. } => "missing_exits",
            ValidationError::UnexpectedExits { .. } => "unexpected_exits",
            ValidationError::EmptyMenu { .. } => "empty_menu",
            ValidationError::BadDigit { .. } => "bad_digit",
            // Delegate to the inner hours code so both languages report the
            // same code for a hours defect (TS surfaces it directly).
            ValidationError::Hours { source, .. } => source.code(),
            ValidationError::EmptyTransferTarget { .. } => "empty_transfer_target",
            ValidationError::PromptTooLong { .. } => "prompt_too_long",
            ValidationError::Unreachable { .. } => "unreachable",
            ValidationError::Trapped { .. } => "trapped",
            ValidationError::BookOutOfRange { .. } => "book_out_of_range",
            ValidationError::BookNeverOpen { .. } => "book_never_open",
            ValidationError::KindRequiresNewerSchema { .. } => "kind_requires_newer_schema",
            ValidationError::FieldRequiresNewerSchema { .. } => "field_requires_newer_schema",
            ValidationError::TimeoutWithoutWhisper { .. } => "timeout_without_whisper",
            ValidationError::TransferTimeoutOutOfRange { .. } => "transfer_timeout_out_of_range",
            ValidationError::OutboundNodeNotAllowed { .. } => "outbound_node_not_allowed",
            ValidationError::OutboundBlindTransfer { .. } => "outbound_blind_transfer",
            ValidationError::OutboundUnboundedLoop { .. } => "outbound_unbounded_loop",
        }
    }
}

/// The oldest `schema_version` that may carry each component — the whole
/// of what "a version bump" means in this format, since versions grow by
/// gaining components and nothing else so far. Documents are never
/// rewritten, so a v1 flow keeps working forever; it simply may not use
/// `book`. Twin: `model.ts` `KIND_MIN_SCHEMA_VERSION`.
fn kind_min_schema_version(kind: &str) -> i64 {
    match kind {
        "book" => 2,
        _ => 1,
    }
}

/// The lowest `schema_version` that can carry this document's components —
/// the version it *needs*, as against the one it declares.
///
/// The engine has no use for this; it is here for authoring tools, which
/// set the declared version from it so the number tracks the steps the
/// author placed rather than being one more thing they must know about.
/// A document needing nothing newer stays at 1, which is also the widest:
/// every engine in the field can run it.
///
/// Twin: `model.ts` `requiredSchemaVersion`.
pub fn required_schema_version(flow: &Flow) -> i64 {
    flow.nodes
        .values()
        .map(|node| {
            let fields = match node {
                Node::Transfer {
                    whisper,
                    timeout_secs,
                    ..
                } if whisper.is_some() || timeout_secs.is_some() => {
                    i64::from(TRANSFER_FIELDS_MIN_SCHEMA_VERSION)
                }
                _ => 1,
            };
            kind_min_schema_version(node.kind()).max(fields)
        })
        .max()
        .unwrap_or(1)
}

/// Validate a parsed flow. `Ok(())` means safe to publish / execute; `Err`
/// carries every problem found.
pub fn validate(flow: &Flow) -> Result<(), Vec<ValidationError>> {
    let mut errs = Vec::new();

    if !SUPPORTED_SCHEMA_VERSIONS
        .iter()
        .any(|&v| i64::from(v) == flow.schema_version)
    {
        errs.push(ValidationError::UnsupportedSchemaVersion(
            flow.schema_version,
        ));
    }

    if flow.nodes.is_empty() {
        errs.push(ValidationError::EmptyFlow);
        return Err(errs); // graph checks below would be meaningless
    }

    let entry_exists = flow.nodes.contains_key(&flow.entry);
    if !entry_exists {
        errs.push(ValidationError::MissingEntry(flow.entry.clone()));
    }

    for (id, node) in &flow.nodes {
        check_exits(id, node, flow, &mut errs);
        check_node(id, node, &mut errs);
        check_transfer_fields_version(id, node, flow.schema_version, &mut errs);

        // A component the document's own version doesn't have. Checked
        // per node rather than once per flow so the editor points at the
        // step that has to change, and kept separate from the parser's
        // `unknown_kind` (which a build predating the component reports
        // for the same document) because the fix differs: bump the
        // version, don't fix the typo.
        let required = kind_min_schema_version(node.kind());
        if flow.schema_version < required {
            errs.push(ValidationError::KindRequiresNewerSchema {
                node: id.clone(),
                kind: node.kind(),
                required,
                declared: flow.schema_version,
            });
        }
    }

    // Reachability and trap analysis need a real entry to walk from.
    if entry_exists {
        check_graph(flow, &mut errs);
    }

    if errs.is_empty() {
        Ok(())
    } else {
        Err(errs)
    }
}

/// `whisper` and `timeout_secs` on a document older than the version that
/// has them. Reported per field, so the editor can say which one to drop
/// or which version to raise.
fn check_transfer_fields_version(
    id: &NodeId,
    node: &Node,
    declared: i64,
    errs: &mut Vec<ValidationError>,
) {
    let Node::Transfer {
        whisper,
        timeout_secs,
        ..
    } = node
    else {
        return;
    };
    if declared >= i64::from(TRANSFER_FIELDS_MIN_SCHEMA_VERSION) {
        return;
    }
    for (field, present) in [
        ("whisper", whisper.is_some()),
        ("timeout_secs", timeout_secs.is_some()),
    ] {
        if present {
            errs.push(ValidationError::FieldRequiresNewerSchema {
                node: id.clone(),
                field,
                required: TRANSFER_FIELDS_MIN_SCHEMA_VERSION,
                declared,
            });
        }
    }
}

/// The kinds a flow may use on a call the app *places*, as of
/// `schema_version` 2 and earlier: no person is standing by. Kept for
/// compatibility; [`outbound_kinds`] is the version-aware list. Twin:
/// `validate.ts` `OUTBOUND_KINDS`.
///
/// Left out: `ring` (there is nobody to hand the call to), `book` (it
/// books against the number that called in, which an outbound call does
/// not have), and `transfer` (not offered on outbound calls before
/// version 3).
pub const OUTBOUND_KINDS: &[&str] = &["greeting", "menu", "message", "hangup", "hours"];

/// [`OUTBOUND_KINDS`] plus what version 3 adds: `ring` and `transfer`,
/// because a person can now be reached on purpose. `transfer` must be
/// screened (see [`validate_outbound`]).
const OUTBOUND_KINDS_V3: &[&str] = &[
    "greeting", "menu", "message", "hangup", "hours", "ring", "transfer",
];

/// The kinds a flow declaring `schema_version` may use on an outbound
/// call. Version 2 and earlier get [`OUTBOUND_KINDS`], so a frozen
/// document keeps its verdict; version 3 adds `ring` and `transfer`.
/// Twin: `validate.ts` `outboundKinds`.
pub fn outbound_kinds(schema_version: u32) -> &'static [&'static str] {
    if schema_version >= 3 {
        OUTBOUND_KINDS_V3
    } else {
        OUTBOUND_KINDS
    }
}

/// Validate a flow for an **outbound** call: everything [`validate`] checks,
/// plus the rules for a call the app places itself.
///
/// This runs [`validate`] first and adds to its errors, so it is the one
/// gate to call for an outbound flow — there is no need to call both. All
/// errors are collected, as with [`validate`].
///
/// The outbound rules:
///
/// - every node is one of [`outbound_kinds`] for the document's version
///   (`outbound_node_not_allowed`);
/// - a `transfer` must be screened, i.e. carry a `whisper`
///   (`outbound_blind_transfer`) — the callee never lands on a person who
///   did not know a call was coming;
/// - no loop reachable from `entry` is made only of moves that happen
///   without the callee — any exit of a `greeting`, `hours` or `ring` step
///   or a screened `transfer`, or a `menu`'s `no_input` exit. Such a loop, played into voicemail or to a
///   callee who stays silent, would never end (`outbound_unbounded_loop`).
///   A loop through a menu's digit or `invalid` exits is fine: only a
///   callee pressing keys can take it.
///
/// Twin: `validate.ts` `validateOutbound`.
pub fn validate_outbound(flow: &Flow) -> Result<(), Vec<ValidationError>> {
    let mut errs = validate(flow).err().unwrap_or_default();
    let allowed = outbound_kinds(flow.schema_version.clamp(0, i64::from(u32::MAX)) as u32);

    // In id order, so the errors come out the same every time.
    let mut nodes: Vec<(&NodeId, &Node)> = flow.nodes.iter().collect();
    nodes.sort_by_key(|(id, _)| *id);
    for (id, node) in nodes {
        if !allowed.contains(&node.kind()) {
            errs.push(ValidationError::OutboundNodeNotAllowed {
                node: id.clone(),
                kind: node.kind(),
            });
        } else if matches!(node, Node::Transfer { .. }) && !node.is_screened_transfer() {
            errs.push(ValidationError::OutboundBlindTransfer { node: id.clone() });
        }
    }

    for node in unbounded_loop_nodes(flow) {
        errs.push(ValidationError::OutboundUnboundedLoop {
            node: node.to_string(),
        });
    }

    if errs.is_empty() {
        Ok(())
    } else {
        Err(errs)
    }
}

/// The exits a node takes without the callee doing anything: every exit of
/// a `greeting` (always `next`), `hours` (picked by the clock), `ring` or
/// screened `transfer` step (`no_answer`: nobody picked up), and a
/// `menu`'s `no_input` (taken when nobody presses a key — voicemail, say).
fn silent_exits(node: &Node) -> Vec<&str> {
    let exits = node.exits().into_iter().flatten();
    match node {
        Node::Greeting { .. } | Node::Hours { .. } | Node::Ring { .. } => {
            exits.map(|(_, t)| t.as_str()).collect()
        }
        Node::Transfer { .. } if node.is_screened_transfer() => {
            exits.map(|(_, t)| t.as_str()).collect()
        }
        Node::Menu { .. } => exits
            .filter(|(key, _)| key.as_str() == "no_input")
            .map(|(_, t)| t.as_str())
            .collect(),
        _ => Vec::new(),
    }
}

/// Every node reachable from `entry` that sits on a cycle made only of
/// silent exits (see [`silent_exits`]), in id order.
fn unbounded_loop_nodes(flow: &Flow) -> Vec<&str> {
    let reachable = reachable_from_entry(flow);
    // The subgraph the rule is about: reachable nodes and the silent exits
    // between them.
    let successors = |id: &str| -> Vec<&str> {
        flow.nodes
            .get(id)
            .map(silent_exits)
            .unwrap_or_default()
            .into_iter()
            .filter(|t| reachable.contains(t))
            .collect()
    };

    let mut on_loop = Vec::new();
    for id in &reachable {
        // Does `id` lead back to itself within the subgraph?
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        let mut stack = successors(id);
        while let Some(next) = stack.pop() {
            if next == *id {
                on_loop.push(*id);
                break;
            }
            if seen.insert(next) {
                stack.extend(successors(next));
            }
        }
    }
    on_loop
}

/// Node ids reachable from `entry` over exit edges (`entry` included when
/// it exists).
fn reachable_from_entry(flow: &Flow) -> BTreeSet<&str> {
    let mut reachable: BTreeSet<&str> = BTreeSet::new();
    let Some((entry, _)) = flow.nodes.get_key_value(&flow.entry) else {
        return reachable;
    };
    let mut queue: VecDeque<&str> = VecDeque::new();
    queue.push_back(entry.as_str());
    reachable.insert(entry.as_str());
    while let Some(id) = queue.pop_front() {
        let Some(node) = flow.nodes.get(id) else {
            continue;
        };
        for (_, target) in node.exits().into_iter().flatten() {
            if let Some((target, _)) = flow.nodes.get_key_value(target) {
                if reachable.insert(target.as_str()) {
                    queue.push_back(target.as_str());
                }
            }
        }
    }
    reachable
}

/// Exit keys must be exactly the set the node's kind defines, and every
/// target must exist.
fn check_exits(id: &NodeId, node: &Node, flow: &Flow, errs: &mut Vec<ValidationError>) {
    let kind = node.kind();
    let required: BTreeSet<String> = node.required_exits().into_iter().collect();
    let present: BTreeSet<String> = node
        .exits()
        .map(|e| e.keys().cloned().collect())
        .unwrap_or_default();

    let missing: Vec<String> = required.difference(&present).cloned().collect();
    if !missing.is_empty() {
        errs.push(ValidationError::MissingExits {
            node: id.clone(),
            kind,
            missing,
        });
    }
    let unexpected: Vec<String> = present.difference(&required).cloned().collect();
    if !unexpected.is_empty() {
        errs.push(ValidationError::UnexpectedExits {
            node: id.clone(),
            kind,
            unexpected,
        });
    }

    for (exit, target) in node.exits().into_iter().flatten() {
        if !flow.nodes.contains_key(target) {
            errs.push(ValidationError::UnknownExitTarget {
                node: id.clone(),
                exit: exit.clone(),
                target: target.clone(),
            });
        }
    }
}

/// Per-kind config sanity.
fn check_node(id: &NodeId, node: &Node, errs: &mut Vec<ValidationError>) {
    match node {
        Node::Greeting { prompt, .. } => check_prompt(id, prompt, errs),
        Node::Hours {
            schedule,
            timezone,
            exceptions,
            ..
        } => {
            if let Err(source) = hours::validate_config(schedule, timezone, exceptions) {
                errs.push(ValidationError::Hours {
                    node: id.clone(),
                    source,
                });
            }
        }
        Node::Menu {
            prompt, options, ..
        } => {
            check_prompt(id, prompt, errs);
            if options.is_empty() {
                errs.push(ValidationError::EmptyMenu { node: id.clone() });
            }
            for key in options.keys() {
                if !VALID_DIGITS.contains(&key.as_str()) {
                    errs.push(ValidationError::BadDigit {
                        node: id.clone(),
                        key: key.clone(),
                    });
                }
            }
        }
        Node::Ring { .. } => {}
        Node::Message { prompt, .. } => check_prompt(id, prompt, errs),
        Node::Transfer {
            target,
            whisper,
            timeout_secs,
            ..
        } => {
            if target.trim().is_empty() {
                errs.push(ValidationError::EmptyTransferTarget { node: id.clone() });
            }
            if let Some(p) = whisper {
                check_prompt(id, p, errs);
            }
            if let Some(value) = *timeout_secs {
                if whisper.is_none() {
                    errs.push(ValidationError::TimeoutWithoutWhisper { node: id.clone() });
                }
                if !(MIN_TRANSFER_TIMEOUT_SECS..=MAX_TRANSFER_TIMEOUT_SECS).contains(&value) {
                    errs.push(ValidationError::TransferTimeoutOutOfRange {
                        node: id.clone(),
                        value,
                        min: MIN_TRANSFER_TIMEOUT_SECS,
                        max: MAX_TRANSFER_TIMEOUT_SECS,
                    });
                }
            }
        }
        Node::Hangup { prompt, .. } => {
            if let Some(p) = prompt {
                check_prompt(id, p, errs);
            }
        }
        Node::Book {
            prompt,
            confirm_prompt,
            schedule,
            timezone,
            exceptions,
            ..
        } => {
            check_prompt(id, prompt, errs);
            check_prompt(id, confirm_prompt, errs);
            if let Err(source) = hours::validate_config(schedule, timezone, exceptions) {
                errs.push(ValidationError::Hours {
                    node: id.clone(),
                    source,
                });
            }
            check_book_bounds(id, node, errs);
        }
    }
}

/// The `book` node's numeric bounds, and the one structural question a
/// schedule can fail: whether it leaves room for a single appointment.
///
/// A node that can never offer anything is worth an error rather than a
/// shrug — "we're open 9:00 to 9:30 and appointments run an hour" is a
/// flow whose every caller falls out the `no_slots` exit, and the author
/// will read that as a broken calendar connection, not as arithmetic.
/// [`book::vocabulary_refs`] answers it for free: no time refs, no times.
fn check_book_bounds(id: &NodeId, node: &Node, errs: &mut Vec<ValidationError>) {
    let Node::Book {
        duration_mins,
        buffer_mins,
        lead_mins,
        horizon_days,
        max_offers,
        ..
    } = node
    else {
        return;
    };

    let mut range = |field: &'static str, value: u64, min: u64, max: u64| {
        if value < min || value > max {
            errs.push(ValidationError::BookOutOfRange {
                node: id.clone(),
                field,
                value,
                min,
                max,
            });
        }
    };
    range(
        "duration_mins",
        *duration_mins,
        book::MIN_BOOK_DURATION_MINS,
        book::MAX_BOOK_DURATION_MINS,
    );
    range("buffer_mins", *buffer_mins, 0, book::MAX_BOOK_BUFFER_MINS);
    range("lead_mins", *lead_mins, 0, book::MAX_BOOK_LEAD_MINS);
    range(
        "horizon_days",
        *horizon_days,
        1,
        book::MAX_BOOK_HORIZON_DAYS,
    );
    range("max_offers", *max_offers, 1, book::MAX_BOOK_OFFERS);

    let speaks_a_time = book::vocabulary_refs(node).iter().any(|r| {
        matches!(
            book::parse_vocabulary_ref(r),
            Some(book::VocabularyRef::Time { .. })
        )
    });
    if !speaks_a_time {
        errs.push(ValidationError::BookNeverOpen {
            node: id.clone(),
            duration: *duration_mins,
        });
    }
}

fn check_prompt(id: &NodeId, prompt: &Prompt, errs: &mut Vec<ValidationError>) {
    if let Some(text) = prompt.as_text() {
        let len = text.chars().count();
        if len > MAX_PROMPT_CHARS {
            errs.push(ValidationError::PromptTooLong {
                node: id.clone(),
                len,
            });
        }
    }
}

/// Reachability from `entry`, and the "no caller is trapped" guarantee.
fn check_graph(flow: &Flow, errs: &mut Vec<ValidationError>) {
    let reachable = reachable_from_entry(flow);

    for id in flow.nodes.keys() {
        if !reachable.contains(id.as_str()) {
            errs.push(ValidationError::Unreachable { node: id.clone() });
        }
    }

    // "Can reach a terminal" by backward fixpoint from terminal-capable
    // nodes. A node qualifies if it is itself terminal or any exit target
    // qualifies.
    let mut can_end: BTreeSet<&str> = flow
        .nodes
        .iter()
        .filter(|(_, n)| n.is_terminal())
        .map(|(id, _)| id.as_str())
        .collect();
    loop {
        let mut grew = false;
        for (id, node) in &flow.nodes {
            if can_end.contains(id.as_str()) {
                continue;
            }
            if node
                .exits()
                .into_iter()
                .flatten()
                .any(|(_, t)| can_end.contains(t.as_str()))
                && can_end.insert(id.as_str())
            {
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }

    // A reachable node that can never reach a terminal traps the caller.
    // (Report only reachable ones — an unreachable trap is already flagged as
    // unreachable and would be noise.)
    for id in &reachable {
        if !can_end.contains(id) {
            errs.push(ValidationError::Trapped {
                node: (*id).to_string(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The doc 48 example, reused across tests. Kept in sync with the one in
    // the TS suite on purpose — both must stay valid.
    const LUIGIS: &str = r#"
schema_version: 1
id: flow_9f2
name: Luigi's
entry: welcome
nodes:
  welcome:
    kind: greeting
    prompt: Thanks for calling Luigi's!
    exits: { next: check_hours }
  check_hours:
    kind: hours
    timezone: America/New_York
    schedule:
      tue: [{ open: "11:00", close: "22:00" }]
    exits: { open: front_desk, closed: night_menu }
  front_desk:
    kind: ring
    timeout_secs: 25
    exits: { no_answer: take_message }
  night_menu:
    kind: menu
    prompt: We're closed. Press 1 for hours.
    options: { "1": Hours }
    exits: { "1": say_hours, no_input: take_message, invalid: take_message }
  say_hours:
    kind: greeting
    prompt: Open Tuesday to Sunday.
    exits: { next: take_message }
  take_message:
    kind: message
    prompt: Leave a message after the tone.
"#;

    fn parse(src: &str) -> Flow {
        Flow::from_yaml(src).expect("test flow should parse")
    }

    #[test]
    fn the_documented_example_validates() {
        assert_eq!(validate(&parse(LUIGIS)), Ok(()));
    }

    #[test]
    fn rejects_unsupported_schema_version() {
        let f = parse(&LUIGIS.replace("schema_version: 1", "schema_version: 99"));
        let errs = validate(&f).unwrap_err();
        assert!(errs.contains(&ValidationError::UnsupportedSchemaVersion(99)));
    }

    #[test]
    fn rejects_missing_entry() {
        let f = parse(&LUIGIS.replace("entry: welcome", "entry: nope"));
        let errs = validate(&f).unwrap_err();
        assert!(errs
            .iter()
            .any(|e| matches!(e, ValidationError::MissingEntry(n) if n == "nope")));
    }

    #[test]
    fn rejects_dangling_exit_target() {
        let f = parse(&LUIGIS.replace("next: check_hours", "next: ghost"));
        let errs = validate(&f).unwrap_err();
        assert!(errs.iter().any(|e| matches!(
            e,
            ValidationError::UnknownExitTarget { target, .. } if target == "ghost"
        )));
    }

    #[test]
    fn rejects_missing_required_exit() {
        // A greeting with no `next`.
        let src = r#"
schema_version: 1
id: f
name: n
entry: g
nodes:
  g:
    kind: greeting
    prompt: hi
  bye:
    kind: hangup
"#;
        let errs = validate(&parse(src)).unwrap_err();
        assert!(errs.iter().any(|e| matches!(
            e,
            ValidationError::MissingExits { node, .. } if node == "g"
        )));
    }

    #[test]
    fn rejects_unexpected_exit_on_terminal() {
        let src = r#"
schema_version: 1
id: f
name: n
entry: g
nodes:
  g:
    kind: hangup
    exits: { next: g }
"#;
        let errs = validate(&parse(src)).unwrap_err();
        assert!(errs.iter().any(|e| matches!(
            e,
            ValidationError::UnexpectedExits { node, .. } if node == "g"
        )));
    }

    #[test]
    fn rejects_unreachable_node() {
        let src = r#"
schema_version: 1
id: f
name: n
entry: g
nodes:
  g:
    kind: hangup
  orphan:
    kind: hangup
"#;
        let errs = validate(&parse(src)).unwrap_err();
        assert!(errs.iter().any(|e| matches!(
            e,
            ValidationError::Unreachable { node } if node == "orphan"
        )));
    }

    #[test]
    fn rejects_trapping_cycle() {
        // a -> b -> a, with no terminal anywhere: every caller is stuck.
        let src = r#"
schema_version: 1
id: f
name: n
entry: a
nodes:
  a:
    kind: greeting
    prompt: one
    exits: { next: b }
  b:
    kind: greeting
    prompt: two
    exits: { next: a }
"#;
        let errs = validate(&parse(src)).unwrap_err();
        assert!(
            errs.iter()
                .any(|e| matches!(e, ValidationError::Trapped { .. })),
            "a terminal-less loop must be flagged as trapping: {errs:?}"
        );
    }

    #[test]
    fn a_loop_with_an_escape_is_fine() {
        // Menu loops back to a greeting but no_input/invalid escape to a
        // terminal — not trapped.
        let src = r#"
schema_version: 1
id: f
name: n
entry: m
nodes:
  m:
    kind: menu
    prompt: press one
    options: { "1": again }
    exits: { "1": g, no_input: bye, invalid: bye }
  g:
    kind: greeting
    prompt: again
    exits: { next: m }
  bye:
    kind: hangup
"#;
        assert_eq!(validate(&parse(src)), Ok(()));
    }

    #[test]
    fn rejects_empty_menu_and_bad_digit() {
        let empty = r#"
schema_version: 1
id: f
name: n
entry: m
nodes:
  m:
    kind: menu
    prompt: hi
    options: {}
    exits: { no_input: bye, invalid: bye }
  bye:
    kind: hangup
"#;
        assert!(validate(&parse(empty))
            .unwrap_err()
            .iter()
            .any(|e| matches!(e, ValidationError::EmptyMenu { .. })));

        let bad = r#"
schema_version: 1
id: f
name: n
entry: m
nodes:
  m:
    kind: menu
    prompt: hi
    options: { A: nope }
    exits: { A: bye, no_input: bye, invalid: bye }
  bye:
    kind: hangup
"#;
        assert!(validate(&parse(bad))
            .unwrap_err()
            .iter()
            .any(|e| matches!(e, ValidationError::BadDigit { key, .. } if key == "A")));
    }

    #[test]
    fn rejects_empty_transfer_target() {
        let src = r#"
schema_version: 1
id: f
name: n
entry: t
nodes:
  t:
    kind: transfer
    target: "   "
"#;
        assert!(validate(&parse(src))
            .unwrap_err()
            .iter()
            .any(|e| matches!(e, ValidationError::EmptyTransferTarget { .. })));
    }

    #[test]
    fn rejects_overlong_prompt() {
        let long = "a".repeat(MAX_PROMPT_CHARS + 1);
        let src = format!(
            r#"
schema_version: 1
id: f
name: n
entry: g
nodes:
  g:
    kind: greeting
    prompt: {long}
    exits: {{ next: bye }}
  bye:
    kind: hangup
"#
        );
        assert!(validate(&parse(&src))
            .unwrap_err()
            .iter()
            .any(|e| matches!(e, ValidationError::PromptTooLong { .. })));
    }

    #[test]
    fn surfaces_hours_config_errors() {
        let src = r#"
schema_version: 1
id: f
name: n
entry: h
nodes:
  h:
    kind: hours
    timezone: Mars/Base
    schedule: {}
    exits: { open: bye, closed: bye }
  bye:
    kind: hangup
"#;
        assert!(validate(&parse(src))
            .unwrap_err()
            .iter()
            .any(|e| matches!(e, ValidationError::Hours { .. })));
    }

    // ── `required_schema_version` ────────────────────────────────────────

    const BOOKING: &str = r#"
schema_version: 2
id: f
name: n
entry: appointment
nodes:
  appointment:
    kind: book
    prompt: When suits you?
    confirm_prompt: You're booked for
    timezone: UTC
    schedule:
      tue: [{ open: "09:00", close: "17:00" }]
    duration_mins: 30
    exits:
      booked: bye
      no_slots: bye
      no_input: bye
      unavailable: bye
  bye:
    kind: hangup
"#;

    #[test]
    fn a_document_of_v1_components_needs_only_v1() {
        assert_eq!(required_schema_version(&parse(LUIGIS)), 1);
    }

    #[test]
    fn a_document_rises_to_what_its_newest_component_needs() {
        assert_eq!(required_schema_version(&parse(BOOKING)), 2);
    }

    #[test]
    fn a_document_with_no_steps_needs_v1() {
        let src = r#"
schema_version: 1
id: f
name: n
entry: bye
nodes: {}
"#;
        assert_eq!(required_schema_version(&parse(src)), 1);
    }
    // ── `validate_outbound` ──────────────────────────────────────────────

    fn outbound_codes(src: &str) -> Vec<&'static str> {
        validate_outbound(&parse(src))
            .err()
            .unwrap_or_default()
            .iter()
            .map(ValidationError::code)
            .collect()
    }

    const REMINDER: &str = r#"
schema_version: 1
id: f
name: n
entry: hello
nodes:
  hello:
    kind: greeting
    prompt: This is a reminder about your appointment tomorrow.
    exits: { next: ask }
  ask:
    kind: menu
    prompt: Press 1 to confirm, or 2 to hear this again.
    options: { "1": Confirm, "2": Repeat }
    exits: { "1": thanks, "2": hello, no_input: bye, invalid: ask }
  thanks:
    kind: hangup
    prompt: Thanks, see you then.
  bye:
    kind: hangup
"#;

    #[test]
    fn an_outbound_flow_with_a_menu_loop_validates() {
        assert_eq!(validate_outbound(&parse(REMINDER)), Ok(()));
    }

    #[test]
    fn outbound_refuses_ring_book_and_transfer() {
        let ring = r#"
schema_version: 1
id: f
name: n
entry: r
nodes:
  r:
    kind: ring
    timeout_secs: 20
    exits: { no_answer: bye }
  bye:
    kind: hangup
"#;
        let errs = validate_outbound(&parse(ring)).unwrap_err();
        assert!(errs.contains(&ValidationError::OutboundNodeNotAllowed {
            node: "r".into(),
            kind: "ring",
        }));

        let transfer = r#"
schema_version: 1
id: f
name: n
entry: t
nodes:
  t:
    kind: transfer
    target: "100"
"#;
        assert_eq!(outbound_codes(transfer), vec!["outbound_node_not_allowed"]);

        let errs = validate_outbound(&parse(BOOKING)).unwrap_err();
        assert!(errs.contains(&ValidationError::OutboundNodeNotAllowed {
            node: "appointment".into(),
            kind: "book",
        }));
    }

    #[test]
    fn outbound_runs_the_base_validation_too() {
        let codes = outbound_codes(&LUIGIS.replace("next: check_hours", "next: ghost"));
        assert!(codes.contains(&"unknown_target"), "{codes:?}");
        // LUIGIS also has a ring step.
        assert!(codes.contains(&"outbound_node_not_allowed"), "{codes:?}");
    }

    #[test]
    fn a_base_valid_flow_can_still_loop_forever_outbound() {
        // While open, hours -> greeting -> hours never stops; the closed
        // exit makes it base-valid (not trapped).
        let src = r#"
schema_version: 1
id: f
name: n
entry: check
nodes:
  check:
    kind: hours
    timezone: UTC
    schedule:
      mon: [{ open: "09:00", close: "17:00" }]
    exits: { open: say, closed: bye }
  say:
    kind: greeting
    prompt: Still here.
    exits: { next: check }
  bye:
    kind: hangup
"#;
        assert_eq!(validate(&parse(src)), Ok(()));
        let errs = validate_outbound(&parse(src)).unwrap_err();
        assert_eq!(
            errs,
            vec![
                ValidationError::OutboundUnboundedLoop {
                    node: "check".into()
                },
                ValidationError::OutboundUnboundedLoop { node: "say".into() },
            ]
        );
    }

    #[test]
    fn a_menu_whose_no_input_loops_back_is_unbounded() {
        // Into voicemail, every attempt times out: hello -> ask -> hello ...
        // `thanks` and `bye` can still end it, so the base check passes.
        let src = REMINDER.replace(
            "no_input: bye, invalid: ask",
            "no_input: hello, invalid: bye",
        );
        assert_eq!(validate(&parse(&src)), Ok(()));
        let errs = validate_outbound(&parse(&src)).unwrap_err();
        assert_eq!(
            errs,
            vec![
                ValidationError::OutboundUnboundedLoop { node: "ask".into() },
                ValidationError::OutboundUnboundedLoop {
                    node: "hello".into()
                },
            ]
        );
    }

    #[test]
    fn a_menu_retrying_itself_on_no_input_is_unbounded() {
        let src = REMINDER.replace("no_input: bye, invalid: ask", "no_input: ask, invalid: bye");
        assert_eq!(outbound_codes(&src), vec!["outbound_unbounded_loop"]);
    }

    #[test]
    fn a_greeting_looping_on_itself_is_unbounded() {
        let src = r#"
schema_version: 1
id: f
name: n
entry: g
nodes:
  g:
    kind: greeting
    prompt: again
    exits: { next: g }
"#;
        let codes = outbound_codes(src);
        assert!(codes.contains(&"outbound_unbounded_loop"), "{codes:?}");
        assert!(codes.contains(&"trapped"), "{codes:?}");
    }

    #[test]
    fn an_unreachable_loop_is_not_reported_as_unbounded() {
        let src = r#"
schema_version: 1
id: f
name: n
entry: bye
nodes:
  bye:
    kind: hangup
  g:
    kind: greeting
    prompt: again
    exits: { next: g }
"#;
        let codes = outbound_codes(src);
        assert!(codes.contains(&"unreachable"), "{codes:?}");
        assert!(!codes.contains(&"outbound_unbounded_loop"), "{codes:?}");
    }

    // ── screened transfer (schema_version 3) ─────────────────────────────

    const SCREENED: &str = r#"
schema_version: 3
id: f
name: n
entry: t
nodes:
  t:
    kind: transfer
    target: "+15551234567"
    whisper: Press 1 to accept this call.
    timeout_secs: 20
    exits: { no_answer: bye }
  bye:
    kind: hangup
"#;

    fn codes(src: &str) -> Vec<&'static str> {
        validate(&parse(src))
            .err()
            .unwrap_or_default()
            .iter()
            .map(ValidationError::code)
            .collect()
    }

    #[test]
    fn a_screened_transfer_validates() {
        assert_eq!(validate(&parse(SCREENED)), Ok(()));
    }

    #[test]
    fn screened_transfer_requires_no_answer() {
        let src = SCREENED.replace("    exits: { no_answer: bye }\n", "");
        assert!(codes(&src).contains(&"missing_exits"), "{:?}", codes(&src));
    }

    #[test]
    fn blind_transfer_has_no_exits_in_v3() {
        let src = SCREENED
            .replace("    whisper: Press 1 to accept this call.\n", "")
            .replace("    timeout_secs: 20\n", "");
        assert_eq!(codes(&src), vec!["unexpected_exits"]);
        let blind = src.replace("    exits: { no_answer: bye }\n", "");
        assert!(!codes(&blind).contains(&"unexpected_exits"));
    }

    #[test]
    fn whisper_in_v2_needs_v3() {
        let src = SCREENED
            .replace("schema_version: 3", "schema_version: 2")
            .replace("    timeout_secs: 20\n", "");
        let errs = validate(&parse(&src)).unwrap_err();
        assert!(errs.contains(&ValidationError::FieldRequiresNewerSchema {
            node: "t".into(),
            field: "whisper",
            required: 3,
            declared: 2,
        }));
        assert_eq!(errs[0].code(), "field_requires_newer_schema");
    }

    #[test]
    fn timeout_in_v2_needs_v3() {
        let src = SCREENED
            .replace("schema_version: 3", "schema_version: 1")
            .replace("    whisper: Press 1 to accept this call.\n", "")
            .replace("    exits: { no_answer: bye }\n", "");
        let errs = validate(&parse(&src)).unwrap_err();
        assert!(errs.contains(&ValidationError::FieldRequiresNewerSchema {
            node: "t".into(),
            field: "timeout_secs",
            required: 3,
            declared: 1,
        }));
        assert!(errs.contains(&ValidationError::TimeoutWithoutWhisper { node: "t".into() }));
    }

    #[test]
    fn timeout_without_whisper_refused() {
        let src = SCREENED
            .replace("    whisper: Press 1 to accept this call.\n", "")
            .replace("    exits: { no_answer: bye }\n", "");
        assert!(codes(&src).contains(&"timeout_without_whisper"));
    }

    #[test]
    fn transfer_timeout_is_bounded() {
        for (value, ok) in [
            (4, false),
            (5, true),
            (120, true),
            (121, false),
            (-1, false),
        ] {
            let src = SCREENED.replace("timeout_secs: 20", &format!("timeout_secs: {value}"));
            let errs = validate(&parse(&src)).err().unwrap_or_default();
            assert_eq!(errs.is_empty(), ok, "timeout_secs {value}: {errs:?}");
            if !ok {
                assert_eq!(
                    errs,
                    vec![ValidationError::TransferTimeoutOutOfRange {
                        node: "t".into(),
                        value,
                        min: 5,
                        max: 120,
                    }]
                );
                assert_eq!(errs[0].code(), "transfer_timeout_out_of_range");
            }
        }
    }

    #[test]
    fn an_overlong_whisper_is_refused() {
        let src = SCREENED.replace(
            "Press 1 to accept this call.",
            &"a".repeat(MAX_PROMPT_CHARS + 1),
        );
        assert_eq!(codes(&src), vec!["prompt_too_long"]);
    }

    #[test]
    fn a_screened_transfer_needs_v3() {
        assert_eq!(required_schema_version(&parse(SCREENED)), 3);
        let timeout_only = SCREENED.replace("    whisper: Press 1 to accept this call.\n", "");
        assert_eq!(required_schema_version(&parse(&timeout_only)), 3);
        let blind = timeout_only.replace("    timeout_secs: 20\n", "");
        assert_eq!(required_schema_version(&parse(&blind)), 1);
    }

    #[test]
    fn a_screened_transfer_that_only_loops_traps_the_caller() {
        // The hand-over can succeed, but a callee who never gets picked up
        // must still reach an end.
        let src = SCREENED.replace("no_answer: bye", "no_answer: t");
        assert!(codes(&src).contains(&"trapped"), "{:?}", codes(&src));
    }

    #[test]
    fn outbound_kinds_by_version() {
        assert_eq!(outbound_kinds(1), OUTBOUND_KINDS);
        assert_eq!(outbound_kinds(2), OUTBOUND_KINDS);
        assert_eq!(
            outbound_kinds(3),
            ["greeting", "menu", "message", "hangup", "hours", "ring", "transfer"]
        );
    }

    const HANDOFF: &str = r#"
schema_version: 3
id: f
name: n
entry: hello
nodes:
  hello:
    kind: greeting
    prompt: This is a reminder about your appointment.
    exits: { next: ask }
  ask:
    kind: menu
    prompt: Press 1 to talk to someone, or 2 to confirm.
    options: { "1": Talk, "2": Confirm }
    exits: { "1": connect, "2": thanks, no_input: bye, invalid: ask }
  connect:
    kind: transfer
    target: "+15551234567"
    whisper: Press 1 to accept this call.
    exits: { no_answer: sorry }
  sorry:
    kind: message
    prompt: Nobody is free right now. Leave a message.
  thanks:
    kind: hangup
    prompt: Thanks.
  bye:
    kind: hangup
"#;

    #[test]
    fn v3_outbound_allows_ring_and_screened_transfer() {
        assert_eq!(validate_outbound(&parse(HANDOFF)), Ok(()));
        let with_ring = HANDOFF.replace(
            "    exits: { no_answer: sorry }\n",
            "    exits: { no_answer: desk }\n  desk:\n    kind: ring\n    timeout_secs: 20\n    exits: { no_answer: sorry }\n",
        );
        assert_eq!(validate_outbound(&parse(&with_ring)), Ok(()));
    }

    #[test]
    fn v3_outbound_refuses_blind_transfer() {
        let src = HANDOFF
            .replace("    whisper: Press 1 to accept this call.\n", "")
            .replace("    exits: { no_answer: sorry }\n", "");
        let errs = validate_outbound(&parse(&src)).unwrap_err();
        assert!(errs.contains(&ValidationError::OutboundBlindTransfer {
            node: "connect".into()
        }));
        assert!(!outbound_codes(&src).contains(&"outbound_node_not_allowed"));
    }

    #[test]
    fn no_answer_loop_is_unbounded() {
        // ring -> greeting -> ring, with no key press anywhere in between.
        let src = r#"
schema_version: 3
id: f
name: n
entry: r
nodes:
  r:
    kind: ring
    timeout_secs: 20
    exits: { no_answer: again }
  again:
    kind: greeting
    prompt: Trying again.
    exits: { next: r }
  bye:
    kind: hangup
"#;
        let codes = outbound_codes(src);
        assert!(codes.contains(&"outbound_unbounded_loop"), "{codes:?}");
    }

    #[test]
    fn a_screened_transfer_retrying_without_a_keypress_is_unbounded() {
        // hello -> ask -(no_input)-> connect -(no_answer)-> hello: voicemail
        // would pick up, ring out, and go round again for ever.
        let src = HANDOFF
            .replace("no_answer: sorry", "no_answer: hello")
            .replace(
                "no_input: bye, invalid: ask",
                "no_input: connect, invalid: sorry",
            )
            .replace("  bye:\n    kind: hangup\n", "");
        assert_eq!(validate(&parse(&src)), Ok(()));
        assert_eq!(
            outbound_codes(&src),
            vec![
                "outbound_unbounded_loop",
                "outbound_unbounded_loop",
                "outbound_unbounded_loop"
            ]
        );
    }

    #[test]
    fn a_loop_that_needs_a_keypress_is_bounded() {
        // hello -> ask -(1)-> connect -(no_answer)-> hello: only a callee
        // pressing 1 can take the menu's digit exit.
        let src = HANDOFF
            .replace("no_answer: sorry", "no_answer: hello")
            .replace("no_input: bye", "no_input: sorry")
            .replace("  bye:\n    kind: hangup\n", "");
        assert_eq!(validate(&parse(&src)), Ok(()));
        assert_eq!(validate_outbound(&parse(&src)), Ok(()));
    }
}
