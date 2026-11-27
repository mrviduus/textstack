// The platform sets up the shared API client on load (`platform/web.ts`: the cookie). Importing the
// platform here makes sure that every caller, tests included, gets it before first use.
import '../platform'

export { API_BASE } from './base'
export { authFetch, ApiError } from '@textstack/shared'
