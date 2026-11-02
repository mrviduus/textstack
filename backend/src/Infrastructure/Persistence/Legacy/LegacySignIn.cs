using System.Runtime.CompilerServices;

namespace Infrastructure.Persistence.Legacy;

/// <summary>
/// The answer of an EF adapter member that legacy runs elsewhere: sign-in, sessions, resets and the
/// device flow are legacy <c>AuthService</c>'s and <c>AdminAuthService</c>'s own EF, and only
/// <c>V2AuthService</c> calls these port members, which M5.1 binds to the V2 repositories. Reaching
/// one is a wiring bug, so it throws rather than answering with legacy semantics nobody tested.
/// </summary>
internal static class LegacySignIn
{
    // ponytail: the sign-in members of the ports have no legacy implementation; write one only if
    // something other than V2AuthService ever needs them on legacy.
    public static NotSupportedException Owns([CallerMemberName] string member = "") =>
        new($"{member} is not on the legacy ports: legacy sign-in runs through AuthService/AdminAuthService (#1100)");
}
