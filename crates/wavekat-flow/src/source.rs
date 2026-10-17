//! Finding and rewriting the spoken prompts in a flow document's *source
//! text*, keeping comments and layout as they are.
//!
//! The typed tree ([`crate::Flow`]) is lossy: serializing it back drops
//! comments, key order and quoting. An authoring tool that voices a flow
//! (each text prompt swapped for the clip generated from it) or uploads
//! the recordings a flow points at has to edit the author's text instead.
//! This module does that for Rust callers. The TypeScript side does the
//! same through the `yaml` CST in `mutate.ts`.
//!
//! An edit is a splice at the value's position: everything else stays
//! byte-for-byte as it was. Positions come from saphyr-parser's events; the
//! end of each value is found here. After every splice the result is
//! re-parsed and compared event by event against the original with only
//! the intended values changed, so a splice that went wrong is refused
//! ([`SourceError::Mismatch`]) rather than returned.
//!
//! Which fields hold a prompt comes from [`crate::prompt_fields`], the same
//! table [`crate::Node::prompts`] is checked against, so a new prompt field
//! is found here the moment the model knows it.

use std::collections::HashMap;

use saphyr_parser::{Event, Parser, ScalarStyle, Span, SpannedEventReceiver};

use crate::model_ext::{is_generated_clip_ref, is_local_audio_ref, prompt_fields, PROMPT_FIELDS};

/// Why a source read or edit failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SourceError {
    /// The text isn't valid YAML.
    #[error("the flow isn't valid YAML: {0}")]
    Parse(String),
    /// A value's extent couldn't be worked out from the text.
    #[error("couldn't find the {field} prompt in node {node}")]
    Locate { node: String, field: String },
    /// A replacement clip id isn't a generated clip ref.
    #[error("`{0}` isn't a generated clip ref (vprompt_…)")]
    NotAClipRef(String),
    /// The edited text no longer parses.
    #[error("couldn't edit the prompts in place: the result didn't parse")]
    Reparse,
    /// The edited text parses, but changed more than the swapped values.
    /// Usually an unusual layout; writing the value on one line, or quoted,
    /// avoids it.
    #[error("couldn't edit the prompts in place without changing other parts of the document")]
    Mismatch,
}

/// One text prompt, still waiting for audio.
#[derive(Debug, Clone, PartialEq)]
pub struct TextPrompt {
    pub node: String,
    pub field: String,
    /// The node's `kind:`, when it has one.
    pub kind: Option<String>,
    /// The words, trimmed: what gets synthesized, and the transcript.
    pub text: String,
    /// Byte range of the value in the source.
    start: usize,
    end: usize,
    /// Indentation for a block-style replacement; `None` inside `{…}`,
    /// where the replacement has to be flow style.
    indent: Option<usize>,
    /// Index of the value's event in the document's event stream.
    event: usize,
}

/// One prompt already written as a mapping (`{ audio: …, transcript: … }`).
#[derive(Debug, Clone, PartialEq)]
pub struct AudioPrompt {
    pub node: String,
    pub field: String,
    /// The node's `kind:`, when it has one.
    pub kind: Option<String>,
    /// The `audio:` value, trimmed, when it's a plain string.
    pub audio: Option<String>,
    /// The `transcript:` value, trimmed, when present and non-empty.
    pub transcript: Option<String>,
    /// Where the `audio:` value sits, for [`replace_audio_refs`].
    audio_at: Option<Located>,
}

