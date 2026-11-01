using Application.Identity;
using Dapper;
using Domain.Identity;
using Infrastructure.Persistence.Repositories;
using Npgsql;
using TextStack.Persistence.Tests.Ops;

namespace TextStack.Persistence.Tests.Identity;

public class UserRepositoryTests(V2PostgresFixture db)
{
    private readonly UserRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Every V2 table that can carry a user, books' and identity's alike: the DoD's list.</summary>
    private static readonly string[] UserTables =
    [
        "books", "book_files", "reading_state", "reading_sessions", "annotations",
        "vocabulary_words", "vocabulary_examples", "vocabulary_reviews",
        "shared_chapters", "discussion_checkpoints", "book_insight", "review_question",
        "user_refresh_tokens", "password_reset_tokens", "oauth_authorization_requests", "oauth_grants",
        "device_authorizations", "mcp_access_keys", "agent_run", "book_chapters", "ingestion_jobs",
    ];

    private static UserAccount Account(string? email = null, bool isGuest = false) => new()
    {
        Id = Guid.NewGuid(),
        Email = email ?? $"{Guid.NewGuid()}@test",
        Name = "Reader",
        IsGuest = isGuest,
    };

    private async Task<UserAccount> CreatedAsync(bool isGuest = false) => (await _repo.CreateAsync(Account(isGuest: isGuest), Ct))!;

    [Fact]
    public async Task DeleteAsync_Account_EveryV2TableOfThatUserIsEmpty()
    {
        var alice = await db.NewReaderAsync();
        var bob = await db.NewReaderAsync();
        await SeedAllAsync(alice);
        await SeedAllAsync(bob);
        foreach (var table in UserTables)
            Assert.True(await db.CountAsync(table, alice) > 0, $"the seed left {table} empty");

        // DeleteAsync is one autocommit statement, and its commit is the deferred-constraint check
        // ADR-031 rule 9 asks for: there is no transaction of the test's to end with SET CONSTRAINTS
        // ALL IMMEDIATE without a tx parameter on the port (#1067). A deferred FK the cascade left
        // dangling would fail here, at that commit.
        Assert.True(await _repo.DeleteAsync(alice, Ct));

        foreach (var table in UserTables)
        {
            Assert.Equal((table, 0L), (table, await db.CountAsync(table, alice)));
            Assert.Equal((table, table == "reading_sessions" ? 2L : 1L), (table, await db.CountAsync(table, bob)));
        }
        Assert.Null(await _repo.GetAsync(alice, Ct));
        // No FK by design: the trace keeps its cost history after the account is gone.
        Assert.Equal(1L, await db.CountAsync("llm_traces", alice));
    }

    [Fact]
    public async Task DeleteFromUsers_ConstraintsImmediateBeforeTheDelete_IsRefusedByAProvenanceFk()
    {
        // ponytail: provenance FKs to books are NO ACTION; CASCADE in a later migration if a caller ever needs immediate constraints (#1089).
        // Checked immediately, the books cascade's check on an example runs before the words
        // cascade has removed that example; deferred to the commit, both cascades have run.
        var alice = await db.NewReaderAsync();
        await db.SeedEverythingAsync(alice);
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await conn.BeginTransactionAsync(Ct);

        var error = await Assert.ThrowsAsync<PostgresException>(() => conn.ExecuteAsync(new CommandDefinition(
            "SET CONSTRAINTS ALL IMMEDIATE; DELETE FROM users WHERE id = @alice", new { alice }, tx, cancellationToken: Ct)));

        Assert.Equal(("23503", "fk_vocabulary_examples_books_user_id_book_id"), (error.SqlState, error.ConstraintName));
    }

    [Fact]
    public async Task DeleteAsync_NoSuchAccount_ReturnsFalse() =>
        Assert.False(await _repo.DeleteAsync(Guid.NewGuid(), Ct));

    [Fact]
    public async Task CreateAsync_Guest_StoresAGuestReader()
    {
        var created = (await _repo.CreateAsync(Account(isGuest: true), Ct))!;

        var read = (await _repo.GetAsync(created.Id, Ct))!;
        Assert.Equal((true, UserAccount.ReaderRole, "Free"), (read.IsGuest, read.Role, read.Tier));
    }

    [Fact]
    public async Task CreateAsync_EmailTakenInAnotherCase_ReturnsNullAndStoresNothing()
    {
        var first = await CreatedAsync();
        var second = Account(first.Email.ToUpperInvariant());

        Assert.Null(await _repo.CreateAsync(second, Ct));
        Assert.Null(await _repo.GetAsync(second.Id, Ct));
    }

