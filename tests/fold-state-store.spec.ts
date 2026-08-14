import { afterEach, describe, expect, it, vi } from 'vitest'
import { FOLD_STATE_STORAGE_KEY, FoldStateStore, foldIdentity, type FoldStorage } from '../src/client/fold-state-store.ts'

/** In-memory storage face mirroring the localStorage contract. */
function memoryStorage(initial: Record<string, string> = {}): FoldStorage {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('FoldStateStore', () => {
  it('defaults to folded for unknown identities', () => {
    const store = new FoldStateStore(memoryStorage())
    expect(store.isExpanded('s1', 1)).toBe(false)
  })

  it('restores an explicit expansion from a fresh instance (cross-refresh persistence)', () => {
    const storage = memoryStorage()
    const first = new FoldStateStore(storage)
    first.setExpanded('s1', 2, true)
    const second = new FoldStateStore(storage)
    expect(second.isExpanded('s1', 2)).toBe(true)
    expect(second.isExpanded('s1', 1)).toBe(false)
    expect(second.isExpanded('s2', 2)).toBe(false)
  })

  it('deletes the persistent record when collapsed again', () => {
    const storage = memoryStorage()
    const store = new FoldStateStore(storage)
    store.setExpanded('s1', 3, true)
    expect(storage.getItem(FOLD_STATE_STORAGE_KEY)).toContain(foldIdentity('s1', 3))
    store.setExpanded('s1', 3, false)
    expect(storage.getItem(FOLD_STATE_STORAGE_KEY)).toBeNull()
    expect(new FoldStateStore(storage).isExpanded('s1', 3)).toBe(false)
  })

  it('resets to empty when the persisted JSON is corrupt', () => {
    const storage = memoryStorage({ [FOLD_STATE_STORAGE_KEY]: '{not-json' })
    const store = new FoldStateStore(storage)
    expect(store.isExpanded('s1', 1)).toBe(false)
    store.setExpanded('s1', 1, true)
    expect(new FoldStateStore(storage).isExpanded('s1', 1)).toBe(true)
  })

  it('ignores non-array payloads and non-string members', () => {
    const storage = memoryStorage({ [FOLD_STATE_STORAGE_KEY]: JSON.stringify({ 's1:1': true }) })
    const store = new FoldStateStore(storage)
    expect(store.isExpanded('s1', 1)).toBe(false)
  })

  it('keeps page-local memory state and logs once when persistence fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing = memoryStorage()
    failing.setItem = () => { throw new Error('quota') }
    const store = new FoldStateStore(failing)
    store.setExpanded('s1', 4, true)
    expect(store.isExpanded('s1', 4)).toBe(true)
    store.setExpanded('s1', 5, true)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('works without any storage (SSR/node fail-open)', () => {
    const store = new FoldStateStore(null)
    store.setExpanded('s1', 6, true)
    expect(store.isExpanded('s1', 6)).toBe(true)
    store.setExpanded('s1', 6, false)
    expect(store.isExpanded('s1', 6)).toBe(false)
  })
})
