# SEO Content Report

> **Historical snapshot (Feb 2026), not live numbers.** Live coverage: admin → SEO Backfill →
> Coverage (`GET /admin/seo/coverage`). Note the dashboard below has "Full SEO" counts larger than
> the totals they belong to (654 of 644 authors, 1,567 of 1,349 editions) — it was never internally
> consistent.

## Dashboard

| Metric | Count |
|--------|-------|
| **Total Authors** | 644 |
| Authors Indexable | 617 |
| Authors w/ Full SEO (bio + relevance + themes + FAQs) | 654 |
| Authors w/ SEO Title | 617 |
| **Total Published Editions** | 1,349 |
| Editions w/ Full SEO (relevance + themes + FAQs) | 1,567 |
| Editions w/ SEO Title | 1,349 |
| **Total Genres** | 56 (52 indexable) |
| Genres w/ Description | 52 |
| Genres w/ SEO Title | 52 |

*Last updated: 2026-02-18*

## How to Add SEO Content

Reference this file + provide author name:
```
See docs/seo-content-task.md - generate SEO content for [Author Name]
```

## SEO Fields Structure

### Authors (`authors` table)

| Field | Description | Target Length |
|-------|-------------|---------------|
| `bio` | Biographical text, life, major works, literary style, influence | 200-400 words |
| `seo_relevance_text` | Why relevant today, influence on modern culture | 100-200 words |
| `seo_themes_json` | JSON array of 5-7 key themes | `["Theme 1", ...]` |
| `seo_faqs_json` | JSON array of 4-6 FAQs with answers | `[{"question":"Q?","answer":"A."}]` |
| `seo_title` | Page title (auto-filled) | `[Author] - Books, Biography & Free Reading \| TextStack` |
| `seo_description` | Meta description (auto-filled) | ~160 chars |

### Editions (`editions` table)

| Field | Description | Target Length |
|-------|-------------|---------------|
| `description` | Plot summary, literary significance, style | 150-250 words |
| `seo_relevance_text` | Why it matters today, cultural impact | 100-150 words |
| `seo_themes_json` | JSON array of 5-7 key themes | `["Theme 1", ...]` |
| `seo_faqs_json` | JSON array of 4-6 FAQs | `[{"question":"Q?","answer":"A."}]` |
| `seo_title` | Page title (auto-filled) | `Read [Title] by [Author] Online Free \| TextStack` |
| `seo_description` | Meta description (auto-filled) | ~160 chars |

### Genres (`genres` table)

| Field | Description |
|-------|-------------|
| `description` | Genre overview, 80-150 words |
| `seo_title` | Auto-filled: `Free [Genre] Books Online \| TextStack` |
| `seo_description` | Auto-filled meta description |

## Content Guidelines

### Bio/About
- Factual, encyclopedic tone
- Include birth/death years
- Mention major works and achievements
- Avoid subjective superlatives

### Relevance Text
- Modern connections, adaptations, cultural influence
- Why readers today should care

### Themes
- Noun phrases: "Guilt and redemption" not "Explores guilt"
- Specific: "Urban poverty" not just "Society"

### FAQs
- "What is X about?" + "Is X difficult to read?" + practical Qs
- Mention TextStack features

## Authors with Complete SEO

All authors below have: bio, seo_relevance_text, seo_themes_json, seo_faqs_json, seo_title, indexable=true.

