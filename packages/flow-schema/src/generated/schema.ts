// GENERATED from schema/flow.v{1,2}.schema.json by scripts/generate.mjs — do not edit.
// Run `pnpm gen` after changing a schema; CI fails on drift.

export const flowV1Schema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schema.wavekat.com/flow/v1.json",
  "title": "Flow",
  "description": "The WaveKat call-flow (\"Receptionist\") document, schema_version 1. This file is the single source of truth for the document SHAPE: every consumer (the @wavekat/flow-schema npm package, the wavekat-flow Rust crate) generates its model types from this file. Semantic rules that a JSON Schema cannot express (graph reachability, exit-set exactness, hours/timezone math, DTMF digit validity, prompt length) are NOT encoded here — they live in each language's validator and are pinned by the shared conformance corpus. Unknown fields are permitted structurally, matching both implementations (Rust serde ignores them; the TS parser surfaces a non-blocking warning).",
  "type": "object",
  "required": [
    "schema_version",
    "id",
    "name",
    "entry",
    "nodes"
  ],
  "properties": {
    "schema_version": {
      "description": "Document format version. This file describes version 1 only; a document declaring another version validates against that version's schema file, not this one.",
      "type": "integer",
      "const": 1
    },
    "id": {
      "description": "Opaque platform-assigned id (flow_…). Treated as a label; appears in traces.",
      "type": "string"
    },
    "name": {
      "description": "Human name shown in the editor and the read-only viewer.",
      "type": "string"
    },
    "version": {
      "description": "Platform-assigned publish counter, bumped on publish. Defaults to 1 for a hand-written or generated pre-publish document. Distinct from schema_version.",
      "type": "integer",
      "minimum": 0,
      "default": 1
    },
    "entry": {
      "description": "Node id where execution begins.",
      "type": "string"
    },
    "nodes": {
      "description": "The flat node set, keyed by human-meaningful node id and string-referenced by exits. Order is irrelevant to execution.",
      "type": "object",
      "additionalProperties": {
        "$ref": "#/$defs/Node"
      }
    },
    "ui": {
      "description": "Presentation metadata (canvas positions, annotations). Preserved on round-trip, never read by the engine. Opaque by design so a canvas editor can add layout fields without a schema bump."
    }
  },
  "$defs": {
    "Prompt": {
      "description": "What a component speaks: TTS text (a bare string) or a reference to a pre-rendered audio asset shipped alongside the flow.",
      "oneOf": [
        {
          "title": "Text",
          "type": "string"
        },
        {
          "title": "Audio",
          "type": "object",
          "required": [
            "audio"
          ],
          "properties": {
            "audio": {
              "description": "Audio asset ref. A generated-clip ref is a voice_prompts id matching ^vprompt_[a-z0-9]+$.",
              "type": "string"
            },
            "transcript": {
              "description": "The words this pre-rendered clip speaks — the text it was synthesized from — carried so a viewer can show what a caller hears, and for traces. Advisory only: playback always uses `audio`, never this. Optional and forward-added: absent on older documents and on refs the platform did not generate from text.",
              "type": "string"
            }
          }
        }
      ]
    },
    "MessageTone": {
      "description": "The cue a message node plays between its prompt and the start of recording.",
      "type": "string",
      "enum": [
        "beep",
        "none"
      ]
    },
    "Exits": {
      "description": "Wired exits: exit name → target node id. Which names are valid is a property of the node's kind and is checked by the validator, not by this schema.",
      "type": "object",
      "additionalProperties": {
        "type": "string"
      }
    },
    "TimeRange": {
      "description": "One open window: open–close as \"HH:MM\" (24-hour). Ordering and overnight rules are enforced by the validator.",
      "type": "object",
      "required": [
        "open",
        "close"
      ],
      "properties": {
        "open": {
          "type": "string"
        },
        "close": {
          "type": "string"
        }
      }
    },
    "WeeklySchedule": {
      "description": "Open ranges per weekday; a missing or empty day means closed all day.",
      "type": "object",
      "properties": {
        "mon": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TimeRange"
          }
        },
        "tue": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TimeRange"
          }
        },
        "wed": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TimeRange"
          }
        },
        "thu": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TimeRange"
          }
        },
        "fri": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TimeRange"
          }
        },
        "sat": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TimeRange"
          }
        },
        "sun": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TimeRange"
          }
        }
      }
    },
    "HoursException": {
      "description": "A single-date override of the weekly schedule (holiday / special hours).",
      "type": "object",
      "required": [
        "date"
      ],
      "properties": {
        "date": {
          "description": "\"YYYY-MM-DD\" in the flow's timezone.",
          "type": "string"
        },
        "closed": {
          "description": "Closed all day regardless of ranges.",
          "type": "boolean",
          "default": false
        },
        "ranges": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TimeRange"
          }
        }
      }
    },
    "Node": {
      "description": "One node: a component (kind + its config) plus its wired exits. An internally-tagged union on `kind`.",
      "oneOf": [
        {
          "$ref": "#/$defs/GreetingNode"
        },
        {
          "$ref": "#/$defs/HoursNode"
        },
        {
          "$ref": "#/$defs/MenuNode"
        },
        {
          "$ref": "#/$defs/RingNode"
        },
        {
          "$ref": "#/$defs/MessageNode"
        },
        {
          "$ref": "#/$defs/TransferNode"
        },
        {
          "$ref": "#/$defs/HangupNode"
        }
      ]
    },
    "GreetingNode": {
      "description": "Speak a prompt, then continue. Exit: next.",
      "type": "object",
      "required": [
        "kind",
        "prompt"
      ],
      "properties": {
        "kind": {
          "const": "greeting"
        },
        "prompt": {
          "$ref": "#/$defs/Prompt"
        },
        "exits": {
          "$ref": "#/$defs/Exits"
        }
      }
    },
    "HoursNode": {
      "description": "Branch on the business's weekly schedule + holiday overrides. Exits: open, closed.",
      "type": "object",
      "required": [
        "kind",
        "schedule",
        "timezone"
      ],
      "properties": {
        "kind": {
          "const": "hours"
        },
        "schedule": {
          "$ref": "#/$defs/WeeklySchedule"
        },
        "timezone": {
          "description": "IANA zone (America/New_York). Validated to resolve at load.",
          "type": "string"
        },
        "exceptions": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/HoursException"
          }
        },
        "exits": {
          "$ref": "#/$defs/Exits"
        }
      }
    },
    "MenuNode": {
      "description": "Speak a prompt and collect a DTMF choice. Exits: one per digit in options, plus no_input and invalid.",
      "type": "object",
      "required": [
        "kind",
        "prompt",
        "options"
      ],
      "properties": {
        "kind": {
          "const": "menu"
        },
        "prompt": {
          "$ref": "#/$defs/Prompt"
        },
        "options": {
          "description": "Digit key → human label. The exit for a digit is exits[digit]. Valid digit keys are enforced by the validator.",
          "type": "object",
          "additionalProperties": {
            "type": "string"
          }
        },
        "retries": {
          "type": "integer",
          "minimum": 0,
          "default": 1
        },
        "timeout_secs": {
          "type": "integer",
          "minimum": 0,
          "default": 5
        },
        "exits": {
          "$ref": "#/$defs/Exits"
        }
      }
    },
    "RingNode": {
      "description": "Ring the human for a window. answered is an implicit terminal; the only wired exit is no_answer.",
      "type": "object",
      "required": [
        "kind",
        "timeout_secs"
      ],
      "properties": {
        "kind": {
          "const": "ring"
        },
        "timeout_secs": {
          "type": "integer",
          "minimum": 0
        },
        "exits": {
          "$ref": "#/$defs/Exits"
        }
      }
    },
    "MessageNode": {
      "description": "Voicemail: speak a prompt, record, transcribe, notify. Terminal.",
      "type": "object",
      "required": [
        "kind",
        "prompt"
      ],
      "properties": {
        "kind": {
          "const": "message"
        },
        "prompt": {
          "$ref": "#/$defs/Prompt"
        },
        "max_secs": {
          "type": "integer",
          "minimum": 0,
          "default": 120
        },
        "tone": {
          "allOf": [
            {
              "$ref": "#/$defs/MessageTone"
            }
          ],
          "default": "beep"
        },
        "exits": {
          "$ref": "#/$defs/Exits"
        }
      }
    },
    "TransferNode": {
      "description": "Blind-transfer to an external number. Terminal.",
      "type": "object",
      "required": [
        "kind",
        "target"
      ],
      "properties": {
        "kind": {
          "const": "transfer"
        },
        "target": {
          "type": "string"
        },
        "exits": {
          "$ref": "#/$defs/Exits"
        }
      }
    },
    "HangupNode": {
      "description": "Speak an optional goodbye and end the call. Terminal.",
      "type": "object",
      "required": [
        "kind"
      ],
      "properties": {
        "kind": {
          "const": "hangup"
        },
        "prompt": {
          "$ref": "#/$defs/Prompt"
        },
        "exits": {
          "$ref": "#/$defs/Exits"
        }
      }
    }
  }
} as const;

