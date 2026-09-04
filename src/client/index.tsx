/**
 * dsh-auto-fold-turn client plugin, browser half. Registers the
 * `auto-fold-summary` Conversation Node Definition, its keyed Chat renderer,
 * and the plugin-owned stylesheet. The entry only assembles; every folding
 * decision lives in the Definition / Resolver / Store / Adapter modules.
 * All registrations ride cordis effects, so fiber disposal removes them.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationEventRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { foldSummaryDefinition } from './fold-summary-definition.ts'
import { FoldSummaryRow } from './summary-row.tsx'
import { AUTO_FOLD_STYLE } from './styles.ts'

/**
 * Client context with the conversation registry. dsh ≤ 0.1.1 exposes it as
 * the `conversationEvents` service; dsh ≥ 0.1.2-rc.1 moved it to
 * `uiConversation.events` (UiConversation service). Both shapes carry the
 * same `register`/`entries` surface.
 */
type FoldClientContext = ClientContext & {
  conversationEvents?: ConversationEventRegistry
  uiConversation?: { events: ConversationEventRegistry }
}

/** Services required by the client plugin. */
export const inject = ['slots', 'uiConversation']

/** Mounts the auto-fold client plugin.
 * @param ctx - Client root context.
 */
export function apply(ctx: FoldClientContext): void {
  const events = ctx.uiConversation?.events ?? ctx.conversationEvents
  if (!events) throw new Error('dsh-auto-fold-turn: neither uiConversation nor conversationEvents service is available')
  events.register(foldSummaryDefinition)

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'auto-fold-summary',
  }, FoldSummaryRow))

  // Plugin-owned stylesheet: hidden-row rule + summary button chrome. The
  // effect teardown removes the tag with the fiber.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-auto-fold-style', '')
    style.textContent = AUTO_FOLD_STYLE
    document.head.appendChild(style)
    return () => {
      style.remove()
    }
  }, 'dsh-auto-fold-turn: stylesheet')
}