| Author | Date | Books w/ SEO |
|--------|------|-------------|
| Lewis Carroll | 2026-01 | 4 |
| Fyodor Dostoevsky | 2026-02-02 | 9 |
| Charles Dickens | 2026-02-02 | 14 |
| Jane Austen | 2026-02-02 | 6 |
| Arthur Conan Doyle | 2026-02-02 | 5 |
| Oscar Wilde | 2026-02-02 | 8 |
| William Shakespeare | 2026-02-03 | 40 |
| Mark Twain | 2026-02-03 | 9 |
| Friedrich Nietzsche | 2026-02-03 | 3 |
| Homer | 2026-02-03 | 2 |
| Jack London | 2026-02-03 | 9 |
| Jules Verne | 2026-02-03 | 19 |
| Robert Louis Stevenson | 2026-02-03 | 8 |
| Bram Stoker | 2026-02-03 | 1 |
| Mary Shelley | 2026-02-03 | 3 |
| Victor Hugo | 2026-02-03 | 3 |
| Leo Tolstoy | 2026-02-03 | 9 |
| H. G. Wells | 2026-02-03 | 14 |
| Joseph Conrad | 2026-02-03 | 15 |
| Agatha Christie | 2026-02-03 | 12 |
| Thomas Hardy | 2026-02-03 | 8 |
| Virginia Woolf | 2026-02-03 | 6 |
| James Joyce | 2026-02-03 | 5 |
| F. Scott Fitzgerald | 2026-02-03 | 4 |
| George Eliot | 2026-02-03 | 4 |
| Edith Wharton | 2026-02-03 | 5 |
| Henry James | 2026-02-03 | 6 |
| Anton Chekhov | 2026-02-03 | 6 |
| Charlotte Bronte | 2026-02-03 | 1 |
| Emily Bronte | 2026-02-03 | 1 |
| Alexandre Dumas | 2026-02-03 | 1 |
| Miguel de Cervantes Saavedra | 2026-02-03 | 1 |
| Herman Melville | 2026-02-03 | 1 |
| Dante Alighieri | 2026-02-03 | 1 |
| Virgil | 2026-02-03 | 1 |
| Daniel Defoe | 2026-02-03 | 1 |
| Jonathan Swift | 2026-02-03 | 1 |
| Louisa May Alcott | 2026-02-03 | 1 |
| Nathaniel Hawthorne | 2026-02-03 | 1 |
| Harriet Beecher Stowe | 2026-02-03 | 1 |
| Giovanni Boccaccio | 2026-02-03 | 1 |
| Henry David Thoreau | 2026-02-03 | 1 |
| Kate Chopin | 2026-02-03 | 1 |
| Stephen Crane | 2026-02-03 | 1 |
| James Fenimore Cooper | 2026-02-03 | 1 |
| Willa Cather | 2026-02-03 | 1 |
| John Buchan | 2026-02-03 | 1 |
| W. Somerset Maugham | 2026-02-03 | 1 |
| M. G. Lewis | 2026-02-03 | 1 |
| William Beckford | 2026-02-03 | 1 |
| George MacDonald | 2026-02-03 | 1 |
| Niccolo Machiavelli | 2026-02-03 | 1 |
| Marcus Aurelius | 2026-02-03 | 1 |
| Sun Tzu | 2026-02-03 | 1 |
| John Stuart Mill | 2026-02-03 | 1 |
| Thomas Hobbes | 2026-02-03 | 1 |
| Yevgeny Zamyatin | 2026-02-03 | 1 |
| Donna Tartt | 2026-02-03 | 1 |
| J. P. Jacobsen | 2026-02-03 | 1 |
| Zane Grey | 2026-02-03 | 2 |
| Zitkala-Sa | 2026-02-03 | 1 |
| Zofia Nalkowska | 2026-02-03 | 1 |
| W. N. P. Barbellion | 2026-02-03 | 1 |
| Viktor Pelevin | 2026-02-03 | 1 |
| A. A. Milne | 2026-02-13 | 0 |
| Robert C. Martin | 2026-02-13 | 0 |
| Lesya Ukrainka (UK) | 2026-02-03 | 1 |
| Erich Gamma (UK) | 2026-02-13 | 1 |
| Richard Helm (UK) | 2026-02-13 | 1 |
| Ralph Johnson (UK) | 2026-02-13 | 1 |
| John Vlissides (UK) | 2026-02-13 | 1 |
| Robert Martin (UK) | 2026-02-03 | 1 |
| Taras Shevchenko (UK) | 2026-02-13 | 0 |
| Іван Франко (UK) | 2026-02-17 | 16 |
| Вільям Шекспір (UK) | 2026-02-17 | 11 |
| Марко Кропивницький (UK) | 2026-02-17 | 13 |
| Василь Стефаник (UK) | 2026-02-17 | 9 |
| Артур Конан Дойл (UK) | 2026-02-17 | 9 |
| Ольга Кобилянська (UK) | 2026-02-17 | 8 |
| Михайло Старицький (UK) | 2026-02-17 | 8 |
| Пантелеймон Куліш (UK) | 2026-02-17 | 8 |
| Степан Васильченко (UK) | 2026-02-17 | 8 |
| Антуан де Сент-Екзюпері (UK) | 2026-02-17 | 4 |
| Євген Гребінка (UK) | 2026-02-17 | 7 |
| Степан Руданський (UK) | 2026-02-17 | 6 |
| Джордж Байрон (UK) | 2026-02-17 | 6 |
| Олександр Олесь (UK) | 2026-02-17 | 6 |
| Марко Черемшина (UK) | 2026-02-17 | 5 |
| Чарльз Діккенс (UK) | 2026-02-17 | 5 |
| Маркіян Шашкевич (UK) | 2026-02-17 | 5 |
| Юрій Федькович (UK) | 2026-02-17 | 5 |
| Микола Хвильовий (UK) | 2026-02-17 | 4 |
| Михайло Коцюбинський (UK) | 2026-02-17 | 4 |
| Віктор Гюго (UK) | 2026-02-17 | 4 |
| Анатоль Свидницький (UK) | 2026-02-17 | 4 |
| Григорій Сковорода (UK) | 2026-02-17 | 3 |
| Гі де Мопассан (UK) | 2026-02-17 | 3 |
| Карел Чапек (UK) | 2026-02-17 | 3 |
| Ред'ярд Кіплінг (UK) | 2026-02-17 | 2 |
| Павло Грабовський (UK) | 2026-02-17 | 2 |
| Іван Нечуй-Левицький (UK) | 2026-02-17 | 2 |
| Льюїс Керрол (UK) | 2026-02-17 | 2 |
| Вільям Теккерей (UK) | 2026-02-17 | 2 |
| Григорій Квітка-Основ'яненко (UK) | 2026-02-17 | 2 |
| Панас Мирний (UK) | 2026-02-17 | 2 |
| Петро Гулак-Артемовський (UK) | 2026-02-17 | 2 |
| Едгар Аллан По (UK) | 2026-02-17 | 1 |
| Оноре де Бальзак (UK) | 2026-02-17 | 1 |
| Альфонс Доде (UK) | 2026-02-17 | 1 |
| Даніель Дефо (UK) | 2026-02-17 | 1 |
| Джек Лондон (UK) | 2026-02-17 | 1 |
| Іван Карпенко-Карий (UK) | 2026-02-17 | 1 |
| Марко Вовчок (UK) | 2026-02-17 | 1 |
| Народна творчість (UK) | 2026-02-17 | 1 |
| П'єр Бомарше (UK) | 2026-02-17 | 1 |
| Шарль Перро (UK) | 2026-02-17 | 1 |
| Anthony Trollope | 2026-02-17 | 22 |
| Edgar Wallace | 2026-02-17 | 19 |
| Maurice Leblanc | 2026-02-17 | 12 |
| Baroness Orczy | 2026-02-17 | 12 |
| Andre Norton | 2026-02-17 | 10 |
| 1-book EN authors (A-J, ~260 authors) | 2026-02-18 | ~260 |
| 1-book EN authors (K-R, ~60 authors) | 2026-02-18 | ~60 |
| 1-book EN authors (R-X, ~92 authors) FINAL | 2026-02-18 | ~92 |

