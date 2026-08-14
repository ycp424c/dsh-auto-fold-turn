/** Minimal storage face so the store stays DOM-free and unit-testable. */
export interface FoldStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Versioned persistence key; bump the version to reset user state. */
export const FOLD_STATE_STORAGE_KEY = 'dsh.auto-fold.expanded.v1'

/** Stable identity: sessionId + turn (never relies on a possibly-missing messageId). */
export function foldIdentity(sessionId: string, turn: number): string {
  return `${sessionId}:${turn}`
}

/** Best-effort browser storage access; null when unavailable (fail-open). */
function defaultStorage(): FoldStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * Explicit-expand registry: the default state is folded, so only entries
 * the user explicitly expanded are recorded. Writes are versioned under
 * one localStorage key; corrupt payloads reset to empty; failed writes
 * keep the page-local memory state and log a single diagnostic.
 */
export class FoldStateStore {
  private readonly memory = new Set<string>()
  private warned = false

  constructor(private readonly storage: FoldStorage | null = defaultStorage()) {
    this.load()
  }

  private load(): void {
    if (this.storage === null) return
    let raw: string | null
    try {
      raw = this.storage.getItem(FOLD_STATE_STORAGE_KEY)
    } catch {
      raw = null
    }
    if (raw === null || raw === '') return
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error('not an array')
      for (const item of parsed) {
        if (typeof item === 'string') this.memory.add(item)
      }
    } catch {
      this.memory.clear()
    }
  }

  isExpanded(sessionId: string, turn: number): boolean {
    return this.memory.has(foldIdentity(sessionId, turn))
  }

  setExpanded(sessionId: string, turn: number, expanded: boolean): void {
    const identity = foldIdentity(sessionId, turn)
    if (expanded) this.memory.add(identity)
    else this.memory.delete(identity)
    this.persist()
  }

  private persist(): void {
    if (this.storage === null) return
    try {
      if (this.memory.size === 0) {
        this.storage.removeItem(FOLD_STATE_STORAGE_KEY)
        return
      }
      this.storage.setItem(FOLD_STATE_STORAGE_KEY, JSON.stringify([...this.memory]))
    } catch (error) {
      // Write failure must not break interaction; page-local state survives.
      if (!this.warned) {
        this.warned = true
        console.warn('[dsh-auto-fold-turn] failed to persist expanded state; keeping page-local state', error)
      }
    }
  }
}

/** Module-level singleton shared by all summary rows of this client. */
export const foldStateStore = new FoldStateStore()
