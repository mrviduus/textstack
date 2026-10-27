using Domain.Entities;
using Domain.Enums;

namespace Application.Seo;

/// <summary>
/// The template key (entity, field, language): versions of one key share it, and at most one of
/// them is active (ix_seo_templates_entity_type_field_type_language_code). One spelling, so the
/// key cannot drift between the queries that use it.
/// </summary>
public static class SeoTemplateQueries
{
    public static IQueryable<SeoTemplate> ForKey(this IQueryable<SeoTemplate> q,
        SeoEntityType entityType, SeoFieldType fieldType, string languageCode) =>
        q.Where(t => t.EntityType == entityType && t.FieldType == fieldType && t.LanguageCode == languageCode);

    public static IQueryable<SeoTemplate> ActiveForKey(this IQueryable<SeoTemplate> q,
        SeoEntityType entityType, SeoFieldType fieldType, string languageCode) =>
        q.ForKey(entityType, fieldType, languageCode).Where(t => t.IsActive);
}
