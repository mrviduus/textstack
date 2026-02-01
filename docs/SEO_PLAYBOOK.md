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

### 4.1 SEO Title
```
{Author Name} Books – Read Novels Online | TextStack
```

### 4.2 Meta description
```
Explore books by {Author Name}. Read classic novels online with a clean, distraction‑free reading experience.
```

### 4.3 Content
- 400–700 words
- Biography
- Themes
- Historical significance
- Book list with links

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
