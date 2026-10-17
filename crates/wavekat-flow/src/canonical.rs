//! The canonical text of a flow (docs/01-canonical-document.md §4).
//!
//! One document has one text, the same in every language: the TypeScript
//! twin is `packages/flow-schema/src/serialize.ts`, and the corpus under
//! `conformance/canonical/` pins both byte for byte. The emitter is written
//! by hand, because YAML libraries choose layout and quoting their own way,
//! and it is guided by the bundled schema: property order, which properties
//! are required, and their defaults all come from there, so a schema change
//! needs no change here.

use std::sync::OnceLock;

use serde_json::{Map, Value};

use crate::{Flow, FLOW_V2_SCHEMA};

/// The newest schema, which the model is generated from.
pub(crate) fn schema() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| serde_json::from_str(FLOW_V2_SCHEMA).expect("bundled schema is JSON"))
}

/// Follow `$ref` (and a single-entry `allOf`, the schema's way of putting a
/// default next to a ref) to the schema that describes a value.
fn resolve(mut s: &'static Value) -> &'static Value {
    loop {
        if let Some(r) = s.get("$ref").and_then(Value::as_str) {
            let name = r.strip_prefix("#/$defs/").expect("refs point into $defs");
            s = &schema()["$defs"][name];
        } else if let Some([only]) = s.get("allOf").and_then(Value::as_array).map(Vec::as_slice) {
            s = only;
        } else {
            return s;
        }
    }
}

/// The schema for `value`, picking a `oneOf` branch: by `kind` for a node,
/// by JSON type otherwise (a text or audio prompt).
pub(crate) fn describe(s: Option<&'static Value>, value: &Value) -> Option<&'static Value> {
    let s = resolve(s?);
    let Some(branches) = s.get("oneOf").and_then(Value::as_array) else {
        return Some(s);
    };
    branches.iter().map(resolve).find(|b| {
        if let Some(kind) = b.pointer("/properties/kind/const") {
            return value.get("kind") == Some(kind);
        }
        match b.get("type").and_then(Value::as_str) {
            Some("string") => value.is_string(),
            Some("object") => value.is_object(),
            Some("array") => value.is_array(),
            Some("integer") | Some("number") => value.is_number(),
            Some("boolean") => value.is_boolean(),
            _ => false,
        }
    })
}

/// The canonical text of `flow`.
pub(crate) fn to_yaml(flow: &Flow) -> String {
    let value = serde_json::to_value(flow).expect("a flow always serializes");
    let mut out = String::new();
    // The document, `nodes` and each node are block mappings, whatever
    // they hold.
    write_block_map(
        &mut out,
        &entries(&value, Some(schema())),
        0,
        Level::Document,
        false,
    );
    out
}

/// Where a mapping sits, for the "always block" rule.
#[derive(Clone, Copy, PartialEq)]
enum Level {
    Document,
    Nodes,
    Node,
    Other,
}

impl Level {
    fn child(self, key: &str) -> Level {
        match (self, key) {
            (Level::Document, "nodes") => Level::Nodes,
            (Level::Nodes, _) => Level::Node,
            _ => Level::Other,
        }
    }
}

/// One entry to write: its key, its value and the schema describing it.
type Entry<'v> = (&'v str, &'v Value, Option<&'static Value>);

/// A mapping's entries in canonical order, with omitted ones left out.
fn entries<'v>(value: &'v Value, s: Option<&'static Value>) -> Vec<Entry<'v>> {
    let Value::Object(map) = value else {
        unreachable!("entries of a mapping")
    };
    let s = describe(s, value);
    let props = s
        .and_then(|s| s.get("properties"))
        .and_then(Value::as_object);
    let Some(props) = props else {
        // A map the schema gives no fixed order to.
        let items = s
            .and_then(|s| s.get("additionalProperties"))
            .filter(|a| a.is_object());
        return map_order(map)
            .into_iter()
            .map(|(k, v)| (k, v, items))
            .collect();
    };
    let required: Vec<&str> = s
        .and_then(|s| s.get("required"))
        .and_then(Value::as_array)
        .map(|r| r.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut out = Vec::new();
    for (key, prop) in props {
        let Some(value) = map.get(key) else { continue };
        if !required.contains(&key.as_str()) && omitted(value, resolve_default(prop)) {
            continue;
        }
        out.push((key.as_str(), value, Some(prop)));
    }
    // Keys the schema doesn't know follow, in map order. (The typed model
    // never has any; this keeps the output defined for any input.)
    let unknown: Map<String, Value> = map
        .iter()
        .filter(|(k, _)| !props.contains_key(*k))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    for (k, _) in map_order(&unknown) {
        let (k, v) = map.get_key_value(k).expect("key from this map");
        out.push((k.as_str(), v, None));
    }
    out
}

/// A property's `default`, looking through a single-entry `allOf`.
fn resolve_default(prop: &Value) -> Option<&Value> {
    prop.get("default").or_else(|| {
        prop.get("allOf")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|f| f.get("default"))
    })
}

/// Is an optional property left out: absent, its default, or empty?
fn omitted(value: &Value, default: Option<&Value>) -> bool {
    match value {
        Value::Null => true,
        Value::Object(m) if m.is_empty() => true,
        Value::Array(a) if a.is_empty() => true,
        _ => default.is_some_and(|d| numbers_equal(d, value) || d == value),
    }
}

fn numbers_equal(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => a.is_number() && b.is_number() && x == y,
        _ => false,
    }
}

