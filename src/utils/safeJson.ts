/**
 * JSON.parse reviver that drops dangerous structural keys.
 *
 * Without this a payload like `{"__proto__":{"polluted":1}}` ends up as a
 * literal own key on the parsed object — harmless in isolation under modern
 * V8, but the result then flows through `structuredClone`, spreads, and
 * `getNodeValues(node).<dynamic-key>` lookups across the engine. Stripping
 * `__proto__` / `constructor` / `prototype` at parse time means a tampered
 * localStorage value or a shared `.fastshader` file can't smuggle these
 * keys into the running app at all.
 *
 * ONE copy on purpose. This is a security control, and it used to live verbatim
 * in THREE places — `store/useAppStore.ts` (the `fs:graph` and `fs:savedGroups`
 * loaders), `engine/fastShadersProject.ts` (the shared-`.js` project block) and
 * `components/Preview/ShaderPreview.tsx` (the `fs:previewCameraPos` /
 * `fs:previewRotation` / `fs:previewUniformBounds` / `fs:previewUniformValues`
 * loaders, every one of which `projectImport` writes straight out of an
 * imported file). Three trust boundaries, one rule, maintained three times.
 * Any future key added to the deny-list must land here and nowhere else —
 * `safeJson.test.ts` walks src/ and fails on a fourth declaration.
 *
 * Deliberately dependency-free so every trust boundary can import it without
 * pulling a module graph along (and without risking an import cycle through
 * the store).
 */
export function safeJsonReviver(key: string, value: unknown): unknown {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return value;
}
