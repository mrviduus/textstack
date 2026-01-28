using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddUserBookProgress : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "progress_chapter_slug",
                table: "user_books",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "progress_locator",
                table: "user_books",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "progress_percent",
                table: "user_books",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "progress_updated_at",
                table: "user_books",
                type: "timestamp with time zone",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "progress_chapter_slug",
                table: "user_books");

            migrationBuilder.DropColumn(
                name: "progress_locator",
                table: "user_books");

            migrationBuilder.DropColumn(
                name: "progress_percent",
                table: "user_books");

            migrationBuilder.DropColumn(
                name: "progress_updated_at",
                table: "user_books");
        }
    }
}
