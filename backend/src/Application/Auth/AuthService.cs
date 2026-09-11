using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Application.Common.Interfaces;
using Domain.Entities;
using Google.Apis.Auth;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace Application.Auth;

public class AuthService
{
    private readonly IAppDbContext _db;
    private readonly JwtSettings _jwtSettings;
    private readonly GoogleSettings _googleSettings;
    private readonly AppleSettings? _appleSettings;
    private readonly TimeProvider _clock;
    private readonly ILogger<AuthService>? _logger;

    public AuthService(
        IAppDbContext db,
        IOptions<JwtSettings> jwtSettings,
        IOptions<GoogleSettings> googleSettings,
        IOptions<AppleSettings>? appleSettings = null,
        TimeProvider? clock = null,
        ILogger<AuthService>? logger = null)
    {
        _db = db;
        _jwtSettings = jwtSettings.Value;
        _googleSettings = googleSettings.Value;
        _appleSettings = appleSettings?.Value;
        _clock = clock ?? TimeProvider.System;
        _logger = logger;
    }

    public async Task<(User user, string accessToken, string refreshToken)> TestLoginAsync(
        string email,
        CancellationToken ct)
    {
        var user = await _db.Users.FirstOrDefaultAsync(x => x.Email == email, ct);
        if (user == null)
        {
            user = new User
            {
                Id = Guid.NewGuid(),
                Email = email,
                Name = email.Split('@')[0],
                GoogleSubject = null,
                CreatedAt = DateTimeOffset.UtcNow
            };
            _db.Users.Add(user);
            await _db.SaveChangesAsync(ct);
        }

        var accessToken = GenerateAccessToken(user);
        var refreshToken = await CreateRefreshTokenAsync(user.Id, ct);
        return (user, accessToken, refreshToken);
    }

