/** The address of the API. A build sets it with `VITE_API_URL`. A leaf module: the platform reads it on load. */
export const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8080'
