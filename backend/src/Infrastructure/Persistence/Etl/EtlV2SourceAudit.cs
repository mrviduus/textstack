using Dapper;
using Npgsql;

namespace Infrastructure.Persistence.Etl;

/// <summary>
/// Can the login etl-v2 reads the source as write anything that persists? The connection's read-only
/// default is one safeguard; this is the other: the role itself (<c>database/scripts/etl-reader.sql</c>)
/// must not be able to, whatever a session sets. Checked for <c>session_user</c>, the login, not
/// <c>current_user</c>: <c>RESET ROLE</c> returns a session to its login's powers, so a writer login
/// connected with <c>-c role=etl_reader</c> fails. Effective privileges: attributes, memberships
/// (inherited or SET ROLE-able), ownership of anything, and every grant incl. PUBLIC's.
/// Not checked, by decision (runbook docs/03-ops/v2-etl.md): TEMP (non-persistent) and the large-object
/// functions PUBLIC may execute — closing either means revoking from PUBLIC, i.e. from the app too.
/// </summary>
public static class EtlV2SourceAudit
{
    private const string Login = "SELECT session_user::text";

    // One row per way the login could write; none = it passes.
    private const string Violations = """
        WITH me AS (SELECT oid FROM pg_roles WHERE rolname = session_user),
        user_schemas AS (
            SELECT oid, nspname FROM pg_namespace
            WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg\_toast%' AND nspname NOT LIKE 'pg\_temp\_%'
        )
        SELECT 'session runs as role ' || current_user || ', not its login' WHERE current_user <> session_user
        UNION ALL
        SELECT 'role attribute ' || a.name FROM me JOIN pg_roles r ON r.oid = me.oid,
            LATERAL (VALUES ('SUPERUSER', r.rolsuper), ('CREATEROLE', r.rolcreaterole), ('CREATEDB', r.rolcreatedb),
                            ('REPLICATION', r.rolreplication), ('BYPASSRLS', r.rolbypassrls)) AS a(name, held)
            WHERE a.held
        UNION ALL
        -- MEMBER, not USAGE: a role it can SET ROLE to counts, inherited or not.
        SELECT 'member of role ' || r.rolname FROM me, pg_roles r WHERE r.oid <> me.oid AND pg_has_role(me.oid, r.oid, 'MEMBER')
        UNION ALL
        -- Every object it owns, of any kind, in any database (pg_shdepend 'o'); described where the catalog is at hand.
        SELECT 'owns ' || CASE WHEN d.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
                               THEN pg_describe_object(d.classid, d.objid, 0)
                               ELSE 'an object in database ' || coalesce((SELECT datname FROM pg_database WHERE oid = d.dbid), d.dbid::text) END
            FROM me, pg_shdepend d
            WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = me.oid AND d.deptype = 'o'
        UNION ALL
        SELECT 'CREATE on database ' || d.datname FROM pg_database d WHERE has_database_privilege(session_user, d.oid, 'CREATE')
        UNION ALL
        SELECT 'CREATE on schema ' || n.nspname FROM user_schemas n WHERE has_schema_privilege(session_user, n.oid, 'CREATE')
        UNION ALL
        SELECT 'write on ' || c.oid::regclass FROM pg_class c JOIN user_schemas n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND (has_table_privilege(session_user, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                   OR has_any_column_privilege(session_user, c.oid, 'INSERT, UPDATE, REFERENCES'))
        UNION ALL
        -- USAGE allows nextval(), which persists. CASE: the planner may call it before the relkind filter.
        SELECT 'write on sequence ' || c.oid::regclass FROM pg_class c JOIN user_schemas n ON n.oid = c.relnamespace
            WHERE CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(session_user, c.oid, 'USAGE, UPDATE') ELSE false END
        UNION ALL
        -- Runs as its owner, so it writes with the owner's rights; any owner but the login itself (caught above).
        SELECT 'callable SECURITY DEFINER function ' || p.oid::regprocedure FROM me, pg_proc p
            WHERE p.prosecdef AND p.proowner <> me.oid AND has_function_privilege(session_user, p.oid, 'EXECUTE')
        ORDER BY 1
        """;

    /// <summary>The login (from the server, not the connection string) and the ways it could write; none = SELECT-only.</summary>
    public static async Task<(string Login, IReadOnlyList<string> Violations)> AuditAsync(NpgsqlConnection conn, NpgsqlTransaction? tx, CancellationToken ct)
    {
        var login = await conn.ExecuteScalarAsync<string>(new CommandDefinition(Login, transaction: tx, cancellationToken: ct));
        var violations = await conn.QueryAsync<string>(new CommandDefinition(Violations, transaction: tx, cancellationToken: ct));
        return (login!, violations.AsList());
    }
}
