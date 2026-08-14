import { describe, expect, it } from 'vitest'
import { resolveFoldTarget } from '../src/client/fold-target-resolver.ts'
import { foldChatFixture, type FoldFixtureNode } from './auto-fold-fixture.ts'

const summaryKey = 'auto-fold-summary'
const finalKey = 'assistant-final'
const userKey = 'user-1'
const tailKey = 'turn-tail-1'

/** One completed turn: user, tool rows, intermediate assistant, final, tail, summary. */
function completedTurn(): FoldFixtureNode[] {
  return [
    { key: userKey, kind: 'user', anchorSeq: 2, turn: 1 },
    { key: 'tool-1', kind: 'tool-call', anchorSeq: 4, turn: 1 },
    { key: 'assistant-mid', kind: 'assistant-step', anchorSeq: 5, turn: 1, finalNodeSeq: 5 },
    { key: 'tool-2', kind: 'tool-call', anchorSeq: 6, turn: 1 },
    { key: 'retry-1', kind: 'model-retry', anchorSeq: 7, turn: 1 },
    { key: finalKey, kind: 'assistant-step', anchorSeq: 8, turn: 1, finalNodeSeq: 8 },
    { key: summaryKey, kind: 'auto-fold-summary', anchorSeq: 7.95, turn: 1, summaryData: { closingSeq: 8 } },
    { key: tailKey, kind: 'turn-tail', anchorSeq: 8.1, turn: 1 },
  ]
}

describe('resolveFoldTarget', () => {
  it('folds tools, intermediate assistants and retries strictly before the summary anchor', () => {
    const target = resolveFoldTarget(foldChatFixture(completedTurn()), {
      key: summaryKey,
      kind: 'auto-fold-summary',
      anchorSeq: 7.95,
    } as never)
    expect(target).not.toBeNull()
    expect(target?.count).toBe(4)
    expect(target?.processKeys).toEqual(['tool-1', 'assistant-mid', 'tool-2', 'retry-1'])
    expect(target?.finalKey).toBe(finalKey)
  })

  it('never folds the closing assistant, the summary, the turn-tail, user or steering', () => {
    const target = resolveFoldTarget(foldChatFixture([
      ...completedTurn(),
      { key: 'steer-1', kind: 'steering', anchorSeq: 3, turn: 1 },
    ]), { key: summaryKey, kind: 'auto-fold-summary', anchorSeq: 7.95 } as never)
    expect(target?.processKeys).not.toContain(userKey)
    expect(target?.processKeys).not.toContain('steer-1')
    expect(target?.processKeys).not.toContain(finalKey)
    expect(target?.processKeys).not.toContain(summaryKey)
    expect(target?.processKeys).not.toContain(tailKey)
  })

  it('keeps terminal error and max-token notices that sort after the summary visible', () => {
    const target = resolveFoldTarget(foldChatFixture([
      ...completedTurn().filter(spec => spec.kind !== 'turn-tail'),
      { key: 'max-tokens-1', kind: 'turn-max-tokens', anchorSeq: 8.05, turn: 1 },
      { key: 'turn-error-1', kind: 'turn-error', anchorSeq: 9, turn: 1 },
      { key: tailKey, kind: 'turn-tail', anchorSeq: 8.1, turn: 1 },
    ]), { key: summaryKey, kind: 'auto-fold-summary', anchorSeq: 7.95 } as never)
    expect(target?.processKeys).toEqual(['tool-1', 'assistant-mid', 'tool-2', 'retry-1'])
    expect(target?.processKeys).not.toContain('max-tokens-1')
    expect(target?.processKeys).not.toContain('turn-error-1')
  })

  it('only reads the owning turn; other turns never leak in', () => {
    const target = resolveFoldTarget(foldChatFixture([
      ...completedTurn(),
      { key: 'tool-other', kind: 'tool-call', anchorSeq: 20, turn: 2 },
      { key: 'assistant-other', kind: 'assistant-step', anchorSeq: 21, turn: 2, finalNodeSeq: 21 },
    ]), { key: summaryKey, kind: 'auto-fold-summary', anchorSeq: 7.95 } as never)
    expect(target?.processKeys).toEqual(['tool-1', 'assistant-mid', 'tool-2', 'retry-1'])
  })

  it('returns null when the final assistant is missing or ambiguous', () => {
    const missingFinal = completedTurn().filter(spec => spec.kind !== 'assistant-step' || spec.key !== finalKey)
    expect(resolveFoldTarget(foldChatFixture(missingFinal), {
      key: summaryKey, kind: 'auto-fold-summary', anchorSeq: 7.95,
    } as never)).toBeNull()

    const ambiguous = [...completedTurn(), {
      key: 'assistant-final-dup', kind: 'assistant-step' as const, anchorSeq: 8.5, turn: 1, finalNodeSeq: 8,
    }]
    expect(resolveFoldTarget(foldChatFixture(ambiguous), {
      key: summaryKey, kind: 'auto-fold-summary', anchorSeq: 7.95,
    } as never)).toBeNull()
  })

  it('returns an empty process set for a turn with nothing foldable before the summary', () => {
    const target = resolveFoldTarget(foldChatFixture([
      { key: userKey, kind: 'user', anchorSeq: 2, turn: 1 },
      { key: finalKey, kind: 'assistant-step', anchorSeq: 8, turn: 1, finalNodeSeq: 8 },
      { key: summaryKey, kind: 'auto-fold-summary', anchorSeq: 7.95, turn: 1, summaryData: { closingSeq: 8 } },
    ]), { key: summaryKey, kind: 'auto-fold-summary', anchorSeq: 7.95 } as never)
    expect(target?.count).toBe(0)
    expect(target?.processKeys).toEqual([])
  })
})