    public async Task<(User user, string accessToken, string refreshToken)?> LoginWithGoogleAsync(
        string googleIdToken,
        CancellationToken ct)
    {
        GoogleJsonWebSignature.Payload payload;
        try
        {
            var audiences = new List<string> { _googleSettings.ClientId };
            if (!string.IsNullOrWhiteSpace(_googleSettings.LegacyClientIds))
            {
                audiences.AddRange(_googleSettings.LegacyClientIds.Split(
                    ',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
            }
            payload = await GoogleJsonWebSignature.ValidateAsync(googleIdToken, new GoogleJsonWebSignature.ValidationSettings
            {
                Audience = audiences
            });
        }
        catch (InvalidJwtException)
        {
            return null;
        }

        var user = await GetOrCreateUserAsync(payload, ct);
        var accessToken = GenerateAccessToken(user);
        var refreshToken = await CreateRefreshTokenAsync(user.Id, ct);

        return (user, accessToken, refreshToken);
    }

    public async Task<(User user, string accessToken, string refreshToken)?> LoginWithAppleAsync(
        string identityToken,
        string? fullName,
        string? email,
        CancellationToken ct)
    {
        var (appleSubject, appleEmail) = ValidateAppleToken(identityToken);
        if (appleSubject == null) return null;

        var resolvedEmail = email ?? appleEmail;
        var user = await GetOrCreateAppleUserAsync(appleSubject, resolvedEmail, fullName, ct);

        var accessToken = GenerateAccessToken(user);
        var refreshToken = await CreateRefreshTokenAsync(user.Id, ct);

        return (user, accessToken, refreshToken);
    }

    public async Task<(User user, string accessToken, string refreshToken)> CreateGuestSessionAsync(CancellationToken ct)
    {
        var user = new User
        {
            Id = Guid.NewGuid(),
            Email = $"guest-{Guid.NewGuid():N}@guest.local",
            Name = "Guest",
            IsGuest = true,
            LastActiveAt = DateTimeOffset.UtcNow,
            CreatedAt = DateTimeOffset.UtcNow
        };

        _db.Users.Add(user);
        await _db.SaveChangesAsync(ct);

        return await IssueSessionAsync(user, ct);
    }

    /// <summary>
    /// Mints a fresh access+refresh pair for an <em>existing</em> user, without creating one.
    /// </summary>
    /// <remarks>
    /// The guest flag is derived from the user rather than passed in: refresh-token TTL differs for
    /// guests (<see cref="JwtSettings.GuestRefreshTokenExpiryDays"/>), and a hard-coded <c>false</c>
    /// at a re-issue site would silently upgrade a guest's session to the full 30-day window.
    /// Used by <see cref="CreateGuestSessionAsync"/> and by the idempotent re-issue on
    /// <c>POST /auth/guest</c> when the caller already holds a valid session.
    /// </remarks>
    public async Task<(User user, string accessToken, string refreshToken)> IssueSessionAsync(
        User user,
        CancellationToken ct)
    {
        var accessToken = GenerateAccessToken(user);
        var refreshToken = await CreateRefreshTokenAsync(user.Id, ct, isGuest: user.IsGuest);
        return (user, accessToken, refreshToken);
    }

    /// <summary>Promote guest to real user (registration) or merge guest data into existing user (login).</summary>
    /// <remarks>
    /// Re-parents every user-keyed entity from <paramref name="guestUserId"/> to <paramref name="realUserId"/>.
    /// On unique-key conflict (e.g. both have ReadingProgress for the same edition), prefers the guest's row
    /// for ReadingProgress when it's newer (LWW by UpdatedAt); for all other unique-keyed tables, the real
    /// account's row wins (guest's conflicting row is dropped). UserVocabularySettings is COPIED
    /// rather than re-parented — (UserId, SiteId) is its primary key — and only when the account
    /// has none. Also carries the guest's
    /// <see cref="User.NativeLanguage"/> across when the real account has none — see the inline note.
    /// All changes commit in a single SaveChanges transaction; idempotent — second call is a no-op
    /// once the guest row is gone.
    /// <para>
    /// Never throws on an integrity-constraint violation: sign-in must not become an outage because a
    /// row conflicted. See the catch below for why that specific class, and only that class.
    /// </para>
    /// </remarks>
    /// <returns>
    /// <c>true</c> when the merge ran to completion (including the no-op cases: nothing to move, or
    /// the guest row is already gone). <c>false</c> when it was abandoned on a constraint violation
    /// and NOTHING moved — the caller is expected to surface that rather than report a clean
    /// sign-in, because to the user it is indistinguishable from their data being deleted.
    /// </returns>
    public async Task<bool> MergeGuestAsync(Guid guestUserId, Guid realUserId, CancellationToken ct)
    {
        try
        {
            await MergeGuestCoreAsync(guestUserId, realUserId, ct);
            return true;
        }
        catch (Exception ex) when (IsConstraintViolation(ex))
        {
            // Deterministic failures ONLY — and the narrowness is the whole point.
            //
            // A constraint violation here means a unique index this method does not yet know about.
            // Retrying cannot help: the conflicting row is still there, and the client re-presents the
            // same guest token on every attempt, so letting it escape turns one bad row into a
            // PERMANENT sign-in outage. On mobile the only "fix" is wiping app data, which destroys
            // the guest session — i.e. fail-fast loses the guest's data too, and locks the user out on
            // top. Swallowing loses strictly less.
            //
            // Everything else (timeouts, dropped connections, cancellation) is deliberately NOT caught.
            // Those are the cases where failing is CORRECT: the user retries, the merge runs again, and
            // the data survives. Swallowing them would turn a recoverable retry into permanent
            // orphaning — which is the trade this catch exists to avoid, pointed the other way.
            //
            // The transaction has already rolled back, so nothing merged: the guest row survives with
            // its data, orphaned, until GuestCleanupWorker reaps it. That is a real cost, and the
            // reason this is logged at Error (→ Sentry) with both ids rather than swallowed quietly.
            // A silent merge failure is the SSG failure mode — an endpoint answering 200 while doing
            // nothing — and it is not acceptable as a steady state, only as a better outage than 500.
            _logger?.LogError(ex,
                "Guest merge hit a constraint violation and was skipped; sign-in continued. "
                + "Guest {GuestUserId} data is orphaned on the guest row. Real user {RealUserId}",
                guestUserId, realUserId);
            return false;
        }
    }

    /// <summary>
    /// True for a Postgres integrity-constraint violation (SQLSTATE class 23) — unique, foreign-key,
    /// check, not-null. Deterministic by construction: the offending row is still there on the next
    /// attempt.
    /// </summary>
    /// <remarks>
    /// BOTH shapes are checked, and that is not defensive padding. <c>SaveChangesAsync</c> wraps the
    /// driver error in <see cref="DbUpdateException"/>, but <c>ExecuteUpdateAsync</c>/
    /// <c>ExecuteDeleteAsync</c> bypass the change tracker and let the bare
    /// <c>Npgsql.PostgresException</c> escape. This merge is mostly bulk statements — including the
    /// ReadingSessions re-parent that produced the original 500 — so a <c>DbUpdateException</c>-only
    /// catch would have missed the exact failure it was written for. Verified by disabling the
    /// ReadingSessions conflict fix and watching the guard not fire.
    /// </remarks>
    private static bool IsConstraintViolation(Exception ex) =>
        (ex as Npgsql.PostgresException ?? ex.InnerException as Npgsql.PostgresException)
            is { } pg && pg.SqlState.StartsWith("23", StringComparison.Ordinal);

    private async Task MergeGuestCoreAsync(Guid guestUserId, Guid realUserId, CancellationToken ct)
    {
        if (guestUserId == realUserId) // Promoted in-place
        {
            var guest = await _db.Users.FirstOrDefaultAsync(x => x.Id == guestUserId, ct);
            if (guest != null && guest.IsGuest)
            {
                guest.IsGuest = false;
                await _db.SaveChangesAsync(ct);
            }
            return;
        }

        // Atomicity: reparent + delete guest must be one transaction. If we crash between
        // the two SaveChanges, we'd leave a dangling IsGuest=true row with no data.
        await using var tx = await _db.BeginTransactionAsync(ct);

        // === ReadingProgress: LWW conflict resolution by UpdatedAt ===
        // Unique on (UserId, SiteId, EditionId). Keep whichever row was updated more recently.
        var guestProgress = await _db.ReadingProgresses.Where(x => x.UserId == guestUserId).ToListAsync(ct);
        if (guestProgress.Count > 0)
        {
            var realProgress = await _db.ReadingProgresses
                .Where(x => x.UserId == realUserId)
                .ToListAsync(ct);
            var realByKey = realProgress.ToDictionary(x => (x.SiteId, x.EditionId));
            foreach (var g in guestProgress)
            {
                if (realByKey.TryGetValue((g.SiteId, g.EditionId), out var r))
                {
                    if (g.UpdatedAt > r.UpdatedAt) { _db.ReadingProgresses.Remove(r); g.UserId = realUserId; }
                    else { _db.ReadingProgresses.Remove(g); }
                }
                else { g.UserId = realUserId; }
            }
        }

        // === Unique-keyed tables: real account wins on conflict, guest's conflicting row dropped ===
        await ReparentDropOnConflictAsync(
            _db.UserLibraries, guestUserId, realUserId,
            x => x.EditionId, ct);

        await ReparentDropOnConflictAsync(
            _db.UserBooks, guestUserId, realUserId,
            x => x.Slug, ct);

        await ReparentDropOnConflictAsync(
            _db.ReadingGoals, guestUserId, realUserId,
            x => (x.SiteId, x.GoalType), ct);

        await ReparentDropOnConflictAsync(
            _db.UserAchievements, guestUserId, realUserId,
            x => (x.SiteId, x.AchievementCode), ct);

        await ReparentDropOnConflictAsync(
            _db.VocabularyWords, guestUserId, realUserId,
            x => (x.SiteId, x.Word, x.Language), ct);

        // Anti-spiral buckets. Both carry the SAME unique index as VocabularyWords —
        // (UserId, SiteId, Word, Language), see AppDbContext.Vocabulary.cs — so they get the same
        // drop-on-conflict rule, not a bulk re-parent. These are the first rows a guest ever
        // creates: a tap that doesn't reach SRS lands in WordLookups, and every save past the
        // tier's daily enrichment cap lands in PendingVocabularyWords.
        await ReparentDropOnConflictAsync(
            _db.PendingVocabularyWords, guestUserId, realUserId,
            x => (x.SiteId, x.Word, x.Language), ct);

        await ReparentDropOnConflictAsync(
            _db.WordLookups, guestUserId, realUserId,
            x => (x.SiteId, x.Word, x.Language), ct);

        // UserVocabularySettings — PK is (UserId, SiteId), so "re-parent" is not expressible at
        // all: EF refuses to modify a key on a tracked entity. Copy the row instead, and only when
        // the account has none for that site — the account's own pacing is its own. The guest's
        // row needs no delete; it cascades with the guest user below.
        var guestSettings = await _db.UserVocabularySettings
            .Where(x => x.UserId == guestUserId)
            .ToListAsync(ct);
        foreach (var gs in guestSettings)
        {
            if (await _db.UserVocabularySettings.AnyAsync(
                    x => x.UserId == realUserId && x.SiteId == gs.SiteId, ct))
                continue;

            _db.UserVocabularySettings.Add(new UserVocabularySettings
            {
                UserId = realUserId,
                SiteId = gs.SiteId,
                DailyNewCap = gs.DailyNewCap,
                WeeklyReviewBudget = gs.WeeklyReviewBudget,
                FrequencyFilterEnabled = gs.FrequencyFilterEnabled,
                ClusteringEnabled = gs.ClusteringEnabled,
                AutoRetireEnabled = gs.AutoRetireEnabled,
                AutoSpeakCards = gs.AutoSpeakCards,
                CreatedAt = gs.CreatedAt,
                UpdatedAt = gs.UpdatedAt,
            });
        }

        // Flush reparent-on-conflict work before bulk UPDATEs (ExecuteUpdateAsync bypasses the change tracker).
        await _db.SaveChangesAsync(ct);

        // === Bulk UPDATE re-parent — skips the change tracker. Only tables with NO unique key
        // beyond Id belong here; ReadingSessions is the exception and is handled below. ===
        await _db.Highlights.Where(x => x.UserId == guestUserId).ExecuteUpdateAsync(s => s.SetProperty(x => x.UserId, realUserId), ct);
        await _db.Bookmarks.Where(x => x.UserId == guestUserId).ExecuteUpdateAsync(s => s.SetProperty(x => x.UserId, realUserId), ct);
        await _db.Notes.Where(x => x.UserId == guestUserId).ExecuteUpdateAsync(s => s.SetProperty(x => x.UserId, realUserId), ct);
        // ReadingSession is NOT a plain re-parent, despite having lived under that header. It carries
        // TWO unique indexes, both partial (AppDbContext.Reading.cs):
        //     (user_id, edition_id,   started_at) WHERE edition_id   IS NOT NULL
        //     (user_id, user_book_id, started_at) WHERE user_book_id IS NOT NULL
        // and StartedAt is CLIENT-supplied (SubmitSessionRequest, accepted up to 7 days old), which
        // makes it the de-facto idempotency key of the offline session queue. "Guest and account hold
        // a session with the same key" is therefore one queued session flushed under two identities,
        // not a microsecond race — and a blind bulk UPDATE raised 23505, rolled the whole merge back,
        // and answered 500 on EVERY retry, because the client keeps presenting the same guest token.
        //
        // Same rule as the other unique-keyed tables: the account's row wins, the guest's conflicting
        // row is dropped. Done as a targeted DELETE + bulk UPDATE rather than through
        // ReparentDropOnConflictAsync deliberately, on two counts:
        //   1. PARTIALNESS. The helper compares one composite key per row, so it would treat two rows
        //      that are both outside an index (edition_id NULL on each) as colliding and silently drop
        //      a session the database was perfectly happy to keep. The predicate below only matches
        //      where the guest's own column is non-null — exactly the index's WHERE clause.
        //   2. VOLUME. Every other drop-on-conflict table is small and bounded; reading_sessions is
        //      the one high-cardinality table in this merge (one row per reading stretch, for the
        //      life of the account), and the helper materializes BOTH sides into memory.
        await _db.ReadingSessions
            .Where(g => g.UserId == guestUserId
                && _db.ReadingSessions.Any(r =>
                    r.UserId == realUserId
                    && r.StartedAt == g.StartedAt
                    && ((g.EditionId != null && r.EditionId == g.EditionId)
                        || (g.UserBookId != null && r.UserBookId == g.UserBookId))))
            .ExecuteDeleteAsync(ct);
        await _db.ReadingSessions.Where(x => x.UserId == guestUserId).ExecuteUpdateAsync(s => s.SetProperty(x => x.UserId, realUserId), ct);
        await _db.VocabularyReviews.Where(x => x.UserId == guestUserId).ExecuteUpdateAsync(s => s.SetProperty(x => x.UserId, realUserId), ct);
        // WordCluster: indexed on (UserId, SiteId, IsDismissed, CreatedAt) but NOT unique — two
        // clusters may legitimately share a theme, so nothing to resolve. Its member words moved
        // above via VocabularyWord.ClusterId/ConceptClusterId, which are FKs to the cluster row.
        await _db.WordClusters.Where(x => x.UserId == guestUserId).ExecuteUpdateAsync(s => s.SetProperty(x => x.UserId, realUserId), ct);
        // Collection: no unique key beyond Id (duplicate names are allowed), so bulk re-parent.
        // BookCollection hangs off CollectionId, not UserId, so its rows follow with no code here.
        await _db.Collections.Where(x => x.UserId == guestUserId).ExecuteUpdateAsync(s => s.SetProperty(x => x.UserId, realUserId), ct);

        // Cross-table dedup that no unique index can express: a merged pending row and an existing
        // active row may name the same word. Nothing throws at merge time — but PromotePending
        // would later insert a second VocabularyWord and hit the (UserId, SiteId, Word, Language)
        // unique index, i.e. a 500 days after the merge. SaveWord's contract is that a word lives
        // in exactly one bucket; the active row is the one worth keeping.
        await _db.PendingVocabularyWords
            .Where(p => p.UserId == realUserId
                && _db.VocabularyWords.Any(w => w.UserId == realUserId
                    && w.SiteId == p.SiteId && w.Word == p.Word && w.Language == p.Language))
            .ExecuteDeleteAsync(ct);

        // === Profile: NativeLanguage survives the merge, but never clobbers the account's own ===
        // The guest answered "what language do you already know?" on their first word tap, minutes
        // ago; the row that holds the answer is about to be deleted, and nothing else carries it.
        // Asking again after sign-in is exactly the silent reset this endpoint is here to avoid.
        // The account's own value wins when it has one — a throwaway session must not overwrite a
        // setting the user made on their real account. Only NativeLanguage: Name/Picture on a guest
        // are synthesized ("Guest"), and Tier/StorageLimitOverrideBytes are grants, not preferences.
        var guestNativeLanguage = await _db.Users
            .Where(x => x.Id == guestUserId)
            .Select(x => x.NativeLanguage)
            .FirstOrDefaultAsync(ct);
        if (!string.IsNullOrWhiteSpace(guestNativeLanguage))
        {
            // Predicate does the "don't clobber" check in SQL, inside this transaction, so a
            // concurrent profile update can't slip between a read and a write.
            await _db.Users
                .Where(x => x.Id == realUserId && (x.NativeLanguage == null || x.NativeLanguage == ""))
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.NativeLanguage, guestNativeLanguage), ct);
        }

        // Delete guest user (cascades refresh tokens, password reset tokens — reparented rows survive).
        await _db.Users.Where(x => x.Id == guestUserId).ExecuteDeleteAsync(ct);

        await tx.CommitAsync(ct);
    }

