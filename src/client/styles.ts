/** Class applied to the summary button. */
export const AUTO_FOLD_BUTTON_CLASS = 'dsh-auto-fold-summary'

/**
 * Plugin-owned stylesheet (injected by the client entry). Hides only rows
 * carrying the plugin-owned attribute and styles the button through DSH
 * theme tokens with local fallbacks — never overrides DSH class or inline
 * styles.
 */
export const AUTO_FOLD_STYLE = `
.dsh-auto-fold-summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  margin: 0 0 0 -6px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #667085);
  font: inherit;
  font-size: 13px;
  line-height: 22px;
  cursor: pointer;
}
.dsh-auto-fold-summary:hover,
.dsh-auto-fold-summary:focus-visible {
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.08));
  border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  color: var(--dsw-alias-label-primary, #1d2939);
}
.dsh-auto-fold-summary:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4176e6);
  outline-offset: 1px;
}
[data-auto-fold-hidden] {
  display: none !important;
}
`
