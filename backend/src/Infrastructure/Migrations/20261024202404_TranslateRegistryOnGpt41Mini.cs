using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <summary>
    /// docs/incidents/2026-10-24-translation-down-on-a-retired-model.md. OpenAI retired gpt-4.1-nano and
    /// the default moved to gpt-4.1-mini; <c>ModelRegistrySeeder</c> only fills an empty table, so the
    /// existing translate row still named nano. Label only (routing reads the provider key), but the
    /// admin registry should say what is served. Skips if a mini row already exists (unique index).
    /// </summary>
    public partial class TranslateRegistryOnGpt41Mini : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                UPDATE models SET model_id = 'gpt-4.1-mini'
                WHERE feature_tag = 'translate' AND provider_key = 'openai' AND model_id = 'gpt-4.1-nano'
                  AND NOT EXISTS (SELECT 1 FROM models
                                  WHERE feature_tag = 'translate' AND provider_key = 'openai' AND model_id = 'gpt-4.1-mini');
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                UPDATE models SET model_id = 'gpt-4.1-nano'
                WHERE feature_tag = 'translate' AND provider_key = 'openai' AND model_id = 'gpt-4.1-mini'
                  AND NOT EXISTS (SELECT 1 FROM models
                                  WHERE feature_tag = 'translate' AND provider_key = 'openai' AND model_id = 'gpt-4.1-nano');
                """);
        }
    }
}
