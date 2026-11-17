using Google.Apis.Auth;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.JsonWebTokens;
using JsonWebToken = Microsoft.IdentityModel.JsonWebTokens.JsonWebToken;
using Microsoft.IdentityModel.Tokens;

namespace Application.Auth;

/// <summary>A sign-in a provider vouched for: Google's verified id token, or Apple's identity token.</summary>
public sealed record ProviderIdentity(string Subject, string? Email, string? Name, string? Picture);

/// <summary>
/// Google and Apple sign-in tokens, read for the identity they name; legacy and V2 alike. Virtual so a
/// test can stand in for the providers.
/// </summary>
public class ProviderTokens(GoogleSettings? google = null, AppleSettings? apple = null, AppleSigningKeys? appleKeys = null,
    ILogger? logger = null)
{
    public const string AppleIssuer = "https://appleid.apple.com";

    private static readonly JsonWebTokenHandler Handler = new();

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
    /// The Apple account an identity token names: RS256-signed by one of Apple's published keys, issued by
    /// Apple, for this app's bundle id, unexpired. Null otherwise, and always null without <c>Apple:BundleId</c>.
    /// </summary>
    public virtual async Task<ProviderIdentity?> VerifyAppleAsync(string identityToken, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(apple?.BundleId)) return null;

        JsonWebToken parsed;
        try
        {
            parsed = Handler.ReadJsonWebToken(identityToken);
        }
        catch (Exception ex)
        {
            // Any malformed input (not a JWT, bad base64, bad JSON) is a refusal, never an error.
            logger?.LogInformation("Apple sign-in refused: unreadable identity token ({Reason})", ex.GetType().Name);
            return null;
        }
        if (parsed.IsEncrypted)
        {
            logger?.LogInformation("Apple sign-in refused: encrypted identity token");
            return null;
        }

        var result = await Handler.ValidateTokenAsync(parsed, new TokenValidationParameters
        {
            ValidIssuer = AppleIssuer,
            ValidAudience = apple.BundleId,
            IssuerSigningKeys = await (appleKeys ?? AppleSigningKeys.Shared).GetAsync(parsed.Kid, logger, ct),
            ValidAlgorithms = [SecurityAlgorithms.RsaSha256],
            RequireSignedTokens = true,
            RequireExpirationTime = true,
            ClockSkew = TimeSpan.FromMinutes(1),
        });
        if (!result.IsValid || result.SecurityToken is not JsonWebToken token)
        {
            logger?.LogInformation("Apple sign-in refused: {Reason}", result.Exception?.GetType().Name ?? "invalid token");
            return null;
        }

        var email = token.TryGetPayloadValue<string>("email", out var e) ? e : null;
        return string.IsNullOrEmpty(token.Subject) ? null : new ProviderIdentity(token.Subject, email, null, null);
    }
}
