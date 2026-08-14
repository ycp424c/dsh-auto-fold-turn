/**
 * @ycp424c/dsh-auto-fold-turn — external DSH plugin, host half.
 * The host owns package loading and client bundle exposure only; all
 * folding behavior lives in the browser half (src/client). The web
 * profile's cordis patch row mounts this package so its `./client` bundle
 * joins the browser roster.
 */

/** Cordis plugin id used in loader diagnostics. */
export const name = '@ycp424c/dsh-auto-fold-turn'

/** No host behavior: nothing to inject or configure. */
export function apply(): void {}
