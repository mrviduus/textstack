import { initApi } from '@textstack/shared'
import { API_BASE } from './base'
import { platform } from '../platform'

export { API_BASE }

// One authFetch for both apps (the shared one). The platform gives its auth options (`platform/web.ts`: the
// cookie). Initialised on import so every caller, tests included, gets it before first use.
initApi({ baseUrl: API_BASE, ...platform.transport.api })

export { authFetch, ApiError } from '@textstack/shared'
