import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

/**
 * Vitest config for mobile — UNIT TESTS ONLY for pure utilities.
 *
 * Hooks/components are NOT in scope here. They depend on the React Native
 * runtime, which doesn't run under Vitest's Node/jsdom envs without a
 * full @testing-library/react-native + native-module mock setup. That's
 * a separate infra slice — when a real regression demands it, add it then.
 *
 * For now: pure logic in `src/lib/` is testable, and that's the highest
 * ROI per minute of setup. RN modules (AsyncStorage, Linking, Platform)
 * get aliased to in-process mocks at the top of this file so tests for
 * `progressStorage.ts`/`reviewMode.ts` etc. can run without bundling RN.
 */
export default defineConfig({
  test: {
    // Default environment is Node — fast and matches the pure-fn target.
    // Tests that need DOM-like APIs can opt-in via `// @vitest-environment jsdom`.
    environment: 'node',
    // Only the lib/ folder is in scope. Apps/components/hooks intentionally
    // excluded — see header for rationale.
    include: ['src/lib/**/*.test.ts'],
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
