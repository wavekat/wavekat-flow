//! Placeholder syntax shared by validation and filling.
//!
//! A template is text with `{{name}}` placeholders and `{{#name}}…{{/name}}`
//! conditional blocks (kept only when the variable's value is non-empty).
//! Blocks do not nest and have no else. Names are `[a-z][a-z0-9_]{0,31}`.
//! Twin: `packages/flow-schema/src/vars.ts`.

use std::collections::BTreeMap;

use crate::model::{Exits, Flow, Node, Prompt};

/// One piece of a parsed template.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment<'a> {
    /// Literal text, spoken as written.
    Text(&'a str),
    /// A `{{name}}` placeholder.
    Var(&'a str),
    /// A `{{#name}}…{{/name}}` block; `body` holds only `Text` and `Var`.
    Block {
        name: &'a str,
        body: Vec<Segment<'a>>,
    },
}

/// Why a template could not be parsed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TemplateError {
    #[error("a `{{{{` or block is never closed")]
    Unclosed,
    #[error("blocks cannot be nested")]
    Nested,
    #[error("{0:?} is not a valid variable name (a lowercase letter, then up to 31 lowercase letters, digits or underscores)")]
    BadName(String),
    #[error("block close {{{{/{0}}}}} does not match an open block")]
    Mismatched(String),
}

/// Whether `name` fits `[a-z][a-z0-9_]{0,31}`. Twin: `isVariableName`.
pub fn is_variable_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some('a'..='z'))
        && name.len() <= 32
        && chars.all(|c| matches!(c, 'a'..='z' | '0'..='9' | '_'))
}

enum Tok<'a> {
    Text(&'a str),
    Var(&'a str),
    Open(&'a str),
    Close(&'a str),
}

/// Split `s` into tokens. The flag is true when a `{{` has no `}}`.
fn tokens(s: &str) -> (Vec<Tok<'_>>, bool) {
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(start) = rest.find("{{") {
        if start > 0 {
            out.push(Tok::Text(&rest[..start]));
        }
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            return (out, true);
        };
        let inner = &after[..end];
        out.push(if let Some(name) = inner.strip_prefix('#') {
            Tok::Open(name)
        } else if let Some(name) = inner.strip_prefix('/') {
            Tok::Close(name)
        } else {
            Tok::Var(inner)
        });
        rest = &after[end + 2..];
    }
    if !rest.is_empty() {
        out.push(Tok::Text(rest));
    }
    (out, false)
}

/// Parse `s` into segments.
pub fn parse_template(s: &str) -> Result<Vec<Segment<'_>>, TemplateError> {
    let (toks, unclosed) = tokens(s);
    let mut out = Vec::new();
    // The open block: its name and the body gathered so far.
    let mut open: Option<(&str, Vec<Segment<'_>>)> = None;
    for tok in toks {
        match tok {
            Tok::Text(t) => match &mut open {
                Some((_, body)) => body.push(Segment::Text(t)),
                None => out.push(Segment::Text(t)),
            },
            Tok::Var(n) => {
                if !is_variable_name(n) {
                    return Err(TemplateError::BadName(n.to_string()));
                }
                match &mut open {
                    Some((_, body)) => body.push(Segment::Var(n)),
                    None => out.push(Segment::Var(n)),
                }
            }
            Tok::Open(n) => {
                if !is_variable_name(n) {
                    return Err(TemplateError::BadName(n.to_string()));
                }
                if open.is_some() {
                    return Err(TemplateError::Nested);
                }
                open = Some((n, Vec::new()));
            }
            Tok::Close(n) => {
                if !is_variable_name(n) {
                    return Err(TemplateError::BadName(n.to_string()));
                }
                match open.take() {
                    Some((name, body)) if name == n => out.push(Segment::Block { name, body }),
                    _ => return Err(TemplateError::Mismatched(n.to_string())),
                }
            }
        }
    }
    if unclosed || open.is_some() {
        return Err(TemplateError::Unclosed);
    }
    Ok(out)
}

/// Every variable name `s` mentions, first-mention order, no repeats.
/// Best effort on a malformed template: the well-formed names it holds.
pub fn template_names(s: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for tok in tokens(s).0 {
        if let Tok::Var(n) | Tok::Open(n) = tok {
            if is_variable_name(n) && !names.iter().any(|x| x == n) {
                names.push(n.to_string());
            }
        }
    }
    names
}

/// Why [`fill`] refused the values.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FillError {
    #[error("the flow declares no variable named {0:?}")]
    Unknown(String),
    #[error("variable {name:?} is {len} characters; its max_len is {max}")]
    TooLong { name: String, max: u64, len: u64 },
}

impl FillError {
    /// The stable code, shared with the TypeScript twin.
    pub fn code(&self) -> &'static str {
        match self {
            FillError::Unknown(_) => "variable_unknown",
            FillError::TooLong { .. } => "variable_too_long",
        }
    }
}

