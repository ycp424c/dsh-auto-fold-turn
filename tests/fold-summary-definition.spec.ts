import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import {
  ConversationEventRegistry, ConversationNodeAssembler, ConversationViewRegistry,
  type ChatSnapshot, type ConversationEventInput, type ConversationNodeDefinition,
  type ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { chatViewDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { assistantDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/assistant.ts'
import { messageDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/message.ts'
import { toolDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/tool.ts'
import { turnTailDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/turn-tail.ts'
import { turnErrorDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/turn-error.ts'
import { turnMaxTokensDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/turn-max-tokens.ts'
import { retryDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/retry.ts'
import { AUTO_FOLD_SUMMARY_KIND, foldSummaryDefinition } from '../src/client/fold-summary-definition.ts'

function at(
  seq: number,
  type: string,
  data: unknown,
  extra: Record<string, unknown> = {},
): ConversationEventInput {
  return {
    event: {
      seq,
      time: 1_700_000_000_000 + seq,
      type,
      data,
      ...extra,
    } as unknown as ConversationEventInput['event'],
    view: undefined,
  }
}

function textMessage(id: string, text: string) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function assistantMessage(id: string, text: string) {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'fake', model: 'fake' },
  }
}

function toolResult(callId: string, text: string) {
  return {
    id: `result-${callId}`,
    role: 'user',
    source: { kind: 'tool', callId },
    content: [{
      type: 'tool-result',
      toolCallId: callId,
      content: [{ type: 'text', text }],
      isError: false,
    }],
  }
}

function assemble(
  entries: readonly ConversationEventInput[],
  hasMore = false,
  extraDefinitions: readonly ConversationNodeDefinition[] = [],
): ChatSnapshot {
  const ctx = new Context()
  const events = new ConversationEventRegistry(ctx)
  const views = new ConversationViewRegistry(ctx)
  for (const definition of [
    messageDefinition,
    assistantDefinition,
    toolDefinition,
    retryDefinition,
    turnErrorDefinition,
    turnMaxTokensDefinition,
    turnTailDefinition,
    ...extraDefinitions,
  ]) {
    events.register(definition)
  }
  events.register(foldSummaryDefinition)
  views.register(chatViewDefinition as unknown as ConversationViewDefinition)
  const value = new ConversationNodeAssembler(events, views)
  value.replaceWindow(entries, hasMore)
  value.flush()
  return value.snapshot('chat') as ChatSnapshot
}

function node(value: ChatSnapshot, kind: string) {
  return value.nodes.values().find(candidate => candidate.kind === kind)
}

const completedTurn = (turn: number, start = 1): ConversationEventInput[] => [
  at(start, 'turn/start', { turn }),
  at(start + 1, 'user/message', textMessage(`u${turn}`, `ask ${turn}`), { surfaceOp: 'append' }),
  at(start + 2, 'step/start', { turn, step: 1 }),
  at(start + 3, 'tool/call', { turn, step: 1, callId: `c${turn}`, name: 'read', arguments: '{}' }),
  at(start + 4, 'tool/result', { turn, step: 1, message: toolResult(`c${turn}`, 'ok') }, { surfaceOp: 'append' }),
  at(start + 5, 'assistant/message', {
    turn,
    step: 1,
    message: assistantMessage(`a${turn}`, `answer ${turn}`),
  }, { surfaceOp: 'append' }),
  at(start + 6, 'step/end', { turn, step: 1 }),
  at(start + 7, 'turn/end', { turn, reason: { kind: 'completed' } }),
]

describe('auto-fold-summary Definition', () => {
  it('publishes a summary Node only when the turn has a closing assistant', () => {
    const withClosing = assemble(completedTurn(1))
    const summary = node(withClosing, AUTO_FOLD_SUMMARY_KIND)
    expect(summary).toBeDefined()
    expect(summary?.data).toMatchObject({ turn: 1, closingSeq: 6 })

    const toolOnly = assemble([
      at(1, 'turn/start', { turn: 2 }),
      at(2, 'user/message', textMessage('u2', 'run tool'), { surfaceOp: 'append' }),
      at(3, 'step/start', { turn: 2, step: 1 }),
      at(4, 'tool/call', { turn: 2, step: 1, callId: 'c2', name: 'read', arguments: '{}' }),
      at(5, 'tool/result', { turn: 2, step: 1, message: toolResult('c2', 'ok') }, { surfaceOp: 'append' }),
      at(6, 'step/end', { turn: 2, step: 1 }),
      at(7, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ])
    expect(node(toolOnly, AUTO_FOLD_SUMMARY_KIND)).toBeUndefined()
  })

  it('still publishes for an interrupted closing assistant without a messageId', () => {
    const value = assemble([
      at(1, 'turn/start', { turn: 3 }),
      at(2, 'user/message', textMessage('u3', 'ask'), { surfaceOp: 'append' }),
      at(3, 'step/start', { turn: 3, step: 1 }),
      at(4, 'assistant/chunk', { turn: 3, step: 1, chunk: { type: 'text-delta', index: 0, text: 'partial' } }),
      at(5, 'step/end', { turn: 3, step: 1 }),
      at(6, 'turn/end', { turn: 3, reason: { kind: 'abort' } }),
    ])
    const summary = node(value, AUTO_FOLD_SUMMARY_KIND)
    expect(summary).toBeDefined()
    // The frozen partial freezes at the closed step boundary: step/end seq 5
    // minus the interruptedAssistant offset 0.9 → 4.1 (the assistant
    // Definition does not match turn/end, so its boundary is the step/end).
    expect((summary?.data as { closingSeq: number }).closingSeq).toBeCloseTo(5 - 0.9, 5)
  })

  it('anchors strictly before the closing assistant and after the process rows', () => {
    const value = assemble(completedTurn(1))
    const summary = node(value, AUTO_FOLD_SUMMARY_KIND)!
    const closing = node(value, 'assistant-step')!
    const tool = node(value, 'tool-call')!
    expect(summary.anchorSeq).toBeLessThan(closing.anchorSeq)
    expect(summary.anchorSeq).toBeGreaterThan(tool.anchorSeq)
    expect(summary.anchorSeq).toBeCloseTo(6 - 0.05, 5)
  })

  it('keeps the max-tokens notice after the summary anchor (visible, not folded)', () => {
    const value = assemble([
      at(1, 'turn/start', { turn: 4 }),
      at(2, 'user/message', textMessage('u4', 'ask'), { surfaceOp: 'append' }),
      at(3, 'step/start', { turn: 4, step: 1 }),
      at(4, 'assistant/message', {
        turn: 4,
        step: 1,
        message: assistantMessage('a4', 'truncated'),
      }, { surfaceOp: 'append' }),
      at(5, 'step/end', { turn: 4, step: 1 }),
      at(6, 'turn/end', { turn: 4, reason: { kind: 'max-tokens' } }),
    ])
    const summary = node(value, AUTO_FOLD_SUMMARY_KIND)!
    const notice = node(value, 'turn-max-tokens')!
    const tail = node(value, 'turn-tail')!
    expect(summary.anchorSeq).toBeCloseTo(4 - 0.05, 5)
    expect(notice.anchorSeq).toBeGreaterThan(summary.anchorSeq)
    expect(tail.anchorSeq).toBeGreaterThan(summary.anchorSeq)
  })

  it('produces the same final Node across full replace, historical prepend and live append', () => {
    const all = completedTurn(5)
    const fullReplace = assemble(all)
    const summaryA = node(fullReplace, AUTO_FOLD_SUMMARY_KIND)!

    // Historical: tail window first (no turn/start), then prepend the head.
    const tail = all.slice(5)
    const ctx = new Context()
    const events = new ConversationEventRegistry(ctx)
    const views = new ConversationViewRegistry(ctx)
    for (const definition of [
      messageDefinition, assistantDefinition, toolDefinition, retryDefinition,
      turnErrorDefinition, turnMaxTokensDefinition, turnTailDefinition,
    ]) {
      events.register(definition)
    }
    events.register(foldSummaryDefinition)
    views.register(chatViewDefinition as unknown as ConversationViewDefinition)
    const value = new ConversationNodeAssembler(events, views)
    value.replaceWindow(tail, true)
    value.flush()
    expect(node(value.snapshot('chat') as ChatSnapshot, AUTO_FOLD_SUMMARY_KIND)).toBeDefined()
    value.prepend(all.slice(0, 5), false)
    value.flush()
    const summaryB = node(value.snapshot('chat') as ChatSnapshot, AUTO_FOLD_SUMMARY_KIND)!
    expect(summaryB.key).toBe(summaryA.key)
    expect(summaryB.data).toEqual(summaryA.data)
    expect(summaryB.anchorSeq).toBe(summaryA.anchorSeq)

    // Live: events up to step/end first, then append turn/end.
    const ctx2 = new Context()
    const events2 = new ConversationEventRegistry(ctx2)
    const views2 = new ConversationViewRegistry(ctx2)
    for (const definition of [
      messageDefinition, assistantDefinition, toolDefinition, retryDefinition,
      turnErrorDefinition, turnMaxTokensDefinition, turnTailDefinition,
    ]) {
      events2.register(definition)
    }
    events2.register(foldSummaryDefinition)
    views2.register(chatViewDefinition as unknown as ConversationViewDefinition)
    const live = new ConversationNodeAssembler(events2, views2)
    live.replaceWindow(all.slice(0, -1), false)
    live.flush()
    expect(node(live.snapshot('chat') as ChatSnapshot, AUTO_FOLD_SUMMARY_KIND)).toBeUndefined()
    live.append(all.at(-1)!)
    live.flush()
    const summaryC = node(live.snapshot('chat') as ChatSnapshot, AUTO_FOLD_SUMMARY_KIND)!
    expect(summaryC.key).toBe(summaryA.key)
    expect(summaryC.data).toEqual(summaryA.data)
    expect(summaryC.anchorSeq).toBe(summaryA.anchorSeq)
  })
})
