using Dapper;
using Npgsql;

namespace Infrastructure.Persistence.Etl;

/// <summary>
/// Can the role etl-v2 reads the source as write anything that persists? The connection's read-only
/// default is one safeguard; this is the other: the role itself (<c>database/scripts/etl-reader.sql</c>)
/// must not be able to, whatever a session sets. Checked on the role's effective privileges:
/// attributes, memberships (inherited or SET ROLE-able), ownership, and every grant incl. PUBLIC's.
/// Not checked, by decision (runbook docs/03-ops/v2-etl.md): TEMP (non-persistent) and the large-object
/// functions PUBLIC may execute — closing either means revoking from PUBLIC, i.e. from the app too.
/// </summary>
public static class EtlV2SourceAudit
{
    // One row per way the current role could write; none = it passes.
    private const string Violations = """
        WITH me AS (SELECT oid FROM pg_roles WHERE rolname = current_user),
        user_schemas AS (
            SELECT oid, nspname FROM pg_namespace
            WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg\_toast%' AND nspname NOT LIKE 'pg\_temp\_%'
        )
        SELECT 'role attribute ' || a.name FROM me JOIN pg_roles r ON r.oid = me.oid,
            LATERAL (VALUES ('SUPERUSER', r.rolsuper), ('CREATEROLE', r.rolcreaterole), ('CREATEDB', r.rolcreatedb),
                            ('REPLICATION', r.rolreplication), ('BYPASSRLS', r.rolbypassrls)) AS a(name, held)
            WHERE a.held
        UNION ALL
        -- MEMBER, not USAGE: a role it can SET ROLE to counts, inherited or not.
        SELECT 'member of role ' || r.rolname FROM me, pg_roles r WHERE r.oid <> me.oid AND pg_has_role(me.oid, r.oid, 'MEMBER')
        UNION ALL
        SELECT 'owns database ' || d.datname FROM me, pg_database d WHERE d.datdba = me.oid
        UNION ALL
        SELECT 'owns schema ' || n.nspname FROM me, pg_namespace n WHERE n.nspowner = me.oid
        UNION ALL
        SELECT 'owns relation ' || c.oid::regclass FROM me, pg_class c WHERE c.relowner = me.oid
        UNION ALL
        SELECT 'owns function ' || p.oid::regprocedure FROM me, pg_proc p WHERE p.proowner = me.oid
        UNION ALL
        SELECT 'CREATE on database ' || d.datname FROM pg_database d WHERE has_database_privilege(d.oid, 'CREATE')
        UNION ALL
        SELECT 'CREATE on schema ' || n.nspname FROM user_schemas n WHERE has_schema_privilege(n.oid, 'CREATE')
        UNION ALL
        SELECT 'write on ' || c.oid::regclass FROM pg_class c JOIN user_schemas n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND (has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                   OR has_any_column_privilege(c.oid, 'INSERT, UPDATE, REFERENCES'))
        UNION ALL
        -- USAGE allows nextval(), which persists.
        SELECT 'write on sequence ' || c.oid::regclass FROM pg_class c JOIN user_schemas n ON n.oid = c.relnamespace
            WHERE CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(c.oid, 'USAGE, UPDATE') ELSE false END
        UNION ALL
        -- Runs as its owner, so it writes with the owner's rights; any owner but the role itself (caught above).
        SELECT 'callable SECURITY DEFINER function ' || p.oid::regprocedure FROM me, pg_proc p
            WHERE p.prosecdef AND p.proowner <> me.oid AND has_function_privilege(p.oid, 'EXECUTE')
        ORDER BY 1
        """;

    /// <summary>The ways the connection's role could write; empty = SELECT-only.</summary>
    public static async Task<IReadOnlyList<string>> ViolationsAsync(NpgsqlConnection conn, NpgsqlTransaction? tx, CancellationToken ct) =>
        (await conn.QueryAsync<string>(new CommandDefinition(Violations, transaction: tx, cancellationToken: ct))).AsList();
}
