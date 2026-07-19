/**
 * One thing wrong (or worth flagging) in a flow document. Carries a
 * stable `code` so UIs can localize, an English `message` mirroring the
 * daemon engine's wording, the flow `node` when the problem is
 * node-scoped, and a source `range` (char offsets) when the parser
 * could point at the offending text.
 */
export type Issue = {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  node?: string;
  range?: [number, number];
  params?: Record<string, string | number | string[]>;
};

export function hasErrors(issues: Issue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

/**
 * Issue code for an `audio:` prompt whose generated clip no longer resolves
 * against the author's voice-prompt library. Emitted by the API — not the pure
 * validator, which has no DB access — as a node-scoped warning on a draft and
 * as a blocking error at publish (docs/16 §4). Exported so both stacks share
 * one stable code string.
 */
export const MISSING_ASSET = 'missing_asset';
