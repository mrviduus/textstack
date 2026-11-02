using System.IdentityModel.Tokens.Jwt;
using Google.Apis.Auth;

namespace Application.Auth;

/// <summary>A sign-in a provider vouched for: Google's verified id token, or Apple's identity token.</summary>
public sealed record ProviderIdentity(string Subject, string? Email, string? Name, string? Picture);

/// <summary>
/// Google and Apple sign-in tokens, read for the identity they name; legacy and V2 alike. Virtual so a
/// test can stand in for the providers.
/// </summary>
public class ProviderTokens(GoogleSettings? google = null, AppleSettings? apple = null)
{
    public const string AppleIssuer = "https://appleid.apple.com";

    /// <summary>The Google account a verified id token names, for this app's client ids; null when it does not verify.</summary>
    public virtual async Task<ProviderIdentity?> VerifyGoogleAsync(string idToken)
    {
        if (google is null) return null;
        try
        {
            var audiences = new List<string> { google.ClientId };
            if (!string.IsNullOrWhiteSpace(google.LegacyClientIds))
            {
                audiences.AddRange(google.LegacyClientIds.Split(
                    ',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
            }
            var payload = await GoogleJsonWebSignature.ValidateAsync(idToken, new GoogleJsonWebSignature.ValidationSettings
            {
                Audience = audiences
            });
            return new ProviderIdentity(payload.Subject, payload.Email, payload.Name, payload.Picture);
        }
        catch (InvalidJwtException)
        {
            return null;
        }
    }

    /// <summary>
    /// The Apple account an identity token names; null when its audience, issuer or expiry is wrong.
    /// ponytail: signature not validated — legacy behaviour, owner-deferred 2026-11-02.
    /// </summary>
    public virtual ProviderIdentity? VerifyApple(string identityToken)
    {
        try
        {
            var token = new JwtSecurityTokenHandler().ReadJwtToken(identityToken);

            var audience = apple?.BundleId;
            if (audience != null && token.Audiences.All(a => a != audience))
                return null;

            if (token.Issuer != AppleIssuer)
                return null;

            if (token.ValidTo < DateTime.UtcNow)
                return null;

            var email = token.Claims.FirstOrDefault(c => c.Type == "email")?.Value;
            return token.Subject is null ? null : new ProviderIdentity(token.Subject, email, null, null);
        }
        catch
        {
            return null;
        }
    }
}