/// A caller's value, trimmed with control characters stripped.
fn clean(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string()
}

fn render(segments: &[Segment<'_>], effective: &dyn Fn(&str) -> String, out: &mut String) {
    for seg in segments {
        match seg {
            Segment::Text(t) => out.push_str(t),
            Segment::Var(n) => out.push_str(&effective(n)),
            Segment::Block { name, body } => {
                if !effective(name).is_empty() {
                    render(body, effective, out);
                }
            }
        }
    }
}

/// Turn a flow with variables plus a caller's values into a plain flow the
/// engine can run: every placeholder replaced, `variables` gone,
/// `schema_version` unchanged. Twin: `vars.ts` `fill`.
///
/// A name's effective value is the caller's (trimmed, control characters
/// stripped) when that is non-empty, else the variable's default. Values are
/// inserted as text and never parsed again. A menu option whose label is
/// exactly `{{name}}` with an empty value is removed, with its exit. An audio
/// prompt with a `template` stays audio (dropping the template) unless a
/// variable it names got a non-default value; then it becomes the filled
/// text. A flow without variables comes back as a clone. A malformed template is left as written (validation rejects those
/// before fill is reached).
pub fn fill(flow: &Flow, values: &BTreeMap<String, String>) -> Result<Flow, Vec<FillError>> {
    // No variables: `{{` is ordinary text (v1-v3), so there is nothing to fill.
    if flow.variables.is_empty() && values.is_empty() {
        return Ok(flow.clone());
    }
    let mut errors = Vec::new();
    let mut given: BTreeMap<&str, String> = BTreeMap::new();
    for (name, raw) in values {
        let Some(var) = flow.variables.get(name) else {
            errors.push(FillError::Unknown(name.clone()));
            continue;
        };
        let value = clean(raw);
        let len = value.chars().count() as u64;
        if len > var.max_len.get() {
            errors.push(FillError::TooLong {
                name: name.clone(),
                max: var.max_len.get(),
                len,
            });
        } else if !value.is_empty() {
            given.insert(name, value);
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let effective = |name: &str| -> String {
        given
            .get(name)
            .cloned()
            .or_else(|| flow.variables.get(name).map(|v| v.default.clone()))
            .unwrap_or_default()
    };
    let fill_text = |text: &str| -> String {
        match parse_template(text) {
            Ok(segments) => {
                let mut out = String::new();
                render(&segments, &effective, &mut out);
                out
            }
            Err(_) => text.to_string(),
        }
    };

    let mut out = flow.clone();
    out.variables.clear();
    for node in out.nodes.values_mut() {
        for (_, prompt) in node.prompt_slots_mut() {
            match prompt {
                Prompt::Text(text) => *text = fill_text(text),
                Prompt::Audio { template, .. } => {
                    let Some(t) = template.take() else { continue };
                    let overridden = template_names(&t).iter().any(|n| {
                        given
                            .get(n.as_str())
                            .is_some_and(|v| flow.variables.get(n).is_none_or(|d| &d.default != v))
                    });
                    if overridden {
                        *prompt = Prompt::Text(fill_text(&t));
                    }
                }
            }
        }
        if let Node::Menu { options, exits, .. } = node {
            let mut dropped = Vec::new();
            for (key, label) in options.iter_mut() {
                let bare = label
                    .strip_prefix("{{")
                    .and_then(|l| l.strip_suffix("}}"))
                    .filter(|n| is_variable_name(n));
                if bare.is_some_and(|n| effective(n).is_empty()) {
                    dropped.push(key.clone());
                } else {
                    *label = fill_text(label);
                }
            }
            for key in dropped {
                options.shift_remove(&key);
                if let Some(Exits(map)) = exits {
                    map.shift_remove(&key);
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_text_vars_and_blocks() {
        assert_eq!(
            parse_template("Hi {{a}}.{{#b}} B={{b}}{{/b}}").unwrap(),
            vec![
                Segment::Text("Hi "),
                Segment::Var("a"),
                Segment::Text("."),
                Segment::Block {
                    name: "b",
                    body: vec![Segment::Text(" B="), Segment::Var("b")]
                },
            ]
        );
    }

    #[test]
    fn plain_text_and_stray_closers_pass_through() {
        assert_eq!(parse_template("").unwrap(), vec![]);
        assert_eq!(
            parse_template("a }} b").unwrap(),
            vec![Segment::Text("a }} b")]
        );
    }

    #[test]
    fn rejects_nested_and_unclosed_blocks() {
        assert_eq!(
            parse_template("{{#a}}{{#b}}{{/b}}{{/a}}"),
            Err(TemplateError::Nested)
        );
        assert_eq!(parse_template("{{#a}} x"), Err(TemplateError::Unclosed));
        assert_eq!(parse_template("{{a"), Err(TemplateError::Unclosed));
    }

    #[test]
    fn rejects_mismatched_closers() {
        assert_eq!(
            parse_template("{{/a}}"),
            Err(TemplateError::Mismatched("a".into()))
        );
        assert_eq!(
            parse_template("{{#a}}{{/b}}"),
            Err(TemplateError::Mismatched("b".into()))
        );
    }

    #[test]
    fn rejects_bad_names() {
        assert_eq!(
            parse_template("{{A}}"),
            Err(TemplateError::BadName("A".into()))
        );
        assert_eq!(
            parse_template("{{1a}}"),
            Err(TemplateError::BadName("1a".into()))
        );
        assert_eq!(
            parse_template("{{}}"),
            Err(TemplateError::BadName(String::new()))
        );
        assert!(parse_template(&format!("{{{{{}}}}}", "a".repeat(32))).is_ok());
        assert!(parse_template(&format!("{{{{{}}}}}", "a".repeat(33))).is_err());
    }

    #[test]
    fn brace_edge_cases() {
        assert_eq!(
            parse_template("{{{a}}}"),
            Err(TemplateError::BadName("{a".into()))
        );
        assert_eq!(
            parse_template("{ {a} }").unwrap(),
            vec![Segment::Text("{ {a} }")]
        );
        assert_eq!(parse_template("}}").unwrap(), vec![Segment::Text("}}")]);
        assert_eq!(parse_template("{{#a}} x {{"), Err(TemplateError::Unclosed));
    }

    #[test]
    fn names_are_listed_once_in_order() {
        assert_eq!(
            template_names("{{b}} {{#a}}{{a}}{{/a}} {{b}}"),
            vec!["b".to_string(), "a".to_string()]
        );
    }

    const ASK: &str = include_str!("../../../conformance/v4/valid/ask-question.yaml");

    fn ask() -> Flow {
        Flow::from_yaml(ASK).unwrap()
    }

    fn vals(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn menu(flow: &Flow) -> (String, Vec<(String, String)>, Vec<String>) {
        let Node::Menu {
            prompt,
            options,
            exits,
            ..
        } = &flow.nodes["ask"]
        else {
            panic!("ask is a menu")
        };
        let Prompt::Text(text) = prompt else {
            panic!("text prompt")
        };
        (
            text.clone(),
            options
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            exits.as_ref().unwrap().keys().cloned().collect(),
        )
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn fills_question_and_two_options() {
        let filled = fill(
            &ask(),
            &vals(&[
                ("question", "Which database?"),
                ("option1", "Postgres"),
                ("option2", "SQLite"),
            ]),
        )
        .unwrap();
        let (prompt, options, exits) = menu(&filled);
        assert_eq!(
            prompt,
            "Claude has a question. Which database? Press 1 for Postgres. Press 2 for SQLite. Press 9 to hear this again."
        );
        assert_eq!(
            options,
            pairs(&[("1", "Postgres"), ("2", "SQLite"), ("9", "Repeat")])
        );
        assert!(!exits.contains(&"3".to_string()) && !exits.contains(&"4".to_string()));
        assert!(filled.variables.is_empty());
        assert_eq!(filled.schema_version, 4);
    }

    #[test]
    fn keeps_option3_when_given() {
        let filled = fill(&ask(), &vals(&[("option3", "Both")])).unwrap();
        let (prompt, options, exits) = menu(&filled);
        assert!(prompt.contains(" Press 3 for Both."), "{prompt}");
        assert!(options.contains(&("3".to_string(), "Both".to_string())));
        let Node::Menu { exits: e, .. } = &filled.nodes["ask"] else {
            unreachable!()
        };
        assert_eq!(e.as_ref().unwrap()["3"], "thanks");
        assert!(!exits.contains(&"4".to_string()));
    }

    #[test]
    fn no_values_plays_the_defaults() {
        let filled = fill(&ask(), &BTreeMap::new()).unwrap();
        let (prompt, options, exits) = menu(&filled);
        assert_eq!(
            prompt,
            "Claude has a question. Claude needs your input on screen. Press 1 for Yes. Press 2 for No. Press 9 to hear this again."
        );
        assert_eq!(
            options,
            pairs(&[("1", "Yes"), ("2", "No"), ("9", "Repeat")])
        );
        assert!(!exits.contains(&"3".to_string()) && !exits.contains(&"4".to_string()));
    }

    #[test]
    fn rendered_prompt_stays_audio_when_defaults_kept() {
        let mut flow = Flow::from_yaml(
            "schema_version: 4\nid: f\nname: F\nentry: a\nvariables:\n  name: { default: there }\nnodes:\n  a:\n    kind: hangup\n    prompt: { audio: vprompt_a, template: \"Hi {{name}}\" }\n",
        )
        .unwrap();
        let filled = fill(&flow, &BTreeMap::new()).unwrap();
        let Node::Hangup { prompt, .. } = &filled.nodes["a"] else {
            unreachable!()
        };
        assert!(matches!(
            prompt,
            Some(Prompt::Audio { audio, template: None, .. }) if audio == "vprompt_a"
        ));
        // Giving the default itself changes nothing.
        let same = fill(&flow, &vals(&[("name", "there")])).unwrap();
        assert!(matches!(
            &same.nodes["a"],
            Node::Hangup {
                prompt: Some(Prompt::Audio { .. }),
                ..
            }
        ));
        let filled = fill(&flow, &vals(&[("name", "Ann")])).unwrap();
        let Node::Hangup { prompt, .. } = &filled.nodes["a"] else {
            unreachable!()
        };
        assert!(matches!(prompt, Some(Prompt::Text(t)) if t == "Hi Ann"));
        flow.variables.clear();
    }

    #[test]
    fn blank_value_falls_back_to_default() {
        let filled = fill(&ask(), &vals(&[("question", "  ")])).unwrap();
        assert!(menu(&filled)
            .0
            .contains("Claude needs your input on screen."));
    }

    #[test]
    fn control_characters_are_stripped() {
        let filled = fill(&ask(), &vals(&[("question", " Hi\u{7}\n there ")])).unwrap();
        assert!(menu(&filled)
            .0
            .contains("Claude has a question. Hi there Press"));
    }

    #[test]
    fn unknown_value_is_an_error() {
        let errs = fill(&ask(), &vals(&[("colour", "red")])).unwrap_err();
        assert_eq!(errs, vec![FillError::Unknown("colour".into())]);
        assert_eq!(errs[0].code(), "variable_unknown");
    }

    #[test]
    fn values_are_not_expanded() {
        let filled = fill(&ask(), &vals(&[("question", "{{option1}} {x}")])).unwrap();
        assert!(menu(&filled).0.contains("{{option1}} {x}"));
    }

    #[test]
    fn max_len_counts_characters() {
        let mut flow = ask();
        flow.variables.get_mut("question").unwrap().max_len = 300.try_into().unwrap();
        assert!(fill(&flow, &vals(&[("question", &"问".repeat(150))])).is_ok());
        assert!(fill(&flow, &vals(&[("question", &"问".repeat(300))])).is_ok());
        let errs = fill(&flow, &vals(&[("question", &"问".repeat(301))])).unwrap_err();
        assert_eq!(
            errs,
            vec![FillError::TooLong {
                name: "question".into(),
                max: 300,
                len: 301
            }]
        );
        assert_eq!(errs[0].code(), "variable_too_long");
    }

    #[test]
    fn filled_flow_passes_validate_outbound() {
        for v in [
            vals(&[]),
            vals(&[("option3", "Both"), ("option4", "Neither")]),
        ] {
            let filled = fill(&ask(), &v).unwrap();
            crate::validate::validate_outbound(&filled).unwrap();
        }
    }

    #[test]
    fn a_flow_without_variables_is_returned_unchanged() {
        let plain = Flow::from_yaml(
            "schema_version: 3\nid: f\nname: F\nentry: a\nnodes:\n  a:\n    kind: hangup\n    prompt: Hi {{x}}\n",
        )
        .unwrap();
        assert_eq!(
            fill(&plain, &BTreeMap::new()).unwrap().to_yaml(),
            plain.to_yaml()
        );
    }
}
