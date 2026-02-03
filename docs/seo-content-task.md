# SEO Content Generation Task

## Overview

This document describes the task of generating comprehensive SEO content for authors and their books on TextStack. The goal is to improve search engine visibility and provide rich, informative content for users.

## How to Use

When you want SEO content generated for an author, reference this file and provide the author's name:

```
See docs/seo-content-task.md - generate SEO content for [Author Name]
```

Claude will:
1. Find the author and all their books in the database
2. Generate high-quality SEO content for each entity
3. Update the database via SQL
4. Rebuild SSG pages

## SEO Fields Structure

### For Authors (`authors` table)

| Field | Description | Target Length |
|-------|-------------|---------------|
| `bio` | Biographical text about the author, their life, major works, literary style, and influence | 200-400 words |
| `seo_relevance_text` | Why this author remains relevant today, their influence on modern culture/literature | 100-200 words |
| `seo_themes_json` | JSON array of 5-7 key themes in their work | `["Theme 1", "Theme 2", ...]` |
| `seo_faqs_json` | JSON array of 4-6 frequently asked questions with answers | See format below |

Note: "About" text is auto-generated from `bio` field (first 2 sentences). No separate `seo_about_text` field needed.

### For Books (`editions` table)

| Field | Description | Target Length |
|-------|-------------|---------------|
| `description` | Plot summary without major spoilers, literary significance, writing style | 150-250 words |
| `seo_relevance_text` | Why this book matters today, its cultural impact, who should read it | 100-150 words |
| `seo_themes_json` | JSON array of 5-7 key themes in the book | `["Theme 1", "Theme 2", ...]` |
| `seo_faqs_json` | JSON array of 4-6 frequently asked questions with answers | See format below |

Note: "About" text is auto-generated from `description` field (first 2 sentences). No separate `seo_about_text` field needed.

### FAQ JSON Format

```json
[
  {
    "question": "Full question text?",
    "answer": "Comprehensive answer (2-4 sentences)."
  }
]
```

## Content Guidelines

### About Text
- Factual, encyclopedic tone
- Include birth/death years for authors
- Mention major works and achievements
- Avoid subjective superlatives
- Use proper literary terminology

### Relevance Text
- Focus on modern connections
- Mention adaptations, academic study, cultural influence
- Explain why readers today should care
- Connect to contemporary themes/issues

### Themes
- Use noun phrases: "Guilt and redemption" not "Explores guilt"
- Be specific: "Urban poverty" not just "Society"
- Include both literary and philosophical themes

### FAQs
- Start with basic "What is X about?" question
- Include "Is X difficult to read?" for challenging works
- Add author-specific questions (biography, influences)
- Include practical questions ("How long to read?", "Where to start?")
- Mention TextStack features where appropriate

## Example: Fyodor Dostoevsky

Completed on 2026-02-02.

### Author SEO Content

**seo_about_text** (excerpt):
> Fyodor Mikhailovich Dostoevsky (1821–1881) was a Russian novelist, philosopher, and journalist whose works have profoundly shaped world literature and modern thought...

**seo_themes_json**:
```json
["Psychological realism", "Guilt and redemption", "Faith and doubt", "Free will and morality", "Suffering and salvation", "Russian society"]
```

### Books Updated

1. Crime and Punishment
2. The Brothers Karamazov
3. The Idiot
4. Demons
5. Notes from Underground
6. The Gambler
7. Poor Folk
8. The House of the Dead

## Technical Implementation

### Step 1: Find Author and Books

```sql
-- Find author ID
SELECT id, name FROM authors WHERE name ILIKE '%[author name]%';

-- Find all books by author
SELECT e.id, e.title
FROM editions e
JOIN edition_authors ea ON e.id = ea.edition_id
WHERE ea.author_id = '[author-uuid]'
ORDER BY e.title;
```

### Step 2: Update Database

```sql
-- Update author
UPDATE authors SET
  bio = '...',
  seo_relevance_text = '...',
  seo_themes_json = '[...]',
  seo_faqs_json = '[...]'
WHERE id = '[author-uuid]';

-- Update each book
UPDATE editions SET
  description = '...',
  seo_relevance_text = '...',
  seo_themes_json = '[...]',
  seo_faqs_json = '[...]'
WHERE id = '[edition-uuid]';
```

### Step 3: Rebuild SSG

```bash
make rebuild-ssg
```

### Step 4: Verify

- Check author page: `https://textstack.app/en/authors/[slug]/`
- Check book pages: `https://textstack.app/en/books/[slug]/`
- Test Schema.org markup: Google Rich Results Test

## Reference: Lewis Carroll (Quality Benchmark)

Lewis Carroll was the first author to receive complete SEO content and serves as the quality benchmark. Check his pages for reference:

- Author: https://textstack.app/en/authors/lewis-carroll/
- Books: Alice's Adventures in Wonderland, Through the Looking-Glass, etc.

## Completed Authors

| Author | Date | Books Updated |
|--------|------|---------------|
| Lewis Carroll | 2026-01 | 4 |
| Fyodor Dostoevsky | 2026-02-02 | 9 |
| Charles Dickens | 2026-02-02 | 14 |
| Jane Austen | 2026-02-02 | 6 |
| Arthur Conan Doyle | 2026-02-02 | 5 |
| Oscar Wilde | 2026-02-02 | 8 |

## Priority Queue

Next authors to process, prioritized by book count and search interest:

| Priority | Author | Books | Notes |
|----------|--------|-------|-------|
| 1 | William Shakespeare | 4 | Classic, high search volume |
| 2 | Mark Twain | 3 | American classic |
| 3 | Friedrich Nietzsche | 2 | Philosophy |
| 4 | Homer | 2 | Ancient classics |
| 5 | Jack London | 2 | Adventure classics |
| 6 | Jules Verne | 2 | Sci-fi pioneer |
| 7 | Robert Louis Stevenson | 2 | Adventure/horror |
| 8 | Bram Stoker | 1 | Dracula - high search volume |
| 9 | Mary Shelley | 1 | Frankenstein - high search volume |
| 10 | Victor Hugo | 1 | Les Misérables - iconic work |
