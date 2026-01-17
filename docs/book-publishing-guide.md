# Book Publishing Guide

This guide documents the complete workflow for publishing public domain books on TextStack, including SEO optimization, author management, and photo uploads.

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Step 1: Check Existing Books](#step-1-check-existing-books)
4. [Step 2: Update Book SEO Data](#step-2-update-book-seo-data)
5. [Step 3: Publish Books](#step-3-publish-books)
6. [Step 4: Update Author Data](#step-4-update-author-data)
7. [Step 5: Upload Author Photos](#step-5-upload-author-photos)
8. [API Reference](#api-reference)
9. [SEO Guidelines](#seo-guidelines)
10. [Automation Scripts](#automation-scripts)
11. [Photo Sources & AI Generation](#photo-sources--ai-generation)

---

## Overview

The book publishing process consists of:

1. **Check existing books** - Query database to see which books are already added
2. **Update book SEO** - Add unique description, seoTitle, and seoDescription
3. **Publish books** - Change status from Draft to Published (also splits chapters)
4. **Update authors** - Add bio and SEO data for each author
5. **Upload author photos** - Download from Wikimedia/other sources or generate with AI

**Important**: Books are split into ~1000 character chunks only when published via admin panel.

---

## Prerequisites

- Access to the production server
- Docker running with production containers (`textstack_*_prod`)
- API running at `http://localhost:8080`
- Book plan file (e.g., `6_month_public_domain_book_plan_EN.txt`)

---

## Step 1: Check Existing Books

### Query to find books from your plan

```bash
docker exec -i textstack_db_prod psql -U textstack_prod -d textstack_prod <<'SQL'
SELECT e.id, e.title, e.status, e.language,
       string_agg(a.name, ', ') as authors
FROM editions e
JOIN edition_authors ea ON ea.edition_id = e.id
JOIN authors a ON a.id = ea.author_id
WHERE e.site_id = 1  -- general site
  AND e.language = 'en'
  AND (
    e.title ILIKE '%Pride and Prejudice%'
    OR e.title ILIKE '%Crime and Punishment%'
    -- Add more titles from your plan
  )
GROUP BY e.id, e.title, e.status, e.language
ORDER BY e.title;
SQL
```

### Check draft books (unpublished)

```bash
docker exec -i textstack_db_prod psql -U textstack_prod -d textstack_prod <<'SQL'
SELECT e.id, e.title, e.status,
       string_agg(a.name, ', ') as authors
FROM editions e
JOIN edition_authors ea ON ea.edition_id = e.id
JOIN authors a ON a.id = ea.author_id
WHERE e.site_id = 1
  AND e.language = 'en'
  AND e.status = 'Draft'
GROUP BY e.id, e.title, e.status
ORDER BY e.title;
SQL
```

### Check published books

```bash
docker exec -i textstack_db_prod psql -U textstack_prod -d textstack_prod <<'SQL'
SELECT COUNT(*) as published_count
FROM editions
WHERE site_id = 1 AND language = 'en' AND status = 'Published';
SQL
```

---

## Step 2: Update Book SEO Data

### Single book update

```bash
curl -s -X PUT "http://localhost:8080/admin/editions/{EDITION_ID}" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Pride and Prejudice",
    "description": "A masterful exploration of love, class, and personal growth in Regency-era England. Follow Elizabeth Bennet as she navigates society expectations and her evolving relationship with the proud Mr. Darcy. Jane Austen crafts unforgettable characters and witty social commentary in this beloved classic that continues to captivate readers worldwide.",
    "seoTitle": "Pride and Prejudice by Jane Austen - Read Free Online | TextStack",
    "seoDescription": "Read Pride and Prejudice by Jane Austen free online. A timeless romance exploring love, class, and personal growth in Regency England."
  }'
```

### Batch update script

```bash
#!/bin/bash
# update_books_seo.sh

API_URL="http://localhost:8080"

# Array of books: id|title|description|seoTitle|seoDescription
declare -a BOOKS=(
  '123|Pride and Prejudice|A masterful exploration...|Pride and Prejudice by Jane Austen - Read Free Online | TextStack|Read Pride and Prejudice...'
  '124|Crime and Punishment|A psychological masterpiece...|Crime and Punishment by Dostoevsky - Read Free | TextStack|Read Crime and Punishment...'
)

for book in "${BOOKS[@]}"; do
  IFS='|' read -r id title desc seo_title seo_desc <<< "$book"

  echo "Updating: $title (ID: $id)"

  curl -s -X PUT "$API_URL/admin/editions/$id" \
    -H "Content-Type: application/json" \
    -d "$(cat <<EOF
{
  "title": "$title",
  "description": "$desc",
  "seoTitle": "$seo_title",
  "seoDescription": "$seo_desc"
}
EOF
)" | jq -r '.title // .error // "Error"'

  sleep 0.5  # Rate limiting
done
```

---

## Step 3: Publish Books

### Single book publish

```bash
curl -s -X POST "http://localhost:8080/admin/editions/{EDITION_ID}/publish"
```

### Batch publish script

```bash
#!/bin/bash
# publish_books.sh

API_URL="http://localhost:8080"

# Get all draft book IDs
DRAFT_IDS=$(docker exec -i textstack_db_prod psql -U textstack_prod -d textstack_prod -t -A <<'SQL'
SELECT e.id FROM editions e
WHERE e.site_id = 1 AND e.language = 'en' AND e.status = 'Draft'
ORDER BY e.title;
SQL
)

for id in $DRAFT_IDS; do
  echo "Publishing edition ID: $id"
  curl -s -X POST "$API_URL/admin/editions/$id/publish" | jq -r '.title // .error'
  sleep 0.5
done
```

---

## Step 4: Update Author Data

### Query authors needing updates

```bash
docker exec -i textstack_db_prod psql -U textstack_prod -d textstack_prod <<'SQL'
SELECT a.id, a.name, a.slug,
       CASE WHEN a.bio IS NULL OR a.bio = '' THEN 'No' ELSE 'Yes' END as has_bio,
       CASE WHEN a.photo_path IS NULL THEN 'No' ELSE 'Yes' END as has_photo
FROM authors a
WHERE a.site_id = 1
ORDER BY a.name;
SQL
```

### Single author update

```bash
curl -s -X PUT "http://localhost:8080/admin/authors/{AUTHOR_ID}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Jane Austen",
    "bio": "Jane Austen (1775-1817) was an English novelist known for her sharp social commentary and masterful portrayal of the British landed gentry. Her works explore themes of love, morality, and the dependence of women on marriage for social standing and economic security.\n\nBorn in Steventon, Hampshire, Austen began writing as a teenager, producing early versions of her later novels. Her major works include Sense and Sensibility (1811), Pride and Prejudice (1813), Mansfield Park (1814), Emma (1815), and the posthumously published Northanger Abbey and Persuasion (1817).\n\nAusten'\''s novels have never been out of print and have inspired countless adaptations. Her keen observations of human nature and her ironic, witty prose style have earned her a place among the most beloved authors in English literature.",
    "seoTitle": "Jane Austen - Biography & Books | TextStack",
    "seoDescription": "Discover Jane Austen'\''s life and works. Read Pride and Prejudice, Sense and Sensibility, and more classic novels free online at TextStack."
  }'
```

### Batch author update script

```bash
#!/bin/bash
# update_authors.sh

API_URL="http://localhost:8080"

update_author() {
  local id="$1"
  local name="$2"
  local bio="$3"
  local seo_title="$4"
  local seo_desc="$5"

  echo "Updating author: $name (ID: $id)"

  # Use heredoc for proper JSON escaping
  curl -s -X PUT "$API_URL/admin/authors/$id" \
    -H "Content-Type: application/json" \
    -d @- <<EOF
{
  "name": "$name",
  "bio": "$bio",
  "seoTitle": "$seo_title",
  "seoDescription": "$seo_desc"
}
EOF
}

# Example calls
update_author 42 "Jane Austen" "Jane Austen (1775-1817)..." "Jane Austen - Biography & Books | TextStack" "Discover Jane Austen's life and works..."
```

---

## Step 5: Upload Author Photos

### Download from Wikimedia Commons

Use the Special:Redirect API to avoid rate limiting:

```bash
# Download with proper User-Agent
curl -sL \
  -H "User-Agent: Mozilla/5.0 (compatible; TextStackBot/1.0; +https://textstack.app)" \
  "https://commons.wikimedia.org/wiki/Special:Redirect/file/Jane_Austen_coloured_version.jpg?width=500" \
  -o jane_austen.jpg

# Verify file is valid (should be > 10KB)
ls -la jane_austen.jpg
file jane_austen.jpg  # Should show "JPEG image data"
```

### Upload photo to author

```bash
curl -s -X POST "http://localhost:8080/admin/authors/{AUTHOR_ID}/photo" \
  -F "file=@jane_austen.jpg"
```

### Batch photo download and upload

```bash
#!/bin/bash
# upload_author_photos.sh

API_URL="http://localhost:8080"
PHOTO_DIR="/tmp/author_photos"
mkdir -p "$PHOTO_DIR"

# Array: author_id|filename_on_wikimedia
declare -a AUTHORS=(
  '42|Jane_Austen_coloured_version.jpg'
  '43|Dostoevsky_1872.jpg'
  '44|Charles_Dickens_circa_1860s.jpg'
)

for entry in "${AUTHORS[@]}"; do
  IFS='|' read -r author_id filename <<< "$entry"
  local_file="$PHOTO_DIR/${author_id}.jpg"

  echo "Downloading: $filename"
  curl -sL \
    -H "User-Agent: Mozilla/5.0 (compatible; TextStackBot/1.0)" \
    "https://commons.wikimedia.org/wiki/Special:Redirect/file/${filename}?width=500" \
    -o "$local_file"

  # Check if valid image
  if [ $(stat -c%s "$local_file") -gt 10000 ]; then
    echo "Uploading to author ID: $author_id"
    curl -s -X POST "$API_URL/admin/authors/$author_id/photo" \
      -F "file=@$local_file"
  else
    echo "WARNING: Invalid file for $filename"
  fi

  sleep 1  # Rate limiting
done
```

---

## API Reference

### Books/Editions

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/editions` | GET | List all editions |
| `/admin/editions/{id}` | GET | Get edition details |
| `/admin/editions/{id}` | PUT | Update edition (title, description, SEO) |
| `/admin/editions/{id}/publish` | POST | Publish edition (Draft -> Published) |

### Authors

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/authors` | GET | List all authors |
| `/admin/authors/{id}` | GET | Get author details |
| `/admin/authors/{id}` | PUT | Update author (name, bio, SEO) |
| `/admin/authors/{id}/photo` | POST | Upload author photo (multipart/form-data) |

### Request/Response Examples

**Update Edition Request:**
```json
{
  "title": "Book Title",
  "description": "300-700 character unique description...",
  "seoTitle": "Book Title by Author - Read Free | TextStack",
  "seoDescription": "150-160 character meta description..."
}
```

**Update Author Request:**
```json
{
  "name": "Author Name",
  "bio": "2-3 paragraph biography...",
  "seoTitle": "Author Name - Biography & Books | TextStack",
  "seoDescription": "150-160 character meta description..."
}
```

---

## SEO Guidelines

### Book Description (300-700 characters)

- **Unique content**: Never copy from Wikipedia or other sources
- **Include keywords**: Book title, author name, genre terms
- **Highlight themes**: What makes this book special
- **Call to action**: Subtle encouragement to read

**Example:**
> A masterful exploration of love, class, and personal growth in Regency-era England. Follow Elizabeth Bennet as she navigates society's expectations and her evolving relationship with the proud Mr. Darcy. Jane Austen crafts unforgettable characters and witty social commentary in this beloved classic that continues to captivate readers worldwide.

### SEO Title (~60 characters)

Format: `{Book Title} by {Author} - Read Free Online | TextStack`

**Examples:**
- `Pride and Prejudice by Jane Austen - Read Free Online | TextStack`
- `Crime and Punishment by Dostoevsky - Read Free | TextStack`

### SEO Description (150-160 characters)

- Include book title and author
- Mention "free online" or "read free"
- End with brand name

**Examples:**
- `Read Pride and Prejudice by Jane Austen free online. A timeless romance exploring love, class, and personal growth in Regency England.`
- `Read Crime and Punishment by Fyodor Dostoevsky free. A psychological masterpiece exploring guilt, redemption, and the human condition.`

### Author Bio (2-3 paragraphs)

1. **First paragraph**: Birth/death dates, nationality, what they're known for
2. **Second paragraph**: Major works and achievements
3. **Third paragraph**: Legacy and influence

### Author SEO Title

Format: `{Author Name} - Biography & Books | TextStack`

### Author SEO Description

Include: author name, notable works, "free online" keyword

---

## Automation Scripts

### Complete workflow script

```bash
#!/bin/bash
# publish_books_workflow.sh
# Complete workflow for publishing a batch of books

set -e

API_URL="http://localhost:8080"
DB_CONTAINER="textstack_db_prod"
DB_USER="textstack_prod"
DB_NAME="textstack_prod"

# Step 1: Get draft books
echo "=== Step 1: Finding draft books ==="
docker exec -i $DB_CONTAINER psql -U $DB_USER -d $DB_NAME <<'SQL'
SELECT e.id, e.title, string_agg(a.name, ', ') as authors
FROM editions e
JOIN edition_authors ea ON ea.edition_id = e.id
JOIN authors a ON a.id = ea.author_id
WHERE e.site_id = 1 AND e.language = 'en' AND e.status = 'Draft'
GROUP BY e.id, e.title
ORDER BY e.title;
SQL

# Step 2: Update SEO (manual step - requires unique content)
echo ""
echo "=== Step 2: Update SEO data for each book ==="
echo "Use: curl -X PUT '$API_URL/admin/editions/{id}' with SEO data"

# Step 3: Publish
echo ""
echo "=== Step 3: Publish books ==="
read -p "Enter comma-separated edition IDs to publish: " ids
IFS=',' read -ra ID_ARRAY <<< "$ids"
for id in "${ID_ARRAY[@]}"; do
  id=$(echo "$id" | tr -d ' ')
  echo "Publishing ID: $id"
  curl -s -X POST "$API_URL/admin/editions/$id/publish" | jq -r '.title'
done

# Step 4: Get authors needing updates
echo ""
echo "=== Step 4: Authors needing bio/photo ==="
docker exec -i $DB_CONTAINER psql -U $DB_USER -d $DB_NAME <<'SQL'
SELECT a.id, a.name,
       CASE WHEN a.bio IS NULL OR a.bio = '' THEN 'NEEDS BIO' ELSE 'OK' END as bio_status,
       CASE WHEN a.photo_path IS NULL THEN 'NEEDS PHOTO' ELSE 'OK' END as photo_status
FROM authors a
WHERE a.site_id = 1
  AND (a.bio IS NULL OR a.bio = '' OR a.photo_path IS NULL)
ORDER BY a.name;
SQL

echo ""
echo "=== Workflow complete ==="
```

### SQL: Get book-author mapping

```sql
SELECT e.id as edition_id, e.title, e.status,
       a.id as author_id, a.name as author_name,
       a.bio IS NOT NULL as has_bio,
       a.photo_path IS NOT NULL as has_photo
FROM editions e
JOIN edition_authors ea ON ea.edition_id = e.id
JOIN authors a ON a.id = ea.author_id
WHERE e.site_id = 1 AND e.language = 'en'
ORDER BY a.name, e.title;
```

### SQL: Statistics

```sql
-- Publishing stats
SELECT
  (SELECT COUNT(*) FROM editions WHERE site_id = 1 AND status = 'Published') as published_books,
  (SELECT COUNT(*) FROM editions WHERE site_id = 1 AND status = 'Draft') as draft_books,
  (SELECT COUNT(*) FROM authors WHERE site_id = 1) as total_authors,
  (SELECT COUNT(*) FROM authors WHERE site_id = 1 AND bio IS NOT NULL AND bio != '') as authors_with_bio,
  (SELECT COUNT(*) FROM authors WHERE site_id = 1 AND photo_path IS NOT NULL) as authors_with_photo;
```

---

## Photo Sources & AI Generation

### Primary Source: Wikimedia Commons

Search for author photos at: `https://commons.wikimedia.org/`

Common file naming patterns:
- `{Author_Name}_portrait.jpg`
- `{Author_Name}_{year}.jpg`
- `{Author_Name}_photograph.jpg`

Download URL format:
```
https://commons.wikimedia.org/wiki/Special:Redirect/file/{filename}?width=500
```

### Alternative Sources

1. **Library of Congress**: `https://www.loc.gov/pictures/`
2. **National Portrait Gallery**: `https://www.npg.org.uk/`
3. **Metropolitan Museum of Art**: `https://www.metmuseum.org/`

### AI Generation Prompt Template

For authors without available photos, use this prompt with AI image generators:

```
Portrait of {AUTHOR_NAME}, {NATIONALITY} {PROFESSION}, circa {YEAR}.

Style: Period-appropriate formal portrait, sepia or muted color tones,
classic library or study setting with books in background.
Artistic style reminiscent of 19th century photography or painted portraits.

Details: {AGE_DESCRIPTION}, {CLOTHING_DESCRIPTION based on era},
thoughtful expression, soft natural lighting.

Aspect ratio: 3:4 portrait orientation
Quality: High detail, photorealistic
```

**Example for Jane Austen:**
```
Portrait of Jane Austen, English novelist, circa 1810.

Style: Period-appropriate formal portrait, sepia tones,
classic Regency-era library setting with books in background.
Artistic style reminiscent of early 19th century painted portraits.

Details: Woman in her mid-30s, wearing Regency-era white muslin dress
with high waistline, hair styled in period-appropriate curls,
thoughtful expression, soft natural lighting.

Aspect ratio: 3:4 portrait orientation
Quality: High detail, photorealistic
```

### Photo Requirements

- **Format**: JPEG or PNG
- **Minimum size**: 500x600 pixels
- **Aspect ratio**: Portrait (3:4 preferred)
- **File size**: Under 5MB
- **Style**: Period-appropriate, professional appearance

---

## Troubleshooting

### Wikimedia download returns HTML error page

**Symptom**: Downloaded file is ~2KB HTML instead of image

**Solution**: Use Special:Redirect API instead of direct URLs:
```bash
# Wrong (may be blocked)
curl "https://upload.wikimedia.org/wikipedia/commons/..."

# Correct
curl "https://commons.wikimedia.org/wiki/Special:Redirect/file/{filename}?width=500"
```

### Rate limiting (HTTP 429)

**Solution**: Add delays between requests and use proper User-Agent:
```bash
curl -H "User-Agent: Mozilla/5.0 (compatible; YourBot/1.0)" ...
sleep 1
```

### Book not splitting into chapters

**Cause**: Book is still in Draft status

**Solution**: Publish the book - chapter splitting happens during publish:
```bash
curl -X POST "http://localhost:8080/admin/editions/{id}/publish"
```

### API returns 404 for author

**Cause**: Author ID might be wrong or author doesn't exist

**Solution**: Query database to verify:
```bash
docker exec -i textstack_db_prod psql -U textstack_prod -d textstack_prod -c \
  "SELECT id, name FROM authors WHERE name ILIKE '%search_term%';"
```

---

## Checklist for New Book Batch

- [ ] Review book plan file
- [ ] Query database for existing books
- [ ] Identify books needing SEO updates
- [ ] Write unique descriptions for each book
- [ ] Update book SEO via API
- [ ] Publish all draft books
- [ ] Query authors needing updates
- [ ] Write unique bios for each author
- [ ] Update author data via API
- [ ] Find/generate author photos
- [ ] Upload all author photos
- [ ] Verify published books appear on site
- [ ] Verify author pages have photos and bios

---

*Last updated: January 2026*
*Based on Month 1-6 book ingestion (60 books)*
