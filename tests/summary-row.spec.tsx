// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore, EMPTY_CONVERSATION_VIEWS, type ChatSnapshot, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { FoldStateStore } from '../src/client/fold-state-store.ts'
import { FoldSummaryRow } from '../src/client/summary-row.tsx'
import { TurnDomAdapter } from '../src/client/dom-adapter.ts'
import { foldChatFixture, type FoldFixtureNode } from './auto-fold-fixture.ts'

const SID = 's1' as SessionId
const SUMMARY_KEY = '17:auto-fold-summary1'
const PROCESS = ['tool-1', 'assistant-mid', 'tool-2']

function completedTurn(): FoldFixtureNode[] {
  return [
    { key: 'user-1', kind: 'user', anchorSeq: 2, turn: 1 },
    { key: 'tool-1', kind: 'tool-call', anchorSeq: 4, turn: 1 },
    { key: 'assistant-mid', kind: 'assistant-step', anchorSeq: 5, turn: 1, finalNodeSeq: 5 },
    { key: 'tool-2', kind: 'tool-call', anchorSeq: 6, turn: 1 },
    { key: 'assistant-final', kind: 'assistant-step', anchorSeq: 8, turn: 1, finalNodeSeq: 8 },
    { key: SUMMARY_KEY, kind: 'auto-fold-summary', anchorSeq: 7.95, turn: 1, summaryData: { closingSeq: 8 } },
    { key: 'turn-tail-1', kind: 'turn-tail', anchorSeq: 8.1, turn: 1 },
  ]
}

