/**
 * Ambient declarations for modules that exist only as JavaScript (no bundled
 * types) in the test/typecheck graph:
 * - DSH sources use CSS modules (`*.module.css`), whose declarations DSH
 *   itself obtains from Vite's client types; this plugin declares the shape
 *   directly to stay self-contained.
 * - web-react's bind imports `use-sync-external-store/shim/with-selector.js`,
 *   whose types are not resolved in this graph.
 */

declare module '*.module.css' {
  const styles: Record<string, string>
  export default styles
}

declare module '*.module.scss' {
  const styles: Record<string, string>
  export default styles
}

declare module 'use-sync-external-store/shim/with-selector.js' {
  export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => Snapshot,
    getServerSnapshot: undefined | null | (() => Snapshot),
    selector: (snapshot: Snapshot) => Selection,
    isEqual?: (a: Selection, b: Selection) => boolean,
  ): Selection
}
