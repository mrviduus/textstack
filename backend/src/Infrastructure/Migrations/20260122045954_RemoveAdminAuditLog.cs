using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class RemoveAdminAuditLog : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "admin_audit_logs");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "admin_audit_logs",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    admin_user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    action_type = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    entity_id = table.Column<Guid>(type: "uuid", nullable: true),
                    entity_type = table.Column<string>(type: "text", nullable: false),
                    payload_json = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_admin_audit_logs", x => x.id);
                    table.ForeignKey(
                        name: "fk_admin_audit_logs_admin_users_admin_user_id",
                        column: x => x.admin_user_id,
                        principalTable: "admin_users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_admin_audit_logs_action_type",
                table: "admin_audit_logs",
                column: "action_type");

            migrationBuilder.CreateIndex(
                name: "ix_admin_audit_logs_admin_user_id",
                table: "admin_audit_logs",
                column: "admin_user_id");

            migrationBuilder.CreateIndex(
                name: "ix_admin_audit_logs_created_at",
                table: "admin_audit_logs",
                column: "created_at");
        }
    }
}
