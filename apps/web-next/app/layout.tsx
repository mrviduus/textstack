import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'TextStack',
  description: 'Free online book library',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
