// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { AUTO_FOLD_HIDDEN_ATTR, TurnDomAdapter, scrollDeltaFor } from '../src/client/dom-adapter.ts'

const SUMMARY_KEY = '17:auto-fold-summary1'
const PROCESS_KEYS = ['tool-1', 'assistant-mid', 'tool-2']

/** Build one scroll container holding a summary row + process rows. */
function bench(tops: Record<string, number> = {}) {
  const container = document.createElement('div')
  container.setAttribute('data-conversation-scroll', '')
  const summary = document.createElement('div')
  summary.setAttribute('data-chat-anchor-key', SUMMARY_KEY)
  summary.setAttribute('data-chat-flow-kind', 'auto-fold-summary')
  const process = PROCESS_KEYS.map((key) => {
    const row = document.createElement('div')
    row.setAttribute('data-chat-anchor-key', key)
    row.setAttribute('data-chat-flow-kind', 'tool-call')
    return row
  })
  container.append(summary, ...process)
  document.body.appendChild(container)
  const measureTop = (element: HTMLElement): number => tops[element.getAttribute('data-chat-anchor-key') ?? ''] ?? 0
  return { container, summary, process, measureTop }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('TurnDomAdapter', () => {
  it('hides every target row atomically when all are present', () => {
    const b = bench()
    const adapter = new TurnDomAdapter({ root: document.body })
    const targets = adapter.resolve(SUMMARY_KEY, PROCESS_KEYS)
    adapter.apply(targets, true)
    for (const row of b.process) expect(row.hasAttribute(AUTO_FOLD_HIDDEN_ATTR)).toBe(true)
    expect(b.summary.hasAttribute(AUTO_FOLD_HIDDEN_ATTR)).toBe(false)
    expect(b.container.scrollTop).toBe(0)
  })

  it('performs no partial hiding when any required target row is missing', () => {
    const b = bench()
    b.process[1]!.remove()
    const adapter = new TurnDomAdapter({ root: document.body })
    const targets = adapter.resolve(SUMMARY_KEY, PROCESS_KEYS)
    expect(targets).toBeNull()
    adapter.apply(targets, true)
    for (const row of b.process) {
      if (document.body.contains(row)) expect(row.hasAttribute(AUTO_FOLD_HIDDEN_ATTR)).toBe(false)
    }
  })

  it('fails open when the summary row or its flow-kind marker is missing', () => {
    const b = bench()
    b.summary.removeAttribute('data-chat-flow-kind')
    const adapter = new TurnDomAdapter({ root: document.body })
    expect(adapter.resolve(SUMMARY_KEY, PROCESS_KEYS)).toBeNull()
    b.summary.setAttribute('data-chat-flow-kind', 'auto-fold-summary')
    b.summary.remove()
    expect(adapter.resolve(SUMMARY_KEY, PROCESS_KEYS)).toBeNull()
  })

  it('restores the DOM on expand and on dispose, removing only its own attribute', () => {
    const b = bench()
    const adapter = new TurnDomAdapter({ root: document.body })
    adapter.apply(adapter.resolve(SUMMARY_KEY, PROCESS_KEYS), true)
    b.process[0]!.setAttribute('data-other-plugin', 'keep-me')
    adapter.apply(adapter.resolve(SUMMARY_KEY, PROCESS_KEYS), false)
    for (const row of b.process) expect(row.hasAttribute(AUTO_FOLD_HIDDEN_ATTR)).toBe(false)
    expect(b.process[0]!.getAttribute('data-other-plugin')).toBe('keep-me')

    adapter.apply(adapter.resolve(SUMMARY_KEY, PROCESS_KEYS), true)
    adapter.restore()
    for (const row of b.process) expect(row.hasAttribute(AUTO_FOLD_HIDDEN_ATTR)).toBe(false)
  })

  it('compensates the scroll container so the summary row keeps its viewport top', () => {
    // Collapse: process rows above the summary vanish, summary top moves up
    // 300px (before=400, after=100); the container must scroll down by the
    // same delta so the summary stays put.
    const b = bench()
    let summaryReads = 0
    const adapter = new TurnDomAdapter({
      root: document.body,
      // Stateful geometry reader: the adapter measures the summary row once
      // before hiding (top 400) and once after (top 100), simulating the
      // collapsed rows disappearing above it.
      measureTop: (element: HTMLElement) => {
        const key = element.getAttribute('data-chat-anchor-key') ?? ''
        if (key !== SUMMARY_KEY) return 400
        summaryReads += 1
        return summaryReads === 1 ? 400 : 100
      },
    })
    adapter.apply(adapter.resolve(SUMMARY_KEY, PROCESS_KEYS), true)
    expect(b.container.scrollTop).toBe(300)
  })

  it('computes the pure scroll delta as beforeTop - afterTop', () => {
    expect(scrollDeltaFor(400, 100)).toBe(300)
    expect(scrollDeltaFor(100, 400)).toBe(-300)
  })

  it('still hides when the scroll marker is missing, without throwing or scrolling', () => {
    // `[data-conversation-scroll]` drift: rows resolve and hide (fail-open
    // only skips the scroll compensation, never the hide itself), and no
    // scroll mutation happens without a container.
    const b = bench()
    b.container.removeAttribute('data-conversation-scroll')
    const adapter = new TurnDomAdapter({ root: document.body })
    const targets = adapter.resolve(SUMMARY_KEY, PROCESS_KEYS)
    expect(targets?.scrollContainer).toBeNull()
    adapter.apply(targets, true)
    for (const row of b.process) expect(row.hasAttribute(AUTO_FOLD_HIDDEN_ATTR)).toBe(true)
  })
})
