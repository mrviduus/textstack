using System.IdentityModel.Tokens.Jwt;
using Application.Auth;
using Application.Identity;
using Domain.Enums;
using Domain.Identity;
using Infrastructure.Persistence.Repositories;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;
using TextStack.UnitTests;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>
/// <see cref="V2AuthService"/> and <see cref="V2AdminAuthService"/> on the real V2 schema and repositories
/// (plan §8 "auth integration tests"), with a stepped clock and Google/Apple stood in for.
/// </summary>
public class V2AuthServiceTests(V2PostgresFixture db)
{
    private const string Password = "correct horse battery";
    private const string NewPassword = "a brand new password";
    private const int AccountDays = 30;
    private const int GuestDays = 7;

    /// <summary>One BCrypt hash of <see cref="Password"/> for every account a test makes directly.</summary>
    private static readonly string PasswordHash = PasswordHashing.Hash(Password);

    private readonly SteppedClock _clock = new();
    private readonly FakeProviders _providers = new();
    private readonly JwtTokens _tokens = new(new JwtSettings
    {
        SecretKey = TestTokens.Secret,
        RefreshTokenExpiryDays = AccountDays,
        GuestRefreshTokenExpiryDays = GuestDays,
    });
    private readonly UserRepository _users = new(db.DataSource);
    private readonly SessionTokenRepository _sessions = new(db.DataSource);
    private readonly DeviceLoginRepository _devices = new(db.DataSource);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private V2AuthService Auth => AuthWith();

    private V2AuthService AuthWith(IUserRepository? users = null, ISessionTokenRepository? sessions = null, IAccountMergeRepository? merges = null) =>
        new(users ?? _users, sessions ?? _sessions, _devices, merges ?? new AccountMergeRepository(db.DataSource),
            _tokens, _providers, _clock, NullLogger<V2AuthService>.Instance);

    private V2AdminAuthService Admin => AdminWith();

    private V2AdminAuthService AdminWith(IUserRepository? users = null) =>
        new(users ?? _users, _sessions, new AdminSettingsRepository(db.DataSource), new MemoryCache(new MemoryCacheOptions()), _tokens, _clock);

    private static string NewEmail() => $"{Guid.NewGuid():N}@example.test";

    /// <summary>A reader with <see cref="Password"/>, signed in: the cheap path (no BCrypt per test, no register).</summary>
    private async Task<(UserAccount User, string Refresh, string Email)> SignedInAsync()
    {
        var account = await NewAccountAsync(UserAccount.ReaderRole);
        var session = await Auth.IssueSessionAsync(account, DateTimeOffset.UtcNow, Ct);
        return (account, session.RefreshToken!, account.Email);
    }

    /// <summary>An account with <see cref="Password"/> and no session.</summary>
    private async Task<UserAccount> NewAccountAsync(string role) =>
        (await _users.CreateAsync(new UserAccount { Id = Guid.NewGuid(), Email = NewEmail(), PasswordHash = PasswordHash, Role = role }, Ct))!;

    /// <summary>Moves every session of the user <paramref name="interval"/> (SQL, a constant) into the past.</summary>
    private Task AgeSessionsAsync(Guid user, string interval) =>
        db.ExecAsync($"UPDATE user_refresh_tokens SET created_at = now() - interval '{interval}', family_started_at = now() - interval '{interval}' WHERE user_id = @user", new { user });

    // Registration and email login: the real path.

    [Fact]
    public async Task RegisterWithEmailAsync_NewEmail_SignsInAndTheSamePasswordLogsIn()
    {
        var email = NewEmail();

        var registered = await Auth.RegisterWithEmailAsync(email, Password, "Reader", null, Ct);

        Assert.True(registered.Succeeded);
        Assert.Equal((email, false), (registered.User.Email, registered.User.IsGuest));
        Assert.Equal((registered.User.Id, false), Auth.ValidateAccessTokenIdentity(registered.AccessToken));
        Assert.Equal(registered.User.Id, (await Auth.LoginWithEmailAsync("  " + email.ToUpperInvariant(), Password, Ct)).User?.Id);
    }