    /// <summary>
    /// Re-parents <typeparamref name="T"/> rows from guest to real, dropping guest rows whose
    /// composite unique key (per <paramref name="keySelector"/>) already exists on the real user.
    /// </summary>
    private async Task ReparentDropOnConflictAsync<T>(
        DbSet<T> set,
        Guid from,
        Guid to,
        Func<T, object?> keySelector,
        CancellationToken ct) where T : class
    {
        var guestRows = await set.Where(EntityUserIdEquals<T>(from)).ToListAsync(ct);
        if (guestRows.Count == 0) return;

        var realRows = await set.Where(EntityUserIdEquals<T>(to)).ToListAsync(ct);
        var realKeys = new HashSet<object>(realRows.Select(r => keySelector(r) ?? new object()));

        foreach (var g in guestRows)
        {
            var key = keySelector(g);
            if (key != null && realKeys.Contains(key))
                set.Remove(g);
            else
                SetUserId(g, to);
        }
    }

    private static System.Linq.Expressions.Expression<Func<T, bool>> EntityUserIdEquals<T>(Guid id)
    {
        var p = System.Linq.Expressions.Expression.Parameter(typeof(T), "x");
        var prop = System.Linq.Expressions.Expression.Property(p, "UserId");
        var val = System.Linq.Expressions.Expression.Constant(id);
        return System.Linq.Expressions.Expression.Lambda<Func<T, bool>>(
            System.Linq.Expressions.Expression.Equal(prop, val), p);
    }

