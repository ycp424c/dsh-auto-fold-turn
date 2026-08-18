import type { ChatSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { AssistantChatData, ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { FoldSummaryChatData } from './contract.ts'

/** Result of folding one completed turn: the process set + final reply identity. */
export interface FoldTarget {
  readonly turn: number
  readonly summaryKey: string
  readonly finalKey: string
  readonly processKeys: readonly string[]
  readonly count: number
}

/** Kinds never folded even when they sort before the summary anchor. */
const PROTECTED_KINDS = new Set(['user', 'steering', 'turn-tail'])

/**
 * Compute the fold target of one turn from the Chat snapshot and the
 * summary Node. Pure: scans only the owning Turn's keys intersected with
 * the currently visible `chat.order`. Returns null when the final reply
 * cannot be uniquely resolved (fail-open).
 */
export function resolveFoldTarget(
  chat: ChatSnapshot,
  summary: ChatNode<'auto-fold-summary'>,
): FoldTarget | null {
  // The authoritative summary node comes from the snapshot itself (the
  // caller's handle may only carry `key`); fail-open when it is missing.
  const summaryNode = chat.nodes.get(summary.key)
  if (summaryNode === undefined || summaryNode.kind !== 'auto-fold-summary') return null
  const data = summaryNode.data as FoldSummaryChatData
  const turnKeys = chat.locations.getTurn(data.turn)
  // Only currently visible nodes participate; DSH-hidden nodes are skipped.
  // Defensive: the engine's getTurn already returns only visible keys, so
  // this intersection is belt-and-braces against snapshot/location drift.
  const visibleKeys = turnKeys.filter(key => chat.order.includes(key))
  const finalCandidates = visibleKeys.filter((key) => {
    const node = chat.nodes.get(key)
    return node?.kind === 'assistant-step'
      && (node.data as AssistantChatData).finalNode?.seq === data.closingSeq
  })
  if (finalCandidates.length !== 1) return null
  const finalKey = finalCandidates[0]!
  const finalNode = chat.nodes.get(finalKey)!
  // The folded set is everything strictly before the final reply. The
  // summary row now anchors at the top of the turn, so it can no longer
  // serve as the folding boundary; the final reply's own anchor is the
  // stable line between process nodes and result states.
  const finalAnchor = finalNode.anchorSeq
  const processKeys: string[] = []
  for (const key of visibleKeys) {
    if (key === summary.key || key === finalKey) continue
    const node = chat.nodes.get(key)
    if (node === undefined) continue
    if (PROTECTED_KINDS.has(node.kind)) continue
    // Only nodes sorted strictly before the final reply belong to the
    // folded set; anything at or after it (terminal error/max-token
    // notices, late tool evidence) is a result state and stays visible.
    if (node.anchorSeq >= finalAnchor) continue
    processKeys.push(key)
  }
  return { turn: data.turn, summaryKey: summary.key, finalKey, processKeys, count: processKeys.length }
}