### Added 2026-02-13 (Priority Queue)

| Author | Date | Books w/ SEO |
|--------|------|-------------|
| P. G. Wodehouse | 2026-02-13 | 26 |
| Edgar Rice Burroughs | 2026-02-13 | 24 |
| Honore de Balzac | 2026-02-13 | 17 |
| George Bernard Shaw | 2026-02-13 | 16 |
| G. K. Chesterton | 2026-02-13 | 12 |

### Added 2026-02-17 (Ukrainian SEO Queue)

| # | Author | Books | Status |
|---|--------|-------|--------|
| 1 | Іван Франко (UK) | 16 | done |
| 2 | Вільям Шекспір (UK) | 11 | done |
| 3 | Марко Кропивницький (UK) | 13 | done |
| 4 | Василь Стефаник (UK) | 9 | done |
| 5 | Артур Конан Дойл (UK) | 9 | done |
| 6 | Ольга Кобилянська (UK) | 8 | done |
| 7 | Михайло Старицький (UK) | 8 | done |
| 8 | Пантелеймон Куліш (UK) | 8 | done |
| 9 | Степан Васильченко (UK) | 8 | done |
| 10 | Антуан де Сент-Екзюпері (UK) | 4 | done |
| 11 | Євген Гребінка (UK) | 7 | done |
| 12 | Степан Руданський (UK) | 6 | done |
| 13 | Джордж Байрон (UK) | 6 | done |
| 14 | Олександр Олесь (UK) | 6 | done |
| 15 | Марко Черемшина (UK) | 5 | done |
| 16 | Чарльз Діккенс (UK) | 5 | done |
| 17 | Маркіян Шашкевич (UK) | 5 | done |
| 18 | Юрій Федькович (UK) | 5 | done |
| 19 | Микола Хвильовий (UK) | 4 | done |
| 20 | Михайло Коцюбинський (UK) | 4 | done |
| 21 | Віктор Гюго (UK) | 4 | done |
| 22 | Анатоль Свидницький (UK) | 4 | done |
| 23 | Григорій Сковорода (UK) | 3 | done |
| 24 | Гі де Мопассан (UK) | 3 | done |
| 25 | Карел Чапек (UK) | 3 | done |
| 26 | Ред'ярд Кіплінг (UK) | 2 | done |
| 27 | Павло Грабовський (UK) | 2 | done |
| 28 | Іван Нечуй-Левицький (UK) | 2 | done |
| 29 | Льюїс Керрол (UK) | 2 | done |
| 30 | Вільям Теккерей (UK) | 2 | done |
| 31 | Григорій Квітка-Основ'яненко (UK) | 2 | done |
| 32 | Панас Мирний (UK) | 2 | done |
| 33 | Петро Гулак-Артемовський (UK) | 2 | done |
| 34 | Едгар Аллан По (UK) | 1 | done |
| 35 | Оноре де Бальзак (UK) | 1 | done |
| 36 | Альфонс Доде (UK) | 1 | done |
| 37 | Даніель Дефо (UK) | 1 | done |
| 38 | Джек Лондон (UK) | 1 | done |
| 39 | Іван Карпенко-Карий (UK) | 1 | done |
| 40 | Марко Вовчок (UK) | 1 | done |
| 41 | Народна творчість (UK) | 1 | done |
| 42 | П'єр Бомарше (UK) | 1 | done |
| 43 | Шарль Перро (UK) | 1 | done |