impl AudioPrompt {
    /// Does `audio:` name a file on the author's machine? See
    /// [`crate::is_local_audio_ref`].
    pub fn is_local(&self) -> bool {
        self.audio.as_deref().is_some_and(is_local_audio_ref)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Located {
    start: usize,
    end: usize,
    event: usize,
}

/// Every prompt in a document, in document order, split by how it's voiced.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Prompts {
    /// Non-empty text prompts.
    pub text: Vec<TextPrompt>,
    /// Prompts written as a mapping (normally `{ audio: … }`).
    pub audio: Vec<AudioPrompt>,
}

/// A simplified event, for comparing two documents' structure.
#[derive(Debug, Clone, PartialEq)]
enum Ev {
    MapStart,
    MapEnd,
    SeqStart,
    SeqEnd,
    Scalar(String),
    Alias,
}

#[derive(Clone, Copy, PartialEq)]
enum Ctx {
    Block,
    Flow,
}

enum Frame {
    Map {
        key: Option<String>,
        awaiting_key: bool,
        ctx: Ctx,
    },
    Seq,
}

/// A scalar value's start, before its end is worked out.
#[derive(Clone)]
struct Found {
    node: String,
    field: String,
    value: String,
    style: ScalarStyle,
    start: usize,
    key_start: usize,
    flow: bool,
    event: usize,
}

/// A prompt mapping as it's walked.
struct FoundMap {
    node: String,
    field: String,
    audio: Option<Found>,
    transcript: Option<String>,
}

struct Walker<'s> {
    src: &'s str,
    /// saphyr-parser 0.2.2's markers count chars (not bytes, whatever its
    /// docs say); this maps a char index to a byte offset.
    char_to_byte: Vec<usize>,
    stack: Vec<Frame>,
    events: Vec<Ev>,
    /// Start of the key whose value comes next, per open mapping.
    last_key_start: Vec<usize>,
    /// Scalar prompt values, by field in [`PROMPT_FIELDS`].
    scalars: Vec<Found>,
    /// Mapping prompt values.
    maps: Vec<FoundMap>,
    /// The document's top-level `name:`.
    name: Option<String>,
    /// Top-level keys, and whether the top-level mapping is block style.
    root_keys: Vec<String>,
    root_block: bool,
    /// `kind:` per node id.
    kinds: HashMap<String, String>,
}

impl<'s> Walker<'s> {
    fn new(src: &'s str) -> Self {
        let mut char_to_byte: Vec<usize> = src.char_indices().map(|(b, _)| b).collect();
        char_to_byte.push(src.len());
        Self {
            src,
            char_to_byte,
            stack: Vec::new(),
            events: Vec::new(),
            last_key_start: Vec::new(),
            scalars: Vec::new(),
            maps: Vec::new(),
            name: None,
            root_keys: Vec::new(),
            root_block: false,
            kinds: HashMap::new(),
        }
    }

    fn byte(&self, char_index: usize) -> usize {
        *self.char_to_byte.get(char_index).unwrap_or(&self.src.len())
    }

    /// The keys leading to the value about to arrive, when every open
    /// container is a mapping keyed by a plain string.
    fn path(&self) -> Option<Vec<&str>> {
        self.stack
            .iter()
            .map(|f| match f {
                Frame::Map {
                    key: Some(k),
                    awaiting_key: false,
                    ..
                } => Some(k.as_str()),
                _ => None,
            })
            .collect()
    }

    /// `(node, field)` when the value about to arrive is a node's prompt.
    fn prompt_slot(&self) -> Option<(String, String)> {
        match self.path()?.as_slice() {
            ["nodes", node, field] if PROMPT_FIELDS.contains(field) => {
                Some((node.to_string(), field.to_string()))
            }
            _ => None,
        }
    }

    /// Called for every node event; true when it's a mapping key.
    fn as_key(&mut self, scalar: Option<&str>, start: usize) -> bool {
        if let Some(Frame::Map {
            key, awaiting_key, ..
        }) = self.stack.last_mut()
        {
            if *awaiting_key {
                *key = scalar.map(str::to_string);
                *awaiting_key = false;
                if self.stack.len() == 1 {
                    if let Some(k) = scalar {
                        self.root_keys.push(k.to_string());
                    }
                }
                if let Some(slot) = self.last_key_start.last_mut() {
                    *slot = start;
                }
                return true;
            }
        }
        false
    }

    fn value_done(&mut self) {
        if let Some(Frame::Map { awaiting_key, .. }) = self.stack.last_mut() {
            *awaiting_key = true;
        }
    }

    fn in_flow(&self) -> bool {
        self.stack
            .iter()
            .any(|f| matches!(f, Frame::Map { ctx: Ctx::Flow, .. }))
    }

    fn opens_flow(&self, start: usize) -> bool {
        matches!(self.src.as_bytes().get(start), Some(b'{') | Some(b'['))
    }

