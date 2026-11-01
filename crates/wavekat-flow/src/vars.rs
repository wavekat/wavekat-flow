//! Placeholder syntax shared by validation and filling.
//!
//! A template is text with `{{name}}` placeholders and `{{#name}}…{{/name}}`
//! conditional blocks (kept only when the variable's value is non-empty).
//! Blocks do not nest and have no else. Names are `[a-z][a-z0-9_]{0,31}`.
//! Twin: `packages/flow-schema/src/vars.ts`.

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
}
