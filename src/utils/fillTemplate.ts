/**
 * THE ONE way a translated sentence gets its `{placeholders}` filled.
 *
 * Why it exists: notices used to fill a template with successive
 * first-occurrence `.replace('{name}', …).replace('{limit}', …)` calls, `{name}`
 * first. A file name is chosen by whoever made the file (braces are legal on
 * every OS, and a shared `.zip` can carry any name), so a zip called
 * `{limit}.zip` swallowed the later placeholder: the `{limit}` INSIDE the
 * inserted name was filled instead of the real one, and the sentence printed
 * "“96.zip” unpacks to more than {limit} MB". Measured in the browser, in both
 * languages.
 *
 * So this is a SINGLE PASS over the template: every `{key}` is matched in the
 * template text and replaced once, and nothing inserted is ever scanned again.
 * Values are inserted VERBATIM (the replacer is a function, so a `$&`, `$1` or
 * `$'` in a file name is text, not a replacement pattern). A key the template
 * uses more than once is filled everywhere; a key with no value is left
 * literal, so a missing value shows up as `{key}` rather than vanishing.
 *
 * Lookups are own-property only — the keys come from a template that is plain
 * text, and a bare `values[key]` would resolve `{constructor}` or `{toString}`
 * through Object.prototype to a FUNCTION. A leaf module (no imports) so
 * previewMesh.ts, which must not take an i18n value import, can use it too.
 */
export type TemplateValues = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

export function fillTemplate(template: string, values: TemplateValues): string {
  return template.replace(PLACEHOLDER, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}