    fn on_scalar(&mut self, value: &str, style: ScalarStyle, start: usize, event: usize) {
        let key_start = self.last_key_start.last().copied().unwrap_or(start);
        let found = |node: &str, field: &str| Found {
            node: node.to_string(),
            field: field.to_string(),
            value: value.to_string(),
            style,
            start,
            key_start,
            flow: self.in_flow(),
            event,
        };
        let Some(owned) = self
            .path()
            .map(|p| p.into_iter().map(str::to_string).collect::<Vec<_>>())
        else {
            return;
        };
        let path: Vec<&str> = owned.iter().map(String::as_str).collect();
        match path.as_slice() {
            ["name"] => self.name = Some(value.to_string()),
            ["nodes", node, "kind"] => {
                self.kinds.insert(node.to_string(), value.to_string());
            }
            ["nodes", node, field] if PROMPT_FIELDS.contains(field) => {
                let f = found(node, field);
                self.scalars.push(f);
            }
            ["nodes", node, field, leaf] if PROMPT_FIELDS.contains(field) => {
                let (node, field, leaf) = (node.to_string(), field.to_string(), *leaf);
                let f = found(&node, &field);
                if let Some(m) = self
                    .maps
                    .iter_mut()
                    .rev()
                    .find(|m| m.node == node && m.field == field)
                {
                    match leaf {
                        "audio" => m.audio = Some(f),
                        "transcript" => m.transcript = Some(value.to_string()),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
}

impl<'input> SpannedEventReceiver<'input> for Walker<'_> {
    fn on_event(&mut self, ev: Event<'input>, span: Span) {
        let start = self.byte(span.start.index());
        let index = self.events.len();
        match ev {
            Event::Scalar(value, style, _, _) => {
                self.events.push(Ev::Scalar(value.to_string()));
                if self.as_key(Some(&value), start) {
                    return;
                }
                self.on_scalar(&value, style, start, index);
                self.value_done();
            }
            Event::MappingStart(..) => {
                self.events.push(Ev::MapStart);
                if !self.as_key(None, start) {
                    if let Some((node, field)) = self.prompt_slot() {
                        self.maps.push(FoundMap {
                            node,
                            field,
                            audio: None,
                            transcript: None,
                        });
                    }
                }
                let ctx = if self.opens_flow(start) {
                    Ctx::Flow
                } else {
                    Ctx::Block
                };
                if self.stack.is_empty() {
                    self.root_block = ctx == Ctx::Block;
                }
                self.stack.push(Frame::Map {
                    key: None,
                    awaiting_key: true,
                    ctx,
                });
                self.last_key_start.push(start);
            }
            Event::MappingEnd => {
                self.events.push(Ev::MapEnd);
                self.stack.pop();
                self.last_key_start.pop();
                self.value_done();
            }
            Event::SequenceStart(..) => {
                self.events.push(Ev::SeqStart);
                self.as_key(None, start);
                self.stack.push(Frame::Seq);
            }
            Event::SequenceEnd => {
                self.events.push(Ev::SeqEnd);
                self.stack.pop();
                self.value_done();
            }
            Event::Alias(_) => {
                self.events.push(Ev::Alias);
                if !self.as_key(None, start) {
                    self.value_done();
                }
            }
            _ => {}
        }
    }
}

fn walk(src: &str) -> Result<Walker<'_>, SourceError> {
    let mut w = Walker::new(src);
    Parser::new_from_str(src)
        .load(&mut w, false)
        .map_err(|e| SourceError::Parse(e.to_string()))?;
    Ok(w)
}

impl Walker<'_> {
    /// Is `field` a prompt of `node`, given its kind? A node with no kind,
    /// or one this build doesn't know, keeps every prompt field, so nothing
    /// is silently skipped; validation reports the kind.
    fn speaks(&self, node: &str, field: &str) -> bool {
        match self.kinds.get(node).and_then(|k| prompt_fields(k)) {
            Some(fields) => fields.contains(&field),
            None => true,
        }
    }
}

/// Every prompt in `src`, in document order.
pub fn prompts(src: &str) -> Result<Prompts, SourceError> {
    let w = walk(src)?;
    let mut out = Prompts::default();
    for f in &w.scalars {
        if !w.speaks(&f.node, &f.field) {
            continue;
        }
        // `prompt:` with nothing after it (a hangup with no goodbye) parses
        // as an empty plain scalar; there's nothing to say.
        let text = f.value.trim();
        if text.is_empty() || (f.style == ScalarStyle::Plain && matches!(text, "~" | "null")) {
            continue;
        }
        let (mut start, end) = value_range(src, f)?;
        let indent = (!f.flow).then(|| indent_of_line(src, f.key_start) + 2);
        if indent.is_some() {
            // A block replacement starts on the next line, so take the
            // spaces after the colon with it.
            while start > 0 && matches!(src.as_bytes()[start - 1], b' ' | b'\t') {
                start -= 1;
            }
        }
        out.text.push(TextPrompt {
            node: f.node.clone(),
            field: f.field.clone(),
            kind: w.kinds.get(&f.node).cloned(),
            text: text.to_string(),
            start,
            end,
            indent,
            event: f.event,
        });
    }
    for m in &w.maps {
        if !w.speaks(&m.node, &m.field) {
            continue;
        }
        let audio_at = match &m.audio {
            Some(f) => {
                let (start, end) = value_range(src, f)?;
                Some(Located {
                    start,
                    end,
                    event: f.event,
                })
            }
            None => None,
        };
        out.audio.push(AudioPrompt {
            node: m.node.clone(),
            field: m.field.clone(),
            kind: w.kinds.get(&m.node).cloned(),
            audio: m.audio.as_ref().map(|f| f.value.trim().to_string()),
            transcript: m
                .transcript
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(str::to_string),
            audio_at,
        });
    }
    // Both lists are in document order already; the source order of text
    // vs. audio prompts isn't needed by anything.
    Ok(out)
}

/// Every prompt in `src` whose `audio:` names a local file, in document
/// order.
pub fn local_audio(src: &str) -> Result<Vec<AudioPrompt>, SourceError> {
    Ok(prompts(src)?
        .audio
        .into_iter()
        .filter(AudioPrompt::is_local)
        .collect())
}

/// The document's top-level `name:`, if it has a non-blank one.
pub fn top_level_name(src: &str) -> Option<String> {
    walk(src).ok()?.name.filter(|n| !n.trim().is_empty())
}

/// `src` with `key: "value"` appended for each of `fields` whose key isn't
/// already at the top level, so a draft that leaves platform-assigned
/// fields (`id`, `name`) out can still be validated. Appended at the end so
/// issue positions in the original text stay right. Unchanged when the
/// document doesn't parse or isn't a block mapping.
pub fn with_placeholder_fields(src: &str, fields: &[(&str, &str)]) -> String {
    let Ok(w) = walk(src) else {
        return src.to_string();
    };
    if !w.root_block {
        return src.to_string();
    }
    let mut out = src.to_string();
    for (key, value) in fields {
        if w.root_keys.iter().any(|k| k == key) {
            continue;
        }
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&format!("{key}: {}\n", quoted(value)));
    }
    out
}

/// A YAML double-quoted scalar (a JSON string is one).
fn quoted(s: &str) -> String {
    serde_json::to_string(s).expect("a string always serializes")
}

/// The YAML written in place of a text prompt: block style at `indent`, as
/// the web editor writes it, or flow style (`{ audio: …, … }`) when `indent`
/// is `None`.
fn audio_prompt_yaml(clip_ref: &str, transcript: &str, indent: Option<usize>) -> String {
    let transcript = quoted(transcript);
    match indent {
        Some(n) => {
            let pad = " ".repeat(n);
            format!("\n{pad}audio: {clip_ref}\n{pad}transcript: {transcript}")
        }
        None => format!("{{ audio: {clip_ref}, transcript: {transcript} }}"),
    }
}

fn check_clip_refs<'a>(refs: impl IntoIterator<Item = &'a String>) -> Result<(), SourceError> {
    match refs.into_iter().find(|r| !is_generated_clip_ref(r)) {
        Some(bad) => Err(SourceError::NotAClipRef(bad.clone())),
        None => Ok(()),
    }
}

