/** Plugin-owned visibility attribute; the injected stylesheet hides rows carrying it. */
export const AUTO_FOLD_HIDDEN_ATTR = 'data-auto-fold-hidden'

/**
 * Escape a Node key for a `[data-chat-anchor-key=<value>]` selector:
 * CSS.escape when available, else a quoted-attribute fallback that only
 * needs to escape `"` and `\`.
 */
export function escapeSelector(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return `"${value.replace(/["\\]/g, ch => `\\${ch}`)}"`
}

/** ScrollTop delta keeping the summary row's viewport top stable. */
export function scrollDeltaFor(beforeTop: number, afterTop: number): number {
  return beforeTop - afterTop
}

/** Located rows of one fold operation; null anywhere means fail-open. */
export interface FoldRowTargets {
  readonly summaryRow: HTMLElement
  readonly processRows: readonly HTMLElement[]
  readonly scrollContainer: HTMLElement | null
}

export interface DomAdapterDeps {
  /** Query root (document in production; a scoped container in tests). */
  readonly root: ParentNode
  /** Geometry reader, injectable for deterministic tests. */
  readonly measureTop?: (element: HTMLElement) => number
}

/**
 * The only module that touches DSH chat DOM. Resolves every row by the
 * authoritative Node key first, then hides/shows atomically via the
 * plugin-owned attribute; restores only what this instance marked.
 */
export class TurnDomAdapter {
  private readonly hidden = new Set<HTMLElement>()
  private readonly root: ParentNode
  private readonly measureTop: (element: HTMLElement) => number

  constructor(deps: DomAdapterDeps) {
    this.root = deps.root
    this.measureTop = deps.measureTop ?? ((element) => element.getBoundingClientRect().top)
  }

  /**
   * Locate the summary row and every process row by exact key. Returns
   * null (fail-open) when the summary row is absent, its flow-kind marker
   * drifted, or any process row is missing — callers then hide nothing.
   */
  resolve(summaryKey: string, processKeys: readonly string[]): FoldRowTargets | null {
    const summaryRow = this.root.querySelector<HTMLElement>(
      `[data-chat-anchor-key=${escapeSelector(summaryKey)}]`)
    if (summaryRow === null || summaryRow.dataset.chatFlowKind !== 'auto-fold-summary') return null
    const scrollContainer = summaryRow.closest('[data-conversation-scroll]') as HTMLElement | null
    const processRows: HTMLElement[] = []
    for (const key of processKeys) {
      const row = this.root.querySelector<HTMLElement>(
        `[data-chat-anchor-key=${escapeSelector(key)}]`)
      if (row === null) return null
      processRows.push(row)
    }
    return { summaryRow, processRows, scrollContainer }
  }

  /**
   * Apply the visibility state to the resolved targets and compensate the
   * summary row's viewport top through the scroll container. No-op when
   * targets are null. Returns the measured before/after tops.
   */
  apply(targets: FoldRowTargets | null, hidden: boolean): { beforeTop: number; afterTop: number } | null {
    if (targets === null) return null
    const beforeTop = this.measureTop(targets.summaryRow)
    for (const row of targets.processRows) {
      if (hidden) {
        row.setAttribute(AUTO_FOLD_HIDDEN_ATTR, '')
        this.hidden.add(row)
      } else {
        row.removeAttribute(AUTO_FOLD_HIDDEN_ATTR)
        this.hidden.delete(row)
      }
    }
    const afterTop = this.measureTop(targets.summaryRow)
    if (targets.scrollContainer !== null) {
      targets.scrollContainer.scrollTop += scrollDeltaFor(beforeTop, afterTop)
    }
    return { beforeTop, afterTop }
  }

  /** Restore every row this instance marked (plugin-owned attribute only). */
  restore(): void {
    for (const row of this.hidden) row.removeAttribute(AUTO_FOLD_HIDDEN_ATTR)
    this.hidden.clear()
  }
}
