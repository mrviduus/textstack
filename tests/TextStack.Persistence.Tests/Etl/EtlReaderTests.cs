using Dapper;
using Infrastructure.Persistence.Etl;
using Npgsql;

namespace TextStack.Persistence.Tests.Etl;

/// <summary>
/// The SELECT-only <c>etl_reader</c> (<c>database/scripts/etl-reader.sql</c>) and the privilege audit
/// etl-v2 runs on its source role, on disposable legacy databases.
/// </summary>
[Collection("etl_reader")]
public sealed class EtlReaderTests(PostgresFixture legacy, V2PostgresFixture v2)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static string AsAdmin(string cs) => new NpgsqlConnectionStringBuilder(cs) { Username = "postgres", Password = "postgres" }.ConnectionString;

    private async Task<(string Admin, string Reader)> NewSourceAsync()
    {
        var admin = await legacy.NewDatabaseAsync("etl_" + Guid.NewGuid().ToString("N"));
        await ExecAsync(admin, "INSERT INTO users (id, email, google_subject, created_at) VALUES (gen_random_uuid(), 'a@test', NULL, now())");
        return (admin, await legacy.ProvisionEtlReaderAsync(admin));
    }

    [Fact]
    public async Task EtlReader_Select_Succeeds()
    {
        var (_, reader) = await NewSourceAsync();
        await using var conn = new NpgsqlConnection(EtlV2.ReadOnly(reader));

        Assert.Equal(1, await conn.ExecuteScalarAsync<long>(new CommandDefinition("SELECT count(*) FROM users", cancellationToken: Ct)));
    }

    [Theory]
    [InlineData("INSERT INTO users (id, email, google_subject, created_at) VALUES (gen_random_uuid(), 'b@test', NULL, now())", false)]
    [InlineData("INSERT INTO users (id, email, google_subject, created_at) VALUES (gen_random_uuid(), 'b@test', NULL, now())", true)]
    [InlineData("UPDATE users SET email = 'c@test'", false)]
    [InlineData("UPDATE users SET email = 'c@test'", true)]
    [InlineData("DELETE FROM users", false)]
    [InlineData("DELETE FROM users", true)]
    [InlineData("TRUNCATE users", false)]
    [InlineData("TRUNCATE users", true)]
    [InlineData("CREATE TABLE public.etl_probe (id int)", false)]
    [InlineData("CREATE TABLE public.etl_probe (id int)", true)]
    [InlineData("CREATE SCHEMA etl_probe", false)]
    [InlineData("CREATE SCHEMA etl_probe", true)]
    public async Task EtlReader_Write_Fails(string sql, bool readOnlyOff)
    {
        var (admin, reader) = await NewSourceAsync();
        await using var conn = new NpgsqlConnection(EtlV2.ReadOnly(reader));
        await conn.OpenAsync(Ct);
        if (readOnlyOff)
            await conn.ExecuteAsync(new CommandDefinition("SET default_transaction_read_only = off", cancellationToken: Ct));

        var error = await Assert.ThrowsAsync<PostgresException>(() => conn.ExecuteAsync(new CommandDefinition(sql, cancellationToken: Ct)));

        // Read-only first; with that switched off, the role's missing privilege.
        Assert.Equal(readOnlyOff ? PostgresErrorCodes.InsufficientPrivilege : PostgresErrorCodes.ReadOnlySqlTransaction, error.SqlState);
        Assert.Equal(1, await ScalarAsync<long>(admin, "SELECT count(*) FROM users WHERE email = 'a@test'"));
        Assert.False(await ScalarAsync<bool>(admin, "SELECT to_regclass('public.etl_probe') IS NOT NULL OR EXISTS (SELECT FROM pg_namespace WHERE nspname = 'etl_probe')"));
    }

    [Fact]
    public async Task ViolationsAsync_EtlReader_None()
    {
        var (_, reader) = await NewSourceAsync();

        Assert.Empty(await ViolationsAsync(reader));
    }

    [Fact]
    public async Task ViolationsAsync_AppRole_Fails()
    {
        var (admin, _) = await NewSourceAsync();

        Assert.Contains("role attribute SUPERUSER", await ViolationsAsync(admin));
    }

    // {r}: a fresh role with etl_reader's grants on users; the SQL adds one way to write (admin runs it).
    [Theory]
    [InlineData("", null)]
    [InlineData("GRANT INSERT ON users TO {r}", "write on users")]
    [InlineData("GRANT UPDATE (email) ON users TO {r}", "write on users")]
    [InlineData("GRANT TRUNCATE ON users TO PUBLIC", "write on users")]
    [InlineData("CREATE ROLE {r}_w NOLOGIN; GRANT INSERT ON users TO {r}_w; GRANT {r}_w TO {r}", "member of role {r}_w")]
    [InlineData("CREATE ROLE {r}_w NOLOGIN; GRANT {r}_w TO {r} WITH INHERIT FALSE", "member of role {r}_w")]
    [InlineData("GRANT CREATE ON SCHEMA public TO PUBLIC", "CREATE on schema public")]
    [InlineData("GRANT CREATE ON DATABASE {db} TO {r}", "CREATE on database {db}")]
    [InlineData("CREATE SEQUENCE public.s_{r}; GRANT USAGE ON SEQUENCE public.s_{r} TO {r}", "write on sequence s_{r}")]
    [InlineData("CREATE TABLE public.t_{r} (id int); ALTER TABLE public.t_{r} OWNER TO {r}", "owns relation t_{r}")]
    [InlineData("CREATE FUNCTION public.f_{r}() RETURNS void LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'", "callable SECURITY DEFINER function f_{r}()")]
    [InlineData("ALTER ROLE {r} CREATEDB", "role attribute CREATEDB")]
    public async Task ViolationsAsync_OneWayToWrite_Listed(string grant, string? expected)
    {
        var (admin, _) = await NewSourceAsync();
        var role = "etl_probe_" + Guid.NewGuid().ToString("N")[..12];
        var db = new NpgsqlConnectionStringBuilder(admin).Database!;
        string Fill(string s) => s.Replace("{r}", role).Replace("{db}", db);
        await ExecAsync(admin, Fill($"""
            CREATE ROLE {role} LOGIN PASSWORD 'probe-pw' NOINHERIT;
            GRANT CONNECT ON DATABASE {db} TO {role};
            GRANT USAGE ON SCHEMA public TO {role};
            GRANT SELECT ON users TO {role};
            {grant};
            """));

        var violations = await ViolationsAsync(new NpgsqlConnectionStringBuilder(admin) { Username = role, Password = "probe-pw" }.ConnectionString);

        if (expected is null)
            Assert.Empty(violations);
        else
            Assert.Contains(Fill(expected), violations);
    }

    [Fact]
    public async Task RunAsync_SourceRoleCanWrite_RefusedBeforeLedger()
    {
        var (admin, _) = await NewSourceAsync();
        var target = await v2.NewDatabaseAsync("etl_" + Guid.NewGuid().ToString("N"));

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => EtlV2.RunAsync(new EtlV2Options(admin, target, DryRun: false), [], Ct));

        Assert.Contains("can write (", error.Message);
        Assert.Contains("etl_reader", error.Message);
        Assert.Equal(0, await ScalarAsync<long>(target, "SELECT count(*) FROM migration_runs"));
    }

    [Fact]
    public async Task RunAsync_PasswordsFromPassfiles_Runs()
    {
        // libpq's pgpass format via Npgsql's Passfile: the password is in neither the string nor argv.
        var (_, reader) = await NewSourceAsync();
        var target = await v2.NewDatabaseAsync("etl_" + Guid.NewGuid().ToString("N"));
        var passfile = Path.Combine(Path.GetTempPath(), "etl-" + Guid.NewGuid().ToString("N") + ".pgpass");
        await File.WriteAllTextAsync(passfile, $"*:*:*:etl_reader:{PostgresFixture.EtlReaderPassword}\n*:*:*:postgres:postgres\n", Ct);
        try
        {
            string NoPassword(string cs) => new NpgsqlConnectionStringBuilder(cs) { Password = null, Passfile = passfile }.ConnectionString;

            var report = await EtlV2.RunAsync(new EtlV2Options(NoPassword(reader), NoPassword(target), DryRun: false), [], Ct);

            Assert.Equal(1, report.SourceCounts["users"]);
            Assert.NotNull(report.RunId);
        }
        finally
        {
            File.Delete(passfile);
        }
    }

    private static async Task<IReadOnlyList<string>> ViolationsAsync(string cs)
    {
        await using var conn = new NpgsqlConnection(cs);
        await conn.OpenAsync(Ct);
        return await EtlV2SourceAudit.ViolationsAsync(conn, null, Ct);
    }

    private static async Task ExecAsync(string cs, string sql)
    {
        await using var conn = new NpgsqlConnection(AsAdmin(cs));
        await conn.ExecuteAsync(new CommandDefinition(sql, cancellationToken: Ct));
    }

    private static async Task<T> ScalarAsync<T>(string cs, string sql)
    {
        await using var conn = new NpgsqlConnection(AsAdmin(cs));
        return (await conn.ExecuteScalarAsync<T>(new CommandDefinition(sql, cancellationToken: Ct)))!;
    }
}