    [Fact]
    public async Task RegisterWithEmailAsync_EmailTakenInAnotherCase_EmailTaken()
    {
        var (_, _, email) = await SignedInAsync();

        Assert.Equal(AuthStatus.EmailTaken, (await Auth.RegisterWithEmailAsync(email.ToUpperInvariant(), Password, null, null, Ct)).Status);
    }

    [Theory]
    [InlineData("not-an-email", Password)]
    [InlineData("reader@example.test", "short")]
    public async Task RegisterWithEmailAsync_BadEmailOrPassword_InvalidInput(string email, string password)
    {
        Assert.Equal(AuthStatus.InvalidInput, (await Auth.RegisterWithEmailAsync(email, password, null, null, Ct)).Status);
    }

    [Fact]
    public async Task RegisterWithEmailAsync_WithAGuest_PromotesItInPlace()
    {
        var guest = (await Auth.CreateGuestSessionAsync(Ct)).User!;

        var registered = await Auth.RegisterWithEmailAsync(NewEmail(), Password, null, guest.Id, Ct);

        Assert.Equal(guest.Id, registered.User?.Id);
        var stored = (await _users.GetAsync(guest.Id, Ct))!;
        Assert.False(stored.IsGuest);
        Assert.NotNull(stored.PromotedAt);
    }

    [Fact]
    public async Task RegisterWithEmailAsync_GuestIdOfAnAdmin_NewAccountTheAdminUntouched()
    {
        var guest = (await Auth.CreateGuestSessionAsync(Ct)).User!;
        await _users.SetRoleAsync(guest.Id, UserAccount.AdminRole, Ct);

        var registered = await Auth.RegisterWithEmailAsync(NewEmail(), Password, null, guest.Id, Ct);

        Assert.NotEqual(guest.Id, registered.User?.Id);
        Assert.Null((await _users.GetAsync(guest.Id, Ct))!.PasswordHash);
    }

    [Fact]
    public async Task LoginWithEmailAsync_WrongPasswordOrUnknownEmail_InvalidCredentials()
    {
        var (_, _, email) = await SignedInAsync();

        Assert.Equal(AuthStatus.InvalidCredentials, (await Auth.LoginWithEmailAsync(email, "wrong password", Ct)).Status);
        Assert.Equal(AuthStatus.InvalidCredentials, (await Auth.LoginWithEmailAsync(NewEmail(), Password, Ct)).Status);
    }

    [Fact]
    public async Task LoginWithEmailAsync_ResetBetweenCheckAndIssue_InvalidCredentialsAndNoSession()
    {
        var account = await NewAccountAsync(UserAccount.ReaderRole);
        var code = (await Auth.RequestPasswordResetAsync(account.Email, Ct))!;
        var users = new HookedUsers(_users) { AfterGetByEmail = async () => Assert.True(await Auth.ResetPasswordAsync(code, NewPassword, Ct)) };

        var login = await AuthWith(users: users).LoginWithEmailAsync(account.Email, Password, Ct);

        Assert.Equal(AuthStatus.InvalidCredentials, login.Status);
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", account.Id));
    }

