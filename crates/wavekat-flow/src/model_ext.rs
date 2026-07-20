//! Hand-written model helpers layered on the SCHEMA-GENERATED types in
//! [`crate::model`]. The schema owns the document *shape*; the accessors
//! here are *logic*, not shape (the exit set a kind must wire, terminal-ness,
//! the `kind` tag, prompt text extraction) — so they live in code, one twin
//! per language. The TypeScript twin is `packages/flow-schema/src/model.ts`;
//! keep the two in lockstep.
//!
//! typify emits `Node` as an internally-tagged enum (`#[serde(tag = "kind")]`,
//! wired by the `build.rs` schema normalization) whose variants carry their
//! config fields *and* `exits` together. The pre-consolidation crate used a
//! `Node { #[flatten] config: Component, exits }` split with a `Component`
//! enum; these methods present the same query surface over the generated
//! shape so the validator/engine read the same.

use std::collections::HashMap;

use crate::model::{Flow, Node, Prompt};

/// A node's key within a flow. Human-meaningful (`night_menu`, not `n7`).
pub type NodeId = String;

impl Node {
    /// The `kind` tag, for traces and diagnostics.
    pub fn kind(&self) -> &'static str {
        match self {
            Node::Greeting { .. } => "greeting",
            Node::Hours { .. } => "hours",
            Node::Menu { .. } => "menu",
            Node::Ring { .. } => "ring",
            Node::Message { .. } => "message",
            Node::Transfer { .. } => "transfer",
            Node::Hangup { .. } => "hangup",
        }
    }

    /// Whether a caller who reaches this node can have the call *end* here.
    /// `ring` counts — its implicit `answered` hands the call to a human,
    /// which ends the flow. Used by the "no caller is ever trapped" check.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Node::Message { .. } | Node::Transfer { .. } | Node::Hangup { .. } | Node::Ring { .. }
        )
    }

    /// The exit names this node **must** wire, given its config. Validation
    /// checks the node's `exits` keys are exactly this set — no missing exit
    /// (a dead choice) and no stray exit (a typo the engine would never
    /// follow).
    pub fn required_exits(&self) -> Vec<String> {
        match self {
            Node::Greeting { .. } => vec!["next".into()],
            Node::Hours { .. } => vec!["open".into(), "closed".into()],
            Node::Menu { options, .. } => {
                let mut names: Vec<String> = options.keys().cloned().collect();
                names.push("no_input".into());
                names.push("invalid".into());
                names
            }
            Node::Ring { .. } => vec!["no_answer".into()],
            Node::Message { .. } | Node::Transfer { .. } | Node::Hangup { .. } => Vec::new(),
        }
    }

    /// The node's wired exits (exit name → target node id), or `None` when
    /// the document omits the block. Every generated variant carries an
    /// `exits: Option<Exits>`, so this reads them uniformly.
    pub fn exits(&self) -> Option<&HashMap<String, String>> {
        let exits = match self {
            Node::Greeting { exits, .. }
            | Node::Hours { exits, .. }
            | Node::Menu { exits, .. }
            | Node::Ring { exits, .. }
            | Node::Message { exits, .. }
            | Node::Transfer { exits, .. }
            | Node::Hangup { exits, .. } => exits,
        };
        exits.as_deref()
    }
}

impl Prompt {
    /// The *synthesizable* text: `Some` for a bare-string prompt the engine
    /// speaks with TTS, `None` for an audio-asset prompt it plays as a clip.
    /// This drives playback branching and the length cap — an audio prompt's
    /// transcript, when present, is *not* returned here (it is display text,
    /// not something to synthesize or bound). For the human-readable words
    /// either kind speaks, use [`Prompt::transcript`].
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Prompt::Text(t) => Some(t.as_str()),
            Prompt::Audio { .. } => None,
        }
    }

    /// The human-readable words this prompt speaks, for display (a "what the
    /// caller hears" transcript) and traces — regardless of how it is voiced.
    /// A text prompt is its own transcript; an audio prompt carries the text
    /// it was synthesized from in `transcript`, `None` when the document omits
    /// it (older flows, or a ref not generated from text). Unlike [`as_text`],
    /// this is never used to decide playback or enforce the length cap.
    ///
    /// [`as_text`]: Prompt::as_text
    pub fn transcript(&self) -> Option<&str> {
        match self {
            Prompt::Text(t) => Some(t.as_str()),
            Prompt::Audio { transcript, .. } => transcript.as_deref(),
        }
    }
}

