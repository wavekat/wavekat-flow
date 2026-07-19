// The one-call gate: parse + decode + validate. This is what the API's
// publish endpoint and the web editor's live checking both run, so
// "valid in the editor" and "publishable" can never disagree.

import type { Flow } from './model.js';
import { requiredAssets } from './model.js';
import type { Issue } from './issues.js';
import { hasErrors } from './issues.js';
import { parseFlow } from './parse.js';
import { validateFlow } from './validate.js';

export type FlowCheck = {
  /** The decoded document; present whenever the YAML parses, even when
   * semantic validation failed — so a graph view can show the broken
   * shape. `null` on a parse/decode error. */
  flow: Flow | null;
  /** Every problem found, parse and validation alike. */
  issues: Issue[];
  /** No error-severity issues — safe to publish. */
  valid: boolean;
  /** Audio asset refs the document's prompts reference. */
  requiredAssets: string[];
  /** Source range of each node's definition, for editor highlighting. */
  nodeRanges: Record<string, [number, number]>;
};

export function checkFlow(source: string): FlowCheck {
  const parsed = parseFlow(source);
  const issues = [...parsed.issues];
  if (parsed.flow) issues.push(...validateFlow(parsed.flow, parsed.nodeRanges));
  return {
    flow: parsed.flow,
    issues,
    valid: !hasErrors(issues),
    requiredAssets: parsed.flow ? requiredAssets(parsed.flow) : [],
    nodeRanges: parsed.nodeRanges,
  };
}
