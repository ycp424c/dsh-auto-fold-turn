import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Renderer payload of the auto-fold summary node: the turn number and the
 * closing assistant's durable finalNode seq. `closingSeq` is the resolver's
 * authoritative final-reply identity and the anchor basis (summary anchors
 * strictly before it).
 */
export interface FoldSummaryChatData {
  readonly turn: number
  readonly closingSeq: number
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Completed-turn process fold summary, anchored before the closing assistant. */
    'auto-fold-summary': FoldSummaryChatData
  }
}

/** The auto-fold summary Chat view node. */
export type FoldSummaryChatNode = ChatConversationViewNode & {
  readonly kind: 'auto-fold-summary'
  readonly data: FoldSummaryChatData
}
