using Application.Auth;
using Application.Identity;
using Domain.Identity;
using Infrastructure.Persistence.Repositories;
using Microsoft.Extensions.Logging.Abstractions;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>
/// <see cref="V2AuthService"/> and <see cref="V2AdminAuthService"/> on the real V2 schema and repositories
/// (plan §8 "auth integration tests"), with a settable clock and Google/Apple stood in for.
/// </summary>
public class V2AuthServiceTests(V2PostgresFixture db)
{
    private const string Password = "correct horse battery";

    private readonly Clock _clock = new();
    private readonly FakeProviders _tokens = new();
    private readonly UserRepository _users = new(db.DataSource);
    private readonly SessionTokenRepository _sessions = new(db.DataSource);
    private readonly DeviceLoginRepository _devices = new(db.DataSource);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private V2AuthService Auth => new(_users, _sessions, _devices, new AccountMergeRepository(db.DataSource),
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
        _tokens.Google["first"] = new(subject, NewEmail(), "Ann", null, EmailVerified: true);
        _tokens.Google["second"] = new(subject, NewEmail(), "Ann B", null, EmailVerified: true);

        var first = await Auth.LoginWithGoogleAsync("first", Ct);
        var second = await Auth.LoginWithGoogleAsync("second", Ct);

        Assert.Equal(first.User!.Id, second.User?.Id);
        Assert.Equal((_tokens.Google["second"].Email, "Ann B"), (second.User!.Email, second.User.Name));
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.LoginWithGoogleAsync("forged", Ct)).Status);
    }

    [Fact]
    public async Task LoginWithGoogleAsync_VerifiedEmailOfAnAccount_SignsThatAccountIn()
    {
        var (registered, email) = await RegisterAsync();
        _tokens.Google["token"] = new(Guid.NewGuid().ToString(), email, "Ann", null, EmailVerified: true);

        Assert.Equal(registered.User!.Id, (await Auth.LoginWithGoogleAsync("token", Ct)).User?.Id);
    }

    [Fact]
    public async Task LoginWithGoogleAsync_UnverifiedEmailOfAnAccount_EmailTaken()
    {
        var (_, email) = await RegisterAsync();
        _tokens.Google["token"] = new(Guid.NewGuid().ToString(), email, "Ann", null, EmailVerified: false);

        Assert.Equal(AuthStatus.EmailTaken, (await Auth.LoginWithGoogleAsync("token", Ct)).Status);
    }

    [Fact]
    public async Task LoginWithAppleAsync_SameSubject_OneAccount_AndItsEmailLinksNothing()
    {
        var subject = Guid.NewGuid().ToString();
        _tokens.Apple["token"] = new(subject, null, null, null, EmailVerified: false);

        var first = await Auth.LoginWithAppleAsync("token", "Ann", null, Ct);
        var second = await Auth.LoginWithAppleAsync("token", "Ann B", null, Ct);

        Assert.Equal($"{subject}@privaterelay.appleid.com", first.User!.Email);
        Assert.Equal((first.User.Id, "Ann B"), (second.User!.Id, second.User.Name));
        // A client-supplied email of another account never signs that account in.
        var (_, email) = await RegisterAsync();
        _tokens.Apple["other"] = new(Guid.NewGuid().ToString(), email, null, null, EmailVerified: false);
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

    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = DateTimeOffset.UtcNow;

        public override DateTimeOffset GetUtcNow() => Now;
    }

    /// <summary>Google and Apple, stood in for: a token is whatever identity the test filed under it.</summary>
    private sealed class FakeProviders() : JwtTokens(new JwtSettings { SecretKey = "a-test-signing-key-long-enough-for-hmac-sha256-abcdefgh" })
    {
        public Dictionary<string, ProviderIdentity> Google { get; } = [];
        public Dictionary<string, ProviderIdentity> Apple { get; } = [];

        public override Task<ProviderIdentity?> VerifyGoogleAsync(string idToken) => Task.FromResult(Google.GetValueOrDefault(idToken));

        public override ProviderIdentity? VerifyApple(string identityToken) => Apple.GetValueOrDefault(identityToken);
    }
}
