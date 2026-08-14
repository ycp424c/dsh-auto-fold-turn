import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatSnapshot, ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TurnDomAdapter } from './dom-adapter.ts'
import { FoldStateStore, foldStateStore } from './fold-state-store.ts'
import { resolveFoldTarget } from './fold-target-resolver.ts'
import { AUTO_FOLD_BUTTON_CLASS } from './styles.ts'

/** Narrow props: the dispatcher supplies the full keyed-slot share; tests
 *  supply exactly these plus `foldState`/`root` seams. */
export interface FoldSummaryRowProps {
  readonly node: ChatNode<'auto-fold-summary'>
  readonly sessionId: string
  readonly useSession: (selector: (snapshot: ConversationSnapshot) => unknown) => unknown
  /** Test seam; defaults to the module-level singleton store. */
  readonly foldState?: FoldStateStore
  /** Test seam; defaults to document. */
  readonly root?: ParentNode
}

/**
 * Renderer of the `auto-fold-summary` node: computes the fold target from
 * the Chat snapshot, applies the visibility through TurnDomAdapter inside
 * a layout effect (no flash on history loads), and toggles the persisted
 * expanded state on click.
 */
export function FoldSummaryRow({ node, sessionId, useSession, foldState, root }: FoldSummaryRowProps) {
  const store = foldState ?? foldStateStore
  const chat = useSession(snapshot => snapshot.chat) as ChatSnapshot
  const target = useMemo(() => resolveFoldTarget(chat, node), [chat, node])
  const [expanded, setExpanded] = useState(() =>
    target === null ? false : store.isExpanded(sessionId, target.turn))
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  // Streaming emits a fresh ChatSnapshot per event, which would re-resolve
  // `target` into a new object on every event. The layout effect therefore
  // depends on a STABLE fold-set signature string (turn + final key + ordered
  // process keys) instead of the target object: when nothing in this turn's
  // fold set changed, the effect does not re-run at all, so no restore /
  // re-apply / scroll compensation churn happens for already-loaded turns.
  const targetRef = useRef(target)
  targetRef.current = target
  // JSON-encoded fold identity: unambiguous even though node keys may contain
  // `:` and `,` (a naive join could collide across different fold sets).
  // Premise: React keeps same-key seats mounted, and DSH does not virtualize
  // chat rows, so an unchanged signature implies the same DOM rows — a row
  // unloaded and re-mounted with the same key would otherwise miss its
  // hidden attribute until the signature or expanded state changes.
  const signature = target === null
    ? null
    : JSON.stringify([target.turn, target.finalKey, target.processKeys])

  useLayoutEffect(() => {
    const current = targetRef.current
    if (current === null || current.processKeys.length === 0) return
    const button = buttonRef.current
    if (button === null) return
    const adapter = new TurnDomAdapter({ root: root ?? document })
    const targets = adapter.resolve(node.key, current.processKeys)
    adapter.apply(targets, !expanded)
    return () => {
      adapter.restore()
    }
  }, [signature, expanded, sessionId, node.key, root])

  if (target === null || target.processKeys.length === 0) return null

  const toggle = (): void => {
    const next = !expanded
    setExpanded(next)
    store.setExpanded(sessionId, target.turn, next)
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      className={AUTO_FOLD_BUTTON_CLASS}
      data-auto-fold-summary=""
      aria-expanded={expanded}
      onClick={toggle}
    >
      {expanded ? `▼ 收起过程 · ${target.count} 项` : `▶ 过程 · ${target.count} 项`}
    </button>
  )
}