## Needs Attention

### Authors with Published Books but No Full SEO (0 remaining)

ALL English-language authors with published editions now have full SEO content (bio, relevance, themes, FAQs). Completed 2026-02-18.

### Duplicate Authors/Genres to Clean Up

**Authors** (same person, multiple DB entries):
- Robert C. Martin / Robert C. Martin (2 entries, different slugs)
- GoF authors have English-slug + Cyrillic-slug duplicates
- Taras Shevchenko has 2 entries

**Genres** (non-indexable duplicates):
- Children's Books (dup of Children's)
- Non-Fiction (dup of Nonfiction)
- Short Stories (dup of Shorts)
- Humor (dup of Comedy)

## Genre SEO Status

All 52 indexable genres have: description, seo_title, seo_description.

Tech genres also have extended descriptions: Algorithms & Data Structures, Clean Code, Computer Science, Databases, Design Patterns, DevOps, Machine Learning & AI, Mobile Development, Networking, Object-Oriented Programming, Security, Software Architecture, Software Development, Testing & QA, Web Development.

## SEO Strategy

### Keyword Clusters

1. **"Read [Book] online free"** — each book page is a landing page for this query
   - 1,349 published editions targeting these keywords
   - Each has unique seo_title: "Read [Title] by [Author] Online Free | TextStack"

