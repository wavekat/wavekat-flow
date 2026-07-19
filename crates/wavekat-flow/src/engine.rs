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
use time::OffsetDateTime;

use crate::hours::{self, HoursError};
use crate::model::{Flow, MessageTone, Node, Prompt};
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

    /// The current instant, for `hours` evaluation. Injectable so tests pin a
    /// fixed time and the schedule is deterministic.
    fn now(&self) -> OffsetDateTime;
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
    }
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
            }
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

    fn prompt_label(p: &Prompt) -> String {
        match p.as_text() {
            Some(t) => t.to_string(),
            None => "<audio>".to_string(),
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
        fn now(&self) -> OffsetDateTime {
            self.now
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
