export default function LangLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}

// Generate static params for all languages
export function generateStaticParams() {
  return [
    { lang: 'en' },
    { lang: 'uk' },
  ]
}
