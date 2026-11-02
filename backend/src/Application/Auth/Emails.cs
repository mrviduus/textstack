namespace Application.Auth;

/// <summary>The account email rules legacy and V2 sign-in share, and the placeholders they mint.</summary>
public static class Emails
{
    /// <summary>The name a guest account carries.</summary>
    public const string GuestName = "Guest";

    /// <summary>How an email is stored and looked up: trimmed, lower-cased.</summary>
    public static string Normalize(string email) => email.Trim().ToLowerInvariant();

    /// <summary>A new guest's placeholder email, unique.</summary>
    public static string NewGuest() => $"guest-{Guid.NewGuid():N}@guest.local";

    /// <summary>The email of an Apple account that shared none.</summary>
    public static string AppleRelay(string appleSubject) => $"{appleSubject}@privaterelay.appleid.com";
}
