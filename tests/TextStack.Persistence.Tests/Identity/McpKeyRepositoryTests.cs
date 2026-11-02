using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>The contract on V2, and what only V2 has: the password-reset stamp (#1092).</summary>
public class McpKeyRepositoryTests(V2PostgresFixture db) : McpKeyRepositoryContract(db, new McpKeyRepository(db.DataSource))
{
    private readonly McpKeyRepository _repo = new(db.DataSource);

    [Fact]
    public async Task CreateAsync_ResetCommitsWhileItWaits_StoresNothing()
    {
        // #1092: an access token minted before the reset asks for a key; the reset holds the user and
        // has stamped it, not yet committed.
        var user = await db.NewReaderAsync();

        var (waited, key) = await db.WhileUserHeldAsync(user, "UPDATE users SET credentials_reset_at = now() WHERE id = @user;",
            () => _repo.CreateAsync(user, "laptop", NewHash(), "tsk_ab", DateTimeOffset.UtcNow.AddMinutes(-1), Ct));

        Assert.True(waited);
        Assert.Null(key);
        Assert.Equal(0L, await db.CountAsync("mcp_access_keys", user));
    }
}