export const flowV2Schema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schema.wavekat.com/flow/v2.json",
  "title": "Flow",
  "description": "The WaveKat call-flow (\"Receptionist\") document, schema_version 2. Version 2 is version 1 plus the `book` component (appointment booking over the phone); every version-1 document is a valid version-2 document once its `schema_version` is bumped, and nothing else changed. This file is the single source of truth for the document SHAPE, and — being the newest version — it is also the file both consumers generate their model types from, so one model covers every supported version. Semantic rules that a JSON Schema cannot express (graph reachability, exit-set exactness, hours/timezone math, DTMF digit validity, prompt length, per-component numeric bounds, and which components a given schema_version may use) are NOT encoded here — they live in each language's validator and are pinned by the shared conformance corpus. Unknown fields are permitted structurally, matching both implementations (Rust serde ignores them; the TS parser surfaces a non-blocking warning).",
  "type": "object",
  "required": [
    "schema_version",
    "id",
    "name",
    "entry",
    "nodes"
  ],
  "properties": {
    "schema_version": {
      "description": "Document format version. This file describes version 2 only; a document declaring another version validates against that version's schema file, not this one. (The type generators relax this constant to a plain integer so the generated model can hold any supported version — see scripts/generate.mjs and build.rs.)",
      "type": "integer",
      "const": 2
    },
    "id": {
      "description": "Opaque platform-assigned id (flow_…). Treated as a label; appears in traces.",
      "type": "string"
    },
    "name": {
      "description": "Human name shown in the editor and the read-only viewer.",
      "type": "string"
    },
    "version": {
      "description": "Platform-assigned publish counter, bumped on publish. Defaults to 1 for a hand-written or generated pre-publish document. Distinct from schema_version.",
      "type": "integer",
      "minimum": 0,
      "default": 1
    },
    "entry": {
      "description": "Node id where execution begins.",
      "type": "string"
    },
    "nodes": {
      "description": "The flat node set, keyed by human-meaningful node id and string-referenced by exits. Order is irrelevant to execution.",
      "type": "object",
      "additionalProperties": {
        "$ref": "#/$defs/Node"
      }
    },
    "ui": {
      "description": "Presentation metadata (canvas positions, annotations). Preserved on round-trip, never read by the engine. Opaque by design so a canvas editor can add layout fields without a schema bump."
    }
  },
  "$defs": {
    "Prompt": {
      "description": "What a component speaks: TTS text (a bare string) or a reference to a pre-rendered audio asset shipped alongside the flow.",
      "oneOf": [
        {
          "title": "Text",
          "type": "string"
        },
        {
          "title": "Audio",
          "type": "object",
          "required": [
            "audio"
          ],
          "properties": {
            "audio": {
              "description": "Audio asset ref. A generated-clip ref is a voice_prompts id matching ^vprompt_[a-z0-9]+$.",
              "type": "string"
            },
            "transcript": {
              "description": "The words this pre-rendered clip speaks — the text it was synthesized from — carried so a viewer can show what a caller hears, and for traces. Advisory only: playback always uses `audio`, never this. Optional and forward-added: absent on older documents and on refs the platform did not generate from text.",
              "type": "string"
            }
          }
        }
      ]
    },
    "MessageTone": {
      "description": "The cue a message node plays between its prompt and the start of recording.",
      "type": "string",
      "enum": [
        "beep",
        "none"
      ]
    },
    "Exits": {
      "description": "Wired exits: exit name → target node id. Which names are valid is a property of the node's kind and is checked by the validator, not by this schema.",
      "type": "object",
      "additionalProperties": {
        "type": "string"
      }
    },
    "TimeRange": {
      "description": "One open window: open–close as \"HH:MM\" (24-hour). Ordering and overnight rules are enforced by the validator.",
      "type": "object",
      "required": [
        "open",
        "close"
      ],
      "properties": {
        "open": {
          "type": "string"
        },
        "close": {
          "type": "string"
        }
      }
    },
    "WeeklySchedule": {
      "description": "Open ranges per weekday; a missing or empty day means closed all day.",
      "type": "object",
      "properties": {
        "mon": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TimeRange"
          }
        },
        "tue": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TimeRange"
          }
        },
        "wed": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TimeRange"
          }
        },
        "thu": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TimeRange"
          }
        },
        "fri": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TimeRange"
          }
        },
        "sat": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TimeRange"
          }
        },
        "sun": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TimeRange"
          }
        }
      }
    },
    "HoursException": {
      "description": "A single-date override of the weekly schedule (holiday / special hours).",
      "type": "object",
      "required": [
        "date"
      ],
      "properties": {
        "date": {
          "description": "\"YYYY-MM-DD\" in the flow's timezone.",
          "type": "string"
        },
        "closed": {
          "description": "Closed all day regardless of ranges.",
          "type": "boolean",
          "default": false
        },
        "ranges": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/TimeRange"
          }
        }
      }
    },
    "Node": {
      "description": "One node: a component (kind + its config) plus its wired exits. An internally-tagged union on `kind`.",
      "oneOf": [
        {
          "$ref": "#/$defs/GreetingNode"
        },
        {
          "$ref": "#/$defs/HoursNode"
        },
        {
          "$ref": "#/$defs/MenuNode"
        },
        {
          "$ref": "#/$defs/RingNode"
        },
        {
          "$ref": "#/$defs/MessageNode"
        },
        {
          "$ref": "#/$defs/TransferNode"
        },
        {
          "$ref": "#/$defs/HangupNode"
        },
        {
          "$ref": "#/$defs/BookNode"
        }
      ]
    },
    "GreetingNode": {
      "description": "Speak a prompt, then continue. Exit: next.",
      "type": "object",
      "required": [
        "kind",
        "prompt"
      ],
      "properties": {
        "kind": {
          "const": "greeting"
        },
        "prompt": {
          "$ref": "#/$defs/Prompt"
        },
        "exits": {
          "$ref": "#/$defs/Exits"
        }
      }
    },
    "HoursNode": {
      "description": "Branch on the business's weekly schedule + holiday overrides. Exits: open, closed.",
      "type": "object",
      "required": [
        "kind",
        "schedule",
        "timezone"
      ],
      "properties": {
        "kind": {
          "const": "hours"
        },
        "schedule": {
          "$ref": "#/$defs/WeeklySchedule"
        },
        "timezone": {
          "description": "IANA zone (America/New_York). Validated to resolve at load.",
          "type": "string"
        },
        "exceptions": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/HoursException"
          }
        },
        "exits": {
          "$ref": "#/$defs/Exits"
        }
      }
    },
    "MenuNode": {
      "description": "Speak a prompt and collect a DTMF choice. Exits: one per digit in options, plus no_input and invalid.",
      "type": "object",
      "required": [
        "kind",
        "prompt",
        "options"
      ],
      "properties": {
        "kind": {
          "const": "menu"
        },
        "prompt": {
          "$ref": "#/$defs/Prompt"
        },
        "options": {
          "description": "Digit key → human label. The exit for a digit is exits[digit]. Valid digit keys are enforced by the validator.",
          "type": "object",
          "additionalProperties": {
            "type": "string"
          }
        },
        "retries": {
          "type": "integer",
          "minimum": 0,
          "default": 1
        },
        "timeout_secs": {
          "type": "integer",
          "minimum": 0,
          "default": 5
        },
        "exits": {
          "$ref": "#/$defs/Exits"
        }
      }
    },
    "RingNode": {
      "description": "Ring the human for a window. answered is an implicit terminal; the only wired exit is no_answer.",
      "type": "object",
      "required": [
        "kind",
        "timeout_secs"
      ],
      "properties": {
        "kind": {
          "const": "ring"
        },
        "timeout_secs": {
          "type": "integer",
          "minimum": 0
        },
        "exits": {
          "$ref": "#/$defs/Exits"
        }
      }
    },
    "MessageNode": {
      "description": "Voicemail: speak a prompt, record, transcribe, notify. Terminal.",
      "type": "object",
      "required": [
        "kind",
        "prompt"
      ],
      "properties": {
        "kind": {
          "const": "message"
        },
        "prompt": {
          "$ref": "#/$defs/Prompt"
        },
        "max_secs": {
          "type": "integer",
          "minimum": 0,
          "default": 120
        },
        "tone": {
          "allOf": [
            {
              "$ref": "#/$defs/MessageTone"
            }
          ],
          "default": "beep"
        },
        "exits": {
          "$ref": "#/$defs/Exits"
        }
      }
    },
    "TransferNode": {
      "description": "Blind-transfer to an external number. Terminal.",
      "type": "object",
      "required": [
        "kind",
        "target"
      ],
      "properties": {
        "kind": {
          "const": "transfer"
        },
        "target": {
          "type": "string"
        },
        "exits": {
          "$ref": "#/$defs/Exits"
        }
      }
    },
    "HangupNode": {
      "description": "Speak an optional goodbye and end the call. Terminal.",
      "type": "object",
      "required": [
        "kind"
      ],
      "properties": {
        "kind": {
          "const": "hangup"
        },
        "prompt": {
          "$ref": "#/$defs/Prompt"
        },
        "exits": {
          "$ref": "#/$defs/Exits"
        }
      }
    },
    "BookNode": {
      "description": "Offer the caller open appointment times and book the one they choose, before the call ends. New in schema_version 2. The bookable grid is described here (weekly schedule + timezone + how long an appointment is); which times are actually free comes from the connected calendar at call time, and the engine never sees a credential. Exits: booked, no_slots, no_input, unavailable. Three fields carry more meaning than their types show, and are described here because a `$ref` with a sibling description makes the type generators emit a duplicate type instead of reusing the named one. `prompt` is spoken once before the open times are offered (\"I can book you in — here are the next available times\"); the times themselves are never part of it, since they are not known until the call. `confirm_prompt` is spoken immediately after a successful booking and directly BEFORE the booked time (\"You're booked for\" → \"Tuesday\" → \"ten thirty a.m.\"); it deliberately takes no placeholder, because a prompt is frozen audio by the time a call runs and nothing can be interpolated into the middle of it — anything that should follow the time belongs on the booked exit. `schedule` is when this business takes appointments, the `hours` node's weekly shape reused verbatim; it is not the same question `hours` answers, because a business can answer the phone at times it will not book.",
      "type": "object",
      "required": [
        "kind",
        "prompt",
        "confirm_prompt",
        "schedule",
        "timezone",
        "duration_mins"
      ],
      "properties": {
        "kind": {
          "const": "book"
        },
        "prompt": {
          "$ref": "#/$defs/Prompt"
        },
        "confirm_prompt": {
          "$ref": "#/$defs/Prompt"
        },
        "schedule": {
          "$ref": "#/$defs/WeeklySchedule"
        },
        "timezone": {
          "description": "IANA zone (America/New_York) the schedule is written in. Validated to resolve at load.",
          "type": "string"
        },
        "exceptions": {
          "description": "Single-date overrides of the weekly schedule (holidays, one-off clinics), as on `hours`.",
          "type": "array",
          "items": {
            "$ref": "#/$defs/HoursException"
          }
        },
        "duration_mins": {
          "description": "How long one appointment runs. Bounds are the validator's (see each language's validate module), not this schema's.",
          "type": "integer",
          "minimum": 0
        },
        "buffer_mins": {
          "description": "Clear time kept on BOTH sides of an appointment, so a slot is not offered flush against a busy interval.",
          "type": "integer",
          "minimum": 0,
          "default": 0
        },
        "lead_mins": {
          "description": "Nothing sooner than this many minutes from now is offered — the caller cannot book the next five minutes.",
          "type": "integer",
          "minimum": 0,
          "default": 120
        },
        "horizon_days": {
          "description": "How far ahead to look for open times.",
          "type": "integer",
          "minimum": 0,
          "default": 14
        },
        "max_offers": {
          "description": "How many times to offer the caller. Each offered time gets one keypad digit, counting from 1.",
          "type": "integer",
          "minimum": 0,
          "default": 3
        },
        "retries": {
          "description": "Extra attempts to collect a keypress after the first, as on `menu`.",
          "type": "integer",
          "minimum": 0,
          "default": 1
        },
        "timeout_secs": {
          "description": "How long to wait for a keypress on each attempt, as on `menu`.",
          "type": "integer",
          "minimum": 0,
          "default": 5
        },
        "exits": {
          "$ref": "#/$defs/Exits"
        }
      }
    }
  }
} as const;

/** Newest supported version's schema. */
export default flowV2Schema;
