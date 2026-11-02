using Application.Auth;
using Application.Identity;
using Domain.Identity;
using Infrastructure.Persistence.Repositories;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>
/// <see cref="V2AuthService"/> and <see cref="V2AdminAuthService"/> on the real V2 schema and repositories
/// (plan §8 "auth integration tests"), with a settable clock and Google/Apple stood in for.
/// </summary>
public class V2AuthServiceTests(V2PostgresFixture db)
{
    private const string Password = "correct horse battery";
    private const int AccountDays = 30;
    private const int GuestDays = 7;

    private readonly Clock _clock = new();
    private readonly FakeProviders _tokens = new();
    private readonly UserRepository _users = new(db.DataSource);
    private readonly SessionTokenRepository _sessions = new(db.DataSource);
    private readonly DeviceLoginRepository _devices = new(db.DataSource);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private V2AuthService Auth => AuthWith();

    private V2AuthService AuthWith(IUserRepository? users = null, ISessionTokenRepository? sessions = null, IAccountMergeRepository? merges = null) =>
        new(users ?? _users, sessions ?? _sessions, _devices, merges ?? new AccountMergeRepository(db.DataSource),
            _tokens, _clock, NullLogger<V2AuthService>.Instance);

    private V2AdminAuthService Admin => new(_users, _sessions, new AdminSettingsRepository(db.DataSource), _tokens, _clock);

    private static string NewEmail() => $"{Guid.NewGuid():N}@example.test";

    private async Task<(AuthResult Result, string Email)> RegisterAsync(Guid? guestId = null)
    {
        var email = NewEmail();
        return (await Auth.RegisterWithEmailAsync(email, Password, "Reader", guestId, Ct), email);
    }

    [Fact]
    public async Task RegisterWithEmailAsync_NewEmail_SignsInAndTheSamePasswordLogsIn()
    {
        var (registered, email) = await RegisterAsync();

        Assert.True(registered.Succeeded);
        Assert.Equal((email, false), (registered.User.Email, registered.User.IsGuest));
        Assert.Equal((registered.User.Id, false), Auth.ValidateAccessTokenIdentity(registered.AccessToken));
        var login = await Auth.LoginWithEmailAsync("  " + email.ToUpperInvariant(), Password, Ct);
        Assert.Equal(registered.User.Id, login.User?.Id);
    }

    [Fact]
    public async Task RegisterWithEmailAsync_EmailTakenInAnotherCase_EmailTaken()
    {
        var (_, email) = await RegisterAsync();

        Assert.Equal(AuthStatus.EmailTaken, (await Auth.RegisterWithEmailAsync(email.ToUpperInvariant(), Password, null, null, Ct)).Status);
        Assert.True(await Auth.EmailExistsAsync(email.ToUpperInvariant(), Ct));
    }

    [Theory]
    [InlineData("not-an-email", Password)]
    [InlineData("reader@example.test", "short")]
    public async Task RegisterWithEmailAsync_BadEmailOrPassword_InvalidInput(string email, string password)
    {
        Assert.Equal(AuthStatus.InvalidInput, (await Auth.RegisterWithEmailAsync(email, password, null, null, Ct)).Status);
    }

    [Fact]
    public async Task LoginWithEmailAsync_WrongPasswordOrUnknownEmail_InvalidCredentials()
    {
        var (_, email) = await RegisterAsync();

        Assert.Equal(AuthStatus.InvalidCredentials, (await Auth.LoginWithEmailAsync(email, "wrong password", Ct)).Status);
        Assert.Equal(AuthStatus.InvalidCredentials, (await Auth.LoginWithEmailAsync(NewEmail(), Password, Ct)).Status);
    }

    [Fact]
    public async Task CreateGuestSessionAsync_NewGuest_IsAGuestWithAGuestToken()
    {
        var guest = await Auth.CreateGuestSessionAsync(Ct);

        Assert.True(guest.Succeeded);
        Assert.True((await _users.GetAsync(guest.User.Id, Ct))!.IsGuest);
        Assert.Matches("^guest-[0-9a-f]{32}@guest.local$", guest.User.Email);
        Assert.Equal((guest.User.Id, true), Auth.ValidateAccessTokenIdentity(guest.AccessToken));
        Assert.True((await Auth.RefreshTokenAsync(guest.RefreshToken, Ct)).Succeeded);
    }

