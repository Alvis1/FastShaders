/**
 * One generation: up to three rounds of prompt → model → gate, each repair
 * round a FRESH prompt carrying the request, the rejected program and its
 * problem lines (prompt.ts says why stateless). Nothing here touches the store:
 * a result is committed only by the dialog's Add (place.ts).
 *
 * Refuses outright in a study session — the feature is absent there, and this
 * is the last of its gates (docs/dev/node-generator.md).
 */
import type { Catalogue } from './catalogue';
import { selectExamples, type Example } from './examples';
import { gateText, type GateResult } from './gate';
import { buildPrompt, buildRepairUser, CONTEXT_BUDGETS } from './prompt';
import type { GenerateFailure, GenerateResult, GenerateUsage, GeneratorProvider } from './providerTypes';

export const MAX_ROUNDS = 3;

export type RunStatus =
  | { round: number; phase: 'connecting' | 'loading' | 'checking' }
  | { round: number; phase: 'thinking' | 'writing'; chars: number };

export type GateOk = Extract<GateResult, { ok: true }>;

export type RunResult =
  | { ok: true; result: GateOk; rounds: number; usage: GenerateUsage[] }
  | { ok: false; kind: 'provider'; failure: GenerateFailure; detail?: string; rounds: number }
  | { ok: false; kind: 'rejected'; problems: string[]; lastCode: string | null; rounds: number }
  | { ok: false; kind: 'study' };

export interface RunOptions {
  provider: GeneratorProvider;
  /** The typed request; may be empty when `picture` is given. */
  request: string;
  /** An added picture, as the app measured it (imageAnalysis.ts): the lines
   *  the request carries, and the words that pick examples when it has none.
   *  `seen` is set only for a model that SEES, on a server on this computer:
   *  the picture itself (picture.ts `seeUrl`) and the block that goes with it
   *  (`pictureSeenLines`). A model that refuses the picture gets `lines`. */
  picture?: {
    lines: readonly string[];
    hintWords: string;
    seen?: { lines: readonly string[]; image: string };
  };
  /** The model was sent the picture and could not take it; the run went on
   *  with the measurements. Called at most once. */
  onPictureRefused?: () => void;
  catalogue: Catalogue;
  corpus: readonly Example[];
  /** Uniform names already in use (live graph + stored tuned values). */
  takenNames: ReadonlySet<string>;
  signal: AbortSignal;
  /** True in a study session; checked before anything is sent. */
  inStudy: () => boolean;
  onStatus?: (s: RunStatus) => void;
  maxRounds?: number;
}

/**
 * The two calls that must never take the dialog down with them: a provider
 * breaking its never-throw contract, or the gate meeting a reply that trips a
 * bug in the parser underneath it. There is no error boundary in this app, and
 * a rejected run would leave the dialog "running" forever — so both become
 * ordinary outcomes.
 */
async function safeGenerate(provider: GeneratorProvider, req: Parameters<GeneratorProvider['generate']>[0]): Promise<GenerateResult> {
  try {
    return await provider.generate(req);
  } catch (e) {
    return req.signal.aborted
      ? { ok: false, failure: 'cancelled' }
      : { ok: false, failure: 'bad-response', detail: e instanceof Error ? e.message : String(e) };
  }
}

function safeGate(text: string, catalogue: Catalogue, takenNames: ReadonlySet<string>): GateResult {
  try {
    return gateText(text, { catalogue, takenNames });
  } catch (e) {
    return { ok: false, problems: [`the program could not be checked (${e instanceof Error ? e.message.slice(0, 120) : 'error'}) — write it more plainly`], code: null };
  }
}

export async function runGeneration(o: RunOptions): Promise<RunResult> {
  if (o.inStudy()) return { ok: false, kind: 'study' };
  const budget = CONTEXT_BUDGETS[o.provider.contextClass];
  // The picture travels only while the model takes it; after a refusal the
  // run is the measured one, as if the picture had never been attached.
  let seen = o.picture?.seen ?? null;
  let picture = seen?.lines ?? o.picture?.lines ?? [];
  // With no words, the picture's pattern picks the worked examples.
  const examples = selectExamples(o.request.trim() ? o.request : o.picture?.hintWords ?? '', o.corpus, budget.examples);
  let prompt = buildPrompt(o.request, o.catalogue, examples, o.provider.contextClass, picture);
  const usage: GenerateUsage[] = [];
  const rounds = Math.max(1, Math.min(o.maxRounds ?? MAX_ROUNDS, MAX_ROUNDS));
  let user = prompt.user;
  let last: Extract<GateResult, { ok: false }> | null = null;

  for (let round = 1; round <= rounds; round++) {
    if (o.signal.aborted) return { ok: false, kind: 'provider', failure: 'cancelled', rounds: round - 1 };
    o.onStatus?.({ round, phase: 'connecting' });
    const reply: GenerateResult = await safeGenerate(o.provider, {
      system: prompt.system,
      user,
      ...(seen ? { image: seen.image } : {}),
      maxOutputTokens: budget.output,
      signal: o.signal,
      onProgress: (p) => o.onStatus?.(p.phase === 'thinking' || p.phase === 'writing'
        ? { round, phase: p.phase, chars: p.chars }
        : { round, phase: p.phase }),
    });
    if (!reply.ok && reply.failure === 'no-vision' && seen) {
      // The same round again, blind: the measured block, and the program a
      // repair round was quoting stays quoted.
      seen = null;
      picture = o.picture?.lines ?? [];
      prompt = buildPrompt(o.request, o.catalogue, examples, o.provider.contextClass, picture);
      user = last ? buildRepairUser(o.request, last.code, last.problems, picture) : prompt.user;
      o.onPictureRefused?.();
      round--;
      continue;
    }
    if (!reply.ok) return { ok: false, kind: 'provider', failure: reply.failure, detail: reply.detail, rounds: round };
    if (reply.usage) usage.push(reply.usage);
    if (o.signal.aborted) return { ok: false, kind: 'provider', failure: 'cancelled', rounds: round };
    o.onStatus?.({ round, phase: 'checking' });
    const gated = safeGate(reply.text, o.catalogue, o.takenNames);
    if (gated.ok) return { ok: true, result: gated, rounds: round, usage };
    last = gated;
    user = buildRepairUser(o.request, gated.code, gated.problems, picture);
  }
  return { ok: false, kind: 'rejected', problems: last?.problems ?? [], lastCode: last?.code ?? null, rounds };
}
