/**
 * The Claude models the cloud route offers — a leaf, so the dialog and the
 * preferences can name them without loading the SDK (providers/claude.ts).
 * Exact ids, never date-suffixed. Claude Opus 5.5 is the default.
 */
export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];
export const DEFAULT_CLAUDE_MODEL: ClaudeModel = 'claude-opus-5-5';

export const CLAUDE_MODEL_LABELS: Record<ClaudeModel, string> = {
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
};

export const isClaudeModel = (v: unknown): v is ClaudeModel =>
  typeof v === 'string' && (CLAUDE_MODELS as readonly string[]).includes(v);
