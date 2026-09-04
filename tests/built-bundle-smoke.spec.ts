// @vitest-environment jsdom
/**
 * Artifact smoke: loads the BUILT lib/client.js through the DSH
 * module-loader contract (window.__ModuleLoader__.load) exactly like the
 * web shell does, then mounts the plugin fiber and asserts the Definition /
 * keyed renderer / stylesheet register and dispose cleanly.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context, Service } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationEventRegistry, SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { FoldSummaryRow } from '../src/client/summary-row.tsx'

/** Stand-in for the UiConversation service (dsh ≥ 0.1.2-rc.1). */
class FakeUiConversation extends Service {
  static inject = ['conversationEvents']
  readonly events: ConversationEventRegistry
  constructor(ctx: Context) {
    super(ctx, 'uiConversation')
    this.events = (ctx as unknown as { conversationEvents: ConversationEventRegistry }).conversationEvents
  }
}

const BUNDLE_PATH = resolve(import.meta.dirname, '../lib/client.js')
const BUNDLE = existsSync(BUNDLE_PATH) ? readFileSync(BUNDLE_PATH, 'utf8') : null
const nodeRequire = createRequire(import.meta.url)

interface LoadedModule {
  inject: string[]
  apply: (ctx: never) => void
}

/** Minimal DSH module-loader: executes the factory with Node's require. */
function loadBundle(code: string): LoadedModule {
  const window_ = window as unknown as {
    __ModuleLoader__: { load(spec: { id: string; factory: (require: (id: string) => unknown) => unknown }): unknown }
  }
  let loaded: LoadedModule | undefined
  window_.__ModuleLoader__ = {
    load: (spec) => {
      expect(spec.id).toBe('@ycp424c/dsh-auto-fold-turn')
      const result = spec.factory(nodeRequire as (id: string) => unknown)
      loaded = result as unknown as LoadedModule
      return undefined
    },
  }
  // eslint-disable-next-line no-new-func
  new Function(code)()
  if (loaded === undefined) throw new Error('bundle did not expose module exports')
  return loaded
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  new ConversationEventRegistry(ctx)
  await ctx.plugin(FakeUiConversation).await()
  ctx.slots.register(
    {
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never,
    () => null,
  )
  return ctx
}

describe('built client bundle artifact smoke', () => {
  afterEach(() => {
    document.head.innerHTML = ''
  })

  it('loads via __ModuleLoader__ and registers definition + renderer + stylesheet', async () => {
    if (BUNDLE === null) {
      // Runs after `pnpm build`; skip on a source-only checkout so the
      // plain `pnpm test` gate stays green before the artifact exists.
      return
    }
    const mod = loadBundle(BUNDLE)
    expect(mod.inject).toEqual(['slots', 'uiConversation'])
    expect(typeof mod.apply).toBe('function')

    const ctx = await bench()
    const fiber = ctx.plugin({ inject: [...mod.inject], apply: mod.apply })
    await fiber.await()

    expect(ctx.conversationEvents.entries().map(entry => entry.kind)).toContain('auto-fold-summary')
    const ours = ctx.slots.entries('conversation.chat.node').find(entry => entry.options.key === 'auto-fold-summary')
    // The bundle carries its own copy of the component (same source, bundled);
    // assert shape, not reference identity with the src import above.
    const component = ours?.component
    expect(typeof component).toBe('function')
    expect((component as { name?: string })?.name).toBe('FoldSummaryRow')
    expect(document.head.querySelector('[data-auto-fold-style]')).not.toBeNull()

    await fiber.dispose()
    expect(ctx.conversationEvents.entries().map(entry => entry.kind)).not.toContain('auto-fold-summary')
    expect(ctx.slots.entries('conversation.chat.node').some(entry => entry.options.key === 'auto-fold-summary')).toBe(false)
    expect(document.head.querySelector('[data-auto-fold-style]')).toBeNull()
  })
})