impl Flow {
    /// Parse a flow document from YAML text. This is the only surface-syntax
    /// entry point; everything downstream works on the typed tree. Parsing
    /// does **not** validate semantics (reachability, exit wiring, …) — call
    /// [`crate::validate::validate`] on the result.
    ///
    /// Routes through `serde_yaml_ng::Value` first, on purpose: the
    /// duplicate-key check lives in that crate's `Mapping` deserializer, not
    /// on the direct-into-struct path — a `HashMap` field would otherwise
    /// silently take last-wins. Routing through `Value` rejects a duplicate
    /// key at *any* nesting level, the footgun doc 48 fences off.
    pub fn from_yaml(src: &str) -> Result<Flow, serde_yaml_ng::Error> {
        let value: serde_yaml_ng::Value = serde_yaml_ng::from_str(src)?;
        serde_yaml_ng::from_value(value)
    }

    /// Serialize back to YAML (lossless for the model; the opaque `ui` block
    /// round-trips).
    pub fn to_yaml(&self) -> Result<String, serde_yaml_ng::Error> {
        serde_yaml_ng::to_string(self)
    }
}

#[cfg(test)]
mod tests {
    use crate::model::Prompt;

    #[test]
    fn as_text_is_synthesizable_text_only() {
        // A bare-string prompt is TTS the engine speaks.
        let text = Prompt::Text("open eleven to ten".into());
        assert_eq!(text.as_text(), Some("open eleven to ten"));

        // An audio prompt is a clip — never synthesizable, even when it
        // carries a transcript. `as_text` drives playback + the length cap,
        // so it must stay `None` here.
        let audio = Prompt::Audio {
            audio: "vprompt_ab12cd34".into(),
            transcript: Some("open eleven to ten".into()),
        };
        assert_eq!(audio.as_text(), None);
    }

    #[test]
    fn transcript_is_the_spoken_words_regardless_of_voicing() {
        // Text prompt is its own transcript.
        let text = Prompt::Text("open eleven to ten".into());
        assert_eq!(text.transcript(), Some("open eleven to ten"));

        // Audio prompt surfaces the text it was synthesized from.
        let with_text = Prompt::Audio {
            audio: "vprompt_ab12cd34".into(),
            transcript: Some("open eleven to ten".into()),
        };
        assert_eq!(with_text.transcript(), Some("open eleven to ten"));

        // No transcript recorded (older flow / non-generated ref) → None.
        let without_text = Prompt::Audio {
            audio: "vprompt_ff00ee11".into(),
            transcript: None,
        };
        assert_eq!(without_text.transcript(), None);
    }

    #[test]
    fn audio_transcript_round_trips_through_yaml() {
        let with = "{ audio: vprompt_ab12cd34, transcript: open eleven to ten }";
        let parsed: Prompt = serde_yaml_ng::from_str(with).unwrap();
        assert_eq!(parsed.transcript(), Some("open eleven to ten"));

        // Re-serialize and re-parse: the transcript survives the trip.
        let yaml = serde_yaml_ng::to_string(&parsed).unwrap();
        let reparsed: Prompt = serde_yaml_ng::from_str(&yaml).unwrap();
        assert_eq!(reparsed.transcript(), Some("open eleven to ten"));

        // The field is optional: a bare ref still parses, with no transcript,
        // and is skipped on the way back out (no `transcript: null` noise).
        let bare: Prompt = serde_yaml_ng::from_str("{ audio: vprompt_ff00ee11 }").unwrap();
        assert_eq!(bare.transcript(), None);
        assert!(!serde_yaml_ng::to_string(&bare)
            .unwrap()
            .contains("transcript"));
    }
}
