//! Loading a document to edit it (docs/01-canonical-document.md §5).
//!
//! Editing is [`Flow::from_yaml`], change the flow, [`Flow::to_yaml`]. Two
//! things in a source can't survive that round trip, and an editor has to
//! know about them before it saves:
//!
//! - **Fields this build doesn't know.** The model drops them, so saving
//!   would delete them. [`load`] refuses such a document.
//! - **YAML comments.** They carry no meaning (the words belong in
//!   `note`), but the author should be told a save drops them. [`load`]
//!   returns them; [`comments`] finds them in any text. The TypeScript
//!   parser reports the same comments as `comment_ignored`, and the corpus
//!   under `conformance/canonical/` pins the count for both.

use serde_json::Value;

use crate::canonical::{describe, schema};
use crate::{Flow, SUPPORTED_SCHEMA_VERSIONS};

/// A YAML comment in a source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Comment {
    /// 1-based line number.
    pub line: usize,
    /// The words after `#`, trimmed.
    pub text: String,
}

/// A document ready to edit.
#[derive(Debug, Clone)]
pub struct Loaded {
    pub flow: Flow,
    /// Comments in the source, which saving drops.
    pub comments: Vec<Comment>,
}

/// Why a document can't be edited.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LoadError {
    /// It isn't a flow document.
    #[error("the flow doesn't parse: {0}")]
    Parse(String),
    /// It declares a version this build can't write back.
    #[error(
        "the flow declares schema_version {0}, which this version of the tool doesn't support"
    )]
    UnsupportedVersion(i64),
    /// It has fields this build doesn't know; saving would delete them.
    #[error("unknown fields would be lost on save: {}", .0.join(", "))]
    UnknownFields(Vec<String>),
}

/// Parse `src` for editing: refuse what a save would lose, and return the
/// comments it would drop.
pub fn load(src: &str) -> Result<Loaded, LoadError> {
    load_value(src, None)
}

/// The platform-assigned fields a new draft may leave out. A draft is
/// complete enough to edit once they're filled; the platform stamps the
/// real ones when the draft is saved there. Twin: `mutate.ts`
/// `stampIdentity`, which does the same for a draft without an `id`.
#[derive(Debug, Clone, Copy)]
pub struct Missing<'a> {
    /// Used when the draft has no `id`.
    pub id: &'a str,
    /// Used when the draft has no `name`.
    pub name: &'a str,
}

/// [`load`] for a draft that may leave out `id` and `name`: each one
/// missing is filled from `missing`, then the draft is loaded like any
/// other document.
pub fn load_draft(src: &str, missing: Missing<'_>) -> Result<Loaded, LoadError> {
    load_value(src, Some(missing))
}

fn load_value(src: &str, missing: Option<Missing<'_>>) -> Result<Loaded, LoadError> {
    let parse = |e: &dyn std::fmt::Display| LoadError::Parse(e.to_string());
    // Through `serde_yaml_ng::Value` first: its mapping rejects duplicate
    // keys at any depth, as `Flow::from_yaml` does.
    let yaml: serde_yaml_ng::Value = serde_yaml_ng::from_str(src).map_err(|e| parse(&e))?;
    let mut value = serde_json::to_value(&yaml).map_err(|e| parse(&e))?;
    if let (Some(missing), Value::Object(map)) = (missing, &mut value) {
        for (key, fill) in [("id", missing.id), ("name", missing.name)] {
            map.entry(key)
                .or_insert_with(|| Value::String(fill.to_string()));
        }
    }
    let flow: Flow = serde_json::from_value(value.clone()).map_err(|e| parse(&e))?;
    let supported =
        u32::try_from(flow.schema_version).is_ok_and(|v| SUPPORTED_SCHEMA_VERSIONS.contains(&v));
    if !supported {
        return Err(LoadError::UnsupportedVersion(flow.schema_version));
    }
    let unknown = unknown_in(&value);
    if !unknown.is_empty() {
        return Err(LoadError::UnknownFields(unknown));
    }
    Ok(Loaded {
        flow,
        comments: comments(src),
    })
}

/// The dotted paths (`nodes.menu.colour`) of fields in `src` the schema
/// doesn't describe. Nothing inside the opaque `ui` block counts.
pub fn unknown_fields(src: &str) -> Result<Vec<String>, LoadError> {
    let value: Value = serde_yaml_ng::from_str(src).map_err(|e| LoadError::Parse(e.to_string()))?;
    Ok(unknown_in(&value))
}

fn unknown_in(value: &Value) -> Vec<String> {
    let mut out = Vec::new();
    walk(value, Some(schema()), "", &mut out);
    out
}

