import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'

// Tells React this environment drives updates through act().
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Renders a hook under react-dom (jsdom env). The reader hooks touch no RN view, so no React
 * Native renderer is needed. `rerender` merges new props; every call runs in act().
 */
export function renderHook<P extends object, R>(hook: (props: P) => R, initialProps: P) {
  const result = { current: undefined as unknown as R }
  let props = initialProps
  const Probe = ({ p }: { p: P }) => { result.current = hook(p); return null }
  const root = createRoot(document.createElement('div'))
  act(() => root.render(createElement(Probe, { p: props })))
  return {
    result,
    rerender(next: Partial<P>) {
      props = { ...props, ...next }
      act(() => root.render(createElement(Probe, { p: props })))
    },
    unmount() { act(() => root.unmount()) },
  }
}