/** One chat row per visible key: attribute-holders; the summary key hosts the real button. */
function Flow({ chat, store, container, dropKeys = [] }: {
  chat: ChatSnapshot
  store: FoldStateStore
  container: HTMLElement
  /** Test seam: rows to omit from the DOM (simulates DOM drift). */
  dropKeys?: readonly string[]
}) {
  const source = createSnapshotStore({ chat, sessionId: SID, views: EMPTY_CONVERSATION_VIEWS } as never)
  const useSession = bindSnapshotSelector(source)
  return (
    <div data-conversation-scroll="">
      {chat.order.map((key) => {
        if (dropKeys.includes(key)) return null
        const node = chat.nodes.get(key)!
        if (node.kind === 'auto-fold-summary') {
          return (
            <div key={key} data-chat-anchor-key={key} data-chat-flow-kind="auto-fold-summary">
              <FoldSummaryRow
                node={node as never}
                sessionId={SID}
                useSession={useSession as never}
                foldState={store}
                root={container}
              />
            </div>
          )
        }
        return <div key={key} data-chat-anchor-key={key} data-chat-flow-kind={node.kind} />
      })}
    </div>
  )
}

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('FoldSummaryRow', () => {
  it('renders the folded button with the process count and aria-expanded=false', () => {
    const chat = foldChatFixture(completedTurn())
    const store = new FoldStateStore(null)
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(<Flow chat={chat} store={store} container={container} />, { container })
    const button = screen.getByRole('button', { name: '▶ 过程 · 3 项' })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.tagName).toBe('BUTTON')
  })

  it('hides the process rows in a layout effect (no flash on load)', () => {
    const chat = foldChatFixture(completedTurn())
    const store = new FoldStateStore(null)
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(<Flow chat={chat} store={store} container={container} />, { container })
    for (const key of PROCESS) {
      const row = container.querySelector(`[data-chat-anchor-key="${key}"]`)
      expect(row?.hasAttribute('data-auto-fold-hidden')).toBe(true)
    }
    expect(container.querySelector('[data-chat-anchor-key="assistant-final"]')?.hasAttribute('data-auto-fold-hidden')).toBe(false)
  })

  it('expands on click (rows visible, label toggles) and re-folds on a second click', () => {
    const chat = foldChatFixture(completedTurn())
    const store = new FoldStateStore(null)
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(<Flow chat={chat} store={store} container={container} />, { container })
    const button = screen.getByRole('button', { name: '▶ 过程 · 3 项' })
    fireEvent.click(button)
    expect(screen.getByRole('button', { name: '▼ 收起过程 · 3 项' }).getAttribute('aria-expanded')).toBe('true')
    for (const key of PROCESS) {
      expect(container.querySelector(`[data-chat-anchor-key="${key}"]`)?.hasAttribute('data-auto-fold-hidden')).toBe(false)
    }
    fireEvent.click(screen.getByRole('button', { name: '▼ 收起过程 · 3 项' }))
    expect(screen.getByRole('button', { name: '▶ 过程 · 3 项' }).getAttribute('aria-expanded')).toBe('false')
    for (const key of PROCESS) {
      expect(container.querySelector(`[data-chat-anchor-key="${key}"]`)?.hasAttribute('data-auto-fold-hidden')).toBe(true)
    }
  })

  it('persists the explicit expansion and restores it on a fresh instance (refresh)', () => {
    const storage = new Map<string, string>()
    const storageFace = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    }
    const store = new FoldStateStore(storageFace)
    const chat = foldChatFixture(completedTurn())
    const container = document.createElement('div')
    document.body.appendChild(container)
    const first = render(<Flow chat={chat} store={store} container={container} />, { container })
    fireEvent.click(screen.getByRole('button', { name: '▶ 过程 · 3 项' }))
    // Simulate a page refresh: tear the mounted tree down completely (RTL's
    // cleanup resets its per-container root registry, so the fresh render
    // below mounts a brand-new root), clear the DOM and re-attach the
    // test container.
    cleanup()
    container.innerHTML = ''
    document.body.appendChild(container)
    const fresh = new FoldStateStore(storageFace)
    render(<Flow chat={chat} store={fresh} container={container} />, { container })
    expect(screen.getByRole('button', { name: '▼ 收起过程 · 3 项' }).getAttribute('aria-expanded')).toBe('true')
    for (const key of PROCESS) {
      expect(container.querySelector(`[data-chat-anchor-key="${key}"]`)?.hasAttribute('data-auto-fold-hidden')).toBe(false)
    }
  })

  it('renders nothing when there is no process to fold (empty flow row)', () => {
    const chat = foldChatFixture([
      { key: 'user-1', kind: 'user', anchorSeq: 2, turn: 1 },
      { key: 'assistant-final', kind: 'assistant-step', anchorSeq: 8, turn: 1, finalNodeSeq: 8 },
      { key: SUMMARY_KEY, kind: 'auto-fold-summary', anchorSeq: 7.95, turn: 1, summaryData: { closingSeq: 8 } },
    ])
    const store = new FoldStateStore(null)
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(<Flow chat={chat} store={store} container={container} />, { container })
    const summaryRow = container.querySelector(`[data-chat-anchor-key="${SUMMARY_KEY}"]`)
    expect(summaryRow).not.toBeNull()
    expect(summaryRow?.textContent).toBe('')
    expect(summaryRow?.childElementCount).toBe(0)
  })

  it('fails open when the DOM rows are missing: button renders but nothing is hidden', () => {
    const chat = foldChatFixture(completedTurn())
    const store = new FoldStateStore(null)
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(<Flow chat={chat} store={store} container={container} dropKeys={[PROCESS[1]!]} />, { container })
    expect(screen.getByRole('button', { name: '▶ 过程 · 3 项' })).toBeDefined()
    for (const key of PROCESS) {
      const row = container.querySelector(`[data-chat-anchor-key="${key}"]`)
      if (row !== null) expect(row.hasAttribute('data-auto-fold-hidden')).toBe(false)
    }
  })

  it('does not re-apply the DOM fold when a fresh snapshot changes nothing (perf guard)', () => {
    const store = new FoldStateStore(null)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const applySpy = vi.spyOn(TurnDomAdapter.prototype, 'apply')
    // Same fold content in a brand-new ChatSnapshot object (streaming emits a
    // fresh snapshot per event): the layout effect must skip re-application.
    const first = render(<Flow chat={foldChatFixture(completedTurn())} store={store} container={container} />, { container })
    expect(applySpy).toHaveBeenCalledTimes(1)
    render(<Flow chat={foldChatFixture(completedTurn())} store={store} container={container} />, { container })
    expect(applySpy).toHaveBeenCalledTimes(1)
    // A real state change (expand) still re-applies.
    fireEvent.click(screen.getByRole('button', { name: '▶ 过程 · 3 项' }))
    expect(applySpy).toHaveBeenCalledTimes(2)
    first.unmount()
    applySpy.mockRestore()
  })
})