2. **"Free [genre] books online"** — genre pages
   - 52 indexable genre pages
   - Each has: description, seo_title, seo_description

3. **"[Author] books list / bibliography"** — author pages
   - 617 indexable author pages
   - 654 with full bio + SEO content (rich pages)
   - 0 thin pages remaining

4. **"[Book] summary / themes / analysis"** — edition FAQs + descriptions
   - 1,567 editions with full SEO (themes, FAQs, relevance)
   - FAQ schema markup drives rich snippets in search

5. **"Best [genre] books"** — future collection pages
   - Not yet implemented
   - Opportunity for curated list pages

6. **Ukrainian: "читати [книгу] онлайн безкоштовно"**
   - Ukrainian literature section with Lesya Ukrainka, Taras Shevchenko, Pelevin
   - Design Patterns and Clean Code in Ukrainian

### Medium-Term Opportunities

- **Collection/list pages**: "Best Victorian Novels", "Top Russian Literature", "Essential Philosophy Books"
- **Internal cross-linking**: Related books widget on each book page
- **Breadcrumbs JSON-LD**: Author > Genre > Book hierarchy
- **"Where to start with [Author]" guides**: Reading order recommendations
- **Chapter-level meta tags**: Individual chapter pages for long-tail keywords
- **Reading time estimates**: Add to book pages for featured snippets
- **Structured data expansion**: Add Review, AggregateRating schema
- **Sitemap segmentation**: Separate sitemaps for books, authors, genres

### Content Gap Analysis

| Category | Complete | Partial | Missing |
|----------|----------|---------|---------|
| Author bios | 654 | 0 | 0 |
| Author SEO (full) | 654 | 0 | 0 |
| Edition SEO (full) | 1,567 | 0 | 0 |
| Genre descriptions | 52 | 0 | 0 |

**Priority for next batch**: Authors with 5+ published books and no SEO content.

## Technical Implementation

### Generate SEO for Author

```sql
SELECT id, name FROM authors WHERE name ILIKE '%[author name]%';
SELECT e.id, e.title FROM editions e
JOIN edition_authors ea ON e.id = ea.edition_id
WHERE ea.author_id = '[author-uuid]' AND e.status = 1
ORDER BY e.title;

UPDATE authors SET bio='...', seo_relevance_text='...', seo_themes_json='[...]', seo_faqs_json='[...]'
WHERE id = '[author-uuid]';

UPDATE editions SET description='...', seo_relevance_text='...', seo_themes_json='[...]', seo_faqs_json='[...]'
WHERE id = '[edition-uuid]';
```

### Rebuild SSG
```bash
make rebuild-ssg
```

### Verify
```bash
curl -I https://textstack.app/en/authors/[slug]/ | grep X-SEO-Render
curl -I https://textstack.app/en/books/[slug]/ | grep X-SEO-Render
```

## Audit Queries