fn walk(value: &Value, s: Option<&'static Value>, path: &str, out: &mut Vec<String>) {
    let Some(s) = describe(s, value) else { return };
    let join = |key: &str| {
        if path.is_empty() {
            key.to_string()
        } else {
            format!("{path}.{key}")
        }
    };
    match value {
        Value::Object(map) => {
            if let Some(props) = s.get("properties").and_then(Value::as_object) {
                for (k, v) in map {
                    match props.get(k) {
                        Some(p) => walk(v, Some(p), &join(k), out),
                        None => out.push(join(k)),
                    }
                }
            } else if let Some(items) = s.get("additionalProperties").filter(|a| a.is_object()) {
                for (k, v) in map {
                    walk(v, Some(items), &join(k), out);
                }
            }
        }
        Value::Array(items) => {
            if let Some(item) = s.get("items") {
                for (i, v) in items.iter().enumerate() {
                    walk(v, Some(item), &join(&i.to_string()), out);
                }
            }
        }
        _ => {}
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Quote {
    Single,
    Double,
}

/// Every comment in `src`, in order.
///
/// A `#` starts a comment at the start of a line's content or after a
/// space or tab, unless it's inside a quoted scalar or a block scalar's
/// content (`|` / `>`). Quotes only open a scalar where a value or key
/// starts (after `: `, `- `, `? `, `[`, `{`, `,` or at the start of a
/// line), so the apostrophe in `It's open` is just a letter.
pub fn comments(src: &str) -> Vec<Comment> {
    let mut out = Vec::new();
    let mut quote: Option<Quote> = None;
    // Indent of the line that opened a block scalar still being read.
    let mut block: Option<usize> = None;

    for (n, line) in src.lines().enumerate() {
        let indent = line.len() - line.trim_start_matches(' ').len();
        if let Some(opener) = block {
            if line.trim().is_empty() || indent > opener {
                continue;
            }
            block = None;
        }

        let chars: Vec<(usize, char)> = line.char_indices().collect();
        // The last non-blank character before the current one on this line.
        let mut last: Option<char> = None;
        let mut i = 0;
        while i < chars.len() {
            let (at, c) = chars[i];
            match quote {
                Some(Quote::Double) => {
                    match c {
                        '\\' => i += 1,
                        '"' => quote = None,
                        _ => {}
                    }
                    last = Some(c);
                    i += 1;
                    continue;
                }
                Some(Quote::Single) => {
                    if c == '\'' {
                        if chars.get(i + 1).map(|(_, c)| *c) == Some('\'') {
                            i += 1;
                        } else {
                            quote = None;
                        }
                    }
                    last = Some(c);
                    i += 1;
                    continue;
                }
                None => {}
            }
            let after_blank = i == 0 || matches!(chars[i - 1].1, ' ' | '\t');
            let value_start = match last {
                None => true,
                Some(':' | '-' | '?') => after_blank,
                Some('[' | '{' | ',') => true,
                _ => false,
            };
            match c {
                '#' if after_blank || last.is_none() => {
                    out.push(Comment {
                        line: n + 1,
                        text: line[at + 1..].trim().to_string(),
                    });
                    break;
                }
                '"' if value_start => quote = Some(Quote::Double),
                '\'' if value_start => quote = Some(Quote::Single),
                '|' | '>' if value_start && last.is_some() => block = Some(indent),
                _ => {}
            }
            if !matches!(c, ' ' | '\t') {
                last = Some(c);
            }
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(src: &str) -> Vec<(usize, String)> {
        comments(src)
            .into_iter()
            .map(|c| (c.line, c.text))
            .collect()
    }

    #[test]
    fn finds_comments_and_only_comments() {
        let src = "\
# top
name: Test   # the name
nodes:
  # before a node
  a:
    kind: greeting
    prompt: \"Press # for more\"   # trailing
    note: It's C# day
  b:
    kind: message
    prompt: 'it''s # not a comment'
  c:
    kind: message
    prompt: |
      # inside a block scalar
      still inside
    # after the block
    exits: { next: a } # flow
  d: { kind: hangup, prompt: \"multi
    line # still quoted\" }
";
        assert_eq!(
            lines(src),
            vec![
                (1, "top".into()),
                (2, "the name".into()),
                (4, "before a node".into()),
                (7, "trailing".into()),
                (17, "after the block".into()),
                (18, "flow".into()),
            ]
        );
    }

    #[test]
    fn load_refuses_unknown_fields() {
        let src = "\
schema_version: 2
id: f
name: F
entry: a
colour: blue
nodes:
  a:
    kind: hangup
    shape: round
    prompt: { audio: vprompt_a, transcript: Bye, speed: 2 }
ui:
  anything: goes
";
        assert_eq!(
            load(src).unwrap_err(),
            LoadError::UnknownFields(vec![
                "colour".into(),
                "nodes.a.shape".into(),
                "nodes.a.prompt.speed".into(),
            ])
        );
    }

    #[test]
    fn load_draft_fills_only_what_is_missing() {
        let draft = "schema_version: 2\nname: Mine\nentry: a\nnodes:\n  a: { kind: hangup }\n";
        assert!(matches!(load(draft), Err(LoadError::Parse(_))));
        let missing = Missing {
            id: "flow_new",
            name: "Untitled",
        };
        let flow = load_draft(draft, missing).unwrap().flow;
        assert_eq!((flow.id.as_str(), flow.name.as_str()), ("flow_new", "Mine"));
        // Duplicate keys are refused here too.
        let dup = "schema_version: 2\nname: A\nname: B\nentry: a\nnodes:\n  a: { kind: hangup }\n";
        assert!(matches!(load_draft(dup, missing), Err(LoadError::Parse(_))));
    }

    #[test]
    fn load_refuses_unsupported_versions() {
        let src = "schema_version: 99\nid: f\nname: F\nentry: a\nnodes:\n  a: { kind: hangup }\n";
        assert_eq!(load(src).unwrap_err(), LoadError::UnsupportedVersion(99));
    }

    #[test]
    fn load_returns_comments() {
        let src = "schema_version: 2\nid: f\nname: F # hi\nentry: a\nnodes:\n  a:\n    kind: hangup\n    note: Bye\n";
        let loaded = load(src).unwrap();
        assert_eq!(loaded.comments.len(), 1);
        assert_eq!(loaded.flow.to_yaml(), "schema_version: 2\nid: f\nname: F\nentry: a\nnodes:\n  a:\n    kind: hangup\n    note: Bye\n");
    }
}
