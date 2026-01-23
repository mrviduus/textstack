# Multilingual Data Model & EF Core Migrations — TextStack

This document describes the **database model changes** needed for multi-language support and how to implement them with **EF Core (code-first)**.

## Summary

We introduce 2 translation tables:

- `BookTranslation` — localized title/description and translation metadata
- `ChapterTranslation` — localized chapter title and HTML content

We keep:
- `Book` as canonical entity
- `Chapter` as canonical structure entity

## Language Code

Use ISO 639-1 strings:
- `en` for English
- `uk` for Ukrainian

Store as `varchar(8)` to allow future variants (`en-CA`, `uk-UA`) if needed.

## Tables

### Book (canonical)
- `Id` (uuid)
- `CanonicalSlug` (text, unique)
- `OriginalLanguage` (varchar(8), default `en`)
- `Author` (text)
- `Year` (int, nullable)
- `IsPublicDomain` (bool)
- (existing fields as you already have)

Indexes:
- unique on `CanonicalSlug`

### BookTranslation
- `Id` (uuid)
- `BookId` (uuid, FK → Book)
- `LanguageCode` (varchar(8))
- `Title` (text)
- `Description` (text, nullable)
- `Translator` (text, nullable) — for non-original versions
- `TranslationYear` (int, nullable)
- `IsOriginal` (bool) — true for EN baseline
- `CreatedAt`, `UpdatedAt`

Constraints:
- unique `(BookId, LanguageCode)`
- FK cascade delete with Book

### Chapter (canonical)
- `Id` (uuid)
- `BookId` (uuid, FK)
- `ChapterNumber` (int)
- `CanonicalAnchor` (text, nullable) — optional stable identifier

Constraints:
- unique `(BookId, ChapterNumber)`

### ChapterTranslation
- `Id` (uuid)
- `ChapterId` (uuid, FK → Chapter)
- `LanguageCode` (varchar(8))
- `Title` (text, nullable)
- `HtmlContent` (text)
- `WordCount` (int, nullable)
- `Status` (smallint) — Draft/Reviewed/Published (optional but recommended)
- `CreatedAt`, `UpdatedAt`

Constraints:
- unique `(ChapterId, LanguageCode)`
- FK cascade delete with Chapter

Suggested index:
- `(LanguageCode)` for filtering
- Full-text index on extracted plain text if you do search per language.

## EF Core Entities (C#)

### LanguageCode value approach
Use a string column for now. If you want stricter typing:
- define an enum + converter (but string is simplest for migrations).

### Example entities (minimal)

```csharp
public class Book
{
    public Guid Id { get; set; }
    public string CanonicalSlug { get; set; } = default!;
    public string OriginalLanguage { get; set; } = "en";
    public string? Author { get; set; }
    public int? Year { get; set; }
    public bool IsPublicDomain { get; set; }

    public List<BookTranslation> Translations { get; set; } = new();
    public List<Chapter> Chapters { get; set; } = new();
}

public class BookTranslation
{
    public Guid Id { get; set; }
    public Guid BookId { get; set; }
    public Book Book { get; set; } = default!;

    public string LanguageCode { get; set; } = default!; // "en", "uk"
    public string Title { get; set; } = default!;
    public string? Description { get; set; }

    public bool IsOriginal { get; set; }
    public string? Translator { get; set; }
    public int? TranslationYear { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

public class Chapter
{
    public Guid Id { get; set; }
    public Guid BookId { get; set; }
    public Book Book { get; set; } = default!;

    public int ChapterNumber { get; set; }
    public string? CanonicalAnchor { get; set; }

    public List<ChapterTranslation> Translations { get; set; } = new();
}

public enum TranslationStatus : short
{
    Draft = 0,
    Reviewed = 1,
    Published = 2
}

public class ChapterTranslation
{
    public Guid Id { get; set; }
    public Guid ChapterId { get; set; }
    public Chapter Chapter { get; set; } = default!;

    public string LanguageCode { get; set; } = default!; // "en", "uk"
    public string? Title { get; set; }
    public string HtmlContent { get; set; } = default!;
    public int? WordCount { get; set; }

    public TranslationStatus Status { get; set; } = TranslationStatus.Published;

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}
```

## EF Core Fluent Config (key parts)

```csharp
modelBuilder.Entity<Book>(b =>
{
    b.HasIndex(x => x.CanonicalSlug).IsUnique();
    b.Property(x => x.OriginalLanguage).HasMaxLength(8);

    b.HasMany(x => x.Translations)
     .WithOne(x => x.Book)
     .HasForeignKey(x => x.BookId)
     .OnDelete(DeleteBehavior.Cascade);
});

modelBuilder.Entity<BookTranslation>(b =>
{
    b.Property(x => x.LanguageCode).HasMaxLength(8).IsRequired();
    b.HasIndex(x => new { x.BookId, x.LanguageCode }).IsUnique();
});

modelBuilder.Entity<Chapter>(b =>
{
    b.HasIndex(x => new { x.BookId, x.ChapterNumber }).IsUnique();

    b.HasMany(x => x.Translations)
     .WithOne(x => x.Chapter)
     .HasForeignKey(x => x.ChapterId)
     .OnDelete(DeleteBehavior.Cascade);
});

modelBuilder.Entity<ChapterTranslation>(b =>
{
    b.Property(x => x.LanguageCode).HasMaxLength(8).IsRequired();
    b.HasIndex(x => new { x.ChapterId, x.LanguageCode }).IsUnique();
});
```

## Migration Plan

### Migration 1: Add translation tables
- Create `BookTranslations`
- Create `ChapterTranslations`
- Add unique constraints described above

### Migration 2: Backfill existing content into EN translations (if you already have content in Book/Chapter tables)
If you already store `Book.Title`, `Book.Description`, `Chapter.HtmlContent` directly, you should migrate data into translations:

1. Insert EN BookTranslation for each Book
2. Insert EN ChapterTranslation for each Chapter
3. (Optional) Remove old columns afterwards

If you are early and can change quickly:
- prefer moving content fully into translation tables now
- and remove duplicated columns immediately

## Query Patterns (important)

### Get a chapter in language with fallback

- Try `ChapterTranslation(lang)`
- If not found and fallback enabled → use `ChapterTranslation("en")`

SQL-like:

```sql
select ct.*
from chapters c
left join chapter_translations ct
  on ct.chapter_id = c.id and ct.language_code = @lang
left join chapter_translations en
  on en.chapter_id = c.id and en.language_code = 'en'
where c.book_id = @bookId and c.chapter_number = @n
limit 1;
```

In code: prefer 2 queries or a single query with fallback projection.

## SEO Notes for the Data Model

- `BookTranslation.Title` feeds `<title>` and page heading in that language.
- `ChapterTranslation.Title` feeds chapter heading and OG tags.
- If `Title` is null for a chapter translation, generate a default: `Chapter {N}` localized.

---
