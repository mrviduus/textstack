interface JsonLdProps {
  data: Record<string, unknown>
}

// `<` as < keeps the JSON valid while no value (SEO text, book metadata) can close the
// <script> element it sits in.
export const serializeJsonLd = (data: Record<string, unknown>) =>
  JSON.stringify(data).replace(/</g, '\\u003c')

export function JsonLd({ data }: JsonLdProps) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  )
}