/// Map order (§3): keys that are canonical array indices first, ascending,
/// then the rest in the order they were written. JavaScript objects order
/// keys this way, so the TypeScript twin can't do otherwise.
fn map_order(map: &Map<String, Value>) -> Vec<(&str, &Value)> {
    let mut indices: Vec<(u32, &str, &Value)> = Vec::new();
    let mut rest = Vec::new();
    for (k, v) in map {
        match array_index(k) {
            Some(i) => indices.push((i, k, v)),
            None => rest.push((k.as_str(), v)),
        }
    }
    indices.sort_by_key(|(i, _, _)| *i);
    indices
        .into_iter()
        .map(|(_, k, v)| (k, v))
        .chain(rest)
        .collect()
}

/// `Some(n)` when `key` is a canonical array index: `0`, or digits with no
/// leading zero, below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if key.len() > 1 && key.starts_with('0') {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n < u32::MAX)
}

fn is_scalar(v: &Value) -> bool {
    !matches!(v, Value::Object(_) | Value::Array(_))
}

/// Is a collection written in flow style? When every entry it writes
/// (after omissions) is a scalar.
fn is_flow(v: &Value, s: Option<&'static Value>) -> bool {
    match v {
        Value::Object(_) => entries(v, s).iter().all(|(_, x, _)| is_scalar(x)),
        Value::Array(a) => a.iter().all(is_scalar),
        _ => false,
    }
}

fn pad(out: &mut String, indent: usize) {
    out.extend(std::iter::repeat_n(' ', indent));
}

/// Write a block mapping at `indent`. When `on_dash_line`, the first entry
/// continues the current `- ` line of a list item.
fn write_block_map(
    out: &mut String,
    entries: &[Entry<'_>],
    indent: usize,
    level: Level,
    on_dash_line: bool,
) {
    for (i, (key, value, s)) in entries.iter().enumerate() {
        if i > 0 || !on_dash_line {
            pad(out, indent);
        }
        out.push_str(&scalar_string(key, false));
        out.push(':');
        write_value(out, value, *s, indent, level.child(key));
    }
}

/// Write `value` after `key:`, then end the line.
fn write_value(
    out: &mut String,
    value: &Value,
    s: Option<&'static Value>,
    indent: usize,
    level: Level,
) {
    let always_block = matches!(level, Level::Nodes | Level::Node);
    match value {
        Value::Object(m) if m.is_empty() => out.push_str(" {}\n"),
        Value::Array(a) if a.is_empty() => out.push_str(" []\n"),
        Value::Object(_) if always_block || !is_flow(value, s) => {
            out.push('\n');
            write_block_map(out, &entries(value, s), indent + 2, level, false);
        }
        Value::Array(a) if !is_flow(value, s) => {
            out.push('\n');
            write_block_list(out, a, items_of(s), indent + 2);
        }
        _ => {
            out.push(' ');
            write_inline(out, value, s);
            out.push('\n');
        }
    }
}

/// The schema of a list's items.
fn items_of(s: Option<&'static Value>) -> Option<&'static Value> {
    s.map(resolve).and_then(|s| s.get("items"))
}

fn write_block_list(out: &mut String, items: &[Value], s: Option<&'static Value>, indent: usize) {
    for item in items {
        pad(out, indent);
        match item {
            Value::Object(m) if !m.is_empty() && !is_flow(item, s) => {
                out.push_str("- ");
                write_block_map(out, &entries(item, s), indent + 2, Level::Other, true);
            }
            Value::Array(a) if !a.is_empty() && !is_flow(item, s) => {
                out.push_str("-\n");
                write_block_list(out, a, items_of(s), indent + 2);
            }
            _ => {
                out.push_str("- ");
                write_inline(out, item, s);
                out.push('\n');
            }
        }
    }
}

/// A scalar, or a flow collection of scalars, on one line.
fn write_inline(out: &mut String, value: &Value, s: Option<&'static Value>) {
    match value {
        Value::Object(m) if m.is_empty() => out.push_str("{}"),
        Value::Object(_) => {
            out.push_str("{ ");
            for (i, (k, v, _)) in entries(value, s).iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                out.push_str(&scalar_string(k, true));
                out.push_str(": ");
                write_scalar(out, v, true);
            }
            out.push_str(" }");
        }
        Value::Array(a) if a.is_empty() => out.push_str("[]"),
        Value::Array(a) => {
            out.push('[');
            for (i, v) in a.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write_scalar(out, v, true);
            }
            out.push(']');
        }
        _ => write_scalar(out, value, false),
    }
}