    [Fact]
    public async Task RegisterWithEmailAsync_WithAGuest_PromotesItInPlace()
    {
        var guest = (await Auth.CreateGuestSessionAsync(Ct)).User!;

        var (registered, _) = await RegisterAsync(guest.Id);

        Assert.Equal(guest.Id, registered.User?.Id);
        var stored = (await _users.GetAsync(guest.Id, Ct))!;
        Assert.False(stored.IsGuest);
        Assert.NotNull(stored.PromotedAt);
    }

    [Fact]
    public async Task MergeGuestAsync_GuestSignsIn_GuestRowsMoveAndTheMapNamesTheMatchedBook()
    {
        var guest = (await Auth.CreateGuestSessionAsync(Ct)).User!;
        var account = (await RegisterAsync()).Result.User!;
        var sha = NewHash();
        var guestBook = await db.NewBookAsync(guest.Id, sha256: sha);
        var accountBook = await db.NewBookAsync(account.Id, sha256: sha);
        var ownBook = await db.NewBookAsync(guest.Id);

        var merged = await Auth.MergeGuestAsync(guest.Id, account.Id, "/auth/login", Ct);

        Assert.Equal(AccountMergeOutcome.Merged, merged?.Outcome);
        Assert.Equal(accountBook.Id, merged!.Books[guestBook.Id]);
        Assert.Equal(account.Id, await OwnerAsync(ownBook.Id));
        Assert.Null(await _users.GetAsync(guest.Id, Ct));
        Assert.Equal(AccountMergeOutcome.NoGuest, (await Auth.MergeGuestAsync(guest.Id, account.Id, "/auth/login", Ct))?.Outcome);
    }

    [Fact]
    public async Task MergeGuestAsync_IntoAnotherAccountThatIsNoGuest_RefusedAndNothingMoves()
    {
        var (alice, bob) = ((await RegisterAsync()).Result.User!, (await RegisterAsync()).Result.User!);
        var hers = await db.NewBookAsync(alice.Id);

        Assert.Equal(AccountMergeOutcome.Refused, (await Auth.MergeGuestAsync(alice.Id, bob.Id, "/auth/login", Ct))?.Outcome);
        Assert.Equal(alice.Id, await OwnerAsync(hers.Id));
    }

    [Theory]
    [InlineData("23505", null, true, 2)]
    [InlineData("40P01", null, true, 2)]
    [InlineData("23505", "23505", false, 2)]
    [InlineData("40P01", "40P01", false, 2)]
    [InlineData("23503", null, false, 1)]
    public async Task MergeGuestAsync_ConflictThenOutcome_RetriedOnceElseNull(string first, string? second, bool merges, int calls)
    {
        var merge = new ScriptedMerge(first, second);

        var merged = await AuthWith(merges: merge).MergeGuestAsync(Guid.NewGuid(), Guid.NewGuid(), "/auth/login", Ct);

        Assert.Equal(merges, merged is { Outcome: AccountMergeOutcome.Merged });
        Assert.Equal(merges, merged is not null);
        Assert.Equal(calls, merge.Calls);
    }

    [Fact]
    public async Task LoginWithEmailAsync_ResetBetweenCheckAndIssue_InvalidCredentialsAndNoSession()
    {
        var (registered, email) = await RegisterAsync();
        var code = (await Auth.RequestPasswordResetAsync(email, Ct))!;
        var users = new HookedUsers(_users) { AfterGetByEmail = async () => Assert.True(await Auth.ResetPasswordAsync(code, "a brand new password", Ct)) };

        var login = await AuthWith(users: users).LoginWithEmailAsync(email, Password, Ct);

        Assert.Equal(AuthStatus.InvalidCredentials, login.Status);
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", registered.User!.Id));
    }

    [Fact]
    public async Task RefreshTokenAsync_RotationLost_NeverOkWithAnUnstoredToken()
    {
        var signedIn = (await RegisterAsync()).Result;

        var refreshed = await AuthWith(sessions: new LosingRotation(_sessions)).RefreshTokenAsync(signedIn.RefreshToken!, Ct);

        Assert.Equal(AuthStatus.InvalidToken, refreshed.Status);
        Assert.Null(refreshed.RefreshToken);
    }

