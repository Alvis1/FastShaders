import { lazy, type ComponentType } from 'react';

/**
 * `React.lazy` whose failed fetch (a dropped connection, or a redeploy swapping
 * the hashed assets mid-session) renders `Fallback` instead of rejecting: the
 * app has no error boundary, so a rejected lazy import unmounts all of it.
 *
 * The factory is annotated with the component TYPE rather than inferred —
 * otherwise TS pins the lazy type to the real module's exact return
 * (`ReactPortal | null` for a portal) and a plain-`div` fallback stops being
 * assignable.
 */
export function lazyOr<P = {}>(load: () => Promise<ComponentType<P>>, Fallback: ComponentType<P>) {
  return lazy(async (): Promise<{ default: ComponentType<P> }> => {
    try {
      return { default: await load() };
    } catch {
      return { default: Fallback };
    }
  });
}
