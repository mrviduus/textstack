import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'export',           // Static HTML export, no Node.js runtime needed
  trailingSlash: true,        // /books/slug/ not /books/slug
  images: {
    unoptimized: true,        // No Image Optimization for static export
  },
  // Disable x-powered-by header
  poweredByHeader: false,
}

export default nextConfig
