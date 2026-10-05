using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class HashRefreshTokens : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.RenameColumn(
                name: "token",
                table: "user_refresh_tokens",
                newName: "token_hash");

            migrationBuilder.RenameIndex(
                name: "ix_user_refresh_tokens_token",
                table: "user_refresh_tokens",
                newName: "ix_user_refresh_tokens_token_hash");

            migrationBuilder.RenameColumn(
                name: "token",
                table: "admin_refresh_tokens",
                newName: "token_hash");

            migrationBuilder.RenameIndex(
                name: "ix_admin_refresh_tokens_token",
                table: "admin_refresh_tokens",
                newName: "ix_admin_refresh_tokens_token_hash");

            // Hash the live tokens in place so every session survives the deploy. Must equal
            // DeviceCodes.HashToken (lowercase hex SHA-256 of the UTF-8 bytes); a unit test pins
            // a sample produced by this exact expression.
            migrationBuilder.Sql(
                "UPDATE user_refresh_tokens SET token_hash = encode(sha256(convert_to(token_hash, 'UTF8')), 'hex');");
            migrationBuilder.Sql(
                "UPDATE admin_refresh_tokens SET token_hash = encode(sha256(convert_to(token_hash, 'UTF8')), 'hex');");

            migrationBuilder.AddColumn<string>(
                name: "previous_token_hash",
                table: "user_refresh_tokens",
                type: "text",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "ix_user_refresh_tokens_previous_token_hash",
                table: "user_refresh_tokens",
                column: "previous_token_hash");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // A hash cannot be turned back into the token, so after a rollback every stored
            // refresh token is unusable and everyone signs in again.

            migrationBuilder.DropIndex(
                name: "ix_user_refresh_tokens_previous_token_hash",
                table: "user_refresh_tokens");

            migrationBuilder.DropColumn(
                name: "previous_token_hash",
                table: "user_refresh_tokens");

            migrationBuilder.RenameColumn(
                name: "token_hash",
                table: "user_refresh_tokens",
                newName: "token");

            migrationBuilder.RenameIndex(
                name: "ix_user_refresh_tokens_token_hash",
                table: "user_refresh_tokens",
                newName: "ix_user_refresh_tokens_token");

            migrationBuilder.RenameColumn(
                name: "token_hash",
                table: "admin_refresh_tokens",
                newName: "token");

            migrationBuilder.RenameIndex(
                name: "ix_admin_refresh_tokens_token_hash",
                table: "admin_refresh_tokens",
                newName: "ix_admin_refresh_tokens_token");
        }
    }
}
