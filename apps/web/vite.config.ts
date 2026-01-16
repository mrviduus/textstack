import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // Allow prerender container to access via Docker network name
    allowedHosts: ['web', 'localhost', 'general.localhost', 'programming.localhost'],
    // Proxy API requests to API container (needed for prerender)
    proxy: {
      '/api': {
        target: 'http://api:8080',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
        headers: {
          // Send 'general.localhost' for dev site resolution
          Host: 'general.localhost',
        },
      },
    },
  },
})
