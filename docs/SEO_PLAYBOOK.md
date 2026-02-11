# SEO_PLAYBOOK — TextStack

> Living document. Version: v1.0  
> Goal: make SEO repeatable, predictable, and scalable for TextStack.

---

## 1. Core SEO principles (read once)

### 1.1 What we optimize for
- Search intent, not keywords
- Long-tail queries, not head terms
- Content clusters, not single pages

### 1.2 What we do NOT compete on
- Generic queries like `classic books` or `Crime and Punishment book`
- Wikipedia-style summaries with no added value

### 1.3 Golden rule
Every indexable page must clearly answer: **“Why does this page exist?”**

---

## 2. Page types & SEO role

| Page type | URL example | SEO role |
|---------|------------|---------|
| Book page (pillar) | `/en/books/:slug/` | Main ranking unit |
| Author page | `/en/authors/:slug/` | Authority & internal linking |
| Chapter pages | `/en/books/:slug/:chapter` | ❌ Non‑SEO (canonical → book) |
| Supporting pages | `/en/books/:slug/themes/` | Long‑tail capture (future) |

---

## 3. Book page SEO checklist

### 3.1 URL
- `/en/books/{book-slug}/`
- Lowercase
- Trailing slash
- Canonical = self

### 3.2 SEO Title
Template:
```
{Book Title} by {Author} – Read Online | TextStack
```

Rules:
- One brand suffix only
- No emojis
- No keyword stuffing

### 3.3 Meta description
Template:
```
Read {Book Title} by {Author}. A classic novel exploring {themes}. Read online with a clean, distraction‑free reader.
```

Rules:
- 150–160 chars
- Human readable
- No line breaks

### 3.4 Headings structure
Required:
```
H1: {Book Title}

H2: What is {Book Title} about?
H2: Main themes in {Book Title}
  H3: Theme 1
  H3: Theme 2
H2: Why {Book Title} is still relevant today
H2: About the author
H2: Frequently asked questions
```

### 3.5 Body content
- Minimum 500–800 words
- Plot overview
- Themes
- Context
- Modern relevance

### 3.6 FAQ section
3–6 questions:
- Is {Book Title} hard to read?
- What is the main message of {Book Title}?
- How long does it take to read {Book Title}?
- What are the main themes in {Book Title}?
- When was {Book Title} first published? (if known)

### 3.7 Structured data
Required:
- Book
- BreadcrumbList

Conditional:
- FAQPage

---

## 4. Author page SEO checklist

### 4.1 URL
- `/en/authors/{author-slug}/`
- Lowercase, hyphen-separated, trailing slash
- Canonical = self

### 4.2 SEO Title
Templates by author type:
- Classic: `{Author Name} Books – Read Classic Novels Online | TextStack`
- Contemporary: `{Author Name} – Novels & Stories Online | TextStack`
- Poets: `{Author Name} Poetry – Read Poems Online | TextStack`

Rules: author name first, max 60 chars, one brand suffix.

### 4.3 Meta description
- Classic: `Explore books by {Author Name}. Read classic novels and stories online with a clean, distraction‑free reading experience.`
- 150-160 chars, include author name and content type.

### 4.4 Headings structure
```
H1: {Author Name}
H2: About {Author Name}
H2: Writing style and themes
H2: Most popular books
H2: Why {Author Name} is still read today
```

### 4.5 Content
- 400–700 words
- Biography, themes/style, historical context, modern relevance
- Books list with links (mandatory)
- Tone: neutral, informative

### 4.6 SEO Content Blocks (Admin UI)
- `SeoRelevanceText` — "Why still read today" (100-200 words, or auto-generate)
- `SeoThemesJson` — JSON array of theme strings
- `SeoFaqsJson` — JSON array of `{question, answer}` objects → FAQ schema

### 4.7 Structured data
- Person schema (required): name, url, image, description, birthDate, deathDate
- BreadcrumbList (required)
- FAQPage (if FAQs present)

### 4.8 Author publishing checklist
- [ ] SEO title (max 60 chars)
- [ ] Meta description (150-160 chars)
- [ ] Canonical URL
- [ ] One H1, 3-4 H2 sections
- [ ] Bio filled (>= 200 words)
- [ ] Books listed with links
- [ ] Person + BreadcrumbList schema
- [ ] OG tags present

---

## 5. Keyword discovery (manual)

- Google autocomplete
- People Also Ask
- Competitor headings analysis

---

## 6. Publishing checklist

[ ] SEO title  
[ ] Meta description  
[ ] Canonical  
[ ] One H1  
[ ] 3+ H2  
[ ] FAQ  
[ ] Book schema  
[ ] FAQ schema (if needed)

---

End of document.
