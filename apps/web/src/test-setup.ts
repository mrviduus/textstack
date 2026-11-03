import '@testing-library/jest-dom/vitest'
import { beforeEach } from 'vitest'
import { settleV2Session } from './lib/v2Session'

// The V2 switch waits for AuthContext's session bootstrap; tests have none, so it is settled
// before each test (a test that pins the wait re-arms it with `resetV2ForTests`).
beforeEach(() => settleV2Session())
