//! What a flow run did — the trace (doc 48 "Traces: what the flow did,
//! visible everywhere"). The engine appends one [`TraceStep`] per node it
//! executes and ends with a [`FlowOutcome`]. The daemon maps this to call
//! events (a flow timeline in Call details) and to the push uploader that
//! syncs it to the platform; the editor later overlays step counts on the
//! flow diagram.
//!
//! Serializable and self-contained (references node ids and small enums, no
//! daemon types) so it travels unchanged from the engine core to events,
//! storage, and the wire. This is an output format, not the document shape —
//! so it is hand-written here, not generated from the schema.

use std::time::Instant;

use serde::Serialize;

use crate::NodeId;

/// The full record of one run of a flow against one caller.
///
/// Owned by the *caller* of [`crate::engine::run`], not the engine — so a
/// daemon that races the run against the dialog's death still holds every
/// step executed up to the drop (a caller hanging up mid-menu is exactly the
/// trace worth keeping).
#[derive(Debug, Clone, Serialize)]
pub struct Trace {
    pub flow_id: String,
    pub flow_version: u64,
    pub steps: Vec<TraceStep>,
    pub outcome: FlowOutcome,
    /// Set when the run ended abnormally (`Aborted`/`Defect`) — the
    /// underlying effect or engine error, for logs. `None` on a clean run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// When the run started — the zero point every step's [`TraceStep::at_ms`]
    /// offsets from. Not serialized (wall-clock anchoring is the consumer's
    /// job; it knows when it answered).
    #[serde(skip)]
    started: Instant,
}

impl Trace {
    /// Start an empty trace for one run. `outcome` begins as
    /// [`FlowOutcome::Defect`] and is replaced when the engine finishes; a
    /// trace whose run was cancelled (dropped mid-select) keeps the
    /// placeholder — consumers that saw the cancellation should trust their
    /// own end signal, not this field.
    pub fn new(flow_id: &str, flow_version: u64) -> Self {
        Trace {
            flow_id: flow_id.to_string(),
            flow_version,
            steps: Vec::new(),
            outcome: FlowOutcome::Defect, // replaced before return
            error: None,
            started: Instant::now(),
        }
    }

    pub(crate) fn push(&mut self, node: &NodeId, kind: &'static str, detail: StepDetail) {
        let at_ms = self.started.elapsed().as_millis() as u64;
        self.steps.push(TraceStep {
            node: node.clone(),
            kind,
            at_ms,
            detail,
        });
    }

    /// Whether the run completed without an effect failure or engine defect —
    /// the signal the daemon uses to decide whether to log a warning
    /// alongside persisting the trace.
    pub fn is_clean(&self) -> bool {
        !matches!(self.outcome, FlowOutcome::Aborted | FlowOutcome::Defect)
    }
}

/// One executed node and what happened there.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TraceStep {
    pub node: NodeId,
    pub kind: &'static str,
    /// Milliseconds since the run started (≈ since the call was answered) —
    /// places the step on the call's timeline, and later on the recording's
    /// waveform.
    pub at_ms: u64,
    pub detail: StepDetail,
}

/// The per-node outcome. Tagged so it serializes to a self-describing object
/// the renderer can switch on.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "detail", rename_all = "snake_case")]
pub enum StepDetail {
    /// A greeting/`say_hours` spoke and continued.
    Spoke,
    /// An `hours` branch resolved.
    Hours { open: bool },
    /// A menu caller pressed a mapped option.
    MenuChoice { digit: String },
    /// A menu exhausted its retries with no input at all.
    MenuNoInput,
    /// A menu exhausted its retries hearing only unmapped keys.
    MenuInvalid,
    /// A `ring` finished — `answered` means the human took the call.
    Ring { answered: bool },
    /// A voicemail was recorded (seconds captured).
    MessageRecorded { secs: u32 },
    /// A blind transfer was placed.
    Transferred { target: String },
    /// The flow spoke an optional goodbye and hung up.
    HungUp,
    /// A `book` node read the calendar and offered this many times.
    BookOffered { count: u64 },
    /// A `book` node put the caller in the calendar (RFC 3339 start).
    Booked { start: String },
    /// The time the caller chose was gone by the time they pressed a key.
    BookSlotTaken,
    /// A `book` node had nothing to offer — an empty calendar window, or
    /// a second slot lost to somebody else mid-conversation.
    BookNoSlots,
    /// A `book` node offered times and heard nothing usable back.
    BookNoInput,
    /// A `book` node could not reach the calendar at all.
    BookUnavailable,
}

/// How a run ended — the call disposition ("Answered by your receptionist",
/// "Left a message", …) and the debugging outcome for abnormal ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FlowOutcome {
    /// A `ring` node was answered by a human; the engine stepped out.
    Answered,
    /// A `message` node recorded a voicemail.
    MessageLeft,
    /// A `transfer` node handed the call to an external number.
    Transferred,
    /// A `hangup` node ended the call.
    HungUp,
    /// An effect failed mid-run (the call likely dropped). See
    /// [`Trace::error`].
    Aborted,
    /// The flow reached an impossible state — an unknown node, a missing exit,
    /// or the step cap. Validation is meant to prevent all of these, so this
    /// signals a defect worth alerting on.
    Defect,
}
