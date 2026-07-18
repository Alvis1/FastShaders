import { useAppStore } from '@/store/useAppStore';
import type { Language } from './index';

/** Subscribe to the active UI language from the store. */
export function useLanguage(): Language {
  return useAppStore((s) => s.language);
}
