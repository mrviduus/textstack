interface Props {
  params: Promise<{ lang: string }>
}

export default async function HomePage({ params }: Props) {
  const { lang } = await params

  return (
    <main>
      <h1>TextStack</h1>
      <p>Free online book library</p>
      <p>Language: {lang}</p>
    </main>
  )
}
