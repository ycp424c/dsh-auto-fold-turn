import type {
  ConversationNodeContext, ConversationNodeDefinition, TurnLocation,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { TurnTailChatData } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { FoldSummaryChatData } from './contract.ts'

/**
 * Plugin-private sort offset: the summary anchors strictly before the
 * closing assistant but after every integer-seq process node of the turn.
 * Compatibility boundary — NOT a public API; the dedicated ordering tests
 * pin it. Native fractional neighbors (maxTokensNotice +0.05, turn-tail
 * finalizedFollowup +0.1, interruptedAssistant -0.9) never fall inside
 * (closingSeq - 0.05, closingSeq).
 */
export const AUTO_FOLD_SUMMARY_ANCHOR_OFFSET = -0.05

/** The Definition/renderer kind of this plugin's summary row. */
export const AUTO_FOLD_SUMMARY_KIND = 'auto-fold-summary'

interface FoldSummaryState {
  readonly turn: number
}

/** Resolve the engine-owned Turn for this Context (works across window gaps). */
function turnLocation(context: ConversationNodeContext<FoldSummaryState>): TurnLocation | undefined {
  const location = context.start?.location ?? context.matches[0]?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn : undefined
}

/** Read the closing assistant's finalNode seq from the engine-owned turn-tail data. */
function closingSeq(context: ConversationNodeContext<FoldSummaryState>): number | undefined {
  const turn = turnLocation(context)
  const tail = turn?.data.get('turn-tail') as TurnTailChatData | undefined
  return tail?.closing?.finalNode?.seq
}

/**
 * Completed-turn summary Definition: matches every `turn/start`/`turn/end`,
 * publishes one keyed Node per turn with immediate cadence, and stays
 * silent (returns null) when the turn has no closing assistant.
 */
export const foldSummaryDefinition: ConversationNodeDefinition<FoldSummaryState> = {
  kind: AUTO_FOLD_SUMMARY_KIND,
  target: 'chat',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'turn/end') return { id: String(event.data.turn), role: 'update' }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('auto-fold-summary start requires turn/start')
    return { turn: match.event.data.turn }
  },
  update: context => context.state,
  publication: () => 'immediate',
  buildViewNode: (context) => {
    const location = context.start?.location ?? context.matches[0]?.location
    if (location?.kind !== 'turn' && location?.kind !== 'step') return null
    const seq = closingSeq(context)
    if (seq === undefined) return null
    const data: FoldSummaryChatData = { turn: location.turn.turn, closingSeq: seq }
    return {
      key: context.key,
      kind: AUTO_FOLD_SUMMARY_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: seq + AUTO_FOLD_SUMMARY_ANCHOR_OFFSET,
      location,
      visibility: 'visible',
      data,
    }
  },
}
