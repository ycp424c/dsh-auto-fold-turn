// @vitest-environment jsdom
import { Context } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  ConversationEventRegistry, ConversationNodeAssembler, ConversationViewRegistry,
  type ChatSnapshot, type ConversationEventInput, type ConversationNodeDefinition,
  type ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore, EMPTY_CONVERSATION_VIEWS, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { chatViewDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { assistantDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/assistant.ts'
import { messageDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/message.ts'
import { toolDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/tool.ts'
import { retryDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/retry.ts'
import { turnTailDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/turn-tail.ts'
import { turnErrorDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/turn-error.ts'
import { turnMaxTokensDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/turn-max-tokens.ts'
import { foldSummaryDefinition } from '../src/client/fold-summary-definition.ts'
import { FoldStateStore, type FoldStorage } from '../src/client/fold-state-store.ts'
import { FoldSummaryRow } from '../src/client/summary-row.tsx'

const SID = 's1' as SessionId
const BUILTINS: readonly ConversationNodeDefinition[] = [
  messageDefinition, assistantDefinition, toolDefinition, retryDefinition,
  turnErrorDefinition, turnMaxTokensDefinition, turnTailDefinition,
]

function at(
  seq: number,
  type: string,
  data: unknown,
  extra: Record<string, unknown> = {},
): ConversationEventInput {
  return {
    event: { seq, time: 1_700_000_000_000 + seq, type, data, ...extra } as unknown as ConversationEventInput['event'],
    view: undefined,
  }
}

function textMessage(id: string, text: string) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function assistantMessage(id: string, text: string) {
  return { id, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'fake', model: 'fake' } }
}

function toolResult(callId: string, text: string) {
  return {
    id: `result-${callId}`, role: 'user', source: { kind: 'tool', callId },
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }],
  }
}

/**
 * One multi-step turn: two steps — step 1 runs a tool then produces an
 * intermediate assistant reply, step 2 runs another tool then the final
 * reply. (The DSH assistant Definition is per-step, so a distinct step is
 * required for the intermediate assistant to surface as its own node.)
 */
function multiStepTurn(offset: number, turn: number): ConversationEventInput[] {
  const s = (n: number) => offset + n
  return [
    at(s(0), 'turn/start', { turn }),
    at(s(1), 'user/message', textMessage(`u${turn}`, `ask ${turn}`), { surfaceOp: 'append' }),
    at(s(2), 'step/start', { turn, step: 1 }),
    at(s(3), 'tool/call', { turn, step: 1, callId: `c${turn}-1`, name: 'read', arguments: '{}' }),
    at(s(4), 'tool/result', { turn, step: 1, message: toolResult(`c${turn}-1`, 'a') }, { surfaceOp: 'append' }),
    at(s(5), 'assistant/message', { turn, step: 1, message: assistantMessage(`a${turn}-mid`, 'running more') }, { surfaceOp: 'append' }),
    at(s(6), 'step/end', { turn, step: 1 }),
    at(s(7), 'step/start', { turn, step: 2 }),
    at(s(8), 'tool/call', { turn, step: 2, callId: `c${turn}-2`, name: 'write', arguments: '{}' }),
    at(s(9), 'tool/result', { turn, step: 2, message: toolResult(`c${turn}-2`, 'b') }, { surfaceOp: 'append' }),
    at(s(10), 'assistant/message', { turn, step: 2, message: assistantMessage(`a${turn}`, `answer ${turn}`) }, { surfaceOp: 'append' }),
    at(s(11), 'step/end', { turn, step: 2 }),
    at(s(12), 'turn/end', { turn, reason: { kind: 'completed' } }),
  ]
}

async function assemble(entries: readonly ConversationEventInput[]): Promise<ChatSnapshot> {
  const ctx = new Context()
  const events = new ConversationEventRegistry(ctx)
  const views = new ConversationViewRegistry(ctx)
  for (const definition of BUILTINS) events.register(definition)
  events.register(foldSummaryDefinition)
  views.register(chatViewDefinition as unknown as ConversationViewDefinition)
  const value = new ConversationNodeAssembler(events, views)
  value.replaceWindow(entries, false)
  value.flush()
  return value.snapshot('chat') as ChatSnapshot
}

/** Same events, but WITHOUT the plugin's Definition — the engine then
 *  publishes no summary node (simulates the plugin being disabled). */
async function assembleWithoutPlugin(entries: readonly ConversationEventInput[]): Promise<ChatSnapshot> {
  const ctx = new Context()
  const events = new ConversationEventRegistry(ctx)
  const views = new ConversationViewRegistry(ctx)
  for (const definition of BUILTINS) events.register(definition)
  views.register(chatViewDefinition as unknown as ConversationViewDefinition)
  const value = new ConversationNodeAssembler(events, views)
  value.replaceWindow(entries, false)
  value.flush()
  return value.snapshot('chat') as ChatSnapshot
}

function memoryStorage(): FoldStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

/**
 * Renders chat.order rows with DSH-like attributes; the summary key mounts
 * the real button. `markerStrip` drops the `data-chat-anchor-key` markers
 * to simulate DOM drift (E2E#9).
 */
function Flow({ chat, store, container, markerStrip = false }: {
  chat: ChatSnapshot
  store: FoldStateStore
  container: HTMLElement
  markerStrip?: boolean
}) {
  const source = createSnapshotStore({ chat, sessionId: SID, views: EMPTY_CONVERSATION_VIEWS } as never)
  const useSession = bindSnapshotSelector(source)
  return (
    <div data-conversation-scroll="">
      {chat.order.map((key) => {
        const node = chat.nodes.get(key)!
        if (node.kind === 'auto-fold-summary') {
          return (
            <div key={key} data-chat-flow-kind="auto-fold-summary" {...(markerStrip ? {} : { 'data-chat-anchor-key': key })}>
              <FoldSummaryRow node={node as never} sessionId={SID} useSession={useSession as never} foldState={store} root={container} />
            </div>
          )
        }
        return (
          <div
            key={key}
            data-chat-flow-kind={node.kind}
            {...(markerStrip ? {} : { 'data-chat-anchor-key': key })}
          />
        )
      })}
    </div>
  )
}

/** Kinds of rows carrying the hidden attribute, in DOM order. */
function hiddenKinds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-auto-fold-hidden]')]
    .map(row => row.getAttribute('data-chat-flow-kind') ?? '')
}

/** Kinds of all rendered rows that are NOT hidden, in DOM order. */
function visibleKinds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-chat-flow-kind]')]
    .filter(row => !row.hasAttribute('data-auto-fold-hidden'))
    .map(row => row.getAttribute('data-chat-flow-kind') ?? '')
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('auto-fold browser-equivalent flow', () => {
  it('E2E#1: after a multi-step turn only user, summary and final rows are visible', async () => {
    const chat = await assemble(multiStepTurn(0, 1))
    const store = new FoldStateStore(memoryStorage())
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(<Flow chat={chat} store={store} container={container} />, { container })
    expect(screen.getByRole('button', { name: '▶ 过程 · 3 项' })).toBeDefined()
    // 3 process rows hidden: tool-call, intermediate assistant, tool-call.
    expect(hiddenKinds(container)).toEqual(['tool-call', 'assistant-step', 'tool-call'])
    // Visible, in DOM order: user message, then summary at the top of the
    // agent answer (just before the final reply), final assistant, turn-tail.
    expect(visibleKinds(container)).toEqual(['user', 'auto-fold-summary', 'assistant-step', 'turn-tail'])
  })

  it('E2E#2: expand restores every process row in original order; clicking again re-folds', async () => {
    const chat = await assemble(multiStepTurn(0, 1))
    const store = new FoldStateStore(memoryStorage())
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(<Flow chat={chat} store={store} container={container} />, { container })
    fireEvent.click(screen.getByRole('button', { name: '▶ 过程 · 3 项' }))
    expect(hiddenKinds(container)).toHaveLength(0)
    // Expanded: the summary stays at the top of the agent answer, after the
    // user message and before the process rows.
    expect(visibleKinds(container)).toEqual([
      'user', 'auto-fold-summary', 'tool-call', 'assistant-step', 'tool-call', 'assistant-step', 'turn-tail',
    ])
    fireEvent.click(screen.getByRole('button', { name: '▼ 收起过程 · 3 项' }))
    expect(hiddenKinds(container)).toEqual(['tool-call', 'assistant-step', 'tool-call'])
    expect(visibleKinds(container)).toEqual(['user', 'auto-fold-summary', 'assistant-step', 'turn-tail'])
  })

  it('E2E#3: explicit expansion survives a refresh (fresh store instance) and re-collapse persists', async () => {
    const chat = await assemble(multiStepTurn(0, 1))
    const storage = memoryStorage()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const first = render(<Flow chat={chat} store={new FoldStateStore(storage)} container={container} />, { container })
    fireEvent.click(screen.getByRole('button', { name: '▶ 过程 · 3 项' }))
    cleanup()
    container.innerHTML = ''
    document.body.appendChild(container)

    render(<Flow chat={chat} store={new FoldStateStore(storage)} container={container} />, { container })
    expect(screen.getByRole('button', { name: '▼ 收起过程 · 3 项' })).toBeDefined()
    expect(hiddenKinds(container)).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '▼ 收起过程 · 3 项' }))
    expect(screen.getByRole('button', { name: '▶ 过程 · 3 项' })).toBeDefined()
    expect(hiddenKinds(container)).toHaveLength(3)
  })

  it('E2E#4: historical turns fold independently per turn', async () => {
    const chat = await assemble([...multiStepTurn(0, 1), ...multiStepTurn(20, 2)])
    const store = new FoldStateStore(memoryStorage())
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(<Flow chat={chat} store={store} container={container} />, { container })
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]?.textContent).toBe('▶ 过程 · 3 项')
    expect(buttons[1]?.textContent).toBe('▶ 过程 · 3 项')
    expect(hiddenKinds(container)).toHaveLength(6)
    // Expand only turn 1; turn 2 stays folded (3 rows remain hidden).
    fireEvent.click(buttons[0]!)
    expect(hiddenKinds(container)).toHaveLength(3)
  })

  it('E2E#5a: a max-tokens turn with a final reply folds its process and keeps the notice visible', async () => {
    const chat = await assemble([
      at(0, 'turn/start', { turn: 1 }),
      at(1, 'user/message', textMessage('u1', 'ask'), { surfaceOp: 'append' }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' }),
      at(4, 'tool/result', { turn: 1, step: 1, message: toolResult('c1', 'ok') }, { surfaceOp: 'append' }),
      at(5, 'assistant/message', { turn: 1, step: 1, message: assistantMessage('a1', 'truncated') }, { surfaceOp: 'append' }),
      at(6, 'step/end', { turn: 1, step: 1 }),
      at(7, 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } }),
    ])
    const store = new FoldStateStore(memoryStorage())
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(<Flow chat={chat} store={store} container={container} />, { container })
    expect(screen.getByRole('button', { name: '▶ 过程 · 1 项' })).toBeDefined()
    expect(hiddenKinds(container)).toEqual(['tool-call'])
    // The max-tokens notice sorts after the final reply and stays visible.
    expect(visibleKinds(container)).toEqual([
      'user', 'auto-fold-summary', 'assistant-step', 'turn-max-tokens', 'turn-tail',
    ])
  })

  it('E2E#5b: an error turn with a final reply folds its process and keeps the error notice visible', async () => {
    const chat = await assemble([
      at(0, 'turn/start', { turn: 2 }),
      at(1, 'user/message', textMessage('u2', 'ask'), { surfaceOp: 'append' }),
      at(2, 'step/start', { turn: 2, step: 1 }),
      at(3, 'assistant/message', { turn: 2, step: 1, message: assistantMessage('a2-mid', 'running tool') }, { surfaceOp: 'append' }),
      at(4, 'step/end', { turn: 2, step: 1 }),
      at(5, 'step/start', { turn: 2, step: 2 }),
      at(6, 'tool/call', { turn: 2, step: 2, callId: 'c2', name: 'read', arguments: '{}' }),
      at(7, 'tool/result', { turn: 2, step: 2, message: toolResult('c2', 'boom') }, { surfaceOp: 'append' }),
      at(8, 'assistant/message', { turn: 2, step: 2, message: assistantMessage('a2', 'final words') }, { surfaceOp: 'append' }),
      at(9, 'step/end', { turn: 2, step: 2 }),
      at(10, 'turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'PLUGIN', message: 'exploded' } } }),
    ])
    const store = new FoldStateStore(memoryStorage())
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(<Flow chat={chat} store={store} container={container} />, { container })
    expect(screen.getByRole('button', { name: '▶ 过程 · 2 项' })).toBeDefined()
    expect(hiddenKinds(container)).toEqual(['assistant-step', 'tool-call'])
    expect(visibleKinds(container)).toEqual([
      'user', 'auto-fold-summary', 'assistant-step', 'turn-tail', 'turn-error',
    ])
  })

  it('E2E#6: an abnormal turn without a final reply stays fully visible', async () => {
    const chat = await assemble([
      at(0, 'turn/start', { turn: 1 }),
      at(1, 'user/message', textMessage('u1', 'ask'), { surfaceOp: 'append' }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' }),
      at(4, 'tool/result', { turn: 1, step: 1, message: toolResult('c1', 'ok') }, { surfaceOp: 'append' }),
      at(5, 'step/end', { turn: 1, step: 1 }),
      at(6, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'down' } } }),
    ])
    const store = new FoldStateStore(memoryStorage())
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(<Flow chat={chat} store={store} container={container} />, { container })
    expect(screen.queryByRole('button', { name: /过程/ })).toBeNull()
    expect(hiddenKinds(container)).toHaveLength(0)
    expect(visibleKinds(container)).toEqual(['user', 'tool-call', 'turn-error', 'turn-tail'])
  })

  it('E2E#7: unmounting the view (session/view switch) restores every hidden row', async () => {
    const chat = await assemble(multiStepTurn(0, 1))
    const store = new FoldStateStore(memoryStorage())
    const container = document.createElement('div')
    document.body.appendChild(container)
    const first = render(<Flow chat={chat} store={store} container={container} />, { container })
    expect(hiddenKinds(container)).toHaveLength(3)
    cleanup()
    container.innerHTML = ''
    expect(document.body.querySelectorAll('[data-auto-fold-hidden]')).toHaveLength(0)
  })

  it('E2E#8: disabling the plugin restores the full native transcript', async () => {
    // Disabling is simulated at the engine level (same events, no plugin
    // Definition → no summary node) while the view stays mounted, which is
    // the browser-equivalent of a plugin unload. The fiber-dispose half —
    // registry/slots/stylesheet cleanup — is covered separately by
    // tests/client-composition.spec.tsx; together they cover design E2E#8.
    const store = new FoldStateStore(memoryStorage())
    const container = document.createElement('div')
    document.body.appendChild(container)

    // With the plugin Definition registered, the completed turn folds.
    const withPlugin = await assemble(multiStepTurn(0, 1))
    render(<Flow chat={withPlugin} store={store} container={container} />, { container })
    expect(hiddenKinds(container)).toHaveLength(3)

    // Plugin disabled: the same events now produce no summary node. React
    // reconciles the still-mounted view — the summary seat unmounts, its
    // layout-effect cleanup restores every previously hidden row, and the
    // native transcript is complete again.
    const native = await assembleWithoutPlugin(multiStepTurn(0, 1))
    render(<Flow chat={native} store={store} container={container} />, { container })
    expect(container.querySelectorAll('[data-auto-fold-hidden]')).toHaveLength(0)
    expect(visibleKinds(container)).toEqual([
      'user', 'tool-call', 'assistant-step', 'tool-call', 'assistant-step', 'turn-tail',
    ])
    expect(screen.queryByRole('button', { name: /过程/ })).toBeNull()
  })

  it('E2E#9: when DOM compatibility markers are missing the content stays fully visible', async () => {
    const chat = await assemble(multiStepTurn(0, 1))
    const store = new FoldStateStore(memoryStorage())
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(<Flow chat={chat} store={store} container={container} markerStrip />, { container })
    // Button still renders; nothing can be resolved, so nothing is hidden.
    expect(screen.getByRole('button', { name: '▶ 过程 · 3 项' })).toBeDefined()
    expect(container.querySelectorAll('[data-auto-fold-hidden]')).toHaveLength(0)
    expect(visibleKinds(container)).toHaveLength(7)
  })
})
