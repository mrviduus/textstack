using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddEditionFeaturedRank : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "featured_rank",
                table: "editions",
                type: "integer",
                nullable: true);

            // Starting shelf; missing slugs are no-ops. Order = rank.
            migrationBuilder.Sql("""
                UPDATE editions e
                SET featured_rank = s.ord::int
                FROM unnest(ARRAY[
                    'nineteen-eighty-four', 'animal-farm', 'the-metamorphosis', 'the-trial',
                    'crime-and-punishment', 'pride-and-prejudice', 'the-plague', 'anna-karenina',
                    'the-brothers-karamazov', 'dracula', 'the-castle', 'war-and-peace',
                    'wuthering-heights', 'great-expectations', 'alices-adventures-in-wonderland'
                ]) WITH ORDINALITY AS s(slug, ord)
                WHERE e.slug = s.slug;
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "featured_rank",
                table: "editions");
        }
    }
}
