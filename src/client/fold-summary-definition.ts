import type {
  ConversationNodeContext, ConversationNodeDefinition, TurnLocation,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { TurnTailChatData } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { FoldSummaryChatData } from './contract.ts'

/**
 * Plugin-private sort offset: the summary anchors strictly before the
 * turn's first agent-content event, so the button sits at the top of the
 * agent answer — after the user prompt, before every process row. In the
 * real event stream `step/start` can precede `user/message` (the
 * agent/inbox/spliced mechanism emits the user message after the step
 * starts), so a step-based anchor would land the button above the user
 * prompt. Agent-content events (`assistant/chunk`, `assistant/message`,
 * `tool/call`, `llm/retry`) always carry a `turn` field and always sort
 * after the user message, making the earliest one a reliable "top of the
 * agent answer" anchor. Compatibility boundary — NOT a public API; the
 * dedicated ordering tests pin it.
 */
export const AUTO_FOLD_SUMMARY_ANCHOR_OFFSET = -0.05

/** The Definition/renderer kind of this plugin's summary row. */
export const AUTO_FOLD_SUMMARY_KIND = 'auto-fold-summary'

/**
 * Event types that produce the turn's visible agent-content rows
 * (process nodes). Each carries a `turn` field, letting the Definition
 * group them into the owning turn's Context without an explicit turn
 * lookup. The earliest one's seq is the "top of the agent answer" anchor:
 * it always sorts after the user message (the user acts before the agent
 * responds) and strictly before every visible process row of the turn.
 */
const AGENT_CONTENT_EVENTS = new Set([
  'assistant/chunk',
  'assistant/message',
  'tool/call',
  'llm/retry',
])

/** Narrow shape for the turn coordinate carried by agent-content events. */
function eventTurn(event: { readonly type: string; readonly data: unknown }): number | undefined {
  const turn = (event.data as { readonly turn?: unknown } | undefined)?.turn
  return typeof turn === 'number' ? turn : undefined
}

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
 * Read the earliest agent-content event seq of this turn from the Context
 * matches. Matches arrive in ascending seq order, so the first
 * agent-content match is the turn's first visible process event. This is
 * the reliable "top of the agent answer": it provably sorts after the
 * user message and strictly before every visible process node. Returns
 * undefined when no agent-content event has arrived yet (window gap).
 */
function firstAgentContentSeq(context: ConversationNodeContext<FoldSummaryState>): number | undefined {
  for (const match of context.matches) {
    if (AGENT_CONTENT_EVENTS.has(match.event.type)) return match.event.seq
  }
  return undefined
}

/**
 * Completed-turn summary Definition: matches `turn/start`/`turn/end` plus
 * the turn's agent-content events, publishes one keyed Node per turn with
 * immediate cadence, and stays silent (returns null) when the turn has no
 * closing assistant.
 */
export const foldSummaryDefinition: ConversationNodeDefinition<FoldSummaryState> = {
  kind: AUTO_FOLD_SUMMARY_KIND,
  target: 'chat',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'turn/end') return { id: String(event.data.turn), role: 'update' }
    if (AGENT_CONTENT_EVENTS.has(event.type)) {
      const turn = eventTurn(event)
      return turn === undefined ? null : { id: String(turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('auto-fold-summary start requires turn/start')
    return { turn: match.event.data.turn }
  },
  update: context => context.state,
  // Only the turn boundaries trigger materialization; agent-content
  // updates stay in the Context (cheap matches) and never re-publish the
  // row during streaming.
  publication: (match) => (match.event.type === 'turn/start' || match.event.type === 'turn/end' ? 'immediate' : 'none'),
  buildViewNode: (context) => {
    const location = context.start?.location ?? context.matches[0]?.location
    if (location?.kind !== 'turn' && location?.kind !== 'step') return null
    const seq = closingSeq(context)
    if (seq === undefined) return null
    const data: FoldSummaryChatData = { turn: location.turn.turn, closingSeq: seq }
    // Anchor strictly before the turn's first agent-content event: the
    // button sits at the top of the agent answer, after the user prompt
    // and before every process row. Falls back to strictly before the
    // closing assistant when the window gap hides every agent-content
    // event (the summary still sorts after the user message there).
    const anchor = (firstAgentContentSeq(context) ?? seq) + AUTO_FOLD_SUMMARY_ANCHOR_OFFSET
    return {
      key: context.key,
      kind: AUTO_FOLD_SUMMARY_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: anchor,
      location,
      visibility: 'visible',
      data,
    }
  },
}