/// Voice text prompts: swap each `(prompt, clip ref)` for
/// `{ audio: <clip ref>, transcript: <the prompt's text> }`. Nothing else in
/// the document changes. `prompt`s must come from [`prompts`] on this same
/// `src`.
pub fn voice_text_prompts(
    src: &str,
    swaps: &[(TextPrompt, String)],
) -> Result<String, SourceError> {
    check_clip_refs(swaps.iter().map(|(_, id)| id))?;
    let mut sorted: Vec<&(TextPrompt, String)> = swaps.iter().collect();
    sorted.sort_by_key(|(p, _)| std::cmp::Reverse(p.start));
    let mut out = src.to_string();
    for (p, id) in &sorted {
        out.replace_range(p.start..p.end, &audio_prompt_yaml(id, &p.text, p.indent));
    }

    // The original event stream with each swapped value expanded into its
    // audio mapping must equal the new document's stream.
    let before = walk(src)?.events;
    let mut by_event: Vec<&(TextPrompt, String)> = swaps.iter().collect();
    by_event.sort_by_key(|(p, _)| p.event);
    let mut expected = Vec::with_capacity(before.len() + swaps.len() * 5);
    let mut next = by_event.iter().peekable();
    for (i, ev) in before.into_iter().enumerate() {
        match next.peek() {
            Some((p, id)) if p.event == i => {
                expected.extend([
                    Ev::MapStart,
                    Ev::Scalar("audio".into()),
                    Ev::Scalar(id.clone()),
                    Ev::Scalar("transcript".into()),
                    Ev::Scalar(p.text.clone()),
                    Ev::MapEnd,
                ]);
                next.next();
            }
            _ => expected.push(ev),
        }
    }
    let after = walk(&out).map_err(|_| SourceError::Reparse)?.events;
    if after != expected {
        return Err(SourceError::Mismatch);
    }
    Ok(out)
}

