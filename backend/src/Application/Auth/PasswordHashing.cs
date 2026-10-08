namespace Application.Auth;

/// <summary>The one place a password is checked against its stored BCrypt hash.</summary>
public static class PasswordHashing
{
    /// <summary>
    /// A hash BCrypt cannot parse (a bad hand edit, a truncated value) is a failed login, not a 500.
    /// BCrypt.Net throws several exception types for corrupt input; none of them means "match".
    /// </summary>
    public static bool Matches(string password, string? hash)
    {
        if (string.IsNullOrEmpty(hash)) return false;
        try { return BCrypt.Net.BCrypt.Verify(password, hash); }
        catch (Exception) { return false; }
    }
}
