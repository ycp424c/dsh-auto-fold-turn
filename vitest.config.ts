import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// DSH source roots (both read-only, never written):
// - .dsh/source/current  -> ~/.dsh/source/current (built staging snapshot used
//   for the package.json link: devDependencies, per the implementation plan)
// - .dsh/source/reference -> <dsh-checkout>
//   (your local DSH checkout, symlinked as .dsh/source/reference; it carries
//   node kinds like turn-max-tokens that the staging snapshot predates).
const dsh = fileURLToPath(new URL('.dsh/source/', import.meta.url))
const pluginRoot = fileURLToPath(new URL('./', import.meta.url))

// DSH's own test lane resolves bare `@deepseek-ai/dsh-*` imports to source so
// tests run against the real engine instead of the window-gated
// module-loader bundles under lib/. This plugin aliases exactly the packages
// its tests touch. (vite-tsconfig-paths cannot be used here: Vite 8.2's
// native tsconfigPaths resolver supersedes it.)
const dshSource = {
  '@deepseek-ai/dsh-client-runtime/client': `${dsh}reference/packages/client/runtime/src/client/index.ts`,
  '@deepseek-ai/dsh-client-connection/client': `${dsh}reference/packages/client/connection/src/client/index.ts`,
  '@deepseek-ai/dsh-host-apiproxy/api': `${dsh}reference/packages/host/apiproxy/src/api/index.ts`,
  '@deepseek-ai/dsh-session/surface': `${dsh}reference/packages/core/session/src/surface.ts`,
  '@deepseek-ai/dsh-client-ui-slots': `${dsh}reference/packages/client/ui-slots/src/index.ts`,
  '@deepseek-ai/dsh-client-web-react': `${dsh}reference/packages/client/web-react/src/index.ts`,
  '@deepseek-ai/dsh-client-ui-conversation/src': `${dsh}reference/packages/client/ui-conversation/src`,
  // Single React copy: reference sources under .dsh/source/reference would
  // otherwise
  // resolve their own react and break hook identity with the plugin's react.
  // Specific subpaths must precede the bare `react` prefix alias.
  'react/jsx-dev-runtime': `${pluginRoot}node_modules/react/jsx-dev-runtime.js`,
  'react/jsx-runtime': `${pluginRoot}node_modules/react/jsx-runtime.js`,
  'react-dom/client': `${pluginRoot}node_modules/react-dom/client.js`,
  'react-dom/test-utils': `${pluginRoot}node_modules/react-dom/test-utils.js`,
  'react-dom': `${pluginRoot}node_modules/react-dom/index.js`,
  react: `${pluginRoot}node_modules/react/index.js`,
  // use-sync-external-store (consumed by web-react's bind) must be a single
  // copy wired to the same react instance; alias it to the plugin's copy.
  'use-sync-external-store': `${pluginRoot}node_modules/use-sync-external-store/`,
} as const

export default defineConfig({
  resolve: {
    alias: dshSource,
  },
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    environment: 'node',
    restoreMocks: true,
    clearMocks: true,
  },
})