    private static void SetUserId<T>(T row, Guid id)
    {
        typeof(T).GetProperty("UserId")!.SetValue(row, id);
    }

    public async Task<(User user, string accessToken, string refreshToken)?> RefreshTokenAsync(
        string refreshToken,
        CancellationToken ct)
    {
        var token = await _db.UserRefreshTokens
            .Include(x => x.User)
            .FirstOrDefaultAsync(x => x.Token == refreshToken && x.ExpiresAt > DateTimeOffset.UtcNow, ct);

        if (token == null)
            return null;

        // Rotate refresh token — catch race condition if token already consumed by concurrent request
        try
        {
            _db.UserRefreshTokens.Remove(token);
            // Preserve guest-vs-real TTL on refresh — guests keep the shorter window.
            var newRefreshToken = await CreateRefreshTokenAsync(token.UserId, ct, isGuest: token.User.IsGuest);
            var accessToken = GenerateAccessToken(token.User);
            return (token.User, accessToken, newRefreshToken);
        }
        catch (DbUpdateConcurrencyException)
        {
            return null;
        }
    }

    public async Task<bool> LogoutAsync(string refreshToken, CancellationToken ct)
    {
        var token = await _db.UserRefreshTokens
            .FirstOrDefaultAsync(x => x.Token == refreshToken, ct);

        if (token == null)
            return false;

        _db.UserRefreshTokens.Remove(token);
        await _db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<User?> GetUserByIdAsync(Guid userId, CancellationToken ct)
    {
        return await _db.Users.FirstOrDefaultAsync(x => x.Id == userId, ct);
    }

    public async Task<(User user, string accessToken, string refreshToken)?> RegisterWithEmailAsync(
        string email, string password, string? name, Guid? guestUserId, CancellationToken ct)
    {
        email = email.Trim().ToLowerInvariant();

        if (!System.Net.Mail.MailAddress.TryCreate(email, out _))
            return null;

        if (password.Length < 8 || password.Length > 128)
            return null;

        var exists = await _db.Users.AnyAsync(x => x.Email == email, ct);
        if (exists)
            return null;

        User user;
        if (guestUserId.HasValue)
        {
            // Promote guest user in-place
            var guest = await _db.Users.FirstOrDefaultAsync(x => x.Id == guestUserId.Value && x.IsGuest, ct);
            if (guest != null)
            {
                guest.Email = email;
                guest.Name = name?.Trim();
                guest.PasswordHash = BCrypt.Net.BCrypt.HashPassword(password);
                guest.IsGuest = false;
                user = guest;
            }
            else
            {
                user = new User
                {
                    Id = Guid.NewGuid(),
                    Email = email,
                    Name = name?.Trim(),
                    PasswordHash = BCrypt.Net.BCrypt.HashPassword(password),
                    CreatedAt = DateTimeOffset.UtcNow
                };
                _db.Users.Add(user);
            }
        }
        else
        {
            user = new User
            {
                Id = Guid.NewGuid(),
                Email = email,
                Name = name?.Trim(),
                PasswordHash = BCrypt.Net.BCrypt.HashPassword(password),
                CreatedAt = DateTimeOffset.UtcNow
            };
            _db.Users.Add(user);
        }

        await _db.SaveChangesAsync(ct);

        var accessToken = GenerateAccessToken(user);
        var refreshToken = await CreateRefreshTokenAsync(user.Id, ct);
        return (user, accessToken, refreshToken);
    }

    public async Task<(User user, string accessToken, string refreshToken)?> LoginWithEmailAsync(
        string email, string password, CancellationToken ct)
    {
        email = email.Trim().ToLowerInvariant();

        var user = await _db.Users.FirstOrDefaultAsync(x => x.Email == email, ct);
        if (user == null || user.PasswordHash == null)
            return null;

        if (!BCrypt.Net.BCrypt.Verify(password, user.PasswordHash))
            return null;

        var accessToken = GenerateAccessToken(user);
        var refreshToken = await CreateRefreshTokenAsync(user.Id, ct);
        return (user, accessToken, refreshToken);
    }

    public async Task<bool> EmailExistsAsync(string email, CancellationToken ct)
    {
        return await _db.Users.AnyAsync(x => x.Email == email.Trim().ToLowerInvariant(), ct);
    }

    public async Task<string?> RequestPasswordResetAsync(string email, CancellationToken ct)
    {
        email = email.Trim().ToLowerInvariant();
        var user = await _db.Users.FirstOrDefaultAsync(x => x.Email == email && x.PasswordHash != null, ct);
        if (user == null)
            return null; // Don't reveal if email exists

        var rawToken = GenerateSecureToken();
        var tokenHash = HashToken(rawToken);

        var resetToken = new PasswordResetToken
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            TokenHash = tokenHash,
            ExpiresAt = DateTimeOffset.UtcNow.AddHours(1),
            CreatedAt = DateTimeOffset.UtcNow,
            Used = false
        };

        _db.PasswordResetTokens.Add(resetToken);
        await _db.SaveChangesAsync(ct);

        return rawToken;
    }

