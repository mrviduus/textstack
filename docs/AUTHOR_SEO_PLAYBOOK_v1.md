# AUTHOR_SEO_PLAYBOOK — TextStack

> Living document — Version v1.1
> Scope: Author pages only (`/en/authors/:slug/`)
> Goal: make author pages authoritative, internally connected, and search‑intent driven.

---

## 1. Purpose of an Author Page

An Author page is not just a biography.
It has three core SEO purposes:

1. Capture author‑based search intent
   - `{Author Name} books`
   - `{Author Name} novels`
   - `{Author Name} bibliography`
2. Act as an authority hub for all books by the author
3. Distribute internal link equity to book pages

---

## 2. URL Rules

/en/authors/{author-slug}/

- lowercase
- hyphen‑separated
- trailing slash
- canonical = self (unless `CanonicalOverride` set)

---

## 3. SEO Title Templates

### Classic/Historical Authors
```
{Author Name} Books – Read Classic Novels Online | TextStack
```

### Contemporary Authors
```
{Author Name} – Novels & Stories Online | TextStack
```

### Poets
```
{Author Name} Poetry – Read Poems Online | TextStack
```

Rules:
- Author name first
- Use appropriate content type (Books/Novels/Poetry)
- One brand suffix only
- Max 60 characters

---

## 4. Meta Description Templates

### Classic Authors
```
Explore books by {Author Name}. Read classic novels and stories online with a clean, distraction‑free reading experience.
```

### Contemporary Authors
```
Read {Author Name}'s novels and stories online. Enjoy a clean, distraction-free reading experience on TextStack.
```

### Poets
```
Read poems by {Author Name}. Explore poetry online with a clean, distraction-free reading experience.
```

Rules:
- 150-160 characters max
- Include author name
- Mention content type
- Include value proposition

---

## 5. Heading Structure

H1: {Author Name}

H2: About {Author Name}
H2: Writing style and themes
H2: Most popular books
H2: Why {Author Name} is still read today

---

## 6. SEO Content Blocks (Admin UI)

These fields override auto-generated content:

### Relevance Text (`SeoRelevanceText`)
- Appears under "Why {Author Name} is still read today"
- 100-200 words
- Cover: modern relevance, influence, adaptations
- Leave empty to auto-generate

### Themes (`SeoThemesJson`)
- JSON array of strings
- Example: `["love", "war", "identity"]`
- Displayed as theme tags
- Leave empty to auto-extract from books

### FAQs (`SeoFaqsJson`)
- JSON array of `{question, answer}` objects
- Generates FAQ schema markup
- Common questions:
  - "What is {Author}'s most famous book?"
  - "When was {Author} born?"
  - "What literary movement was {Author} part of?"

---

## 7. Content Requirements

- 400–700 words total
- Biography section
- Themes and style section
- Historical context
- Modern relevance

Tone:
- Neutral
- Informative
- No exaggeration

---

## 8. Books List (Mandatory)

- Visible list of books
- Each book links to its page
- Use book title as anchor
- Sort by: popularity or publication date

---

## 9. Internal Linking

Author → Books
Books → Author

Optional:
- Link to related authors (same genre/era)
- Link to genre pages

---

## 10. Structured Data

### Person Schema (Required)
```json
{
  "@context": "https://schema.org",
  "@type": "Person",
  "name": "{Author Name}",
  "url": "https://textstack.app/en/authors/{slug}/",
  "image": "{photo URL if available}",
  "description": "{bio excerpt}",
  "birthDate": "{if known}",
  "deathDate": "{if known}",
  "nationality": "{if known}",
  "jobTitle": "Author",
  "sameAs": ["{Wikipedia URL}", "{other authoritative URLs}"]
}
```

### BreadcrumbList (Required)
```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    {"@type": "ListItem", "position": 1, "name": "Home", "item": "https://textstack.app/"},
    {"@type": "ListItem", "position": 2, "name": "Authors", "item": "https://textstack.app/en/authors/"},
    {"@type": "ListItem", "position": 3, "name": "{Author Name}"}
  ]
}
```

### FAQPage Schema (if FAQs present)
```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What is {Author}'s most famous book?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "{Answer text}"
      }
    }
  ]
}
```

---

## 11. Open Graph & Twitter Cards

```html
<meta property="og:title" content="{SEO Title}">
<meta property="og:description" content="{Meta Description}">
<meta property="og:type" content="profile">
<meta property="og:url" content="https://textstack.app/en/authors/{slug}/">
<meta property="og:image" content="{author photo or fallback}">
<meta property="og:site_name" content="TextStack">

<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="{SEO Title}">
<meta name="twitter:description" content="{Meta Description}">
<meta name="twitter:image" content="{author photo or fallback}">
```

---

## 12. Author Image

- Square (1:1)
- Neutral background
- Consistent style

Alt text:
```
Portrait of {Author Name}
```

Fallback: Use site default author silhouette

---

## 13. Publishing Checklist

**Basic SEO:**
[ ] SEO title (max 60 chars)
[ ] Meta description (150-160 chars)
[ ] Canonical URL correct
[ ] Indexable = true (if should be indexed)

**Headings:**
[ ] One H1 (author name only)
[ ] 3–4 H2 sections

**Content:**
[ ] Bio filled (≥ 200 words)
[ ] Relevance text (or auto-generate)
[ ] Themes tagged
[ ] FAQs added (2-4 items)

**Links & Lists:**
[ ] Books listed with links
[ ] Links to book pages working

**Technical:**
[ ] Person schema present
[ ] BreadcrumbList schema present
[ ] FAQPage schema (if FAQs)
[ ] OG tags present
[ ] Author photo uploaded (optional)

---

End of document.