    [Fact]
    public async Task GetByEmailAsync_DifferentCase_FindsTheAccount()
    {
        var account = await CreatedAsync();

        Assert.Equal(account.Id, (await _repo.GetByEmailAsync(account.Email.ToUpperInvariant(), Ct))?.Id);
    }


    [Fact]
    public async Task GetByGoogleSubjectAsync_KnownSubject_ReturnsTheAccount()
    {
        var account = Account();
        account.GoogleSubject = Guid.NewGuid().ToString();
        await _repo.CreateAsync(account, Ct);

        Assert.Equal(account.Id, (await _repo.GetByGoogleSubjectAsync(account.GoogleSubject, Ct))?.Id);
    }

    [Fact]
    public async Task GetByAppleSubjectAsync_KnownSubject_ReturnsTheAccount()
    {
        var account = Account();
        account.AppleSubject = Guid.NewGuid().ToString();
        await _repo.CreateAsync(account, Ct);

        Assert.Equal(account.Id, (await _repo.GetByAppleSubjectAsync(account.AppleSubject, Ct))?.Id);
    }

    [Fact]
    public async Task UpdateProfileAsync_Account_ReplacesEmailNameAndPicture()
    {
        var account = await CreatedAsync();
        var email = $"{Guid.NewGuid()}@new";

        var result = await _repo.UpdateProfileAsync(account.Id, email, "New", "https://pic", Ct);

        Assert.Equal(AccountUpdateOutcome.Updated, result.Outcome);
        var read = (await _repo.GetAsync(account.Id, Ct))!;
        Assert.Equal((email, "New", "https://pic"), (read.Email, read.Name, read.Picture));
    }

    [Fact]
    public async Task UpdateProfileAsync_NoSuchAccount_IsNotFound() =>
        Assert.Equal(AccountUpdateOutcome.NotFound, (await _repo.UpdateProfileAsync(Guid.NewGuid(), $"{Guid.NewGuid()}@x", null, null, Ct)).Outcome);

    [Fact]
    public async Task UpdateProfileAsync_AnotherAccountsEmailInAnotherCase_IsEmailTakenAndChangesNothing()
    {
        var (account, other) = (await CreatedAsync(), await CreatedAsync());

        var result = await _repo.UpdateProfileAsync(account.Id, other.Email.ToUpperInvariant(), "New", null, Ct);

        Assert.Equal((AccountUpdateOutcome.EmailTaken, (UserAccount?)null), (result.Outcome, result.Account));
        Assert.Equal(account.Email, (await _repo.GetAsync(account.Id, Ct))!.Email);
    }

    [Fact]
    public async Task UpdateProfileAsync_Alice_LeavesBobUntouched()
    {
        var (alice, bob) = (await CreatedAsync(), await CreatedAsync());

        await _repo.UpdateProfileAsync(alice.Id, $"{Guid.NewGuid()}@new", "New", null, Ct);

        var read = (await _repo.GetAsync(bob.Id, Ct))!;
        Assert.Equal((bob.Email, bob.Name), (read.Email, read.Name));
    }

    [Fact]
    public async Task PromoteGuestAsync_Guest_BecomesAnAccountKeepingItsId()
    {
        var guest = await CreatedAsync(isGuest: true);
        var email = $"{Guid.NewGuid()}@promoted";

        var promoted = (await _repo.PromoteGuestAsync(guest.Id, email, "Ann", "hash", Ct)).Account!;

        Assert.Equal((guest.Id, email, "Ann", "hash", false), (promoted.Id, promoted.Email, promoted.Name, promoted.PasswordHash, promoted.IsGuest));
        Assert.NotNull(promoted.PromotedAt);
    }

    [Fact]
    public async Task PromoteGuestAsync_NotAGuest_IsNotFoundAndChangesNothing()
    {
        var account = await CreatedAsync();

        Assert.Equal(AccountUpdateOutcome.NotFound, (await _repo.PromoteGuestAsync(account.Id, $"{Guid.NewGuid()}@x", "Ann", "hash", Ct)).Outcome);
        Assert.Equal(account.Email, (await _repo.GetAsync(account.Id, Ct))!.Email);
    }

