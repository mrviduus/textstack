import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

/**
 * Vitest config for mobile.
 *
 * `src/lib/` — pure logic, Node env. RN modules (AsyncStorage, Linking, Platform)
 * get aliased to in-process mocks at the top of this file so tests for
 * `progressStorage.ts`/`reviewMode.ts` etc. can run without bundling RN.
 *
 * `src/hooks/`, `src/components/reader/` — hook behaviour tests. No React Native
 * renderer: the hooks touch no RN view, so they are rendered with react-dom under
 * jsdom (`src/test/renderHook.ts`; opt in per file with `// @vitest-environment jsdom`),
 * and each test file mocks the RN / context modules it reaches at the module boundary.
 */
export default defineConfig({
  test: {
    // Default environment is Node — fast and matches the pure-fn target.
    // Tests that need DOM-like APIs can opt-in via `// @vitest-environment jsdom`.
    environment: 'node',
    include: [
      'src/lib/**/*.test.ts',
      'src/hooks/**/*.test.{ts,tsx}',
      'src/components/reader/**/*.test.{ts,tsx}',
    ],
    // __DEV__ is a React Native global. Tests may run in Node where it
    // doesn't exist; define it so our utility code's `__DEV__ &&` paths
    // don't crash.
    globals: false,
  },
  resolve: {
    alias: [
      // AsyncStorage native module → tiny in-memory mock. Lives next to
      // the tests so it can be inspected per-test if needed.
      {
        find: '@react-native-async-storage/async-storage',
        replacement: resolve(__dirname, 'src/lib/__mocks__/async-storage.ts'),
      },
      // Shared workspace package is a source path-alias (not built) — point
      // Vitest at its source entry so lib tests that import RN-free helpers
      // from modules which also re-export `authFetch` (e.g. agents.ts) resolve.
      {
        find: '@textstack/shared',
        replacement: resolve(__dirname, '../../packages/shared/src/index.ts'),
      },
    ],
  },
  define: {
    // RN-only global. Mock as false in tests so production-like paths
    // run (skip dev logs); flip in a specific test with vi.stubGlobal if
    // a __DEV__ branch needs coverage.
    __DEV__: false,
  },
})