```sql
-- Full author audit
SELECT a.name,
  CASE WHEN a.bio IS NOT NULL AND a.bio != '' THEN 'Y' ELSE 'N' END as bio,
  CASE WHEN a.seo_relevance_text IS NOT NULL AND a.seo_relevance_text != '' THEN 'Y' ELSE 'N' END as seo,
  a.indexable
FROM authors a WHERE a.indexable = true ORDER BY a.name;

-- Authors needing SEO (have published books, no bio)
SELECT a.name, COUNT(e.id) as books
FROM authors a
JOIN edition_authors ea ON a.id = ea.author_id
JOIN editions e ON ea.edition_id = e.id
WHERE e.status = 1 AND (a.bio IS NULL OR a.bio = '')
GROUP BY a.name ORDER BY books DESC;

-- Summary stats
SELECT
  COUNT(*) FILTER (WHERE indexable) as indexable_authors,
  COUNT(*) FILTER (WHERE bio IS NOT NULL AND bio != '') as with_bio,
  COUNT(*) FILTER (WHERE seo_relevance_text IS NOT NULL AND seo_relevance_text != '') as with_seo
FROM authors;
```

## Reference: Lewis Carroll (Quality Benchmark)

- Author: https://textstack.app/en/authors/lewis-carroll/
- Books: Alice's Adventures in Wonderland, Through the Looking-Glass, etc.

## Notes

- 2026-02-03: Bulk SEO update for 42 authors and 41 published books
- 2026-02-13: Major SEO audit + completion. Added bios for 14 authors, SEO for 5 priority queue authors (95 books). Published 1,197 editions. Genre descriptions for 37 genres. Bulk seo_title/desc for 617 authors, 1,349 editions, 52 genres. SSG rebuild triggered.
- "Bratya_Karamazovy" edition unpublished as duplicate of "The Brothers Karamazov"
- 2026-02-17: Ukrainian SEO batch 1 — 10 authors (Франко, Шекспір, Кропивницький, Стефаник, Конан Дойл, Кобилянська, Старицький, Куліш, Васильченко, Сент-Екзюпері) + 94 editions.
- 2026-02-17: Ukrainian SEO batch 2 — 5 authors (Гребінка, Руданський, Байрон, Олесь, Черемшина) + 30 editions.
- 2026-02-17: Ukrainian SEO batch 3 — 5 authors (Діккенс UK, Шашкевич, Федькович, Хвильовий, Коцюбинський) + 23 editions.
- 2026-02-17: Ukrainian SEO batch 4 — 5 authors (Гюго UK, Свидницький, Сковорода, Мопассан UK, Чапек UK) + 17 editions.
- 2026-02-17: Ukrainian SEO batch 5 — 5 authors (Кіплінг UK, Грабовський, Нечуй-Левицький, Керрол UK, Теккерей UK) + 10 editions.
- 2026-02-17: Ukrainian SEO batch 6 — 5 authors (Квітка-Основ'яненко, Панас Мирний, Гулак-Артемовський, По UK, Бальзак UK) + 8 editions.
- 2026-02-17: Ukrainian SEO batch 7 — 5 authors (Доде UK, Дефо UK, Лондон UK, Карпенко-Карий, Марко Вовчок) + 5 editions.
- 2026-02-17: Ukrainian SEO batch 8 (FINAL) — 3 authors (Народна творчість, Бомарше UK, Перро UK) + 3 editions. All UK authors except Винниченко now have SEO.
- 2026-02-17: English SEO batch 9 — 5 authors (Trollope 22, Wallace 19, Leblanc 12, Orczy 12, Norton 10) + 75 editions. High-priority EN authors from Needs Attention list.
- 2026-02-18: English SEO 1-book authors A-J — ~260 authors + editions alphabetically (Abu al-ʻAlaʼ al-Maʻarri through John Steinbeck). 178 remaining.
- 2026-02-18: English SEO 1-book authors K-R — ~60 authors + editions.
- 2026-02-18: English SEO 1-book authors R-X (FINAL) — ~92 authors + editions. ALL English authors now have full SEO. 654 authors, 1,567 editions complete.