    public async Task<bool> ResetPasswordAsync(string token, string newPassword, CancellationToken ct)
    {
        if (newPassword.Length < 8 || newPassword.Length > 128)
            return false;

        var tokenHash = HashToken(token);
        var resetToken = await _db.PasswordResetTokens
            .Include(x => x.User)
            .FirstOrDefaultAsync(x => x.TokenHash == tokenHash && !x.Used && x.ExpiresAt > DateTimeOffset.UtcNow, ct);

        if (resetToken == null)
            return false;

        resetToken.Used = true;
        resetToken.User.PasswordHash = BCrypt.Net.BCrypt.HashPassword(newPassword);

        // Invalidate all refresh tokens for this user
        var refreshTokens = await _db.UserRefreshTokens
            .Where(x => x.UserId == resetToken.UserId)
            .ToListAsync(ct);
        _db.UserRefreshTokens.RemoveRange(refreshTokens);

        await _db.SaveChangesAsync(ct);
        return true;
    }

    // ===========================================================================
    // OAuth 2.0 Device Authorization Grant (RFC 8628) — AI-050a
    // Reuses the same GenerateAccessToken + CreateRefreshTokenAsync as the login
    // path; uses the injected TimeProvider so expiry is testable with a fake clock.
    // ===========================================================================

