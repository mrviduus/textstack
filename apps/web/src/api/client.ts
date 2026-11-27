import { initApi } from '@textstack/shared'
import { platform } from '../platform'

export const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8080'

// One authFetch for both apps (the shared one). The platform gives its auth options (`platform/web.ts`: the
// cookie). Initialised on import so every caller, tests included, gets it before first use.
initApi({ baseUrl: API_BASE, ...platform.transport.api })

export { authFetch, ApiError } from '@textstack/shared'