    [Fact]
    public async Task RefreshTokenAsync_LiveToken_RotatesAndTheOldOneIsSpent()
    {
        var signedIn = (await RegisterAsync()).Result;

        var refreshed = await Auth.RefreshTokenAsync(signedIn.RefreshToken!, Ct);

        Assert.Equal(signedIn.User!.Id, refreshed.User?.Id);
        Assert.NotEqual(signedIn.RefreshToken, refreshed.RefreshToken);
        // Within the grace: two tabs refreshing at once, refused but not treated as theft.
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(signedIn.RefreshToken!, Ct)).Status);
        Assert.True((await Auth.RefreshTokenAsync(refreshed.RefreshToken!, Ct)).Succeeded);
    }

    [Fact]
    public async Task RefreshTokenAsync_SpentTokenAfterTheGrace_TokenReusedAndEverySuccessorRevoked()
    {
        var signedIn = (await RegisterAsync()).Result;
        var user = signedIn.User!.Id;
        var successor = (await Auth.RefreshTokenAsync(signedIn.RefreshToken!, Ct)).RefreshToken!;
        // The grace is measured on the database clock.
        await db.ExecAsync("UPDATE user_refresh_tokens SET created_at = now() - interval '1 minute' WHERE user_id = @user", new { user });

        Assert.Equal(AuthStatus.TokenReused, (await Auth.RefreshTokenAsync(signedIn.RefreshToken!, Ct)).Status);

        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(successor, Ct)).Status);
    }

    [Fact]
    public async Task RefreshTokenAsync_GrandparentReplayedAfterTheGrace_TheWholeFamilyDies()
    {
        var signedIn = (await RegisterAsync()).Result;
        var child = (await Auth.RefreshTokenAsync(signedIn.RefreshToken!, Ct)).RefreshToken!;
        var grandchild = (await Auth.RefreshTokenAsync(child, Ct)).RefreshToken!;
        await db.ExecAsync("UPDATE user_refresh_tokens SET created_at = now() - interval '1 minute' WHERE user_id = @user", new { user = signedIn.User!.Id });

        Assert.Equal(AuthStatus.TokenReused, (await Auth.RefreshTokenAsync(signedIn.RefreshToken!, Ct)).Status);

        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(grandchild, Ct)).Status);
    }

    [Fact]
    public async Task RefreshTokenAsync_SignInPastItsAbsoluteLifetime_InvalidToken()
    {
        var signedIn = (await RegisterAsync()).Result;
        await db.ExecAsync("UPDATE user_refresh_tokens SET created_at = now() - interval '91 days' WHERE user_id = @user", new { user = signedIn.User!.Id });

        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(signedIn.RefreshToken!, Ct)).Status);
    }

    [Fact]
    public async Task LogoutAsync_Session_RevokedAndOnlyThatOne()
    {
        var (first, email) = await RegisterAsync();
        var second = await Auth.LoginWithEmailAsync(email, Password, Ct);

        Assert.True(await Auth.LogoutAsync(first.RefreshToken!, Ct));

        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(first.RefreshToken!, Ct)).Status);
        Assert.True((await Auth.RefreshTokenAsync(second.RefreshToken!, Ct)).Succeeded);
        Assert.False(await Auth.LogoutAsync(first.RefreshToken!, Ct));
    }

    [Fact]
    public async Task ResetPasswordAsync_RequestThenConfirm_OldSessionsPasswordAndDeviceApprovalsGone()
    {
        var (signedIn, email) = await RegisterAsync();
        var device = await Auth.CreateDeviceAuthorizationAsync(Ct);
        await Auth.ApproveDeviceAsync(device.UserCode, signedIn.User!.Id, Ct);
        var code = (await Auth.RequestPasswordResetAsync(email, Ct))!;

        Assert.True(await Auth.ResetPasswordAsync(code, "a brand new password", Ct));

        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(signedIn.RefreshToken!, Ct)).Status);
        Assert.Equal(AuthStatus.InvalidCredentials, (await Auth.LoginWithEmailAsync(email, Password, Ct)).Status);
        Assert.True((await Auth.LoginWithEmailAsync(email, "a brand new password", Ct)).Succeeded);
        Assert.Equal(AuthStatus.DeviceExpired, (await Auth.RedeemDeviceCodeAsync(device.DeviceCode, Ct)).Status);
        Assert.False(await Auth.ResetPasswordAsync(code, "yet another password", Ct));
    }

    [Fact]
    public async Task ResetPasswordAsync_ShortPasswordOrUnknownCode_False()
    {
        var (_, email) = await RegisterAsync();
        var code = (await Auth.RequestPasswordResetAsync(email, Ct))!;

        Assert.False(await Auth.ResetPasswordAsync(code, "short", Ct));
        Assert.False(await Auth.ResetPasswordAsync("no such code", "a brand new password", Ct));
    }

    [Fact]
    public async Task RequestPasswordResetAsync_UnknownEmailOrPasswordlessGuest_Null()
    {
        var guest = (await Auth.CreateGuestSessionAsync(Ct)).User!;

        Assert.Null(await Auth.RequestPasswordResetAsync(NewEmail(), Ct));
        Assert.Null(await Auth.RequestPasswordResetAsync(guest.Email, Ct));
    }

    [Fact]
    public async Task RedeemDeviceCodeAsync_StartApproveRedeem_TheApproversSessionOnce()
    {
        var (alice, bob) = ((await RegisterAsync()).Result.User!, (await RegisterAsync()).Result.User!);
        var device = await Auth.CreateDeviceAuthorizationAsync(Ct);
        Assert.Equal(AuthStatus.DevicePending, (await Auth.RedeemDeviceCodeAsync(device.DeviceCode, Ct)).Status);

        Assert.Equal(DeviceApprovalResult.Ok, await Auth.ApproveDeviceAsync(device.UserCode.ToLowerInvariant().Replace("-", ""), bob.Id, Ct));

        var redeemed = await Auth.RedeemDeviceCodeAsync(device.DeviceCode, Ct);
        Assert.Equal(bob.Id, redeemed.User?.Id);
        Assert.NotEqual(alice.Id, Auth.ValidateAccessToken(redeemed.AccessToken!));
        Assert.Equal(AuthStatus.DeviceExpired, (await Auth.RedeemDeviceCodeAsync(device.DeviceCode, Ct)).Status);
    }

    [Fact]
    public async Task RedeemDeviceCodeAsync_Denied_DeviceDenied()
    {
        var device = await Auth.CreateDeviceAuthorizationAsync(Ct);

        Assert.Equal(DeviceApprovalResult.Ok, await Auth.DenyDeviceAsync(device.UserCode, Ct));

        Assert.Equal(AuthStatus.DeviceDenied, (await Auth.RedeemDeviceCodeAsync(device.DeviceCode, Ct)).Status);
    }

    [Fact]
    public async Task RedeemDeviceCodeAsync_PastItsDeadline_DeviceExpiredAndApprovalSaysExpired()
    {
        var user = (await RegisterAsync()).Result.User!;
        var device = await Auth.CreateDeviceAuthorizationAsync(Ct);
        _clock.Now += TimeSpan.FromSeconds(DeviceCodes.ExpiresInSeconds + 1);

        Assert.Equal(AuthStatus.DeviceExpired, (await Auth.RedeemDeviceCodeAsync(device.DeviceCode, Ct)).Status);
        Assert.Equal(DeviceApprovalResult.NotFound, await Auth.ApproveDeviceAsync(device.UserCode, user.Id, Ct));
    }

    [Fact]
    public async Task ApproveDeviceAsync_LiveCodePastItsDeadline_Expired()
    {
        var user = (await RegisterAsync()).Result.User!;
        var device = await Auth.CreateDeviceAuthorizationAsync(Ct);
        _clock.Now += TimeSpan.FromSeconds(DeviceCodes.ExpiresInSeconds + 1);

        Assert.Equal(DeviceApprovalResult.Expired, await Auth.ApproveDeviceAsync(device.UserCode, user.Id, Ct));
    }

    [Fact]
    public async Task RedeemDeviceCodeAsync_UnknownCode_DeviceExpired()
    {
        Assert.Equal(AuthStatus.DeviceExpired, (await Auth.RedeemDeviceCodeAsync("no such code", Ct)).Status);
        Assert.Equal(DeviceApprovalResult.NotFound, await Auth.ApproveDeviceAsync("ZZZZ-ZZZZ", Guid.NewGuid(), Ct));
    }

    [Fact]
    public async Task LoginWithEmailAsync_AccountDeleted_RefusedAndItsSessionsGone()
    {
        var (signedIn, email) = await RegisterAsync();

        Assert.True(await _users.DeleteAsync(signedIn.User!.Id, Ct));

        Assert.Equal(AuthStatus.InvalidCredentials, (await Auth.LoginWithEmailAsync(email, Password, Ct)).Status);
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(signedIn.RefreshToken!, Ct)).Status);
        Assert.Null(await Auth.GetUserByIdAsync(signedIn.User.Id, Ct));
    }

    [Fact]
    public async Task LoginWithGoogleAsync_SameSubjectTwice_OneAccountWithTheLatestProfile()
    {
        var subject = Guid.NewGuid().ToString();
        _tokens.Google["first"] = new(subject, NewEmail(), "Ann", null);
        _tokens.Google["second"] = new(subject, NewEmail(), "Ann B", null);

        var first = await Auth.LoginWithGoogleAsync("first", Ct);
        var second = await Auth.LoginWithGoogleAsync("second", Ct);

        Assert.Equal(first.User!.Id, second.User?.Id);
        Assert.Equal((_tokens.Google["second"].Email, "Ann B"), (second.User!.Email, second.User.Name));
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.LoginWithGoogleAsync("forged", Ct)).Status);
    }

    [Fact]
    public async Task LoginWithGoogleAsync_VerifiedEmailOfAnotherAccount_IsEmailTaken()
    {
        // Never linked by email: whoever registered (or Apple-created) the email first would own the
        // owner's Google sign-ins.
        var (registered, email) = await RegisterAsync();
        _tokens.Google["token"] = new(Guid.NewGuid().ToString(), email, "Ann", null);

        Assert.Equal(AuthStatus.EmailTaken, (await Auth.LoginWithGoogleAsync("token", Ct)).Status);
        Assert.Null((await _users.GetAsync(registered.User!.Id, Ct))!.GoogleSubject);
    }

    [Fact]
    public async Task LoginWithAppleAsync_TokenEmailOfAnotherAccount_IsEmailTaken()
    {
        var (_, email) = await RegisterAsync();
        _tokens.Apple["token"] = new(Guid.NewGuid().ToString(), email, null, null);

        Assert.Equal(AuthStatus.EmailTaken, (await Auth.LoginWithAppleAsync("token", null, null, Ct)).Status);
    }

    [Fact]
    public async Task LoginWithGoogleAsync_TokenWithoutAnEmail_InvalidToken()
    {
        _tokens.Google["token"] = new(Guid.NewGuid().ToString(), null, "Ann", null);

        Assert.Equal(AuthStatus.InvalidToken, (await Auth.LoginWithGoogleAsync("token", Ct)).Status);
    }

    [Fact]
    public async Task LoginWithGoogleAsync_NewSubject_StoresItOnTheNewAccount()
    {
        var subject = Guid.NewGuid().ToString();
        _tokens.Google["token"] = new(subject, NewEmail(), "Ann", null);

        var signedIn = await Auth.LoginWithGoogleAsync("token", Ct);

        Assert.Equal(signedIn.User!.Id, (await _users.GetByGoogleSubjectAsync(subject, Ct))?.Id);
    }

    [Fact]
    public async Task LoginWithAppleAsync_SameSubject_OneAccount_AndItsEmailLinksNothing()
    {
        var subject = Guid.NewGuid().ToString();
        _tokens.Apple["token"] = new(subject, null, null, null);

        var first = await Auth.LoginWithAppleAsync("token", "Ann", null, Ct);
        var second = await Auth.LoginWithAppleAsync("token", "Ann B", null, Ct);

        Assert.Equal($"{subject}@privaterelay.appleid.com", first.User!.Email);
        Assert.Equal((first.User.Id, "Ann B"), (second.User!.Id, second.User.Name));
        // A client-supplied email of another account never signs that account in.
        var (_, email) = await RegisterAsync();
        _tokens.Apple["other"] = new(Guid.NewGuid().ToString(), email, null, null);
        Assert.Equal(AuthStatus.EmailTaken, (await Auth.LoginWithAppleAsync("other", null, email, Ct)).Status);
    }

    [Fact]
    public async Task TestLoginAsync_SameEmailTwice_OneAccount()
    {
        var email = NewEmail();

        var first = await Auth.TestLoginAsync(email, Ct);

        Assert.Equal(first.User!.Id, (await Auth.TestLoginAsync(email, Ct)).User?.Id);
    }

    [Fact]
    public async Task AdminLoginAsync_AdminRole_AdminTokenThatIsNoReadersToken()
    {
        var (registered, email) = await RegisterAsync();
        await _users.SetRoleAsync(registered.User!.Id, UserAccount.AdminRole, Ct);

        var admin = (await Admin.LoginAsync(email, Password, Ct))!;

        Assert.Equal((registered.User.Id, Domain.Enums.AdminRole.Admin), (admin.Admin.Id, admin.Admin.Role));
        Assert.Equal((registered.User.Id, Domain.Enums.AdminRole.Admin), Admin.ValidateAccessToken(admin.AccessToken));
        Assert.Null(Auth.ValidateAccessToken(admin.AccessToken));
        Assert.Equal((null, null), Admin.ValidateAccessToken(registered.AccessToken!));
        Assert.Equal(registered.User.Id, (await Admin.RefreshTokenAsync(admin.RefreshToken, Ct))?.Admin.Id);
        Assert.NotNull(await Admin.GetAdminByIdAsync(registered.User.Id, Ct));
    }

    [Fact]
    public async Task AdminRefreshTokenAsync_ReaderSessionOfAnAdminAccount_Refused()
    {
        var (registered, email) = await AdminAccountAsync();
        var reader = await Auth.LoginWithEmailAsync(email, Password, Ct);

        Assert.True(reader.Succeeded);
        Assert.Null(await Admin.RefreshTokenAsync(reader.RefreshToken!, Ct));
        Assert.Null(await Admin.RefreshTokenAsync(registered.RefreshToken!, Ct));
        Assert.False(await Admin.LogoutAsync(reader.RefreshToken!, Ct));
    }

    [Fact]
    public async Task RefreshTokenAsync_AdminPanelToken_RefusedAndNotSignedOut()
    {
        var (_, email) = await AdminAccountAsync();
        var admin = (await Admin.LoginAsync(email, Password, Ct))!;

        Assert.StartsWith(JwtTokens.AdminRefreshTokenPrefix, admin.RefreshToken);
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(admin.RefreshToken, Ct)).Status);
        Assert.False(await Auth.LogoutAsync(admin.RefreshToken, Ct));
        Assert.True(await Admin.LogoutAsync(admin.RefreshToken, Ct));
    }

    [Fact]
    public async Task RedeemDeviceCodeAsync_ApprovedByAnAdmin_ReaderSessionThatNeverRefreshesIntoAdmin()
    {
        var (registered, _) = await AdminAccountAsync();
        var device = await Auth.CreateDeviceAuthorizationAsync(Ct);
        await Auth.ApproveDeviceAsync(device.UserCode, registered.User!.Id, Ct);

        var redeemed = await Auth.RedeemDeviceCodeAsync(device.DeviceCode, Ct);

        Assert.True(redeemed.Succeeded);
        Assert.Null(await Admin.RefreshTokenAsync(redeemed.RefreshToken!, Ct));
    }

    [Fact]
    public async Task TestLoginAsync_AdminAccount_InvalidToken()
    {
        var (_, email) = await AdminAccountAsync();

        Assert.Equal(AuthStatus.InvalidToken, (await Auth.TestLoginAsync(email, Ct)).Status);
    }

    [Fact]
    public async Task LoginWithProviderAsync_AdminAccountsSubject_InvalidToken()
    {
        var (registered, _) = await AdminAccountAsync();
        var (google, apple) = (Guid.NewGuid().ToString(), Guid.NewGuid().ToString());
        await db.ExecAsync("UPDATE users SET google_subject = @google, apple_subject = @apple WHERE id = @user", new { google, apple, user = registered.User!.Id });
        _tokens.Google["g"] = new(google, registered.User.Email, "Admin", null);
        _tokens.Apple["a"] = new(apple, null, null, null);

        Assert.Equal(AuthStatus.InvalidToken, (await Auth.LoginWithGoogleAsync("g", Ct)).Status);
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.LoginWithAppleAsync("a", null, null, Ct)).Status);
    }

    [Fact]
    public async Task RegisterWithEmailAsync_GuestIdOfAnAdmin_NewAccountTheAdminUntouched()
    {
        var guest = (await Auth.CreateGuestSessionAsync(Ct)).User!;
        await _users.SetRoleAsync(guest.Id, UserAccount.AdminRole, Ct);

        var (registered, _) = await RegisterAsync(guest.Id);

        Assert.NotEqual(guest.Id, registered.User?.Id);
        Assert.Null((await _users.GetAsync(guest.Id, Ct))!.PasswordHash);
    }

    private async Task<(AuthResult Registered, string Email)> AdminAccountAsync()
    {
        var (registered, email) = await RegisterAsync();
        await _users.SetRoleAsync(registered.User!.Id, UserAccount.AdminRole, Ct);
        return (registered, email);
    }

    [Fact]
    public async Task RefreshTokenAsync_GuestAndAccount_EachKeepsItsOwnWindow()
    {
        var guest = await Auth.CreateGuestSessionAsync(Ct);
        var account = (await RegisterAsync()).Result;

        var (guestNext, accountNext) = (await Auth.RefreshTokenAsync(guest.RefreshToken!, Ct), await Auth.RefreshTokenAsync(account.RefreshToken!, Ct));

        Assert.Equal(_clock.Now.AddDays(GuestDays), await ExpiresAtAsync(guestNext.RefreshToken!), TimeSpan.FromSeconds(1));
        Assert.Equal(_clock.Now.AddDays(AccountDays), await ExpiresAtAsync(accountNext.RefreshToken!), TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task AdminLoginAsync_DefaultSettings_FifteenMinuteTokenAndSevenDaySession()
    {
        var (_, email) = await AdminAccountAsync();

        var admin = (await Admin.LoginAsync(email, Password, Ct))!;

        var token = new System.IdentityModel.Tokens.Jwt.JwtSecurityTokenHandler().ReadJwtToken(admin.AccessToken);
        Assert.InRange(token.ValidTo - DateTime.UtcNow, TimeSpan.FromMinutes(14), TimeSpan.FromMinutes(15));
        Assert.Equal(_clock.Now.AddDays(7), await ExpiresAtAsync(admin.RefreshToken), TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task AdminLoginAsync_ResetBetweenCheckAndIssue_Null()
    {
        var (registered, email) = await AdminAccountAsync();
        var code = (await Auth.RequestPasswordResetAsync(email, Ct))!;
        var users = new HookedUsers(_users) { AfterGetByEmail = async () => Assert.True(await Auth.ResetPasswordAsync(code, "a brand new password", Ct)) };
        var admin = new V2AdminAuthService(users, _sessions, new AdminSettingsRepository(db.DataSource), _tokens, _clock);

        Assert.Null(await admin.LoginAsync(email, Password, Ct));
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", registered.User!.Id));
    }

    private Task<DateTimeOffset> ExpiresAtAsync(string refreshToken) =>
        db.ScalarAsync<DateTimeOffset>("SELECT expires_at FROM user_refresh_tokens WHERE token_hash = @hash", new { hash = DeviceCodes.HashToken(refreshToken) });

    [Fact]
    public async Task AdminLoginAsync_ReaderOrWrongPassword_Null()
    {
        var (reader, email) = await RegisterAsync();

        Assert.Null(await Admin.LoginAsync(email, Password, Ct));
        Assert.Null(await Admin.RefreshTokenAsync(reader.RefreshToken!, Ct));
        Assert.Null(await Admin.GetAdminByIdAsync(reader.User!.Id, Ct));
        await _users.SetRoleAsync(reader.User.Id, UserAccount.AdminRole, Ct);
        Assert.Null(await Admin.LoginAsync(email, "wrong password", Ct));
    }

    private Task<Guid> OwnerAsync(Guid bookId) => db.ScalarAsync<Guid>("SELECT user_id FROM books WHERE id = @bookId", new { bookId });

    /// <summary>A merge that throws the given SQLSTATEs on its first and second call (null: it merges).</summary>
    private sealed class ScriptedMerge(string first, string? second) : IAccountMergeRepository
    {
        public int Calls { get; private set; }

        public Task<AccountMerge> MergeAsync(Guid guestId, Guid accountId, NpgsqlTransaction? tx, CancellationToken ct)
        {
            var sqlState = Calls++ == 0 ? first : second;
            return sqlState is null
                ? Task.FromResult(AccountMerge.Empty(AccountMergeOutcome.Merged))
                : throw new PostgresException("scripted", "ERROR", "ERROR", sqlState);
        }
    }

    /// <summary>The real users, with a hook that runs once right after the first email lookup.</summary>
    private sealed class HookedUsers(IUserRepository inner) : IUserRepository
    {
        public Func<Task>? AfterGetByEmail { get; set; }

        public async Task<UserAccount?> GetByEmailAsync(string email, CancellationToken ct)
        {
            var found = await inner.GetByEmailAsync(email, ct);
            if (AfterGetByEmail is { } hook)
            {
                AfterGetByEmail = null;
                await hook();
            }
            return found;
        }

        public Task<UserAccount?> GetAsync(Guid userId, CancellationToken ct) => inner.GetAsync(userId, ct);
        public Task<UserAccount?> GetByGoogleSubjectAsync(string subject, CancellationToken ct) => inner.GetByGoogleSubjectAsync(subject, ct);
        public Task<UserAccount?> GetByAppleSubjectAsync(string subject, CancellationToken ct) => inner.GetByAppleSubjectAsync(subject, ct);
        public Task<UserAccount?> CreateAsync(UserAccount account, CancellationToken ct) => inner.CreateAsync(account, ct);
        public Task<AccountUpdate> UpdateProfileAsync(Guid userId, string email, string? name, string? picture, CancellationToken ct) => inner.UpdateProfileAsync(userId, email, name, picture, ct);
        public Task<AccountUpdate> PromoteGuestAsync(Guid userId, string email, string? name, string passwordHash, CancellationToken ct) => inner.PromoteGuestAsync(userId, email, name, passwordHash, ct);
        public Task<bool> SetRoleAsync(Guid userId, string role, CancellationToken ct) => inner.SetRoleAsync(userId, role, ct);
        public Task<bool> DeleteAsync(Guid userId, CancellationToken ct) => inner.DeleteAsync(userId, ct);
    }

    /// <summary>The real sessions, except that every rotation loses to a concurrent one.</summary>
    private sealed class LosingRotation(ISessionTokenRepository inner) : ISessionTokenRepository
    {
        public Task<SessionToken?> RotateAsync(Guid userId, string oldTokenHash, string newTokenHash, DateTimeOffset expiresAt, DateTimeOffset now, DateTimeOffset familyNotBefore, CancellationToken ct) =>
            Task.FromResult<SessionToken?>(null);

        public Task<SessionToken?> IssueAsync(Guid userId, string tokenHash, DateTimeOffset expiresAt, string? verifiedPasswordHash, CancellationToken ct) => inner.IssueAsync(userId, tokenHash, expiresAt, verifiedPasswordHash, ct);
        public Task<SessionToken?> GetLiveAsync(string tokenHash, DateTimeOffset now, CancellationToken ct) => inner.GetLiveAsync(tokenHash, now, ct);
        public Task<Guid?> RevokeFamilyAsync(string tokenHash, TimeSpan grace, CancellationToken ct) => inner.RevokeFamilyAsync(tokenHash, grace, ct);
        public Task<bool> RevokeAsync(string tokenHash, CancellationToken ct) => inner.RevokeAsync(tokenHash, ct);
        public Task<PasswordReset> CreatePasswordResetAsync(Guid userId, string tokenHash, DateTimeOffset expiresAt, CancellationToken ct) => inner.CreatePasswordResetAsync(userId, tokenHash, expiresAt, ct);
        public Task<Guid?> ResetPasswordAsync(string tokenHash, string passwordHash, DateTimeOffset now, CancellationToken ct) => inner.ResetPasswordAsync(tokenHash, passwordHash, now, ct);
        public Task<int> DeleteExpiredSessionsAsync(DateTimeOffset expiredBefore, CancellationToken ct) => inner.DeleteExpiredSessionsAsync(expiredBefore, ct);
        public Task<int> DeleteExpiredPasswordResetsAsync(DateTimeOffset expiredBefore, CancellationToken ct) => inner.DeleteExpiredPasswordResetsAsync(expiredBefore, ct);
    }

    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = DateTimeOffset.UtcNow;

        public override DateTimeOffset GetUtcNow() => Now;
    }

    /// <summary>Google and Apple, stood in for: a token is whatever identity the test filed under it.</summary>
    private sealed class FakeProviders() : JwtTokens(new JwtSettings
    {
        SecretKey = "a-test-signing-key-long-enough-for-hmac-sha256-abcdefgh",
        RefreshTokenExpiryDays = AccountDays,
        GuestRefreshTokenExpiryDays = GuestDays,
    })
    {
        public Dictionary<string, ProviderIdentity> Google { get; } = [];
        public Dictionary<string, ProviderIdentity> Apple { get; } = [];

        public override Task<ProviderIdentity?> VerifyGoogleAsync(string idToken) => Task.FromResult(Google.GetValueOrDefault(idToken));

        public override Task<ProviderIdentity?> VerifyAppleAsync(string identityToken) => Task.FromResult(Apple.GetValueOrDefault(identityToken));
    }
}