    /// <summary>
    /// RFC 8628 §3.2 — create a device authorization. Returns the PLAINTEXT
    /// device_code (returned to the CLI once, stored only hashed) + the short
    /// user_code the user types into the consent page.
    /// </summary>
    public async Task<DeviceCodeResult> CreateDeviceAuthorizationAsync(CancellationToken ct)
    {
        var deviceCode = DeviceCodes.GenerateSecureToken();
        var deviceCodeHash = DeviceCodes.HashToken(deviceCode);
        var now = _clock.GetUtcNow();

        var userCode = await GenerateUniqueUserCodeAsync(now, ct);

        const int expiresInSeconds = 600; // 10 min
        const int intervalSeconds = 5;

        _db.DeviceAuthorizations.Add(new DeviceAuthorization
        {
            Id = Guid.NewGuid(),
            DeviceCodeHash = deviceCodeHash,
            UserCode = userCode,
            Status = DeviceAuthorizationStatus.Pending,
            ExpiresAt = now.AddSeconds(expiresInSeconds),
            IntervalSeconds = intervalSeconds,
            CreatedAt = now
        });
        await _db.SaveChangesAsync(ct);

        return new DeviceCodeResult(deviceCode, userCode, expiresInSeconds, intervalSeconds);
    }

    /// <summary>Approve a pending device authorization, binding it to the user.</summary>
    public async Task<DeviceApprovalResult> ApproveDeviceAsync(string userCode, Guid userId, CancellationToken ct)
    {
        var normalized = DeviceCodes.NormalizeUserCode(userCode);
        if (normalized.Length == 0)
            return DeviceApprovalResult.NotFound;

        // Scope to the live pending row only. The UserCode index is FILTERED on
        // status='pending' (not unique), so the same user_code legitimately recurs
        // across history (old denied/expired/approved rows). Filtering on Pending
        // makes those stale terminal rows invisible — we only ever act on the one
        // still-live row. Expiry is checked below (lazy-expiry) so a genuinely
        // past-deadline pending row still reports Expired rather than NotFound.
        var row = await _db.DeviceAuthorizations.FirstOrDefaultAsync(
            x => x.UserCode == normalized && x.Status == DeviceAuthorizationStatus.Pending, ct);
        if (row == null)
            return DeviceApprovalResult.NotFound;

        var now = _clock.GetUtcNow();
        if (row.ExpiresAt <= now)
        {
            row.Status = DeviceAuthorizationStatus.Expired;
            await _db.SaveChangesAsync(ct);
            return DeviceApprovalResult.Expired;
        }

        row.Status = DeviceAuthorizationStatus.Approved;
        row.UserId = userId;
        await _db.SaveChangesAsync(ct);
        return DeviceApprovalResult.Ok;
    }

