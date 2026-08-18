import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Renderer payload of the auto-fold summary node: the turn number and the
 * closing assistant's durable finalNode seq. `closingSeq` is the resolver's
 * authoritative final-reply identity; the node's anchor sits at the top of
 * the agent answer — after the user prompt, before every process row (the
 * folding boundary is the final reply itself, not the summary).
 */
export interface FoldSummaryChatData {
  readonly turn: number
  readonly closingSeq: number
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Completed-turn process fold summary, anchored at the top of the agent answer. */
    'auto-fold-summary': FoldSummaryChatData
  }
}

/** The auto-fold summary Chat view node. */
export type FoldSummaryChatNode = ChatConversationViewNode & {
  readonly kind: 'auto-fold-summary'
  readonly data: FoldSummaryChatData
}
