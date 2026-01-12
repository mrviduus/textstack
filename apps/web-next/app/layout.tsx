import type { Metadata } from 'next'

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
    <html>
      <body>{children}</body>
    </html>
  )
}