/// Swap each prompt's `audio:` value for a clip ref (a local file's path
/// for the clip uploaded from it, say). Only those values change. Prompts
/// must come from [`prompts`] or [`local_audio`] on this same `src`; one
/// with no `audio:` value is refused.
pub fn replace_audio_refs(
    src: &str,
    swaps: &[(AudioPrompt, String)],
) -> Result<String, SourceError> {
    check_clip_refs(swaps.iter().map(|(_, id)| id))?;
    let mut located = Vec::with_capacity(swaps.len());
    for (p, id) in swaps {
        let at = p.audio_at.ok_or_else(|| SourceError::Locate {
            node: p.node.clone(),
            field: p.field.clone(),
        })?;
        located.push((at, id));
    }
    located.sort_by_key(|(at, _)| std::cmp::Reverse(at.start));
    let mut out = src.to_string();
    for (at, id) in &located {
        out.replace_range(at.start..at.end, id);
    }
    let mut expected = walk(src)?.events;
    for (at, id) in &located {
        match expected.get_mut(at.event) {
            Some(ev @ Ev::Scalar(_)) => *ev = Ev::Scalar((*id).clone()),
            _ => return Err(SourceError::Mismatch),
        }
    }
    let after = walk(&out).map_err(|_| SourceError::Reparse)?.events;
    if after != expected {
        return Err(SourceError::Mismatch);
    }
    Ok(out)
}

/// The byte range of a scalar value in the source.
fn value_range(src: &str, f: &Found) -> Result<(usize, usize), SourceError> {
    let lost = || SourceError::Locate {
        node: f.node.clone(),
        field: f.field.clone(),
    };
    let bytes = src.as_bytes();
    let line_indent = indent_of_line(src, f.key_start);
    match f.style {
        ScalarStyle::SingleQuoted | ScalarStyle::DoubleQuoted => {
            let quote = if f.style == ScalarStyle::SingleQuoted {
                b'\''
            } else {
                b'"'
            };
            // The marker sits on the opening quote; scan to its partner.
            let open = (f.start..bytes.len())
                .find(|&i| bytes[i] == quote)
                .ok_or_else(lost)?;
            let mut i = open + 1;
            while i < bytes.len() {
                match bytes[i] {
                    b'\\' if quote == b'"' => i += 2,
                    b'\'' if quote == b'\'' && bytes.get(i + 1) == Some(&b'\'') => i += 2,
                    b if b == quote => return Ok((open, i + 1)),
                    _ => i += 1,
                }
            }
            Err(lost())
        }
        ScalarStyle::Literal | ScalarStyle::Folded => {
            // The marker sits on the content; the value starts at the
            // `|` / `>` indicator after the key's colon.
            let colon = src[f.key_start..]
                .find(':')
                .map(|i| f.key_start + i)
                .ok_or_else(lost)?;
            let open = (colon + 1..bytes.len())
                .find(|&i| matches!(bytes[i], b'|' | b'>'))
                .ok_or_else(lost)?;
            // Content is every following line indented past the key, plus
            // blank lines between them; the value ends after the last
            // content character, so trailing blank lines stay put.
            let mut end = line_end(src, open);
            let mut pos = end;
            while pos < bytes.len() {
                let next = line_end(src, pos + 1);
                let line = &src[pos + 1..next];
                if line.trim().is_empty() {
                    pos = next;
                    continue;
                }
                if leading_spaces(line) <= line_indent {
                    break;
                }
                end = pos + 1 + line.trim_end().len();
                pos = next;
            }
            Ok((open, end))
        }
        ScalarStyle::Plain => {
            // Ends at a comment, at the end of the line or, inside `{…}` /
            // `[…]`, at the next `,` `}` `]`; may continue on following
            // lines indented past the key.
            let stop = |i: usize| -> bool {
                let b = bytes[i];
                b == b'\n'
                    || b == b'\r'
                    || (b == b'#' && i > 0 && matches!(bytes[i - 1], b' ' | b'\t'))
                    || (f.flow && matches!(b, b',' | b'}' | b']'))
            };
            let mut i = f.start;
            while i < bytes.len() && !stop(i) {
                i += 1;
            }
            let mut end = f.start + src[f.start..i].trim_end().len();
            if !f.flow {
                let mut pos = line_end(src, f.start);
                while pos < bytes.len() {
                    let next = line_end(src, pos + 1);
                    let line = &src[pos + 1..next];
                    let body = line.trim_start();
                    if body.is_empty()
                        || body.starts_with('#')
                        || leading_spaces(line) <= line_indent
                    {
                        break;
                    }
                    let cut = body
                        .find(" #")
                        .or_else(|| body.find("\t#"))
                        .unwrap_or(body.len());
                    end = pos + 1 + leading_spaces(line) + body[..cut].trim_end().len();
                    pos = next;
                }
            }
            Ok((f.start, end))
        }
    }
}