    /// <summary>Deny a pending device authorization (user rejected the CLI).</summary>
    public async Task<DeviceApprovalResult> DenyDeviceAsync(string userCode, CancellationToken ct)
    {
        var normalized = DeviceCodes.NormalizeUserCode(userCode);
        if (normalized.Length == 0)
            return DeviceApprovalResult.NotFound;

        // Same scoping as ApproveDeviceAsync: act on the live pending row only so a
        // stale terminal row sharing the same recurring user_code is never touched.
        var row = await _db.DeviceAuthorizations.FirstOrDefaultAsync(
            x => x.UserCode == normalized && x.Status == DeviceAuthorizationStatus.Pending, ct);
        if (row == null)
            return DeviceApprovalResult.NotFound;

        var now = _clock.GetUtcNow();
        if (row.ExpiresAt <= now)
        {
            row.Status = DeviceAuthorizationStatus.Expired;
            await _db.SaveChangesAsync(ct);
            return DeviceApprovalResult.Expired;
        }

        row.Status = DeviceAuthorizationStatus.Denied;
        await _db.SaveChangesAsync(ct);
        return DeviceApprovalResult.Ok;
    }

    /// <summary>
    /// RFC 8628 §3.4/§3.5 — the CLI polls with its device_code. Returns either a
    /// freshly-minted token pair (single-use) or one of the RFC error states.
    /// </summary>
    public async Task<DeviceRedeemResult> RedeemDeviceCodeAsync(string deviceCode, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(deviceCode))
            return DeviceRedeemResult.ExpiredToken(); // unknown == don't distinguish

        var hash = DeviceCodes.HashToken(deviceCode);
        var row = await _db.DeviceAuthorizations
            .Include(x => x.User)
            .FirstOrDefaultAsync(x => x.DeviceCodeHash == hash, ct);

        // Unknown device_code → expired_token (avoid enumeration; don't reveal "not found").
        if (row == null)
            return DeviceRedeemResult.ExpiredToken();

        var now = _clock.GetUtcNow();

        // Lazily mark past-expiry pending rows expired.
        if (row.Status == DeviceAuthorizationStatus.Pending && row.ExpiresAt <= now)
        {
            row.Status = DeviceAuthorizationStatus.Expired;
            await _db.SaveChangesAsync(ct);
            return DeviceRedeemResult.ExpiredToken();
        }