fn write_scalar(out: &mut String, value: &Value, flow: bool) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number_string(n)),
        Value::String(s) => out.push_str(&scalar_string(s, flow)),
        Value::Object(_) | Value::Array(_) => unreachable!("only scalars are written inline"),
    }
}

/// A number as JavaScript's `String(n)` writes it.
fn number_string(n: &serde_json::Number) -> String {
    if n.is_i64() || n.is_u64() {
        return n.to_string();
    }
    let f = n.as_f64().expect("a JSON number is finite");
    if f == 0.0 {
        return "0".into();
    }
    let abs = f.abs();
    if abs >= 1e21 {
        // Rust writes `1e21`; JavaScript `1e+21`.
        return format!("{f:e}").replacen('e', "e+", 1);
    }
    if abs < 1e-6 {
        return format!("{f:e}");
    }
    // Shortest round-trip digits, no exponent: the same as JavaScript in
    // this range.
    format!("{f}")
}

/// Words some YAML readers take for booleans, null or numbers.
const RESERVED: &[&str] = &[
    "true", "false", "yes", "no", "on", "off", "y", "n", "null", "inf", "nan", "infinity",
];

/// Characters a double-quoted string writes as `\uXXXX`.
fn needs_unicode_escape(c: char) -> bool {
    matches!(c, '\0'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{2028}' | '\u{2029}' | '\u{feff}')
}

/// Can `s` be written as a plain scalar (§4)?
pub(crate) fn is_plain(s: &str, flow: bool) -> bool {
    let Some(first) = s.chars().next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_' || first == '/' || !first.is_ascii()) {
        return false;
    }
    if s.ends_with(' ') || s.ends_with(':') {
        return false;
    }
    if s.contains(": ") || s.contains(" #") {
        return false;
    }
    if s.chars().any(|c| c == '\t' || needs_unicode_escape(c)) {
        return false;
    }
    if flow && s.contains([',', '[', ']', '{', '}', ':']) {
        return false;
    }
    !RESERVED.contains(&s.to_ascii_lowercase().as_str())
}

/// `s` as a plain scalar when it can be one, double-quoted otherwise.
fn scalar_string(s: &str, flow: bool) -> String {
    if is_plain(s, flow) {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if needs_unicode_escape(c) => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_or_quoted() {
        for plain in [
            "Hello",
            "Thanks for calling, how can we help?",
            "再见",
            "_x",
            "/a/b",
            "C#",
            "it's",
        ] {
            assert!(is_plain(plain, false), "{plain}");
        }
        for quoted in [
            "",
            "09:00",
            "2026-12-25",
            "1",
            "-x",
            ".inf",
            "yes",
            "No",
            "a: b",
            "a #b",
            "end ",
            "key:",
            "line\nbreak",
            "tab\there",
            "'q'",
            "\"q\"",
            "[x]",
            "*a",
            "&a",
            "!t",
            "%d",
            "@x",
            "`x",
            "|x",
            ">x",
            "#x",
            "?x",
            "~",
        ] {
            assert!(!is_plain(quoted, false), "{quoted:?}");
        }
        assert!(is_plain("a, b", false));
        assert!(!is_plain("a, b", true));
        assert!(!is_plain("a{b", true));
        // libyaml refuses a `:` inside a plain scalar in flow style.
        assert!(is_plain("a:b", false));
        assert!(!is_plain("a:b", true));
    }

    #[test]
    fn escapes() {
        // Quotes and backslashes are fine in a plain scalar; escaped once quoted.
        assert_eq!(scalar_string("say \"hi\"\\", false), "say \"hi\"\\");
        assert_eq!(scalar_string("\"hi\" \\", false), r#""\"hi\" \\""#);
        assert_eq!(scalar_string("a\nb\tc", false), r#""a\nb\tc""#);
        assert_eq!(
            scalar_string("\u{7f}\u{1}\u{2028}", false),
            r#""\u007f\u0001\u2028""#
        );
        assert_eq!(scalar_string("1", true), r#""1""#);
    }

    #[test]
    fn numbers_like_javascript() {
        let n = |s: &str| number_string(&serde_json::from_str(s).unwrap());
        assert_eq!(n("120"), "120");
        assert_eq!(n("120.0"), "120");
        assert_eq!(n("-0.0"), "0");
        assert_eq!(n("0.5"), "0.5");
        assert_eq!(n("1e21"), "1e+21");
        assert_eq!(n("1.5e21"), "1.5e+21");
        assert_eq!(n("1e20"), "100000000000000000000");
        assert_eq!(n("1e-7"), "1e-7");
        assert_eq!(n("0.000001"), "0.000001");
    }

    #[test]
    fn array_indices_first() {
        let m: Map<String, Value> =
            serde_json::from_str(r#"{"b":1,"2":1,"a":1,"0":1,"01":1,"10":1}"#).unwrap();
        let keys: Vec<&str> = map_order(&m).into_iter().map(|(k, _)| k).collect();
        assert_eq!(keys, ["0", "2", "10", "b", "a", "01"]);
    }
}