/// Byte offset of the `\n` ending the line that contains `at` (or the end
/// of the source).
fn line_end(src: &str, at: usize) -> usize {
    if at >= src.len() {
        return src.len();
    }
    src[at..].find('\n').map(|i| at + i).unwrap_or(src.len())
}

fn leading_spaces(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

fn indent_of_line(src: &str, at: usize) -> usize {
    let line_start = src[..at].rfind('\n').map(|i| i + 1).unwrap_or(0);
    leading_spaces(&src[line_start..])
}

#[cfg(test)]
mod tests {
    use super::*;

    const FLOW: &str = "\
schema_version: 1
id: flow_x
name: Test   # the name
entry: hello
nodes:
  # Say hi first.
  hello:
    kind: greeting
    prompt: Thanks for calling, how can we help?   # keep it short
    exits: { next: menu }
  menu:
    kind: menu
    prompt: 'Press 1 for sales, it''s quick.'
    options: { '1': bye }
    exits: { '1': bye }
  done:
    kind: message
    prompt: |
      Please leave a message
      after the tone.

    # trailing comment
    exits: { next: bye }
  booked:
    kind: book
    prompt: \"I can book you in.\\n\"
    confirm_prompt: { audio: vprompt_abc, transcript: You're booked for }
  bye:
    kind: hangup
    prompt: Goodbye — 再见.
  silent:
    kind: hangup
    prompt:
";

    fn texts(src: &str) -> Vec<(String, String, String)> {
        prompts(src)
            .unwrap()
            .text
            .into_iter()
            .map(|p| (p.node, p.field, p.text))
            .collect()
    }

    fn clip(i: usize) -> String {
        format!("vprompt_{i}")
    }

    #[test]
    fn finds_text_and_audio_prompts() {
        let found = prompts(FLOW).unwrap();
        assert_eq!(found.audio.len(), 1);
        assert_eq!(found.audio[0].audio.as_deref(), Some("vprompt_abc"));
        assert_eq!(
            found.audio[0].transcript.as_deref(),
            Some("You're booked for")
        );
        assert_eq!(found.audio[0].kind.as_deref(), Some("book"));
        assert_eq!(
            texts(FLOW),
            vec![
                (
                    "hello".into(),
                    "prompt".into(),
                    "Thanks for calling, how can we help?".into()
                ),
                (
                    "menu".into(),
                    "prompt".into(),
                    "Press 1 for sales, it's quick.".into()
                ),
                (
                    "done".into(),
                    "prompt".into(),
                    "Please leave a message\nafter the tone.".into()
                ),
                (
                    "booked".into(),
                    "prompt".into(),
                    "I can book you in.".into()
                ),
                ("bye".into(), "prompt".into(), "Goodbye — 再见.".into()),
            ]
        );
    }

    #[test]
    fn voicing_swaps_only_the_prompts() {
        let found = prompts(FLOW).unwrap();
        let swaps: Vec<_> = found
            .text
            .iter()
            .enumerate()
            .map(|(i, p)| (p.clone(), clip(i)))
            .collect();
        let out = voice_text_prompts(FLOW, &swaps).unwrap();
        let block =
            |id: &str, t: &str| format!("    prompt:\n      audio: {id}\n      transcript: {t}");
        for want in [
            format!(
                "{}   # keep it short\n",
                block("vprompt_0", "\"Thanks for calling, how can we help?\"")
            ),
            format!(
                "{}\n    options:",
                block("vprompt_1", "\"Press 1 for sales, it's quick.\"")
            ),
            format!(
                "{}\n\n    # trailing comment\n",
                block("vprompt_2", "\"Please leave a message\\nafter the tone.\"")
            ),
            format!(
                "{}\n    confirm_prompt: {{ audio: vprompt_abc",
                block("vprompt_3", "\"I can book you in.\"")
            ),
            format!("{}\n", block("vprompt_4", "\"Goodbye — 再见.\"")),
        ] {
            assert!(out.contains(&want), "missing {want:?} in:\n{out}");
        }
        // Comments and everything else survive.
        assert!(out.contains("name: Test   # the name\n"));
        assert!(out.contains("  # Say hi first.\n"));
        // Idempotent: nothing left to voice.
        let again = prompts(&out).unwrap();
        assert!(again.text.is_empty());
        assert_eq!(again.audio.len(), 6);
    }

    #[test]
    fn partial_voicing_leaves_the_rest_as_text() {
        let found = prompts(FLOW).unwrap();
        let swaps = vec![(found.text[1].clone(), clip(9))];
        let out = voice_text_prompts(FLOW, &swaps).unwrap();
        let left = texts(&out);
        assert_eq!(left.len(), 4);
        assert!(left.iter().all(|(node, _, _)| node != "menu"));
    }

    #[test]
    fn voicing_refuses_a_ref_that_isnt_a_clip() {
        let found = prompts(FLOW).unwrap();
        let swaps = vec![(found.text[0].clone(), "odd id".to_string())];
        assert_eq!(
            voice_text_prompts(FLOW, &swaps),
            Err(SourceError::NotAClipRef("odd id".into()))
        );
    }

    #[test]
    fn flow_style_nodes_and_multiline_plain() {
        let src = "\
nodes:
  a: { kind: greeting, prompt: Hello there, exits: { next: b } }
  b:
    kind: hangup
    prompt: Thanks for
      calling us   # bye
";
        let found = prompts(src).unwrap();
        assert_eq!(
            texts(src),
            vec![
                ("a".into(), "prompt".into(), "Hello there".into()),
                ("b".into(), "prompt".into(), "Thanks for calling us".into()),
            ]
        );
        let swaps: Vec<_> = found.text.iter().map(|p| (p.clone(), clip(7))).collect();
        let out = voice_text_prompts(src, &swaps).unwrap();
        assert!(out.contains(
            "a: { kind: greeting, prompt: { audio: vprompt_7, transcript: \"Hello there\" }, exits: { next: b } }"
        ), "{out}");
        assert!(
            out.contains(
                "    prompt:\n      audio: vprompt_7\n      transcript: \"Thanks for calling us\"   # bye\n"
            ),
            "{out}"
        );
    }

    #[test]
    fn ignores_prompt_keys_outside_nodes() {
        let src = "\
prompt: not a node
ui:
  hello:
    prompt: also not
nodes:
  hello:
    kind: greeting
    prompt: Hi
    extra:
      prompt: nested, not a node field
";
        assert_eq!(
            texts(src),
            vec![("hello".into(), "prompt".into(), "Hi".into())]
        );
    }

    #[test]
    fn only_fields_the_kind_speaks() {
        // `confirm_prompt` is `book`'s alone; on a greeting it's a stray
        // key for validation to report, not something to voice. A node
        // with no kind (yet) keeps every prompt field.
        let src = "\
nodes:
  a:
    confirm_prompt: Not spoken
    kind: greeting
    prompt: Spoken
  b:
    confirm_prompt: Kept
";
        assert_eq!(
            texts(src),
            vec![
                ("a".into(), "prompt".into(), "Spoken".into()),
                ("b".into(), "confirm_prompt".into(), "Kept".into()),
            ]
        );
    }

    #[test]
    fn reads_the_document_name() {
        assert_eq!(top_level_name(FLOW).as_deref(), Some("Test"));
        assert_eq!(top_level_name("nodes: {}\n"), None);
        assert_eq!(top_level_name("nodes:\n  name: x\n"), None);
    }

    #[test]
    fn placeholders_fill_only_missing_fields() {
        let src = "# c\nname: Mine\nnodes: {}";
        let out = with_placeholder_fields(src, &[("id", "flow_new"), ("name", "x")]);
        assert_eq!(out, "# c\nname: Mine\nnodes: {}\nid: \"flow_new\"\n");
        assert_eq!(with_placeholder_fields(&out, &[("id", "y")]), out);
        // Not a block mapping, or not YAML: left alone for validation.
        assert_eq!(with_placeholder_fields("{a: 1}", &[("id", "x")]), "{a: 1}");
        assert_eq!(with_placeholder_fields("a: [", &[("id", "x")]), "a: [");
    }

    const LOCAL: &str = "\
nodes:
  hello:
    kind: greeting
    # recorded by the owner
    prompt:
      audio: ./intro.wav   # keep
      transcript: Welcome to the shop.
    exits: { next: bye }
  menu:
    kind: menu
    prompt: { audio: 'clips/menu 1.wav', transcript: \"Press 1\" }
  known:
    kind: message
    prompt: { audio: vprompt_abc }
  other:
    kind: greeting
    prompt: { audio: shipped_ref }
  booked:
    kind: book
    prompt: { audio: ../book.wav }
    confirm_prompt: Booked
";

    #[test]
    fn finds_local_audio_with_transcripts_and_kinds() {
        let got = local_audio(LOCAL).unwrap();
        let summary: Vec<_> = got
            .iter()
            .map(|a| {
                (
                    a.node.as_str(),
                    a.audio.as_deref(),
                    a.transcript.as_deref(),
                    a.kind.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (
                    "hello",
                    Some("./intro.wav"),
                    Some("Welcome to the shop."),
                    Some("greeting")
                ),
                (
                    "menu",
                    Some("clips/menu 1.wav"),
                    Some("Press 1"),
                    Some("menu")
                ),
                ("booked", Some("../book.wav"), None, Some("book")),
            ]
        );
        // Audio prompts, local or not, aren't text prompts.
        assert_eq!(
            texts(LOCAL),
            vec![("booked".into(), "confirm_prompt".into(), "Booked".into())]
        );
    }

    #[test]
    fn replacing_audio_swaps_only_the_refs() {
        let got = local_audio(LOCAL).unwrap();
        let swaps: Vec<_> = got
            .iter()
            .enumerate()
            .map(|(i, a)| (a.clone(), clip(i)))
            .collect();
        let out = replace_audio_refs(LOCAL, &swaps).unwrap();
        assert!(
            out.contains(
                "      audio: vprompt_0   # keep\n      transcript: Welcome to the shop.\n"
            ),
            "{out}"
        );
        assert!(
            out.contains("prompt: { audio: vprompt_1, transcript: \"Press 1\" }"),
            "{out}"
        );
        assert!(out.contains("prompt: { audio: vprompt_2 }"), "{out}");
        assert!(out.contains("    # recorded by the owner\n"));
        assert!(out.contains("{ audio: shipped_ref }"));
        assert!(local_audio(&out).unwrap().is_empty());
        assert_eq!(
            replace_audio_refs(LOCAL, &[(got[0].clone(), "not-a-clip".into())]),
            Err(SourceError::NotAClipRef("not-a-clip".into()))
        );
    }

    #[test]
    fn invalid_yaml_is_an_error() {
        assert!(matches!(
            prompts("nodes: [unclosed"),
            Err(SourceError::Parse(_))
        ));
    }

    #[test]
    fn replacement_yaml_quotes_the_transcript() {
        assert_eq!(
            audio_prompt_yaml("vprompt_ab12", "Say \"hi\"", None),
            r#"{ audio: vprompt_ab12, transcript: "Say \"hi\"" }"#
        );
        assert_eq!(
            audio_prompt_yaml("vprompt_1", "Hi", Some(4)),
            "\n    audio: vprompt_1\n    transcript: \"Hi\""
        );
    }
}
