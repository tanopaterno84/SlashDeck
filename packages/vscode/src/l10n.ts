/**
 * Localisation seam. The modules that build the view, the tooltips and the search items do
 * not import `vscode` (so that vitest can run them): they receive a `Translate` function,
 * which is `vscode.l10n.t` in the extension and `format` in the tests.
 *
 * Every user-visible string is written as `t('English text', ...args)` with a literal first
 * argument: test/l10n.test.ts checks that each of them has an Italian translation in
 * l10n/bundle.l10n.it.json.
 */
export type Translate = (message: string, ...args: (string | number | boolean)[]) => string;

/** Replaces `{0}`, `{1}`... with the arguments, like `vscode.l10n.t` without a bundle. */
export const format: Translate = (message, ...args) =>
  message.replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? match : String(value);
  });
