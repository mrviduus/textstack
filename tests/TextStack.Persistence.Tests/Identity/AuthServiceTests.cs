using System.IdentityModel.Tokens.Jwt;
using Application.AdminSettings;
using Application.Identity;
using Application.Library;
using Domain.Identity;
using Infrastructure.Persistence.Repositories;
using Infrastructure.Services;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;
using TextStack.UnitTests;
using static TextStack.Persistence.Tests.PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>
/// <see cref="AuthService"/> and <see cref="AdminAuthService"/> on the real V2 schema and repositories
/// (plan §8 "auth integration tests"), with a stepped clock and Google/Apple stood in for.
/// </summary>
public class AuthServiceTests(PostgresFixture db)
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
    private static readonly string FilesRoot = Path.Combine(Path.GetTempPath(), "textstack-v2-auth-" + Guid.NewGuid());
    private readonly LibraryFileStore _files = new(FilesRoot);
    private static readonly string LegacyStorageRoot = Path.Combine(Path.GetTempPath(), "textstack-v2-auth-storage-" + Guid.NewGuid());
    private readonly LocalFileStorageService _legacyStorage = new(LegacyStorageRoot);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private AuthService Auth => AuthWith();

    private AuthService AuthWith(IUserRepository? users = null, ISessionTokenRepository? sessions = null, IAccountMergeRepository? merges = null) =>
        new(users ?? _users, sessions ?? _sessions, _devices, merges ?? new AccountMergeRepository(db.DataSource), Deletion,
            _tokens, _providers, _clock, NullLogger<AuthService>.Instance);

    private AccountDeletion Deletion => new(_users, new AccountMergeRepository(db.DataSource), new BookAccess(new LibraryRepository(db.DataSource)), _files, _legacyStorage, NullLogger<AccountDeletion>.Instance);

    private AdminAuthService Admin => AdminWith();

    private AdminAuthService AdminWith(IUserRepository? users = null) =>
        new(users ?? _users, _sessions, new AdminSessionLifetimes(new AdminSettingsRepository(db.DataSource)), new MemoryCache(new MemoryCacheOptions()), _tokens, _clock);

    private (Guid UserId, bool IsGuest) Identity(string accessToken) =>
        Auth.ValidateAccessTokenIdentity(accessToken) is { } identity ? (identity.UserId, identity.IsGuest) : default;

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

    // A reader with a password.

    [Fact]
    public async Task RegisterWithEmailAsync_NewReader_RegistersSignsInRefreshesAndSignsOut()
    {
        var email = NewEmail();
        Assert.Equal(AuthStatus.InvalidInput, (await Auth.RegisterWithEmailAsync("not-an-email", Password, null, null, Ct)).Status);
        Assert.Equal(AuthStatus.InvalidInput, (await Auth.RegisterWithEmailAsync(email, "short", null, null, Ct)).Status);

        var registered = await Auth.RegisterWithEmailAsync(email, Password, "Reader", null, Ct);

        Assert.True(registered.Succeeded);
        Assert.Equal((email, false), (registered.User.Email, registered.User.IsGuest));
        Assert.Equal((registered.User.Id, false), Identity(registered.AccessToken));
        Assert.Equal(AuthStatus.EmailTaken, (await Auth.RegisterWithEmailAsync(email.ToUpperInvariant(), Password, null, null, Ct)).Status);

        // Signs in on a second device: email trimmed and case-blind; a wrong password or email is one answer.
        var phone = await Auth.LoginWithEmailAsync("  " + email.ToUpperInvariant(), Password, Ct);
        Assert.Equal(registered.User.Id, phone.User?.Id);
        Assert.Equal(AuthStatus.InvalidCredentials, (await Auth.LoginWithEmailAsync(email, "wrong password", Ct)).Status);
        Assert.Equal(AuthStatus.InvalidCredentials, (await Auth.LoginWithEmailAsync(NewEmail(), Password, Ct)).Status);

        // Refresh rotates; the old token is spent.
        var refreshed = await Auth.RefreshTokenAsync(registered.RefreshToken!, Ct);
        Assert.Equal(registered.User.Id, refreshed.User?.Id);
        Assert.NotEqual(registered.RefreshToken, refreshed.RefreshToken);
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(registered.RefreshToken!, Ct)).Status);
        // Within the grace (two tabs at once) that reuse is not treated as theft: the new token still refreshes.
        var laptop = await Auth.RefreshTokenAsync(refreshed.RefreshToken!, Ct);
        Assert.True(laptop.Succeeded);

        // Signing out ends that session only.
        Assert.True(await Auth.LogoutAsync(laptop.RefreshToken!, Ct));
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(laptop.RefreshToken!, Ct)).Status);
        Assert.True((await Auth.RefreshTokenAsync(phone.RefreshToken!, Ct)).Succeeded);
        Assert.False(await Auth.LogoutAsync(laptop.RefreshToken!, Ct));

        // A test login (e2e) of a reader's email is one account however often it runs.
        var tester = NewEmail();
        Assert.Equal((await Auth.TestLoginAsync(tester, Ct)).User!.Id, (await Auth.TestLoginAsync(tester, Ct)).User?.Id);
    }

    [Fact]
    public async Task RefreshTokenAsync_RotationLostThenStolenTokenReplayed_LostRaceRefusedReplayKillsTheFamily()
    {
        var (user, refresh, _) = await SignedInAsync();

        // A lost rotation race never hands out a token that was not stored; the family lives on.
        var lost = await AuthWith(sessions: new LosingRotation(_sessions)).RefreshTokenAsync(refresh, Ct);
        Assert.Equal(AuthStatus.InvalidToken, lost.Status);
        Assert.Null(lost.RefreshToken);

        var child = (await Auth.RefreshTokenAsync(refresh, Ct)).RefreshToken!;
        var grandchild = (await Auth.RefreshTokenAsync(child, Ct)).RefreshToken!;
        await db.AgeSessionsAsync(user.Id, "1 minute");

        // The grandparent replayed after the grace: theft, so the live grandchild dies too.
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(refresh, Ct)).Status);
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(grandchild, Ct)).Status);
    }

    [Fact]
    public async Task RefreshTokenAsync_GuestAndAccount_OwnWindowsAndAnAbsoluteLifetime()
    {
        var guest = await Auth.CreateGuestSessionAsync(Ct);
        var (_, refresh, _) = await SignedInAsync();

        var (guestNext, accountNext) = (await Auth.RefreshTokenAsync(guest.RefreshToken!, Ct), await Auth.RefreshTokenAsync(refresh, Ct));

        Assert.Equal(_clock.Now.AddDays(GuestDays), await ExpiresAtAsync(guestNext.RefreshToken!), TimeSpan.FromSeconds(1));
        Assert.Equal(_clock.Now.AddDays(AccountDays), await ExpiresAtAsync(accountNext.RefreshToken!), TimeSpan.FromSeconds(1));

        // Refreshing forever does not stretch a sign-in past its absolute lifetime, counted from the
        // family's first row: only that row is aged, the presented child is fresh.
        await db.ExecAsync("UPDATE user_refresh_tokens SET created_at = now() - interval '91 days' WHERE token_hash = @hash",
            new { hash = DeviceCodes.HashToken(refresh) });
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(accountNext.RefreshToken!, Ct)).Status);
    }

    // Guests and the merge.

    [Fact]
    public async Task RegisterWithEmailAsync_GuestRegisters_PromotedInPlaceButAnAdminIdNever()
    {
        var guest = await Auth.CreateGuestSessionAsync(Ct);
        Assert.True(guest.Succeeded);
        Assert.True((await _users.GetAsync(guest.User.Id, Ct))!.IsGuest);
        Assert.Matches("^guest-[0-9a-f]{32}@guest.local$", guest.User.Email);
        Assert.Equal((guest.User.Id, true), Identity(guest.AccessToken));
        Assert.True((await Auth.RefreshTokenAsync(guest.RefreshToken, Ct)).Succeeded);

        var registered = await Auth.RegisterWithEmailAsync(NewEmail(), Password, null, guest.User.Id, Ct);

        Assert.Equal(guest.User.Id, registered.User?.Id);
        var stored = (await _users.GetAsync(guest.User.Id, Ct))!;
        Assert.False(stored.IsGuest);
        Assert.NotNull(stored.PromotedAt);

        // A guest id that names an admin is never promoted: a new account, the admin untouched.
        var admin = (await Auth.CreateGuestSessionAsync(Ct)).User!;
        await _users.SetRoleAsync(admin.Id, UserAccount.AdminRole, Ct);
        var other = await Auth.RegisterWithEmailAsync(NewEmail(), Password, null, admin.Id, Ct);
        Assert.NotEqual(admin.Id, other.User?.Id);
        Assert.Null((await _users.GetAsync(admin.Id, Ct))!.PasswordHash);
    }

    [Fact]
    public async Task MergeGuestAsync_GuestSignsIn_RowsMoveOnceAndAnAccountIsNeverMerged()
    {
        var guest = (await Auth.CreateGuestSessionAsync(Ct)).User!;
        var ((account, _, _), (other, _, _)) = (await SignedInAsync(), await SignedInAsync());
        var sha = NewHash();
        var guestBook = await db.NewBookAsync(guest.Id, sha256: sha);
        var accountBook = await db.NewBookAsync(account.Id, sha256: sha);
        var ownBook = await db.NewBookAsync(guest.Id);
        var othersBook = await db.NewBookAsync(other.Id);

        var merged = await Auth.MergeGuestAsync(guest.Id, account.Id, "/auth/login", Ct);

        Assert.Equal(AccountMergeOutcome.Merged, merged?.Outcome);
        Assert.Equal(accountBook.Id, merged!.Books[guestBook.Id]);
        Assert.Equal(account.Id, await OwnerAsync(ownBook.Id));
        Assert.Null(await _users.GetAsync(guest.Id, Ct));
        Assert.Equal(AccountMergeOutcome.NoGuest, (await Auth.MergeGuestAsync(guest.Id, account.Id, "/auth/login", Ct))?.Outcome);

        // A real account passed as the "guest" is refused and keeps its books.
        Assert.Equal(AccountMergeOutcome.Refused, (await Auth.MergeGuestAsync(other.Id, account.Id, "/auth/login", Ct))?.Outcome);
        Assert.Equal(other.Id, await OwnerAsync(othersBook.Id));
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

    // Password reset.

    [Fact]
    public async Task ResetPasswordAsync_ReaderForgetsThePassword_OldSessionsPasswordAndDeviceApprovalsGone()
    {
        var (user, refresh, email) = await SignedInAsync();
        var device = await Auth.CreateDeviceAuthorizationAsync(Ct);
        await Auth.ApproveDeviceAsync(device.UserCode, user.Id, DateTimeOffset.UtcNow, Ct);
        var guest = (await Auth.CreateGuestSessionAsync(Ct)).User!;
        Assert.Null(await Auth.RequestPasswordResetAsync(NewEmail(), Ct));
        Assert.Null(await Auth.RequestPasswordResetAsync(guest.Email, Ct));
        var code = (await Auth.RequestPasswordResetAsync(email, Ct))!;
        Assert.False(await Auth.ResetPasswordAsync(code, "short", Ct));
        Assert.False(await Auth.ResetPasswordAsync("no such code", NewPassword, Ct));

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
        var issuedAt = Auth.ValidateAccessTokenIdentity(signedIn.AccessToken!)!.IssuedAt;
        var device = await Auth.CreateDeviceAuthorizationAsync(Ct);
        Assert.True(await Auth.ResetPasswordAsync((await Auth.RequestPasswordResetAsync(account.Email, Ct))!, NewPassword, Ct));

        Assert.Equal(AuthStatus.InvalidToken, (await Auth.IssueSessionAsync(account, issuedAt, Ct)).Status);
        Assert.Equal(DeviceApprovalResult.Unauthorized, await Auth.ApproveDeviceAsync(device.UserCode, account.Id, issuedAt, Ct));
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", account.Id));
        Assert.Equal(DeviceRedeemStatus.AuthorizationPending, (await Auth.RedeemDeviceCodeAsync(device.DeviceCode, Ct)).Status);
    }

    [Fact]
    public async Task LoginWithEmailAsync_ResetBetweenCheckAndIssue_NoReaderOrAdminSession()
    {
        var reader = await NewAccountAsync(UserAccount.ReaderRole);
        var readerCode = (await Auth.RequestPasswordResetAsync(reader.Email, Ct))!;
        var readerUsers = new HookedUsers(_users) { AfterGetByEmail = async () => Assert.True(await Auth.ResetPasswordAsync(readerCode, NewPassword, Ct)) };

        Assert.Equal(AuthStatus.InvalidCredentials, (await AuthWith(users: readerUsers).LoginWithEmailAsync(reader.Email, Password, Ct)).Status);
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", reader.Id));

        var admin = await NewAccountAsync(UserAccount.AdminRole);
        var adminCode = (await Auth.RequestPasswordResetAsync(admin.Email, Ct))!;
        var adminUsers = new HookedUsers(_users) { AfterGetByEmail = async () => Assert.True(await Auth.ResetPasswordAsync(adminCode, NewPassword, Ct)) };

        Assert.Null(await AdminWith(adminUsers).LoginAsync(admin.Email, Password, Ct));
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", admin.Id));
    }

    // Account deletion.

    [Fact]
    public async Task DeleteAccountAsync_ReaderDeletesTheAccount_RowsFilesAndSessionsGoneSignInRefused()
    {
        var (account, refresh, email) = await SignedInAsync();
        var cover = _files.CoverKey(account.Id, Guid.NewGuid(), "png");
        _files.Place(await _files.StageAsync(cover, new byte[] { 1 }, Ct));
        Assert.True(File.Exists(Path.Combine(FilesRoot, cover)));
        var avatar = await _legacyStorage.SaveFileAsync(account.Id, "avatar.png", new MemoryStream([1]), Ct);
        await _users.SetPictureAsync(account.Id, avatar, Ct);
        var uploads = Path.Combine(LegacyStorageRoot, "users", account.Id.ToString()[..2], account.Id.ToString());
        Directory.CreateDirectory(uploads);
        await File.WriteAllBytesAsync(Path.Combine(uploads, "book.epub"), [1], Ct);

        Assert.True(await Auth.DeleteAccountAsync(account.Id, Ct));

        Assert.Null(await _users.GetAsync(account.Id, Ct));
        Assert.Null(await Auth.GetUserByIdAsync(account.Id, Ct));
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", account.Id));
        Assert.False(File.Exists(Path.Combine(FilesRoot, cover)));
        Assert.False(File.Exists(Path.Combine(LegacyStorageRoot, avatar)));
        Assert.False(Directory.Exists(uploads));
        Assert.Equal(AuthStatus.InvalidCredentials, (await Auth.LoginWithEmailAsync(email, Password, Ct)).Status);
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(refresh, Ct)).Status);
        Assert.False(await Auth.DeleteAccountAsync(account.Id, Ct));
    }

    [Fact]
    public async Task DeleteIdleGuestsAsync_TheDailySweep_GuestIdle90DaysGoesWithItsBookAndFiles()
    {
        var (gone, recent, account) = (await db.NewReaderAsync(isGuest: true), await db.NewReaderAsync(isGuest: true), await db.NewReaderAsync());
        var covers = new Dictionary<Guid, string>();
        foreach (var reader in new[] { gone, recent, account })
        {
            await db.NewBookAsync(reader);
            covers[reader] = _files.CoverKey(reader, Guid.NewGuid(), "png");
            _files.Place(await _files.StageAsync(covers[reader], new byte[] { 1 }, Ct));
        }
        await db.ExecAsync("UPDATE users SET last_active_at = now() - interval '91 days' WHERE id = @gone", new { gone });
        await db.ExecAsync("UPDATE users SET last_active_at = now() - interval '89 days' WHERE id = @recent", new { recent });
        await db.ExecAsync("UPDATE users SET last_active_at = now() - interval '1 year' WHERE id = @account", new { account });
        var idleSince = await db.ScalarAsync<DateTimeOffset>("SELECT now() - interval '90 days'", new { });

        await Deletion.DeleteIdleGuestsAsync(idleSince, 1000, Ct);

        // The 91-day guest goes with its book and bytes; a guest a day short of it and a registered reader stay.
        Assert.Null(await _users.GetAsync(gone, Ct));
        Assert.Equal(0L, await db.CountAsync("books", gone));
        Assert.False(File.Exists(Path.Combine(FilesRoot, covers[gone])));
        foreach (var kept in new[] { recent, account })
        {
            Assert.NotNull(await _users.GetAsync(kept, Ct));
            Assert.Equal(1L, await db.CountAsync("books", kept));
            Assert.True(File.Exists(Path.Combine(FilesRoot, covers[kept])));
        }
    }

    // Device flow.

    [Fact]
    public async Task RedeemDeviceCodeAsync_TvSignsIn_TheApproversSessionOnceDeniedOrLateNever()
    {
        var ((alice, _, _), (bob, _, _)) = (await SignedInAsync(), await SignedInAsync());
        var device = await Auth.CreateDeviceAuthorizationAsync(Ct);
        Assert.Equal(DeviceRedeemStatus.AuthorizationPending, (await Auth.RedeemDeviceCodeAsync(device.DeviceCode, Ct)).Status);

        Assert.Equal(DeviceApprovalResult.Ok, await Auth.ApproveDeviceAsync(device.UserCode.ToLowerInvariant().Replace("-", ""), bob.Id, DateTimeOffset.UtcNow, Ct));

        var redeemed = await Auth.RedeemDeviceCodeAsync(device.DeviceCode, Ct);
        Assert.Equal(bob.Id, redeemed.User?.Id);
        Assert.NotEqual(alice.Id, Auth.ValidateAccessTokenIdentity(redeemed.AccessToken!)?.UserId);
        Assert.Equal(DeviceRedeemStatus.ExpiredToken, (await Auth.RedeemDeviceCodeAsync(device.DeviceCode, Ct)).Status);

        var denied = await Auth.CreateDeviceAuthorizationAsync(Ct);
        Assert.Equal(DeviceApprovalResult.Ok, await Auth.DenyDeviceAsync(denied.UserCode, Ct));
        Assert.Equal(DeviceRedeemStatus.AccessDenied, (await Auth.RedeemDeviceCodeAsync(denied.DeviceCode, Ct)).Status);

        Assert.Equal(DeviceRedeemStatus.ExpiredToken, (await Auth.RedeemDeviceCodeAsync("no such code", Ct)).Status);
        Assert.Equal(DeviceApprovalResult.NotFound, await Auth.ApproveDeviceAsync("ZZZZ-ZZZZ", Guid.NewGuid(), DateTimeOffset.UtcNow, Ct));

        var late = await Auth.CreateDeviceAuthorizationAsync(Ct);
        _clock.Now += TimeSpan.FromSeconds(DeviceCodes.ExpiresInSeconds + 1);
        Assert.Equal(DeviceRedeemStatus.ExpiredToken, (await Auth.RedeemDeviceCodeAsync(late.DeviceCode, Ct)).Status);
        Assert.Equal(DeviceApprovalResult.Expired, await Auth.ApproveDeviceAsync(late.UserCode, alice.Id, DateTimeOffset.UtcNow, Ct));
    }

    // Google and Apple.

    [Fact]
    public async Task LoginWithGoogleAsync_ReturningReader_OneAccountNeverLinkedByEmail()
    {
        var subject = Guid.NewGuid().ToString();
        _providers.Google["first"] = new(subject, NewEmail(), "Ann", null);
        _providers.Google["second"] = new(subject, NewEmail(), "Ann B", null);

        var first = await Auth.LoginWithGoogleAsync("first", Ct);
        var second = await Auth.LoginWithGoogleAsync("second", Ct);

        Assert.Equal(first.User!.Id, second.User?.Id);
        Assert.Equal((_providers.Google["second"].Email, "Ann"), (second.User!.Email, second.User.Name));
        Assert.Equal(first.User.Id, (await _users.GetByGoogleSubjectAsync(subject, Ct))?.Id);
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.LoginWithGoogleAsync("forged", Ct)).Status);
        _providers.Google["no email"] = new(Guid.NewGuid().ToString(), null, "Ann", null);
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.LoginWithGoogleAsync("no email", Ct)).Status);

        // Never linked by email: whoever registered (or Apple-created) the email first would own the
        // owner's Google sign-ins.
        var (user, _, email) = await SignedInAsync();
        _providers.Google["taken"] = new(Guid.NewGuid().ToString(), email, "Ann", null);
        Assert.Equal(AuthStatus.EmailTaken, (await Auth.LoginWithGoogleAsync("taken", Ct)).Status);
        Assert.Null((await _users.GetAsync(user.Id, Ct))!.GoogleSubject);
    }

    // #1436/#1446: Google seeds a new account's name and photo; after that the reader's own choices win.
    [Fact]
    public async Task LoginWithGoogleAsync_ReaderChangedNameAndPhoto_ReaderChoicesKept()
    {
        _providers.Google["token"] = new(Guid.NewGuid().ToString(), NewEmail(), "Ann Smith", "https://google.test/ann.jpg");
        var user = (await Auth.LoginWithGoogleAsync("token", Ct)).User!;
        Assert.Equal(("Ann Smith", "https://google.test/ann.jpg"), (user.Name, user.Picture));

        // Until the reader chooses, Google's own photo follows Google.
        _providers.Google["token"] = _providers.Google["token"] with { Picture = "https://google.test/ann2.jpg" };
        Assert.Equal("https://google.test/ann2.jpg", (await Auth.LoginWithGoogleAsync("token", Ct)).User!.Picture);

        await _users.UpdateNameAndLanguageAsync(user.Id, "Ann", null, Ct);
        await _users.SetPictureAsync(user.Id, null, Ct);

        _providers.Google["token"] = _providers.Google["token"] with { Name = "Ann S.", Picture = "https://google.test/new.jpg" };
        var again = (await Auth.LoginWithGoogleAsync("token", Ct)).User!;
        Assert.Equal(("Ann", (string?)null), (again.Name, again.Picture));
    }

    [Fact]
    public async Task LoginWithAppleAsync_ReturningReader_OneRelayAccountOnlyTheTokenEmailCounts()
    {
        var subject = Guid.NewGuid().ToString();
        _providers.Apple["token"] = new(subject, null, null, null);

        // A token without an email: the account gets the relay email.
        var first = await Auth.LoginWithAppleAsync("token", "Ann", null, Ct);
        var second = await Auth.LoginWithAppleAsync("token", "Ann B", null, Ct);

        Assert.Equal(Emails.AppleRelay(subject), first.User!.Email);
        Assert.Equal((first.User.Id, "Ann"), (second.User!.Id, second.User.Name));

        // A body email (here another account's) is the client's word, ignored for the relay email.
        var (_, _, email) = await SignedInAsync();
        var other = Guid.NewGuid().ToString();
        _providers.Apple["body"] = new(other, null, null, null);
        Assert.Equal(Emails.AppleRelay(other), (await Auth.LoginWithAppleAsync("body", null, email, Ct)).User!.Email);

        // The verified token's email of another account: taken, never linked.
        _providers.Apple["taken"] = new(Guid.NewGuid().ToString(), email, null, null);
        Assert.Equal(AuthStatus.EmailTaken, (await Auth.LoginWithAppleAsync("taken", null, null, Ct)).Status);
    }

    // Admins.

    [Fact]
    public async Task AdminLoginAsync_NewAdmin_ShortPanelSessionThatNeverCrossesWithAReaderSession()
    {
        var email = NewEmail();
        var admin = (await Admin.CreateAdminAsync(email, Password, Ct))!;
        Assert.Equal((AdminRole.Admin, email), (admin.Role, admin.Email));
        var reader = await Auth.LoginWithEmailAsync(email, Password, Ct);

        var panel = (await Admin.LoginAsync(email, Password, Ct))!;

        Assert.Equal((admin.Id, AdminRole.Admin), (panel.Admin.Id, panel.Admin.Role));
        Assert.Equal((admin.Id, AdminRole.Admin), Admin.ValidateAccessToken(panel.AccessToken));
        Assert.NotNull(await Admin.GetAdminByIdAsync(admin.Id, Ct));
        var token = new JwtSecurityTokenHandler().ReadJwtToken(panel.AccessToken);
        Assert.InRange(token.ValidTo - DateTime.UtcNow, TimeSpan.FromMinutes(14), TimeSpan.FromMinutes(15));
        Assert.Equal(_clock.Now.AddDays(7), await ExpiresAtAsync(panel.RefreshToken), TimeSpan.FromSeconds(1));

        // Panel and reader tokens, access or refresh, never stand in for each other.
        Assert.Null(Auth.ValidateAccessTokenIdentity(panel.AccessToken));
        Assert.Equal((null, null), Admin.ValidateAccessToken(reader.AccessToken!));
        Assert.Null(await Admin.RefreshTokenAsync(reader.RefreshToken!, Ct));
        Assert.False(await Admin.LogoutAsync(reader.RefreshToken!, Ct));
        Assert.Equal(AuthStatus.InvalidToken, (await Auth.RefreshTokenAsync(panel.RefreshToken, Ct)).Status);
        Assert.False(await Auth.LogoutAsync(panel.RefreshToken, Ct));

        // A device the admin approves gets a reader session that never refreshes into the panel.
        var device = await Auth.CreateDeviceAuthorizationAsync(Ct);
        await Auth.ApproveDeviceAsync(device.UserCode, admin.Id, DateTimeOffset.UtcNow, Ct);
        var redeemed = await Auth.RedeemDeviceCodeAsync(device.DeviceCode, Ct);
        Assert.Equal(DeviceRedeemStatus.Approved, redeemed.Status);
        Assert.Null(await Admin.RefreshTokenAsync(redeemed.RefreshToken!, Ct));

        var next = (await Admin.RefreshTokenAsync(panel.RefreshToken, Ct))!;
        Assert.Equal(admin.Id, next.Admin.Id);
        Assert.True(await Admin.LogoutAsync(next.RefreshToken, Ct));
    }

    [Fact]
    public async Task AdminLoginAsync_Reader_NeverReachesThePanel()
    {
        var (reader, refresh, email) = await SignedInAsync();

        Assert.Null(await Admin.CreateAdminAsync(email, Password, Ct));
        Assert.Equal(UserAccount.ReaderRole, (await _users.GetAsync(reader.Id, Ct))!.Role);
        Assert.Null(await Admin.LoginAsync(email, Password, Ct));
        Assert.Null(await Admin.RefreshTokenAsync(refresh, Ct));
        Assert.Null(await Admin.GetAdminByIdAsync(reader.Id, Ct));
        await _users.SetRoleAsync(reader.Id, UserAccount.AdminRole, Ct);
        Assert.Null(await Admin.LoginAsync(email, "wrong password", Ct));
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

        public Task<bool> HoldsNothingDurableAsync(Guid userId, CancellationToken ct) => throw new NotSupportedException();
        public Task<IReadOnlyList<string?>> DeleteIdleEmptyGuestsAsync(DateTimeOffset idleSince, int limit, CancellationToken ct) => throw new NotSupportedException();
        public Task<IReadOnlyList<Guid>> ListIdleGuestsAsync(DateTimeOffset idleSince, int limit, CancellationToken ct) => throw new NotSupportedException();
        public Task<bool> DeleteGuestIfIdleAsync(Guid guestId, DateTimeOffset idleSince, CancellationToken ct) => throw new NotSupportedException();
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
        public Task<UserAccount?> UpdateNameAndLanguageAsync(Guid userId, string? name, string? nativeLanguage, CancellationToken ct) => inner.UpdateNameAndLanguageAsync(userId, name, nativeLanguage, ct);
        public Task<UserAccount?> SetPictureAsync(Guid userId, string? picture, CancellationToken ct) => inner.SetPictureAsync(userId, picture, ct);
        public Task<bool> TouchActiveAsync(Guid userId, DateTimeOffset now, CancellationToken ct) => inner.TouchActiveAsync(userId, now, ct);
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

        public override Task<ProviderIdentity?> VerifyAppleAsync(string identityToken, CancellationToken ct = default) => Task.FromResult(Apple.GetValueOrDefault(identityToken));
    }
}
