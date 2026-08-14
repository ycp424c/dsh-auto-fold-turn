import type {
  ChatLocationNodeIndex, ChatNodeStore, ChatSnapshot, ChatConversationViewNode,
  ConversationLocation, ConversationTimelineSnapshot, LegacyConversationSlice, TurnLocation,
} from '@deepseek-ai/dsh-client-runtime/client'

/** One fixture node descriptor; `turn` puts it inside the owning turn. */
export interface FoldFixtureNode {
  readonly key: string
  readonly kind: string
  readonly anchorSeq: number
  readonly turn: number
  /** assistant-step only: the seq its data.finalNode reports. */
  readonly finalNodeSeq?: number
  /** auto-fold-summary only. */
  readonly summaryData?: { readonly closingSeq: number }
}

const EMPTY_LIST: readonly never[] = []

class FixtureNodeStore implements ChatNodeStore {
  private readonly byKey = new Map<string, ChatConversationViewNode>()
  constructor(nodes: readonly ChatConversationViewNode[]) {
    for (const node of nodes) this.byKey.set(node.key, node)
  }
  get(key: string): ChatConversationViewNode | undefined {
    return this.byKey.get(key)
  }
  values(): readonly ChatConversationViewNode[] {
    return [...this.byKey.values()]
  }
}

class FixtureLocationIndex implements ChatLocationNodeIndex {
  private readonly turns = new Map<number, readonly string[]>()
  constructor(turns: Map<number, readonly string[]>) {
    this.turns = turns
  }
  getTurn(turn: number): readonly string[] {
    return this.turns.get(turn) ?? EMPTY_LIST
  }
  getStep(): readonly string[] {
    return EMPTY_LIST
  }
}

/** Minimal Chat snapshot over fold-relevant nodes; order follows anchorSeq. */
export function foldChatFixture(specs: readonly FoldFixtureNode[]): ChatSnapshot {
  const sorted = [...specs]
    .sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key))
  const byTurn = new Map<number, string[]>()
  const turns = new Map<number, TurnLocation>()
  const nodes = sorted.map((spec): ChatConversationViewNode => {
    if (!turns.has(spec.turn)) {
      turns.set(spec.turn, {
        turn: spec.turn,
        start: undefined,
        end: undefined,
        status: 'closed' as const,
        steps: EMPTY_LIST,
        data: new Map(),
      })
    }
    const turn = turns.get(spec.turn)!
    const location: ConversationLocation = { kind: 'turn', turn }
    const list = byTurn.get(spec.turn) ?? []
    list.push(spec.key)
    byTurn.set(spec.turn, list)
    let data: unknown = {}
    if (spec.kind === 'assistant-step') {
      data = {
        status: 'settled',
        turn: spec.turn,
        step: 1,
        blocks: EMPTY_LIST,
        time: 0,
        finalNode: { seq: spec.finalNodeSeq ?? spec.anchorSeq },
      }
    } else if (spec.kind === 'auto-fold-summary') {
      data = { turn: spec.turn, closingSeq: spec.summaryData?.closingSeq ?? 0 }
    }
    return {
      key: spec.key,
      kind: spec.kind,
      id: spec.key,
      target: 'chat',
      anchorSeq: spec.anchorSeq,
      location,
      visibility: 'visible',
      data,
    }
  })
  const timeline: ConversationTimelineSnapshot = { turnOrder: [...byTurn.keys()], turns }
  const legacy: LegacyConversationSlice = {
    nodes: EMPTY_LIST,
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: EMPTY_LIST,
  }
  return {
    order: nodes.map(node => node.key),
    nodes: new FixtureNodeStore(nodes),
    locations: new FixtureLocationIndex(new Map([...byTurn.entries()].map(([t, keys]) => [t, [...keys]]))),
    timeline,
    legacy,
  }
}
