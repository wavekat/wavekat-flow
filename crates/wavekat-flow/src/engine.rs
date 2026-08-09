//! The flow interpreter — doc 48's "the daemon runs the flow".
//!
//! The loop is deliberately tiny: run the current node, get either the next
//! node id or a terminal, append a trace step, repeat. All the side effects a
//! component needs (speak, collect a DTMF digit, ring the human, record,
//! transfer, hang up) sit behind the [`FlowEffects`] trait — the
//! "component-implementation seam" doc 48 keeps the engine generic over. The
//! daemon supplies the real impl (wiring `wavekat-tts` for prompts, RFC 4733
//! receive for DTMF, the normal incoming-call path for `ring`, the recording
//! pipeline for `message`, REFER for `transfer`); tests supply a scripted
//! mock. Nothing here touches SQLite, the renderer, sync, or cpal — the whole
//! module stays extractable.
//!
//! Control-flow logic (menu retry counting, hours branching) lives here and
//! is pure; only the actual audio/telephony effects cross the trait. That is
//! what makes a full call testable with no call.
//!
//! This crate owns the [`FlowEffects`] trait *definition*; the daemon keeps
//! its live `CallFlowEffects` *impl* in its own codebase.

use std::time::Duration;

use async_trait::async_trait;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::book;
use crate::hours::{self, HoursError};
use crate::model::{Flow, HoursException, MessageTone, Node, Prompt, WeeklySchedule};
use crate::trace::{FlowOutcome, StepDetail, Trace};
use crate::NodeId;

/// Backstop against a cycle in a flow that somehow reached the engine
/// unvalidated (validation's trap check should make this unreachable). A real
/// flow visits a handful of nodes; 100 is far above any genuine path and far
/// below an infinite loop.
const MAX_STEPS: u32 = 100;

/// A DTMF key a caller can press.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Digit {
    D0,
    D1,
    D2,
    D3,
    D4,
    D5,
    D6,
    D7,
    D8,
    D9,
    Star,
    Hash,
}

impl Digit {
    /// The document key for this digit (`"1"`, `"*"`, …) — matches the keys
    /// of a `menu`'s `options` / `exits`.
    pub fn as_key(self) -> &'static str {
        match self {
            Digit::D0 => "0",
            Digit::D1 => "1",
            Digit::D2 => "2",
            Digit::D3 => "3",
            Digit::D4 => "4",
            Digit::D5 => "5",
            Digit::D6 => "6",
            Digit::D7 => "7",
            Digit::D8 => "8",
            Digit::D9 => "9",
            Digit::Star => "*",
            Digit::Hash => "#",
        }
    }
}

/// What a `book` node needs to know to ask "when is this business free?"
/// — its own config, nothing about the caller and nothing about which
/// calendar answers. Borrowed from the node, so the engine copies no
/// schedules around.
#[derive(Debug, Clone, Copy)]
pub struct SlotQuery<'a> {
    pub schedule: &'a WeeklySchedule,
    pub timezone: &'a str,
    pub exceptions: &'a [HoursException],
    pub duration_mins: u64,
    pub buffer_mins: u64,
    pub lead_mins: u64,
    pub horizon_days: u64,
    /// How many times to ask for. The answer may be shorter, never longer.
    pub max_offers: u64,
}

/// One offerable appointment, as absolute instants (RFC 3339). The
/// engine never invents these and never adjusts them — it offers what it
/// was given and hands the chosen one straight back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Slot {
    pub start: String,
    pub end: String,
}

/// The answer to [`FlowEffects::fetch_slots`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotOffer {
    pub slots: Vec<Slot>,
    /// The zone the times should be *said* in — the business's, echoed
    /// back so the engine doesn't have to trust its own parse of the
    /// node's config.
    pub timezone: String,
}

/// What came of trying to book one slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BookOutcome {
    /// It is in the calendar; the caller has an appointment.
    Booked,
    /// Somebody else took it between the offer and the keypress. Worth
    /// its own answer because the caller can be offered something else,
    /// where `Unavailable` means asking again is pointless.
    SlotTaken,
    /// The booking could not be attempted or did not stick — no
    /// connection, a provider outage, a refused request.
    Unavailable,
}

/// Result of a `ring` node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RingOutcome {
    /// A human answered — they own the call now and the engine steps out.
    Answered,
    /// The ring window elapsed with no answer.
    NoAnswer,
}

/// The side effects the components need. The engine calls these; the impl
/// performs the telephony/audio. `&mut self` because a real impl holds the
/// live call. Methods return `anyhow::Result` so the daemon impl can surface
/// call-dropped / device errors uniformly; the engine treats any `Err` as
/// "the call is gone" and aborts with a trace.
#[async_trait]
pub trait FlowEffects: Send {
    /// Play a prompt (TTS text or an audio asset) to the caller, returning
    /// when playback finishes.
    async fn speak(&mut self, prompt: &Prompt) -> anyhow::Result<()>;

    /// Wait up to `timeout` for one DTMF digit. `Ok(None)` means the window
    /// elapsed with no press (distinct from an error).
    async fn collect_digit(&mut self, timeout: Duration) -> anyhow::Result<Option<Digit>>;

    /// Ring the human for up to `timeout`.
    async fn ring_human(&mut self, timeout: Duration) -> anyhow::Result<RingOutcome>;

    /// Record a voicemail: play `tone` (the caller's record-start cue), then
    /// capture up to `max`. The node's prompt has already been spoken via
    /// [`FlowEffects::speak`] — the engine traces it as its own step. Returns
    /// the seconds actually captured (for the trace).
    async fn record_message(&mut self, tone: MessageTone, max: Duration) -> anyhow::Result<u32>;

    /// Blind-transfer the call to `target`.
    async fn transfer(&mut self, target: &str) -> anyhow::Result<()>;

