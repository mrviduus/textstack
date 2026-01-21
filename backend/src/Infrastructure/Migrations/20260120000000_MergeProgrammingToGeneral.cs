using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <summary>
    /// ADR-007: Merge programming books into general site (single domain consolidation).
    /// </summary>
    public partial class MergeProgrammingToGeneral : Migration
    {
        private static readonly Guid GeneralSiteId = new("11111111-1111-1111-1111-111111111111");
        private static readonly Guid ProgrammingSiteId = new("22222222-2222-2222-2222-222222222222");

        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // 1. Disable indexing on programming site (it will become admin-only)
            migrationBuilder.Sql($@"
                UPDATE sites
                SET indexing_enabled = false,
                    sitemap_enabled = false,
                    updated_at = NOW()
                WHERE id = '{ProgrammingSiteId}'
            ");

            // 2. Resolve author slug conflicts (append '-prog' suffix)
            migrationBuilder.Sql($@"
                UPDATE authors
                SET slug = slug || '-prog'
                WHERE site_id = '{ProgrammingSiteId}'
                  AND slug IN (
                    SELECT slug FROM authors WHERE site_id = '{GeneralSiteId}'
                  )
            ");

            // 3. Resolve genre slug conflicts
            migrationBuilder.Sql($@"
                UPDATE genres
                SET slug = slug || '-prog'
                WHERE site_id = '{ProgrammingSiteId}'
                  AND slug IN (
                    SELECT slug FROM genres WHERE site_id = '{GeneralSiteId}'
                  )
            ");

            // 4. Resolve work slug conflicts
            migrationBuilder.Sql($@"
                UPDATE works
                SET slug = slug || '-prog'
                WHERE site_id = '{ProgrammingSiteId}'
                  AND slug IN (
                    SELECT slug FROM works WHERE site_id = '{GeneralSiteId}'
                  )
            ");

            // 5. Resolve edition slug conflicts (per language)
            migrationBuilder.Sql($@"
                UPDATE editions e
                SET slug = e.slug || '-prog'
                FROM editions existing
                WHERE e.site_id = '{ProgrammingSiteId}'
                  AND existing.site_id = '{GeneralSiteId}'
                  AND e.slug = existing.slug
                  AND e.language = existing.language
            ");

            // 6. Migrate all authors to general site
            migrationBuilder.Sql($@"
                UPDATE authors
                SET site_id = '{GeneralSiteId}'
                WHERE site_id = '{ProgrammingSiteId}'
            ");

            // 7. Migrate all genres to general site
            migrationBuilder.Sql($@"
                UPDATE genres
                SET site_id = '{GeneralSiteId}'
                WHERE site_id = '{ProgrammingSiteId}'
            ");

            // 8. Migrate all works to general site
            migrationBuilder.Sql($@"
                UPDATE works
                SET site_id = '{GeneralSiteId}'
                WHERE site_id = '{ProgrammingSiteId}'
            ");

            // 9. Migrate all editions to general site
            migrationBuilder.Sql($@"
                UPDATE editions
                SET site_id = '{GeneralSiteId}'
                WHERE site_id = '{ProgrammingSiteId}'
            ");

            // 10. Migrate user reading progress
            migrationBuilder.Sql($@"
                UPDATE reading_progress
                SET site_id = '{GeneralSiteId}'
                WHERE site_id = '{ProgrammingSiteId}'
            ");

            // 11. Migrate bookmarks
            migrationBuilder.Sql($@"
                UPDATE bookmarks
                SET site_id = '{GeneralSiteId}'
                WHERE site_id = '{ProgrammingSiteId}'
            ");

            // 12. Migrate notes (if any)
            migrationBuilder.Sql($@"
                UPDATE notes
                SET site_id = '{GeneralSiteId}'
                WHERE site_id = '{ProgrammingSiteId}'
            ");

            // 13. Migrate textstack imports
            migrationBuilder.Sql($@"
                UPDATE textstack_imports
                SET site_id = '{GeneralSiteId}'
                WHERE site_id = '{ProgrammingSiteId}'
            ");

            // 14. Delete SEO crawl results for programming site jobs
            migrationBuilder.Sql($@"
                DELETE FROM seo_crawl_results
                WHERE job_id IN (
                    SELECT id FROM seo_crawl_jobs WHERE site_id = '{ProgrammingSiteId}'
                )
            ");

            // 15. Delete SEO crawl jobs for programming site
            migrationBuilder.Sql($@"
                DELETE FROM seo_crawl_jobs
                WHERE site_id = '{ProgrammingSiteId}'
            ");

            // 16. Delete programming site domains
            migrationBuilder.Sql($@"
                DELETE FROM site_domains
                WHERE site_id = '{ProgrammingSiteId}'
            ");

            // 17. Delete programming site (no longer needed)
            migrationBuilder.Sql($@"
                DELETE FROM sites
                WHERE id = '{ProgrammingSiteId}'
            ");
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Cannot safely reverse - would need to track which items came from programming site.
            // For rollback, restore from backup.
            throw new InvalidOperationException(
                "This migration cannot be reversed automatically. Restore from backup if rollback is needed.");
        }
    }
}
