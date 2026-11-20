/**
 * Is "Generate nodes from text" offered right now? The ONE question both
 * search boxes ask before they detect a request or draw an AI entry
 * (docs/dev/node-generator.md § The search-box entry): a build that can reach
 * a model, the switch not off, and never a study session, the embed or a
 * running lesson. The launcher and the Settings row ask the same of the leaf
 * (utils/generatorFlag.ts); the dialog's own run and Add refuse in a study again.
 */
import { useAppStore } from '@/store/useAppStore';
import { isEvalMode } from '@/eval/evalArm';
import { isEmbedMode } from '@/embed/embedMode';
import { generatorBuild, generatorOffered } from '@/utils/generatorFlag';

export function useGeneratorOffer(): boolean {
  const mode = useAppStore((s) => s.nodeGenerator);
  const inLesson = useAppStore((s) => s.tutorial != null);
  if (inLesson || isEmbedMode()) return false;
  return generatorOffered(mode, isEvalMode(), generatorBuild(__FS_DESKTOP__, __FS_LLM_CLOUD__));
}
