/**
 * dsh-auto-fold-turn client plugin, browser half. Registers the
 * `auto-fold-summary` Conversation Node Definition, its keyed Chat renderer,
 * and the plugin-owned stylesheet. The entry only assembles; every folding
 * decision lives in the Definition / Resolver / Store / Adapter modules.
 * All registrations ride cordis effects, so fiber disposal removes them.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { foldSummaryDefinition } from './fold-summary-definition.ts'
import { FoldSummaryRow } from './summary-row.tsx'
import { AUTO_FOLD_STYLE } from './styles.ts'

/** Services required by the client plugin. */
export const inject = ['slots', 'conversationEvents']

/** Mounts the auto-fold client plugin.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(foldSummaryDefinition)

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