    [Fact]
    public async Task PromoteGuestAsync_AnotherAccountsEmail_IsEmailTakenAndStaysAGuest()
    {
        var (taken, guest) = (await CreatedAsync(), await CreatedAsync(isGuest: true));

        Assert.Equal(AccountUpdateOutcome.EmailTaken, (await _repo.PromoteGuestAsync(guest.Id, taken.Email, "Ann", "hash", Ct)).Outcome);
        Assert.True((await _repo.GetAsync(guest.Id, Ct))!.IsGuest);
    }

    [Fact]
    public async Task PromoteGuestAsync_Alice_LeavesBobAGuest()
    {
        var (alice, bob) = (await CreatedAsync(isGuest: true), await CreatedAsync(isGuest: true));

        await _repo.PromoteGuestAsync(alice.Id, $"{Guid.NewGuid()}@x", null, "hash", Ct);

        var read = (await _repo.GetAsync(bob.Id, Ct))!;
        Assert.Equal((true, bob.Email, (string?)null), (read.IsGuest, read.Email, read.PasswordHash));
    }

    [Fact]
    public async Task ClearGuestFlagAsync_Guest_ClearsItAndNotTwice()
    {
        var guest = await CreatedAsync(isGuest: true);

        Assert.True(await _repo.ClearGuestFlagAsync(guest.Id, Ct));

        Assert.False((await _repo.GetAsync(guest.Id, Ct))!.IsGuest);
        Assert.False(await _repo.ClearGuestFlagAsync(guest.Id, Ct));
    }

    [Fact]
    public async Task ClearGuestFlagAsync_Alice_LeavesBobAGuest()
    {
        var (alice, bob) = (await CreatedAsync(isGuest: true), await CreatedAsync(isGuest: true));

        await _repo.ClearGuestFlagAsync(alice.Id, Ct);

        Assert.True((await _repo.GetAsync(bob.Id, Ct))!.IsGuest);
    }

    [Fact]
    public async Task SetRoleAsync_Admin_IsReadBackOnTheAccount()
    {
        var account = await CreatedAsync();

        Assert.True(await _repo.SetRoleAsync(account.Id, UserAccount.AdminRole, Ct));

        Assert.Equal(UserAccount.AdminRole, (await _repo.GetByEmailAsync(account.Email, Ct))!.Role);
    }

    [Fact]
    public async Task SetRoleAsync_Alice_LeavesBobAReader()
    {
        var (alice, bob) = (await CreatedAsync(), await CreatedAsync());

        await _repo.SetRoleAsync(alice.Id, UserAccount.AdminRole, Ct);

        Assert.Equal(UserAccount.ReaderRole, (await _repo.GetAsync(bob.Id, Ct))!.Role);
    }

    /// <summary>
    /// The book side from the fixture's seed, plus one row in every identity and ops table that names
    /// the user: a session, a reset code, an approved OAuth request, a grant, an approved device
    /// login, a connect key, an agent run, and an LLM trace (the one that must survive).
    /// </summary>
    private async Task SeedAllAsync(Guid userId)
    {
        await db.SeedEverythingAsync(userId);
        var hash = Guid.NewGuid().ToString();
        var sessions = new SessionTokenRepository(db.DataSource);
        await sessions.IssueAsync(userId, "s" + hash, DateTimeOffset.UtcNow.AddDays(1), Ct);
        await sessions.CreatePasswordResetAsync(userId, "r" + hash, DateTimeOffset.UtcNow.AddHours(1), Ct);
        var oauth = new OAuthRepository(db.DataSource);
        var request = OAuthRepositoryTests.Request();
        await oauth.CreateRequestAsync(request, Ct);
        await oauth.ApproveRequestAsync(request.Id, userId, "c" + hash, DateTimeOffset.UtcNow.AddMinutes(5), DateTimeOffset.UtcNow, Ct);
        await oauth.ConnectAsync(userId, OAuthRepositoryTests.Grant(), Ct);
        var devices = new DeviceLoginRepository(db.DataSource);
        var login = DeviceLoginRepositoryTests.Login();
        await devices.CreateAsync(login, Ct);
        await devices.DecideAsync(login.UserCode, userId, DateTimeOffset.UtcNow, Ct);
        await new McpKeyRepository(db.DataSource).CreateAsync(userId, "laptop", "k" + hash, "tsk_ab", Ct);
        await new V2AgentRunWriter(db.DataSource).WriteAsync(OpsWritersTests.Run(userId), Ct);
        await new V2LlmTraceWriter(db.DataSource).WriteAsync(OpsWritersTests.Trace(userId), Ct);
    }
}