    /// Speak an optional goodbye and end the call.
    async fn hangup(&mut self, prompt: Option<&Prompt>) -> anyhow::Result<()>;

    /// Ask when the business is free, for a `book` node.
    ///
    /// The credential never comes near here: the impl asks the platform,
    /// which holds the calendar connection and answers with times. An
    /// `Err` is a transport failure — the platform unreachable, a
    /// timeout — and routes the caller to the node's `unavailable` exit
    /// rather than aborting the call, because unlike [`Self::speak`]
    /// this failing says nothing about whether the caller is still
    /// there. A working call with no calendar behind it still has a
    /// voicemail to fall to.
    async fn fetch_slots(&mut self, query: &SlotQuery<'_>) -> anyhow::Result<SlotOffer>;

    /// Book one of the slots [`Self::fetch_slots`] returned. Idempotent
    /// per call as far as the engine is concerned — it asks at most
    /// twice per node, and never for two different slots at once.
    /// `Err` is treated as [`BookOutcome::Unavailable`], for the same
    /// reason as above.
    async fn book_slot(&mut self, slot: &Slot) -> anyhow::Result<BookOutcome>;

    /// The current instant, for `hours` evaluation. Injectable so tests pin a
    /// fixed time and the schedule is deterministic.
    fn now(&self) -> OffsetDateTime;

    /// Called once as the engine *enters* a node, before that node's own
    /// effects run — carries the node's id and its component kind
    /// ([`Node::kind`], e.g. `"greeting"`, `"menu"`). Lets a live consumer
    /// light up which node is executing *right now*, and accumulate the path
    /// the caller has taken, without waiting for the run-end trace.
    ///
    /// Default no-op: the durable, ordered per-node record is the trace
    /// ([`Trace`]); a consumer that only reads results at run end ignores
    /// this. Fires for every visited node including `hours` (which runs no
    /// other effect) and a node re-entered by a menu loop.
    fn on_enter(&mut self, _node: &NodeId, _kind: &'static str) {}
}

/// Engine-internal failure. `Effect` is an outside failure (call dropped) →
/// the run aborts; the others are "impossible on a validated flow" defects
/// the engine refuses to guess through.
#[derive(Debug, thiserror::Error)]
enum EngineError {
    #[error("effect failed: {0}")]
    Effect(anyhow::Error),
    #[error("node {0:?} not found")]
    UnknownNode(NodeId),
    #[error("node {node:?} has no {exit:?} exit")]
    MissingExit { node: NodeId, exit: String },
    #[error("hours evaluation at {node:?} failed: {source}")]
    Hours { node: NodeId, source: HoursError },
}

impl EngineError {
    /// The abnormal outcome this error maps to. An outside failure is an
    /// `Aborted` run; everything else is a `Defect` (a validation gap).
    fn outcome(&self) -> FlowOutcome {
        match self {
            EngineError::Effect(_) => FlowOutcome::Aborted,
            _ => FlowOutcome::Defect,
        }
    }
}

/// One node's result: go to the next node, or end the call.
enum Step {
    Goto(NodeId),
    End(FlowOutcome),
}

/// Run a validated flow to completion against `fx`, filling `trace`.
///
/// Infallible by design: every ending — clean terminal, aborted call, or
/// engine defect — is captured in `trace` (its `outcome`, and `error` for
/// abnormal ends), because the daemon wants to persist and surface *what
/// happened* regardless. Callers check [`Trace::is_clean`] to decide whether
/// to also log a warning.
///
/// The trace is caller-owned (see [`Trace::new`]) so a caller that races this
/// future against the dialog's termination signal — and drops it when the
/// caller hangs up mid-flow — still holds the steps executed so far. A
/// cancelled run never writes `outcome`; it keeps the [`FlowOutcome::Defect`]
/// placeholder.
pub async fn run<E: FlowEffects>(flow: &Flow, fx: &mut E, trace: &mut Trace) {
    let mut current = flow.entry.clone();

    for _ in 0..MAX_STEPS {
        let node = match flow.nodes.get(&current) {
            Some(n) => n,
            None => return abort(trace, EngineError::UnknownNode(current)),
        };
        match run_node(&current, node, fx, trace).await {
            Ok(Step::Goto(next)) => current = next,
            Ok(Step::End(outcome)) => {
                trace.outcome = outcome;
                return;
            }
            Err(err) => return abort(trace, err),
        }
    }

    // Step cap hit — treat as a defect (validation should prevent it).
    trace.outcome = FlowOutcome::Defect;
    trace.error = Some(format!(
        "step cap {MAX_STEPS} exceeded — cycle in an unvalidated flow?"
    ));
}

/// Finalize a trace for an abnormal ending.
fn abort(trace: &mut Trace, err: EngineError) {
    trace.outcome = err.outcome();
    trace.error = Some(err.to_string());
}

async fn run_node<E: FlowEffects>(
    id: &NodeId,
    node: &Node,
    fx: &mut E,
    trace: &mut Trace,
) -> Result<Step, EngineError> {
    let kind = node.kind();
    // Announce the node the instant the engine reaches it — before any
    // prompt plays or digit is collected — so a live view reflects the
    // caller's true position, not where they were a prompt ago.
    fx.on_enter(id, kind);
    match node {
        Node::Greeting { prompt, .. } => {
            fx.speak(prompt).await.map_err(EngineError::Effect)?;
            trace.push(id, kind, StepDetail::Spoke);
            goto(id, node, "next")
        }

        Node::Hours { .. } => {
            let result = hours::evaluate(node, fx.now()).map_err(|source| EngineError::Hours {
                node: id.clone(),
                source,
            })?;
            let open = result == hours::HoursResult::Open;
            trace.push(id, kind, StepDetail::Hours { open });
            goto(id, node, result.exit())
        }

        Node::Menu {
            prompt,
            options,
            retries,
            timeout_secs,
            ..
        } => {
            run_menu(
                id,
                node,
                fx,
                trace,
                prompt,
                options,
                *retries,
                *timeout_secs,
            )
            .await
        }

        Node::Ring { timeout_secs, .. } => {
            let outcome = fx
                .ring_human(Duration::from_secs(*timeout_secs))
                .await
                .map_err(EngineError::Effect)?;
            match outcome {
                RingOutcome::Answered => {
                    trace.push(id, kind, StepDetail::Ring { answered: true });
                    Ok(Step::End(FlowOutcome::Answered))
                }
                RingOutcome::NoAnswer => {
                    trace.push(id, kind, StepDetail::Ring { answered: false });
                    goto(id, node, "no_answer")
                }
            }
        }

        Node::Message {
            prompt,
            max_secs,
            tone,
            ..
        } => {
            // The prompt is a traced step of its own, like a greeting's — it
            // marks the "please leave a message" moment on the call's
            // timeline, minutes before the recording that ends the node.
            fx.speak(prompt).await.map_err(EngineError::Effect)?;
            trace.push(id, kind, StepDetail::Spoke);
            let secs = fx
                .record_message(*tone, Duration::from_secs(*max_secs))
                .await
                .map_err(EngineError::Effect)?;
            trace.push(id, kind, StepDetail::MessageRecorded { secs });
            Ok(Step::End(FlowOutcome::MessageLeft))
        }

        Node::Transfer { target, .. } => {
            fx.transfer(target).await.map_err(EngineError::Effect)?;
            trace.push(
                id,
                kind,
                StepDetail::Transferred {
                    target: target.clone(),
                },
            );
            Ok(Step::End(FlowOutcome::Transferred))
        }

        Node::Hangup { prompt, .. } => {
            fx.hangup(prompt.as_ref())
                .await
                .map_err(EngineError::Effect)?;
            trace.push(id, kind, StepDetail::HungUp);
            Ok(Step::End(FlowOutcome::HungUp))
        }

        Node::Book { .. } => run_book(id, node, fx, trace).await,
    }
}

/// The `book` node: offer open times, take a keypress, book it.
///
/// Four ways out, and the shape of the code is mostly about keeping
/// three of them from turning into a dropped call. Nothing here retries
/// a provider or waits on a queue — there is a person on the line, so
/// every failure resolves to an exit the author wired.
async fn run_book<E: FlowEffects>(
    id: &NodeId,
    node: &Node,
    fx: &mut E,
    trace: &mut Trace,
) -> Result<Step, EngineError> {
    let Node::Book {
        prompt,
        confirm_prompt,
        schedule,
        timezone,
        exceptions,
        duration_mins,
        buffer_mins,
        lead_mins,
        horizon_days,
        max_offers,
        retries,
        timeout_secs,
        ..
    } = node
    else {
        // Unreachable: the caller matched on the variant.
        return Err(EngineError::UnknownNode(id.clone()));
    };

    let query = SlotQuery {
        schedule,
        timezone,
        exceptions,
        duration_mins: *duration_mins,
        buffer_mins: *buffer_mins,
        lead_mins: *lead_mins,
        horizon_days: *horizon_days,
        max_offers: *max_offers,
    };

    // The one thing a slot must be able to do is be *said*. The
    // vocabulary was rendered from this node's own schedule at publish,
    // so a time outside it has no clip — offering it would play the key
    // to press after a silence where the time should be. Dropping it is
    // the honest degradation, and it keeps a schedule edited after
    // publish from producing a mute offer.
    let sayable = book::vocabulary_refs(node);

    // At most two rounds: the caller's chosen slot can be taken out from
    // under them once and still leave something to offer; a second miss
    // means the calendar is busier than this conversation can keep up
    // with, and pretending otherwise just keeps them on the phone.
    for round in 0..2u8 {
        let offer = match fx.fetch_slots(&query).await {
            Ok(offer) => offer,
            Err(_) => {
                trace.push(id, "book", StepDetail::BookUnavailable);
                return goto(id, node, "unavailable");
            }
        };

        let tz = match crate::hours::resolve_tz(&offer.timezone) {
            Ok(tz) => tz,
            // A zone name neither side can resolve. Validation rejects
            // this at publish, so reaching it means the two disagree —
            // which is a defect, not something to guess a zone for.
            Err(_) => {
                trace.push(id, "book", StepDetail::BookUnavailable);
                return goto(id, node, "unavailable");
            }
        };

        let now = fx.now();
        let offered: Vec<(Slot, Vec<String>)> = offer
            .slots
            .iter()
            .filter_map(|slot| {
                let start = OffsetDateTime::parse(&slot.start, &Rfc3339).ok()?;
                Some((slot.clone(), book::time_refs(start, now, tz)))
            })
            .filter(|(_, refs)| refs.iter().all(|r| sayable.contains(r)))
            .take(usize::try_from(*max_offers).unwrap_or(usize::MAX))
            .collect();

        if offered.is_empty() {
            trace.push(id, "book", StepDetail::BookNoSlots);
            return goto(id, node, "no_slots");
        }
        trace.push(
            id,
            "book",
            StepDetail::BookOffered {
                count: offered.len() as u64,
            },
        );

        let chosen = match collect_offer_choice(
            fx,
            prompt,
            &offered,
            *retries,
            Duration::from_secs(*timeout_secs),
        )
        .await?
        {
            Some(index) => &offered[index].0,
            None => {
                trace.push(id, "book", StepDetail::BookNoInput);
                return goto(id, node, "no_input");
            }
        };

        match fx.book_slot(chosen).await {
            Ok(BookOutcome::Booked) => {
                // "You're booked for" → "Tuesday" → "ten thirty a.m." The
                // confirmation is a prompt and the time is clips, which is
                // why the prompt takes no placeholder (see the schema).
                fx.speak(confirm_prompt)
                    .await
                    .map_err(EngineError::Effect)?;
                let start = OffsetDateTime::parse(&chosen.start, &Rfc3339)
                    .map_err(|_| EngineError::UnknownNode(id.clone()))?;
                for reference in book::time_refs(start, now, tz) {
                    fx.speak(&Prompt::Audio {
                        audio: reference,
                        transcript: None,
                    })
                    .await
                    .map_err(EngineError::Effect)?;
                }
                trace.push(
                    id,
                    "book",
                    StepDetail::Booked {
                        start: chosen.start.clone(),
                    },
                );
                return goto(id, node, "booked");
            }
            Ok(BookOutcome::SlotTaken) => {
                trace.push(id, "book", StepDetail::BookSlotTaken);
                fx.speak(&Prompt::Audio {
                    audio: book::taken_ref(),
                    transcript: None,
                })
                .await
                .map_err(EngineError::Effect)?;
                if round == 1 {
                    trace.push(id, "book", StepDetail::BookNoSlots);
                    return goto(id, node, "no_slots");
                }
                // Round two re-reads the calendar rather than re-offering
                // the stale list: whatever took this slot may have taken
                // another.
            }
            Ok(BookOutcome::Unavailable) | Err(_) => {
                trace.push(id, "book", StepDetail::BookUnavailable);
                return goto(id, node, "unavailable");
            }
        }
    }

    trace.push(id, "book", StepDetail::BookNoSlots);
    goto(id, node, "no_slots")
}

/// Speak the intro and the offers, then wait for a key. Returns the
/// index of the offer the caller took, or `None` when the attempts ran
/// out. Unmapped keys and silence both simply cost an attempt — `book`
/// has no `invalid` exit, because "you pressed 7" and "you pressed
/// nothing" want the same thing from the flow: ask again, then move on.
async fn collect_offer_choice<E: FlowEffects>(
    fx: &mut E,
    prompt: &Prompt,
    offered: &[(Slot, Vec<String>)],
    retries: u64,
    timeout: Duration,
) -> Result<Option<usize>, EngineError> {
    for _ in 0..retries.saturating_add(1) {
        fx.speak(prompt).await.map_err(EngineError::Effect)?;
        for (index, (_, refs)) in offered.iter().enumerate() {
            for reference in refs
                .iter()
                .cloned()
                .chain(std::iter::once(book::press_ref(index as u64 + 1)))
            {
                fx.speak(&Prompt::Audio {
                    audio: reference,
                    transcript: None,
                })
                .await
                .map_err(EngineError::Effect)?;
            }
        }

        let pressed = fx
            .collect_digit(timeout)
            .await
            .map_err(EngineError::Effect)?;
        if let Some(digit) = pressed {
            if let Some(index) = digit
                .as_key()
                .parse::<usize>()
                .ok()
                .filter(|d| *d >= 1 && *d <= offered.len())
            {
                return Ok(Some(index - 1));
            }
        }
    }
    Ok(None)
}

/// The menu retry loop. Speak, collect a digit, repeat up to `retries + 1`
/// attempts. A mapped digit follows its exit; running out of attempts follows
/// `invalid` if the caller pressed unmapped keys at all, else `no_input`
/// (pure silence).
#[allow(clippy::too_many_arguments)]
async fn run_menu<E: FlowEffects>(
    id: &NodeId,
    node: &Node,
    fx: &mut E,
    trace: &mut Trace,
    prompt: &Prompt,
    options: &std::collections::HashMap<String, String>,
    retries: u64,
    timeout_secs: u64,
) -> Result<Step, EngineError> {
    let attempts = retries.saturating_add(1);
    let mut heard_any_key = false;

    for _ in 0..attempts {
        fx.speak(prompt).await.map_err(EngineError::Effect)?;
        let pressed = fx
            .collect_digit(Duration::from_secs(timeout_secs))
            .await
            .map_err(EngineError::Effect)?;
        match pressed {
            Some(digit) if options.contains_key(digit.as_key()) => {
                trace.push(
                    id,
                    "menu",
                    StepDetail::MenuChoice {
                        digit: digit.as_key().to_string(),
                    },
                );
                return goto(id, node, digit.as_key());
            }
            Some(_) => heard_any_key = true, // unmapped key → retry
            None => {}                       // timeout → retry
        }
    }

    if heard_any_key {
        trace.push(id, "menu", StepDetail::MenuInvalid);
        goto(id, node, "invalid")
    } else {
        trace.push(id, "menu", StepDetail::MenuNoInput);
        goto(id, node, "no_input")
    }
}

/// Follow a named exit to the next node. On a validated flow the exit is
/// always present; a miss is a defect, surfaced rather than guessed.
fn goto(id: &NodeId, node: &Node, exit: &str) -> Result<Step, EngineError> {
    node.exits()
        .and_then(|exits| exits.get(exit))
        .map(|target| Step::Goto(target.clone()))
        .ok_or_else(|| EngineError::MissingExit {
            node: id.clone(),
            exit: exit.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use time::macros::datetime;

    use super::*;
    use crate::trace::FlowOutcome;
    use crate::validate::validate;

    /// A scripted [`FlowEffects`] — the scenario harness doc 48's M1 "done"
    /// criterion describes ("call the line ourselves, scenario by scenario"),
    /// at unit speed. Feed it a clock, a queue of digit presses, and a ring
    /// outcome; read back what the flow spoke and did.
    struct MockEffects {
        now: OffsetDateTime,
        digits: VecDeque<Option<Digit>>,
        ring: RingOutcome,
        message_secs: u32,
        // observed:
        spoken: Vec<String>,
        transferred: Option<String>,
        recorded: bool,
        /// The record-start cue the message node asked for, when one ran.
        record_tone: Option<MessageTone>,
        hung_up: bool,
        fail_speak: bool,
        /// Every node the engine entered, in visit order (id, kind) — the
        /// live-position signal `on_enter` feeds.
        entered: Vec<(String, &'static str)>,
        /// Scripted answers for `book`, consumed in order. An exhausted
        /// queue answers the way an unreachable platform does, which is
        /// what a test that forgot to script one should see.
        slot_answers: VecDeque<anyhow::Result<SlotOffer>>,
        book_answers: VecDeque<anyhow::Result<BookOutcome>>,
        /// Observed: what was asked for, and what was taken.
        slot_queries: u32,
        booked: Vec<Slot>,
    }

    impl MockEffects {
        fn new(now: OffsetDateTime) -> Self {
            MockEffects {
                now,
                digits: VecDeque::new(),
                ring: RingOutcome::NoAnswer,
                message_secs: 0,
                spoken: Vec::new(),
                transferred: None,
                recorded: false,
                record_tone: None,
                hung_up: false,
                fail_speak: false,
                entered: Vec::new(),
                slot_answers: VecDeque::new(),
                book_answers: VecDeque::new(),
                slot_queries: 0,
                booked: Vec::new(),
            }
        }
        fn slot_answers(
            mut self,
            seq: impl IntoIterator<Item = anyhow::Result<SlotOffer>>,
        ) -> Self {
            self.slot_answers = seq.into_iter().collect();
            self
        }
        fn book_answers(
            mut self,
            seq: impl IntoIterator<Item = anyhow::Result<BookOutcome>>,
        ) -> Self {
            self.book_answers = seq.into_iter().collect();
            self
        }
        fn digits(mut self, seq: impl IntoIterator<Item = Option<Digit>>) -> Self {
            self.digits = seq.into_iter().collect();
            self
        }
        fn ring(mut self, r: RingOutcome) -> Self {
            self.ring = r;
            self
        }
        fn message_secs(mut self, s: u32) -> Self {
            self.message_secs = s;
            self
        }
    }

    /// What the caller heard, as a string a test can assert on. An audio
    /// prompt reports its ref: for `book` that *is* the content — the
    /// clips are the words.
    fn prompt_label(p: &Prompt) -> String {
        match p {
            Prompt::Text(t) => t.clone(),
            Prompt::Audio { audio, .. } => audio.clone(),
        }
    }

    #[async_trait]
    impl FlowEffects for MockEffects {
        async fn speak(&mut self, prompt: &Prompt) -> anyhow::Result<()> {
            if self.fail_speak {
                anyhow::bail!("caller hung up");
            }
            self.spoken.push(prompt_label(prompt));
            Ok(())
        }
        async fn collect_digit(&mut self, _timeout: Duration) -> anyhow::Result<Option<Digit>> {
            // Exhausted script = silence (timeout), never an error.
            Ok(self.digits.pop_front().flatten())
        }
        async fn ring_human(&mut self, _timeout: Duration) -> anyhow::Result<RingOutcome> {
            Ok(self.ring)
        }
        async fn record_message(
            &mut self,
            tone: MessageTone,
            _max: Duration,
        ) -> anyhow::Result<u32> {
            self.recorded = true;
            self.record_tone = Some(tone);
            Ok(self.message_secs)
        }
        async fn transfer(&mut self, target: &str) -> anyhow::Result<()> {
            self.transferred = Some(target.to_string());
            Ok(())
        }
        async fn hangup(&mut self, prompt: Option<&Prompt>) -> anyhow::Result<()> {
            if let Some(p) = prompt {
                self.spoken.push(prompt_label(p));
            }
            self.hung_up = true;
            Ok(())
        }
        async fn fetch_slots(&mut self, _query: &SlotQuery<'_>) -> anyhow::Result<SlotOffer> {
            self.slot_queries += 1;
            self.slot_answers
                .pop_front()
                .unwrap_or_else(|| anyhow::bail!("no slot answer scripted"))
        }
        async fn book_slot(&mut self, slot: &Slot) -> anyhow::Result<BookOutcome> {
            self.booked.push(slot.clone());
            self.book_answers
                .pop_front()
                .unwrap_or_else(|| anyhow::bail!("no book answer scripted"))
        }
        fn now(&self) -> OffsetDateTime {
            self.now
        }
        fn on_enter(&mut self, node: &NodeId, kind: &'static str) {
            self.entered.push((node.clone(), kind));
        }
    }

    const LUIGIS: &str = r#"
schema_version: 1
id: flow_luigi
name: Luigi's — after hours
version: 3
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
    prompt: We're closed. Press 1 for hours, or hold for a message.
    options: { "1": Hours }
    retries: 1
    exits: { "1": say_hours, no_input: take_message, invalid: take_message }
  say_hours:
    kind: greeting
    prompt: We're open Tuesday to Sunday, eleven to ten.
    exits: { next: take_message }
  take_message:
    kind: message
    prompt: Please leave your name and number after the tone.
"#;

    fn luigis() -> Flow {
        let flow = Flow::from_yaml(LUIGIS).expect("parses");
        validate(&flow).expect("the scenario flow must be valid");
        flow
    }

    // A Tuesday during business hours: 15:00 EDT = 19:00 UTC.
    fn open_time() -> OffsetDateTime {
        datetime!(2026-07-07 19:00 UTC)
    }
    // A Tuesday after close: 23:00 EDT = 03:00 UTC Wednesday.
    fn closed_time() -> OffsetDateTime {
        datetime!(2026-07-08 03:00 UTC)
    }

    fn kinds(trace: &Trace) -> Vec<&str> {
        trace.steps.iter().map(|s| s.kind).collect()
    }

    /// Test-side ergonomics for the caller-owned-trace API: build the trace,
    /// run, hand it back.
    async fn run_trace(flow: &Flow, fx: &mut MockEffects) -> Trace {
        let mut trace = Trace::new(&flow.id, flow.version);
        run(flow, fx, &mut trace).await;
        trace
    }

    #[tokio::test]
    async fn open_hours_human_answers() {
        let mut fx = MockEffects::new(open_time()).ring(RingOutcome::Answered);
        let trace = run_trace(&luigis(), &mut fx).await;

        assert_eq!(trace.outcome, FlowOutcome::Answered);
        assert!(trace.is_clean());
        assert_eq!(kinds(&trace), vec!["greeting", "hours", "ring"]);
        // The hours branch went `open`.
        assert_eq!(trace.steps[1].detail, StepDetail::Hours { open: true });
        assert!(!fx.recorded, "a human answered — no voicemail");
    }

    #[tokio::test]
    async fn on_enter_reports_each_node_as_the_engine_reaches_it() {
        // Human answers during open hours: greeting → hours → ring. The
        // effect-less `hours` node still announces itself, so a live view
        // can light it — the whole point of the hook over the effect calls.
        let mut fx = MockEffects::new(open_time()).ring(RingOutcome::Answered);
        let _ = run_trace(&luigis(), &mut fx).await;
        assert_eq!(
            fx.entered,
            vec![
                ("welcome".to_string(), "greeting"),
                ("check_hours".to_string(), "hours"),
                ("front_desk".to_string(), "ring"),
            ],
            "on_enter fires once per visited node, in path order"
        );

        // Closed → press 1 → hours greeting → voicemail: the live position
        // tracks every hop, and the ids line up with the run-end trace.
        let mut fx = MockEffects::new(closed_time())
            .digits([Some(Digit::D1)])
            .message_secs(12);
        let trace = run_trace(&luigis(), &mut fx).await;
        let entered_ids: Vec<&str> = fx.entered.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(
            entered_ids,
            vec![
                "welcome",
                "check_hours",
                "night_menu",
                "say_hours",
                "take_message"
            ],
        );
        // A menu's internal retries don't re-enter the node — it's announced
        // once even though run_menu may loop for a bad/absent key.
        assert_eq!(
            fx.entered
                .iter()
                .filter(|(id, _)| id == "night_menu")
                .count(),
            1,
        );
        // Every node the trace recorded is a node on_enter announced. The
        // message node traces twice (prompt, then recording) but is entered
        // once, so collapse consecutive repeats before comparing.
        let mut trace_nodes: Vec<&str> = trace.steps.iter().map(|s| s.node.as_str()).collect();
        trace_nodes.dedup();
        assert_eq!(entered_ids, trace_nodes);
    }

    #[tokio::test]
    async fn open_hours_no_answer_falls_to_voicemail() {
        let mut fx = MockEffects::new(open_time())
            .ring(RingOutcome::NoAnswer)
            .message_secs(40);
        let trace = run_trace(&luigis(), &mut fx).await;

        assert_eq!(trace.outcome, FlowOutcome::MessageLeft);
        assert_eq!(
            kinds(&trace),
            vec!["greeting", "hours", "ring", "message", "message"]
        );
        // The voicemail prompt is its own traced step (regression: it used to
        // leave no mark on the call's timeline), followed by the recording
        // that ends the run.
        assert_eq!(trace.steps[3].detail, StepDetail::Spoke);
        assert_eq!(
            trace.steps[4].detail,
            StepDetail::MessageRecorded { secs: 40 }
        );
        // The caller actually heard the prompt before the recording.
        assert!(fx.spoken.iter().any(|s| s.contains("leave your name")));
        assert!(fx.recorded);
        // The unconfigured node carried the default record-start cue.
        assert_eq!(fx.record_tone, Some(MessageTone::Beep));
    }

    #[tokio::test]
    async fn closed_press_one_hears_hours_then_leaves_message() {
        let mut fx = MockEffects::new(closed_time())
            .digits([Some(Digit::D1)])
            .message_secs(12);
        let trace = run_trace(&luigis(), &mut fx).await;

        assert_eq!(trace.outcome, FlowOutcome::MessageLeft);
        assert_eq!(
            kinds(&trace),
            vec!["greeting", "hours", "menu", "greeting", "message", "message"]
        );
        assert_eq!(trace.steps[1].detail, StepDetail::Hours { open: false });
        assert_eq!(
            trace.steps[2].detail,
            StepDetail::MenuChoice { digit: "1".into() }
        );
        // The caller heard the opening-hours greeting.
        assert!(fx
            .spoken
            .iter()
            .any(|s| s.contains("open Tuesday to Sunday")));
    }

    #[tokio::test]
    async fn closed_silence_takes_no_input_exit() {
        // No digits scripted → every collect times out → no_input.
        let mut fx = MockEffects::new(closed_time());
        let trace = run_trace(&luigis(), &mut fx).await;

        assert_eq!(trace.outcome, FlowOutcome::MessageLeft);
        assert_eq!(
            kinds(&trace),
            vec!["greeting", "hours", "menu", "message", "message"]
        );
        assert_eq!(trace.steps[2].detail, StepDetail::MenuNoInput);
    }

    #[tokio::test]
    async fn closed_wrong_keys_take_invalid_exit_after_retry() {
        // retries: 1 → 2 attempts; press an unmapped key both times.
        let mut fx = MockEffects::new(closed_time()).digits([Some(Digit::D9), Some(Digit::D7)]);
        let trace = run_trace(&luigis(), &mut fx).await;

        assert_eq!(trace.outcome, FlowOutcome::MessageLeft);
        assert_eq!(trace.steps[2].detail, StepDetail::MenuInvalid);
        // The menu prompt was spoken once per attempt.
        let menu_prompts = fx
            .spoken
            .iter()
            .filter(|s| s.contains("Press 1 for hours"))
            .count();
        assert_eq!(menu_prompts, 2);
    }

    #[tokio::test]
    async fn wrong_key_then_valid_digit_still_routes() {
        // First attempt an unmapped key, second the real option.
        let mut fx = MockEffects::new(closed_time())
            .digits([Some(Digit::D9), Some(Digit::D1)])
            .message_secs(5);
        let trace = run_trace(&luigis(), &mut fx).await;

        assert_eq!(
            trace.steps[2].detail,
            StepDetail::MenuChoice { digit: "1".into() }
        );
        assert_eq!(trace.outcome, FlowOutcome::MessageLeft);
    }

    #[tokio::test]
    async fn steps_carry_monotonic_timeline_offsets() {
        // Each step is stamped with its offset from run start, so the daemon
        // can place it on the call's (and recording's) timeline. Mock effects
        // resolve instantly, so we can't assert real gaps — only that the
        // offsets exist and never run backwards.
        let mut fx = MockEffects::new(closed_time()).digits([Some(Digit::D1)]);
        let trace = run_trace(&luigis(), &mut fx).await;

        assert!(trace.steps.len() >= 3);
        let offsets: Vec<u64> = trace.steps.iter().map(|s| s.at_ms).collect();
        assert!(
            offsets.windows(2).all(|w| w[0] <= w[1]),
            "offsets must be non-decreasing: {offsets:?}"
        );
    }

    #[tokio::test]
    async fn effect_failure_aborts_with_partial_trace() {
        let mut fx = MockEffects::new(open_time());
        fx.fail_speak = true; // the caller hangs up during the greeting
        let trace = run_trace(&luigis(), &mut fx).await;

        assert_eq!(trace.outcome, FlowOutcome::Aborted);
        assert!(!trace.is_clean());
        assert!(trace.error.as_deref().unwrap().contains("caller hung up"));
        // Nothing was appended — it failed on the first node's effect.
        assert!(trace.steps.is_empty());
    }

    // ── `book` (schema_version 2) ────────────────────────────────────────
    //
    // The scenarios that matter are the ones where nothing goes right:
    // three of `book`'s four exits exist because a calendar can fail, and
    // each of them has to end with the caller somewhere sensible rather
    // than listening to silence.

    const CLINIC: &str = r#"
schema_version: 2
id: flow_clinic
name: The clinic
entry: take_booking
nodes:
  take_booking:
    kind: book
    prompt: I can book you in. Here are the next available times.
    confirm_prompt: You're booked for
    timezone: UTC
    schedule:
      tue: [{ open: "09:00", close: "12:00" }]
    duration_mins: 30
    max_offers: 2
    retries: 1
    timeout_secs: 5
    exits:
      booked: goodbye
      no_slots: voicemail
      no_input: voicemail
      unavailable: voicemail
  goodbye:
    kind: hangup
    prompt: See you then.
  voicemail:
    kind: message
    prompt: Leave your name and number.
"#;

    fn clinic() -> Flow {
        let flow = Flow::from_yaml(CLINIC).expect("parses");
        validate(&flow).expect("the scenario flow must be valid");
        flow
    }

    fn slot(start: &str, end: &str) -> Slot {
        Slot {
            start: start.to_string(),
            end: end.to_string(),
        }
    }

    /// Two Tuesday-morning slots, in the vocabulary the CLINIC schedule
    /// renders (09:00–11:30 on the half hour).
    fn two_slots() -> SlotOffer {
        SlotOffer {
            slots: vec![
                slot("2026-07-07T09:00:00Z", "2026-07-07T09:30:00Z"),
                slot("2026-07-07T10:30:00Z", "2026-07-07T11:00:00Z"),
            ],
            timezone: "UTC".to_string(),
        }
    }

    // The Monday before those slots: they are "tomorrow", not "Tuesday".
    fn day_before() -> OffsetDateTime {
        datetime!(2026-07-06 12:00 UTC)
    }

    #[tokio::test]
    async fn book_offers_times_and_confirms_the_one_taken() {
        let mut fx = MockEffects::new(day_before())
            .slot_answers([Ok(two_slots())])
            .book_answers([Ok(BookOutcome::Booked)])
            .digits([Some(Digit::D2)]);
        let trace = run_trace(&clinic(), &mut fx).await;

        // The caller heard the intro, then each time with its key, then
        // the confirmation followed by the time they actually got.
        assert_eq!(
            fx.spoken,
            vec![
                "I can book you in. Here are the next available times.",
                "bkday_tomorrow",
                "bktime_0900",
                "bkpress_1",
                "bkday_tomorrow",
                "bktime_1030",
                "bkpress_2",
                "You're booked for",
                "bkday_tomorrow",
                "bktime_1030",
                "See you then.",
            ],
        );
        // The second offer is what was booked — the digit maps by
        // position, not by any id in the payload.
        assert_eq!(fx.booked, vec![two_slots().slots[1].clone()]);
        assert_eq!(trace.steps[0].detail, StepDetail::BookOffered { count: 2 });
        assert_eq!(
            trace.steps[1].detail,
            StepDetail::Booked {
                start: "2026-07-07T10:30:00Z".into()
            }
        );
        assert_eq!(trace.outcome, FlowOutcome::HungUp);
        assert!(trace.is_clean());
    }

    #[tokio::test]
    async fn an_empty_calendar_takes_the_no_slots_exit() {
        let mut fx = MockEffects::new(day_before()).slot_answers([Ok(SlotOffer {
            slots: Vec::new(),
            timezone: "UTC".to_string(),
        })]);
        let trace = run_trace(&clinic(), &mut fx).await;

        assert_eq!(trace.steps[0].detail, StepDetail::BookNoSlots);
        assert_eq!(trace.outcome, FlowOutcome::MessageLeft);
        // Nothing was offered, so nothing was booked and no key was asked
        // for — the caller goes straight to voicemail.
        assert!(fx.booked.is_empty());
    }

    #[tokio::test]
    async fn an_unreachable_platform_takes_the_unavailable_exit() {
        // The `book` effects failing is NOT the call failing: the caller
        // is still on the line and must land on voicemail, not on a
        // dropped call with an aborted trace.
        let mut fx = MockEffects::new(day_before())
            .slot_answers([Err(anyhow::anyhow!("connect timed out"))]);
        let trace = run_trace(&clinic(), &mut fx).await;

        assert_eq!(trace.steps[0].detail, StepDetail::BookUnavailable);
        assert_eq!(trace.outcome, FlowOutcome::MessageLeft);
        assert!(trace.is_clean(), "a calendar outage is not an aborted call");
    }

    #[tokio::test]
    async fn a_slot_taken_mid_call_is_re_read_and_re_offered_once() {
        // First choice is gone; the second read is a fresh one (whatever
        // took that slot may have taken another), and the caller gets
        // what they pick from it.
        let second_read = SlotOffer {
            slots: vec![slot("2026-07-07T11:00:00Z", "2026-07-07T11:30:00Z")],
            timezone: "UTC".to_string(),
        };
        let mut fx = MockEffects::new(day_before())
            .slot_answers([Ok(two_slots()), Ok(second_read)])
            .book_answers([Ok(BookOutcome::SlotTaken), Ok(BookOutcome::Booked)])
            .digits([Some(Digit::D1), Some(Digit::D1)]);
        let trace = run_trace(&clinic(), &mut fx).await;

        assert_eq!(fx.slot_queries, 2, "the calendar is re-read, not replayed");
        assert!(fx.spoken.contains(&"bktaken".to_string()));
        assert_eq!(trace.steps[1].detail, StepDetail::BookSlotTaken);
        assert_eq!(
            trace.steps[3].detail,
            StepDetail::Booked {
                start: "2026-07-07T11:00:00Z".into()
            }
        );
        assert_eq!(trace.outcome, FlowOutcome::HungUp);
    }

    #[tokio::test]
    async fn losing_the_race_twice_gives_up_rather_than_looping() {
        let mut fx = MockEffects::new(day_before())
            .slot_answers([Ok(two_slots()), Ok(two_slots())])
            .book_answers([Ok(BookOutcome::SlotTaken), Ok(BookOutcome::SlotTaken)])
            .digits([Some(Digit::D1), Some(Digit::D1)]);
        let trace = run_trace(&clinic(), &mut fx).await;

        assert_eq!(fx.slot_queries, 2, "two rounds, then the exit");
        assert_eq!(trace.outcome, FlowOutcome::MessageLeft);
        assert!(trace
            .steps
            .iter()
            .any(|s| s.detail == StepDetail::BookNoSlots));
    }

    #[tokio::test]
    async fn silence_and_unmapped_keys_both_end_at_no_input() {
        // retries: 1 → two attempts. An out-of-range key costs an attempt
        // exactly as silence does: `book` has no `invalid` exit, because
        // both want the same thing from the flow.
        let mut fx = MockEffects::new(day_before())
            .slot_answers([Ok(two_slots())])
            .digits([Some(Digit::D7), None]);
        let trace = run_trace(&clinic(), &mut fx).await;

        assert_eq!(trace.steps[1].detail, StepDetail::BookNoInput);
        assert_eq!(trace.outcome, FlowOutcome::MessageLeft);
        assert!(fx.booked.is_empty());
        // The offers were spoken once per attempt.
        assert_eq!(fx.spoken.iter().filter(|s| *s == "bktime_0900").count(), 2,);
    }

    #[tokio::test]
    async fn a_time_the_vocabulary_cannot_say_is_never_offered() {
        // 13:00 is outside the node's own schedule, so no clip for it was
        // ever rendered. Offering it would play "press one" after a
        // silence; dropping it is the honest degradation.
        let mut fx = MockEffects::new(day_before())
            .slot_answers([Ok(SlotOffer {
                slots: vec![
                    slot("2026-07-07T13:00:00Z", "2026-07-07T13:30:00Z"),
                    slot("2026-07-07T09:00:00Z", "2026-07-07T09:30:00Z"),
                ],
                timezone: "UTC".to_string(),
            })])
            .book_answers([Ok(BookOutcome::Booked)])
            .digits([Some(Digit::D1)]);
        let trace = run_trace(&clinic(), &mut fx).await;

        assert_eq!(
            trace.steps[0].detail,
            StepDetail::BookOffered { count: 1 },
            "only the sayable slot survived"
        );
        assert!(!fx.spoken.iter().any(|s| s == "bktime_1300"));
        assert_eq!(fx.booked, vec![two_slots().slots[0].clone()]);
    }

    #[tokio::test]
    async fn transfer_and_hangup_terminals() {
        let src = r#"
schema_version: 1
id: f
name: n
entry: g
nodes:
  g:
    kind: greeting
    prompt: one moment
    exits: { next: t }
  t:
    kind: transfer
    target: sip:desk@example.com
"#;
        let flow = Flow::from_yaml(src).unwrap();
        validate(&flow).unwrap();
        let mut fx = MockEffects::new(open_time());
        let trace = run_trace(&flow, &mut fx).await;
        assert_eq!(trace.outcome, FlowOutcome::Transferred);
        assert_eq!(fx.transferred.as_deref(), Some("sip:desk@example.com"));
    }
}
