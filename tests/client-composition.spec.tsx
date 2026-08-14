// @vitest-environment jsdom
import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConversationEventRegistry, SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.tsx'
import { foldSummaryDefinition } from '../src/client/fold-summary-definition.ts'
import { FoldSummaryRow } from '../src/client/summary-row.tsx'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  new ConversationEventRegistry(ctx)
  // Stand-in for ui-conversation's declaration of the keyed chat node seat
  // (the real declaration comes from its apply; the plugin only injects into it).
  ctx.slots.register(
    {
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never,
    () => null,
  )
  return ctx
}

describe('client plugin composition', () => {
  beforeEach(() => {
    document.head.innerHTML = ''
  })
  afterEach(() => {
    document.head.innerHTML = ''
  })

  it('declares the slots and conversationEvents dependencies', () => {
    expect(inject).toEqual(['slots', 'conversationEvents'])
  })

  it('registers the Definition, the keyed renderer and the stylesheet, then disposes cleanly', async () => {
    const ctx = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    expect(ctx.conversationEvents.entries().map(entry => entry.kind)).toContain('auto-fold-summary')
    const entries = ctx.slots.entries('conversation.chat.node')
    const ours = entries.find(entry => entry.options.key === 'auto-fold-summary')
    expect(ours).toBeDefined()
    expect(ours?.component).toBe(FoldSummaryRow)
    expect(document.head.querySelector('[data-auto-fold-style]')).not.toBeNull()

    await fiber.dispose()
    expect(ctx.conversationEvents.entries().map(entry => entry.kind)).not.toContain('auto-fold-summary')
    expect(ctx.slots.entries('conversation.chat.node').some(entry => entry.options.key === 'auto-fold-summary')).toBe(false)
    expect(document.head.querySelector('[data-auto-fold-style]')).toBeNull()
  })

  it('coexists with other keyed entries of the same seat without overwriting them', async () => {
    const ctx = await bench()
    // Simulate ui-conversation's own user renderer already registered.
    const userEntry = ctx.slots.register(
      { name: 'conversation.chat.node', key: 'user' } as never,
      () => null,
    )
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const keys = ctx.slots.entries('conversation.chat.node').map(entry => entry.options.key)
    expect(keys).toContain('user')
    expect(keys).toContain('auto-fold-summary')

    await fiber.dispose()
    const after = ctx.slots.entries('conversation.chat.node').map(entry => entry.options.key)
    expect(after).toContain('user')
    expect(after).not.toContain('auto-fold-summary')
    userEntry()
  })

  it('rejects a duplicate registration of the same Definition kind', async () => {
    const ctx = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(() => ctx.conversationEvents.register(foldSummaryDefinition))
      .toThrow(/auto-fold-summary.*already registered/)
    await fiber.dispose()
  })
})
