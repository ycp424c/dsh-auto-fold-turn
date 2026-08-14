import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')

function json(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(ROOT, file), 'utf8')) as Record<string, unknown>
}

describe('plugin package metadata', () => {
  it('declares exports, dsh.bundle and dsh.client for the web platform', () => {
    const manifest = json('package.json')
    expect(manifest.name).toBe('@ycp424c/dsh-auto-fold-turn')
    expect((manifest.exports as Record<string, unknown>)['./client']).toBe('./lib/client.js')
    const dsh = manifest.dsh as { bundle: { patch: string }; client: { platform: string; inject: string[] } }
    expect(dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(dsh.client.platform).toBe('web')
    expect(dsh.client.inject).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-conversation',
    ]))
  })

  it('keeps dsh.plugin.json pointing at the built host/client halves', () => {
    const plugin = json('dsh.plugin.json')
    expect(plugin.name).toBe('@ycp424c/dsh-auto-fold-turn')
    expect(plugin.host).toBe('lib/index.js')
    expect(plugin.client).toBe('lib/client.js')
    expect(plugin.bundle).toBe('cordis.patch.yml')
  })

  it('inserts exactly one bundle row for the web profile patch', () => {
    const patch = readFileSync(resolve(ROOT, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain("name: '@ycp424c/dsh-auto-fold-turn'")
    expect(patch).toContain('id: dsh-auto-fold-turn')
  })
})