    [Fact]
    public async Task LoginWithEmailAsync_AccountDeleted_RefusedAndItsSessionsGone()
    {
        var (user, refresh, email) = await SignedInAsync();

        Assert.True(await _users.DeleteAsync(user.Id, Ct));

        Assert.Equal(AuthStatus.InvalidCredentials, (await Auth.LoginWithEmailAsync(email, Password, Ct)).Status);
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(refresh, Ct)).Status);
        Assert.Null(await Auth.GetUserByIdAsync(user.Id, Ct));
    }

    // Guests and the merge.

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
    public async Task MergeGuestAsync_GuestSignsIn_GuestRowsMoveAndTheMapNamesTheMatchedBook()
    {
        var guest = (await Auth.CreateGuestSessionAsync(Ct)).User!;
        var (account, _, _) = await SignedInAsync();
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
        var ((alice, _, _), (bob, _, _)) = (await SignedInAsync(), await SignedInAsync());
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

    // Refresh and sign-out.

    [Fact]
    public async Task RefreshTokenAsync_LiveToken_RotatesAndTheOldOneIsSpent()
    {
        var (user, refresh, _) = await SignedInAsync();

        var refreshed = await Auth.RefreshTokenAsync(refresh, Ct);

        Assert.Equal(user.Id, refreshed.User?.Id);
        Assert.NotEqual(refresh, refreshed.RefreshToken);
        // Within the grace: two tabs refreshing at once, refused but not treated as theft.
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(refresh, Ct)).Status);
        Assert.True((await Auth.RefreshTokenAsync(refreshed.RefreshToken!, Ct)).Succeeded);
    }

    [Fact]
    public async Task RefreshTokenAsync_GrandparentReplayedAfterTheGrace_TheWholeFamilyDies()
    {
        var (user, refresh, _) = await SignedInAsync();
        var child = (await Auth.RefreshTokenAsync(refresh, Ct)).RefreshToken!;
        var grandchild = (await Auth.RefreshTokenAsync(child, Ct)).RefreshToken!;
        await AgeSessionsAsync(user.Id, "1 minute");

        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(refresh, Ct)).Status);

        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(grandchild, Ct)).Status);
    }

    [Fact]
    public async Task RefreshTokenAsync_SignInPastItsAbsoluteLifetime_InvalidToken()
    {
        var (user, refresh, _) = await SignedInAsync();
        await AgeSessionsAsync(user.Id, "91 days");

        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(refresh, Ct)).Status);
    }

    [Fact]
    public async Task RefreshTokenAsync_RotationLost_NeverOkWithAnUnstoredToken()
    {
        var (_, refresh, _) = await SignedInAsync();

        var refreshed = await AuthWith(sessions: new LosingRotation(_sessions)).RefreshTokenAsync(refresh, Ct);

        Assert.Equal(AuthStatus.InvalidToken, refreshed.Status);
        Assert.Null(refreshed.RefreshToken);
    }

    [Fact]
    public async Task RefreshTokenAsync_GuestAndAccount_EachKeepsItsOwnWindow()
    {
        var guest = await Auth.CreateGuestSessionAsync(Ct);
        var (_, refresh, _) = await SignedInAsync();

        var (guestNext, accountNext) = (await Auth.RefreshTokenAsync(guest.RefreshToken!, Ct), await Auth.RefreshTokenAsync(refresh, Ct));

        Assert.Equal(_clock.Now.AddDays(GuestDays), await ExpiresAtAsync(guestNext.RefreshToken!), TimeSpan.FromSeconds(1));
        Assert.Equal(_clock.Now.AddDays(AccountDays), await ExpiresAtAsync(accountNext.RefreshToken!), TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task LogoutAsync_Session_RevokedAndOnlyThatOne()
    {
        var (_, first, email) = await SignedInAsync();
        var second = await Auth.LoginWithEmailAsync(email, Password, Ct);

        Assert.True(await Auth.LogoutAsync(first, Ct));

        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(first, Ct)).Status);
        Assert.True((await Auth.RefreshTokenAsync(second.RefreshToken!, Ct)).Succeeded);
        Assert.False(await Auth.LogoutAsync(first, Ct));
    }

    // Password reset.

    [Fact]
    public async Task ResetPasswordAsync_RequestThenConfirm_OldSessionsPasswordAndDeviceApprovalsGone()
    {
        var (user, refresh, email) = await SignedInAsync();
        var device = await Auth.CreateDeviceAuthorizationAsync(Ct);
        await Auth.ApproveDeviceAsync(device.UserCode, user.Id, DateTimeOffset.UtcNow, Ct);
        var code = (await Auth.RequestPasswordResetAsync(email, Ct))!;

        Assert.True(await Auth.ResetPasswordAsync(code, NewPassword, Ct));

        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(refresh, Ct)).Status);
        Assert.Equal(AuthStatus.InvalidCredentials, (await Auth.LoginWithEmailAsync(email, Password, Ct)).Status);
        Assert.True((await Auth.LoginWithEmailAsync(email, NewPassword, Ct)).Succeeded);
        Assert.Equal(DeviceRedeemStatus.ExpiredToken, (await Auth.RedeemDeviceCodeAsync(device.DeviceCode, Ct)).Status);
        Assert.False(await Auth.ResetPasswordAsync(code, "yet another password", Ct));
    }

    [Fact]
    public async Task ResetPasswordAsync_AccessTokenFromBefore_MintsNoSessionAndApprovesNoDevice()
    {
        // #1092: the reset cannot reach a JWT already handed out; it refuses what that JWT would mint.
        var account = await NewAccountAsync(UserAccount.ReaderRole);
        var signedIn = await Auth.LoginWithEmailAsync(account.Email, Password, Ct);
        var issuedAt = new DateTimeOffset(new JwtSecurityToken(signedIn.AccessToken).IssuedAt, TimeSpan.Zero);
        var device = await Auth.CreateDeviceAuthorizationAsync(Ct);
        Assert.True(await Auth.ResetPasswordAsync((await Auth.RequestPasswordResetAsync(account.Email, Ct))!, NewPassword, Ct));

        Assert.Equal(AuthStatus.InvalidToken, (await Auth.IssueSessionAsync(account, issuedAt, Ct)).Status);
        Assert.Equal(DeviceApprovalResult.NotFound, await Auth.ApproveDeviceAsync(device.UserCode, account.Id, issuedAt, Ct));
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", account.Id));
        Assert.Equal(DeviceRedeemStatus.AuthorizationPending, (await Auth.RedeemDeviceCodeAsync(device.DeviceCode, Ct)).Status);
    }

    [Fact]
    public async Task ResetPasswordAsync_ShortPasswordOrUnknownCode_False()
    {
        var (_, _, email) = await SignedInAsync();
        var code = (await Auth.RequestPasswordResetAsync(email, Ct))!;

        Assert.False(await Auth.ResetPasswordAsync(code, "short", Ct));
        Assert.False(await Auth.ResetPasswordAsync("no such code", NewPassword, Ct));
    }

    [Fact]
    public async Task RequestPasswordResetAsync_UnknownEmailOrPasswordlessGuest_Null()
    {
        var guest = (await Auth.CreateGuestSessionAsync(Ct)).User!;

        Assert.Null(await Auth.RequestPasswordResetAsync(NewEmail(), Ct));
        Assert.Null(await Auth.RequestPasswordResetAsync(guest.Email, Ct));
    }

    // Device flow.

    [Fact]
    public async Task RedeemDeviceCodeAsync_StartApproveRedeem_TheApproversSessionOnce()
    {
        var ((alice, _, _), (bob, _, _)) = (await SignedInAsync(), await SignedInAsync());
        var device = await Auth.CreateDeviceAuthorizationAsync(Ct);
        Assert.Equal(DeviceRedeemStatus.AuthorizationPending, (await Auth.RedeemDeviceCodeAsync(device.DeviceCode, Ct)).Status);

        Assert.Equal(DeviceApprovalResult.Ok, await Auth.ApproveDeviceAsync(device.UserCode.ToLowerInvariant().Replace("-", ""), bob.Id, DateTimeOffset.UtcNow, Ct));

        var redeemed = await Auth.RedeemDeviceCodeAsync(device.DeviceCode, Ct);
        Assert.Equal(bob.Id, redeemed.User?.Id);
        Assert.NotEqual(alice.Id, Auth.ValidateAccessTokenIdentity(redeemed.AccessToken!).UserId);
        Assert.Equal(DeviceRedeemStatus.ExpiredToken, (await Auth.RedeemDeviceCodeAsync(device.DeviceCode, Ct)).Status);
    }

    [Fact]
    public async Task RedeemDeviceCodeAsync_Denied_AccessDenied()
    {
        var device = await Auth.CreateDeviceAuthorizationAsync(Ct);

        Assert.Equal(DeviceApprovalResult.Ok, await Auth.DenyDeviceAsync(device.UserCode, Ct));

        Assert.Equal(DeviceRedeemStatus.AccessDenied, (await Auth.RedeemDeviceCodeAsync(device.DeviceCode, Ct)).Status);
    }

    [Fact]
    public async Task RedeemDeviceCodeAsync_PastItsDeadline_ExpiredAndApprovalSaysExpired()
    {
        var (user, _, _) = await SignedInAsync();
        var device = await Auth.CreateDeviceAuthorizationAsync(Ct);
        _clock.Now += TimeSpan.FromSeconds(DeviceCodes.ExpiresInSeconds + 1);

        Assert.Equal(DeviceRedeemStatus.ExpiredToken, (await Auth.RedeemDeviceCodeAsync(device.DeviceCode, Ct)).Status);
        Assert.Equal(DeviceApprovalResult.Expired, await Auth.ApproveDeviceAsync(device.UserCode, user.Id, DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task RedeemDeviceCodeAsync_UnknownCode_Expired()
    {
        Assert.Equal(DeviceRedeemStatus.ExpiredToken, (await Auth.RedeemDeviceCodeAsync("no such code", Ct)).Status);
        Assert.Equal(DeviceApprovalResult.NotFound, await Auth.ApproveDeviceAsync("ZZZZ-ZZZZ", Guid.NewGuid(), DateTimeOffset.UtcNow, Ct));
    }

    // Google, Apple, test login.

    [Fact]
    public async Task LoginWithGoogleAsync_SameSubjectTwice_OneAccountWithTheLatestProfile()
    {
        var subject = Guid.NewGuid().ToString();
        _providers.Google["first"] = new(subject, NewEmail(), "Ann", null);
        _providers.Google["second"] = new(subject, NewEmail(), "Ann B", null);

        var first = await Auth.LoginWithGoogleAsync("first", Ct);
        var second = await Auth.LoginWithGoogleAsync("second", Ct);

        Assert.Equal(first.User!.Id, second.User?.Id);
        Assert.Equal((_providers.Google["second"].Email, "Ann B"), (second.User!.Email, second.User.Name));
        Assert.Equal(first.User.Id, (await _users.GetByGoogleSubjectAsync(subject, Ct))?.Id);
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.LoginWithGoogleAsync("forged", Ct)).Status);
    }

    [Fact]
    public async Task LoginWithGoogleAsync_VerifiedEmailOfAnotherAccount_IsEmailTaken()
    {
        // Never linked by email: whoever registered (or Apple-created) the email first would own the
        // owner's Google sign-ins.
        var (user, _, email) = await SignedInAsync();
        _providers.Google["token"] = new(Guid.NewGuid().ToString(), email, "Ann", null);

        Assert.Equal(AuthStatus.EmailTaken, (await Auth.LoginWithGoogleAsync("token", Ct)).Status);
        Assert.Null((await _users.GetAsync(user.Id, Ct))!.GoogleSubject);
    }

    [Fact]
    public async Task LoginWithGoogleAsync_TokenWithoutAnEmail_InvalidToken()
    {
        _providers.Google["token"] = new(Guid.NewGuid().ToString(), null, "Ann", null);

        Assert.Equal(AuthStatus.InvalidToken, (await Auth.LoginWithGoogleAsync("token", Ct)).Status);
    }

    [Fact]
    public async Task LoginWithAppleAsync_SameSubject_OneAccountWithTheRelayEmail()
    {
        var subject = Guid.NewGuid().ToString();
        _providers.Apple["token"] = new(subject, null, null, null);

        var first = await Auth.LoginWithAppleAsync("token", "Ann", null, Ct);
        var second = await Auth.LoginWithAppleAsync("token", "Ann B", null, Ct);

        Assert.Equal(Emails.AppleRelay(subject), first.User!.Email);
        Assert.Equal((first.User.Id, "Ann B"), (second.User!.Id, second.User.Name));
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task LoginWithAppleAsync_EmailOfAnotherAccount_IsEmailTaken(bool inToken, bool asParameter)
    {
        // Whether Apple's token or the client names it, another account's email signs nothing in.
        var (_, _, email) = await SignedInAsync();
        _providers.Apple["token"] = new(Guid.NewGuid().ToString(), inToken ? email : null, null, null);

        Assert.Equal(AuthStatus.EmailTaken, (await Auth.LoginWithAppleAsync("token", null, asParameter ? email : null, Ct)).Status);
    }

    [Fact]
    public async Task TestLoginAsync_SameEmailTwice_OneAccount()
    {
        var email = NewEmail();

        var first = await Auth.TestLoginAsync(email, Ct);

        Assert.Equal(first.User!.Id, (await Auth.TestLoginAsync(email, Ct)).User?.Id);
    }

    // Admins.

    [Fact]
    public async Task AdminLoginAsync_AdminRole_AdminTokenThatIsNoReadersToken()
    {
        var admin = await NewAccountAsync(UserAccount.AdminRole);
        var reader = await Auth.LoginWithEmailAsync(admin.Email, Password, Ct);

        var signedIn = (await Admin.LoginAsync(admin.Email, Password, Ct))!;

        Assert.Equal((admin.Id, AdminRole.Admin), (signedIn.Admin.Id, signedIn.Admin.Role));
        Assert.Equal((admin.Id, AdminRole.Admin), Admin.ValidateAccessToken(signedIn.AccessToken));
        Assert.Null(Auth.ValidateAccessTokenIdentity(signedIn.AccessToken).UserId);
        Assert.Equal((null, null), Admin.ValidateAccessToken(reader.AccessToken!));
        Assert.Equal(admin.Id, (await Admin.RefreshTokenAsync(signedIn.RefreshToken, Ct))?.Admin.Id);
        Assert.NotNull(await Admin.GetAdminByIdAsync(admin.Id, Ct));
    }

    [Fact]
    public async Task AdminLoginAsync_ReaderOrWrongPassword_Null()
    {
        var (reader, refresh, email) = await SignedInAsync();

        Assert.Null(await Admin.LoginAsync(email, Password, Ct));
        Assert.Null(await Admin.RefreshTokenAsync(refresh, Ct));
        Assert.Null(await Admin.GetAdminByIdAsync(reader.Id, Ct));
        await _users.SetRoleAsync(reader.Id, UserAccount.AdminRole, Ct);
        Assert.Null(await Admin.LoginAsync(email, "wrong password", Ct));
    }

    [Fact]
    public async Task AdminLoginAsync_DefaultSettings_FifteenMinuteTokenAndSevenDaySession()
    {
        var admin = await NewAccountAsync(UserAccount.AdminRole);

        var signedIn = (await Admin.LoginAsync(admin.Email, Password, Ct))!;

        var token = new JwtSecurityTokenHandler().ReadJwtToken(signedIn.AccessToken);
        Assert.InRange(token.ValidTo - DateTime.UtcNow, TimeSpan.FromMinutes(14), TimeSpan.FromMinutes(15));
        Assert.Equal(_clock.Now.AddDays(7), await ExpiresAtAsync(signedIn.RefreshToken), TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task AdminLoginAsync_ResetBetweenCheckAndIssue_Null()
    {
        var admin = await NewAccountAsync(UserAccount.AdminRole);
        var code = (await Auth.RequestPasswordResetAsync(admin.Email, Ct))!;
        var users = new HookedUsers(_users) { AfterGetByEmail = async () => Assert.True(await Auth.ResetPasswordAsync(code, NewPassword, Ct)) };

        Assert.Null(await AdminWith(users).LoginAsync(admin.Email, Password, Ct));
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", admin.Id));
    }

    [Fact]
    public async Task AdminAndReaderRefreshTokens_NotInterchangeable()
    {
        var admin = await NewAccountAsync(UserAccount.AdminRole);
        var reader = await Auth.LoginWithEmailAsync(admin.Email, Password, Ct);
        var panel = (await Admin.LoginAsync(admin.Email, Password, Ct))!;

        Assert.Null(await Admin.RefreshTokenAsync(reader.RefreshToken!, Ct));
        Assert.False(await Admin.LogoutAsync(reader.RefreshToken!, Ct));
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(panel.RefreshToken, Ct)).Status);
        Assert.False(await Auth.LogoutAsync(panel.RefreshToken, Ct));
        Assert.True(await Admin.LogoutAsync(panel.RefreshToken, Ct));
    }

    [Fact]
    public async Task RedeemDeviceCodeAsync_ApprovedByAnAdmin_ReaderSessionThatNeverRefreshesIntoAdmin()
    {
        var admin = await NewAccountAsync(UserAccount.AdminRole);
        var device = await Auth.CreateDeviceAuthorizationAsync(Ct);
        await Auth.ApproveDeviceAsync(device.UserCode, admin.Id, DateTimeOffset.UtcNow, Ct);

        var redeemed = await Auth.RedeemDeviceCodeAsync(device.DeviceCode, Ct);

        Assert.Equal(DeviceRedeemStatus.Approved, redeemed.Status);
        Assert.Null(await Admin.RefreshTokenAsync(redeemed.RefreshToken!, Ct));
    }

    [Fact]
    public async Task SignInWithoutAPassword_AdminAccount_InvalidToken()
    {
        // Test login, Google, Apple and a session re-issue never land in an admin account.
        var admin = await NewAccountAsync(UserAccount.AdminRole);
        var (google, apple) = (Guid.NewGuid().ToString(), Guid.NewGuid().ToString());
        await db.ExecAsync("UPDATE users SET google_subject = @google, apple_subject = @apple WHERE id = @user", new { google, apple, user = admin.Id });
        _providers.Google["g"] = new(google, admin.Email, "Admin", null);
        _providers.Apple["a"] = new(apple, null, null, null);

        Assert.Equal(AuthStatus.InvalidToken, (await Auth.TestLoginAsync(admin.Email, Ct)).Status);
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.LoginWithGoogleAsync("g", Ct)).Status);
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.LoginWithAppleAsync("a", null, null, Ct)).Status);
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.IssueSessionAsync(admin, DateTimeOffset.UtcNow, Ct)).Status);
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", admin.Id));
    }

    private Task<Guid> OwnerAsync(Guid bookId) => db.ScalarAsync<Guid>("SELECT user_id FROM books WHERE id = @bookId", new { bookId });

    // When a session of either kind expires.
    private Task<DateTimeOffset> ExpiresAtAsync(string refreshToken) =>
        db.ScalarAsync<DateTimeOffset>("SELECT expires_at FROM user_refresh_tokens WHERE token_hash = @hash", new { hash = DeviceCodes.HashToken(refreshToken) });

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
        public Task<SessionRefresh> RefreshAsync(
            string oldTokenHash, string newTokenHash, SessionKind kind, Func<UserAccount, DateTimeOffset> expiresAt, DateTimeOffset now, CancellationToken ct) =>
            Task.FromResult(SessionRefresh.Invalid);

        public Task<SessionToken?> IssueAsync(Guid userId, string tokenHash, DateTimeOffset expiresAt, string? verifiedPasswordHash, DateTimeOffset? tokenIssuedAt, SessionKind kind, CancellationToken ct) => inner.IssueAsync(userId, tokenHash, expiresAt, verifiedPasswordHash, tokenIssuedAt, kind, ct);
        public Task<bool> RevokeAsync(string tokenHash, SessionKind kind, CancellationToken ct) => inner.RevokeAsync(tokenHash, kind, ct);
        public Task<PasswordReset> CreatePasswordResetAsync(Guid userId, string tokenHash, DateTimeOffset expiresAt, CancellationToken ct) => inner.CreatePasswordResetAsync(userId, tokenHash, expiresAt, ct);
        public Task<Guid?> ResetPasswordAsync(string tokenHash, string passwordHash, DateTimeOffset now, CancellationToken ct) => inner.ResetPasswordAsync(tokenHash, passwordHash, now, ct);
        public Task<int> DeleteExpiredSessionsAsync(DateTimeOffset expiredBefore, CancellationToken ct) => inner.DeleteExpiredSessionsAsync(expiredBefore, ct);
        public Task<int> DeleteExpiredPasswordResetsAsync(DateTimeOffset expiredBefore, CancellationToken ct) => inner.DeleteExpiredPasswordResetsAsync(expiredBefore, ct);
    }

    /// <summary>Google and Apple, stood in for: a token is whatever identity the test filed under it.</summary>
    private sealed class FakeProviders : ProviderTokens
    {
        public Dictionary<string, ProviderIdentity> Google { get; } = [];
        public Dictionary<string, ProviderIdentity> Apple { get; } = [];

        public override Task<ProviderIdentity?> VerifyGoogleAsync(string idToken) => Task.FromResult(Google.GetValueOrDefault(idToken));

        public override ProviderIdentity? VerifyApple(string identityToken) => Apple.GetValueOrDefault(identityToken);
    }
}
