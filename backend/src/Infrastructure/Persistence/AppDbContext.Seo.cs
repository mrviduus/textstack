using Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace Infrastructure.Persistence;

/// <summary>
/// SEO automation: editable Claude templates + per-job audit trail +
/// settings singleton + default `SeoSource = Manual` on SEO-bearing
/// catalog entities (Author, Edition, Genre) so existing rows are
/// flagged as user-curated and protected from auto-overwrite.
/// </summary>
public partial class AppDbContext
{
    private static void ConfigureSeo(ModelBuilder modelBuilder)
    {
        // SeoTemplate — editable Claude prompts per entity_type × field_type × language, version-frozen.
        modelBuilder.Entity<SeoTemplate>(e =>
        {
            e.HasIndex(x => new { x.EntityType, x.FieldType, x.LanguageCode }).IsUnique().HasFilter("is_active");
            e.Property(x => x.LanguageCode).HasMaxLength(8);
            e.Property(x => x.Name).HasMaxLength(200);
            e.Property(x => x.Description).HasMaxLength(500);
            e.Property(x => x.Model).HasMaxLength(100);
            e.Property(x => x.PromptTemplate).HasColumnType("text");
            e.Property(x => x.OutputSchema).HasColumnType("jsonb");
        });

        // SeoBackfillJob — audit trail for every run, frozen template versions enable replay.
        modelBuilder.Entity<SeoBackfillJob>(e =>
        {
            e.HasIndex(x => new { x.Status, x.CreatedAt });
            e.HasIndex(x => new { x.EntityType, x.EntityId });
            e.Property(x => x.TargetFields).HasColumnType("text[]");
            e.Property(x => x.TemplateIds).HasColumnType("uuid[]");
            e.Property(x => x.TemplateVersions).HasColumnType("integer[]");
            e.Property(x => x.TriggeredBy).HasMaxLength(200);
            e.Property(x => x.InputSnapshot).HasColumnType("jsonb");
            e.Property(x => x.RenderedPrompts).HasColumnType("jsonb");
            e.Property(x => x.RawOutputs).HasColumnType("jsonb");
            e.Property(x => x.GeneratedContent).HasColumnType("jsonb");
            e.Property(x => x.BeforeSnapshot).HasColumnType("jsonb");
            e.Property(x => x.AfterSnapshot).HasColumnType("jsonb");
        });

        // seo_source on SEO-bearing entities — default 'Manual' (0) preserves existing rows.
        // These augment the entity configs in Catalog.cs without conflicting; EF merges them.
        modelBuilder.Entity<Author>().Property(x => x.SeoSource).HasDefaultValue(Domain.Enums.SeoSource.Manual);
        modelBuilder.Entity<Edition>().Property(x => x.SeoSource).HasDefaultValue(Domain.Enums.SeoSource.Manual);
        modelBuilder.Entity<Genre>().Property(x => x.SeoSource).HasDefaultValue(Domain.Enums.SeoSource.Manual);
    }
}
