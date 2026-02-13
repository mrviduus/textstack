import axios from 'axios';
import Env from 'env';

export const client = axios.create({
  baseURL: Env.EXPO_PUBLIC_API_URL,
  withCredentials: true,
});

// Track refresh state to avoid concurrent refresh attempts
let isRefreshing = false;
let failedQueue: Array<{
  resolve: (value?: unknown) => void;
  reject: (reason?: unknown) => void;
}> = [];

function processQueue(error: unknown) {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve();
    }
  });
  failedQueue = [];
}

// Auto-refresh on 401
client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Don't retry auth endpoints or already-retried requests
    if (
      error.response?.status !== 401
      || originalRequest._retry
      || originalRequest.url?.startsWith('/auth/')
    ) {
      return Promise.reject(error);
    }

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        failedQueue.push({ resolve, reject });
      }).then(() => client(originalRequest));
    }

    originalRequest._retry = true;
    isRefreshing = true;

    try {
      await client.post('/auth/refresh');
      processQueue(null);
      return client(originalRequest);
    } catch (refreshError) {
      processQueue(refreshError);
      // Import lazily to avoid circular deps
      const { signOut } = await import('@/features/auth/use-auth-store');
      signOut();
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  },
);

/** Build full URL for storage files (covers, photos) */
export function getStorageUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  return `${Env.EXPO_PUBLIC_API_URL}/storage/${path}`;
}