        switch (row.Status)
        {
            case DeviceAuthorizationStatus.Pending:
                return DeviceRedeemResult.AuthorizationPending();
            case DeviceAuthorizationStatus.Denied:
                return DeviceRedeemResult.AccessDenied();
            case DeviceAuthorizationStatus.Expired:
                return DeviceRedeemResult.ExpiredToken();
            case DeviceAuthorizationStatus.Approved when row.User != null:
                // Single-use: flip status off pending so a second redeem can't re-mint.
                row.Status = DeviceAuthorizationStatus.Expired;
                row.ConsumedAt = now;
                var accessToken = GenerateAccessToken(row.User);
                var refreshToken = await CreateRefreshTokenAsync(row.User.Id, ct);
                return DeviceRedeemResult.Success(row.User, accessToken, refreshToken);
            default:
                // Approved-but-already-consumed (UserId set, status flipped) or any
                // other terminal state → treat as expired (don't re-issue).
                return DeviceRedeemResult.ExpiredToken();
        }
    }

    private async Task<string> GenerateUniqueUserCodeAsync(DateTimeOffset now, CancellationToken ct)
    {
        for (var attempt = 0; attempt < 8; attempt++)
        {
            var candidate = DeviceCodes.GenerateUserCode();
            // Collision only matters among still-live pending rows (the approve lookup).
            var clash = await _db.DeviceAuthorizations.AnyAsync(
                x => x.UserCode == candidate
                    && x.Status == DeviceAuthorizationStatus.Pending
                    && x.ExpiresAt > now, ct);
            if (!clash)
                return candidate;
        }
        throw new InvalidOperationException("Could not generate a unique device user_code.");
    }

    private static string HashToken(string token) => DeviceCodes.HashToken(token);

    /// <summary>
    /// Marks an access token as a guest's. Minted in <c>BuildClaims</c>, read by
    /// <c>ValidateAccessTokenIdentity</c> — one definition so the two cannot drift, which is the
    /// failure that left the guest-activity middleware inert.
    /// </summary>
    public const string GuestClaimType = "is_guest";

    public Guid? ValidateAccessToken(string accessToken) => ValidateAccessTokenIdentity(accessToken).UserId;

    /// <summary>
    /// The user this token belongs to, AND whether it is a guest's.
    ///
    /// <para>The <c>is_guest</c> claim has been minted into every guest's access token since guest
    /// sessions shipped (see <see cref="BuildClaims"/>), and until now nothing could read it: this
    /// API registers no ASP.NET authentication middleware at all — every endpoint resolves identity
    /// by hand through <c>GetUserId</c> — so <c>HttpContext.User</c> is permanently empty. Anything
    /// reaching for the claim through <c>context.User</c> silently saw nothing, which is exactly how
    /// <c>GuestActivityMiddleware</c> spent its whole life returning early on every request.</para>
    ///
    /// <para>Returns <c>(null, false)</c> for a token that does not validate, so a caller cannot
    /// mistake an expired token for an account.</para>
    /// </summary>
    public (Guid? UserId, bool IsGuest) ValidateAccessTokenIdentity(string accessToken)
    {
        var tokenHandler = new JwtSecurityTokenHandler();
        var key = Encoding.UTF8.GetBytes(_jwtSettings.SecretKey);

        try
        {
            var principal = tokenHandler.ValidateToken(accessToken, new TokenValidationParameters
            {
                ValidateIssuerSigningKey = true,
                IssuerSigningKey = new SymmetricSecurityKey(key),
                ValidateIssuer = true,
                ValidIssuer = _jwtSettings.Issuer,
                ValidateAudience = false,
                ValidateLifetime = true,
                ClockSkew = TimeSpan.Zero
            }, out _);

            var userIdClaim = principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;
            if (userIdClaim == null) return (null, false);

            var isGuest = principal.FindFirst(GuestClaimType)?.Value == "true";
            return (Guid.Parse(userIdClaim), isGuest);
        }
        catch
        {
            return (null, false);
        }
    }

    private async Task<User> GetOrCreateUserAsync(GoogleJsonWebSignature.Payload payload, CancellationToken ct)
    {
        var user = await _db.Users.FirstOrDefaultAsync(x => x.GoogleSubject == payload.Subject, ct);

        if (user != null)
        {
            // Update name/email/picture if changed
            if (user.Email != payload.Email || user.Name != payload.Name || user.Picture != payload.Picture)
            {
                user.Email = payload.Email;
                user.Name = payload.Name;
                user.Picture = payload.Picture;
                await _db.SaveChangesAsync(ct);
            }
            return user;
        }

        user = new User
        {
            Id = Guid.NewGuid(),
            Email = payload.Email,
            Name = payload.Name,
            Picture = payload.Picture,
            GoogleSubject = payload.Subject,
            CreatedAt = DateTimeOffset.UtcNow
        };

        _db.Users.Add(user);
        await _db.SaveChangesAsync(ct);
        return user;
    }

    private string GenerateAccessToken(User user)
    {
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_jwtSettings.SecretKey));
        var credentials = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new(ClaimTypes.Email, user.Email),
            new(ClaimTypes.Name, user.Name ?? user.Email)
        };
        if (user.IsGuest)
            claims.Add(new Claim(GuestClaimType, "true"));

        var token = new JwtSecurityToken(
            issuer: _jwtSettings.Issuer,
            claims: claims,
            expires: DateTime.UtcNow.AddMinutes(_jwtSettings.AccessTokenExpiryMinutes),
            signingCredentials: credentials
        );

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private async Task<string> CreateRefreshTokenAsync(Guid userId, CancellationToken ct, bool isGuest = false)
    {
        // Guest sessions get a shorter refresh window — reduces DB bloat from abandoned accounts.
        var ttlDays = isGuest
            ? _jwtSettings.GuestRefreshTokenExpiryDays
            : _jwtSettings.RefreshTokenExpiryDays;

        var token = new UserRefreshToken
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Token = GenerateSecureToken(),
            ExpiresAt = DateTimeOffset.UtcNow.AddDays(ttlDays),
            CreatedAt = DateTimeOffset.UtcNow
        };

        _db.UserRefreshTokens.Add(token);
        await _db.SaveChangesAsync(ct);
        return token.Token;
    }

    private static string GenerateSecureToken()
    {
        var bytes = new byte[64];
        using var rng = RandomNumberGenerator.Create();
        rng.GetBytes(bytes);
        return Convert.ToBase64String(bytes);
    }

    private (string? subject, string? email) ValidateAppleToken(string identityToken)
    {
        try
        {
            var handler = new JwtSecurityTokenHandler();
            var jwt = handler.ReadJwtToken(identityToken);

            var audience = _appleSettings?.BundleId;
            if (audience != null && jwt.Audiences.All(a => a != audience))
                return (null, null);

            if (jwt.Issuer != "https://appleid.apple.com")
                return (null, null);

            if (jwt.ValidTo < DateTime.UtcNow)
                return (null, null);

            var subject = jwt.Subject;
            var email = jwt.Claims.FirstOrDefault(c => c.Type == "email")?.Value;

            return (subject, email);
        }
        catch
        {
            return (null, null);
        }
    }

    private async Task<User> GetOrCreateAppleUserAsync(
        string appleSubject, string? email, string? fullName, CancellationToken ct)
    {
        var user = await _db.Users.FirstOrDefaultAsync(x => x.AppleSubject == appleSubject, ct);

        if (user != null)
        {
            if (fullName != null && user.Name != fullName)
            {
                user.Name = fullName;
                await _db.SaveChangesAsync(ct);
            }
            return user;
        }

        var resolvedEmail = email ?? $"{appleSubject}@privaterelay.appleid.com";

        user = new User
        {
            Id = Guid.NewGuid(),
            Email = resolvedEmail,
            Name = fullName,
            GoogleSubject = null,
            AppleSubject = appleSubject,
            CreatedAt = DateTimeOffset.UtcNow
        };

        _db.Users.Add(user);
        await _db.SaveChangesAsync(ct);
        return user;
    }
}
