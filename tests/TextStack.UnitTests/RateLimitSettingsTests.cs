using Api.Extensions;
using Microsoft.Extensions.Configuration;

namespace TextStack.UnitTests;

/// <summary>
/// The guest-session limiter (3 creates / 5 min / IP) is deliberate for production but makes the
/// guest-merge integration suite impossible: it needs ≥6 guests and CI drives every request from
/// one host. The permit limit is therefore configurable — a knob, NOT a test-only bypass, so the
/// limiter itself stays on the same code path in CI as in production.
/// </summary>
public class RateLimitSettingsTests
{
    private static RateLimitSettings Bind(params (string Key, string Value)[] values)
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(values.Select(v => new KeyValuePair<string, string?>(v.Key, v.Value)))
            .Build();

        return config.GetSection(RateLimitSettings.SectionName).Get<RateLimitSettings>()
            ?? new RateLimitSettings();
    }

    [Fact]
    public void GuestSessionPermitLimit_Unconfigured_IsProductionDefault()
    {
        var settings = Bind();

        Assert.Equal(3, settings.EffectiveGuestSessionPermitLimit);
        Assert.Equal(RateLimitSettings.DefaultGuestSessionPermitLimit, settings.EffectiveGuestSessionPermitLimit);
    }

    [Fact]
    public void GuestSessionPermitLimit_Configured_Overrides()
    {
        // The CI shape: RateLimits__GuestSessionPermitLimit=50 in compose env.
        var settings = Bind(("RateLimits:GuestSessionPermitLimit", "50"));

        Assert.Equal(50, settings.EffectiveGuestSessionPermitLimit);
    }

    [Fact]
    public void GuestSessionPermitLimit_ZeroOrNegative_DegradesToDefault()
    {
        // A configured 0 is a typo, and locking every client out of creating a session is an outage.
        Assert.Equal(3, Bind(("RateLimits:GuestSessionPermitLimit", "0")).EffectiveGuestSessionPermitLimit);
        Assert.Equal(3, Bind(("RateLimits:GuestSessionPermitLimit", "-1")).EffectiveGuestSessionPermitLimit);
    }

    // The other three knobs, added when the limiter started actually running: user-login, clip and
    // account-delete all have production values the integration suite legitimately exceeds from a
    // single host. Same contract as the guest one in all three cases.

    [Fact]
    public void UserLoginPermitLimit_UnconfiguredConfiguredAndInvalid_BehavesLikeGuestKnob()
    {
        Assert.Equal(10, Bind().EffectiveUserLoginPermitLimit);
        Assert.Equal(100, Bind(("RateLimits:UserLoginPermitLimit", "100")).EffectiveUserLoginPermitLimit);
        Assert.Equal(10, Bind(("RateLimits:UserLoginPermitLimit", "0")).EffectiveUserLoginPermitLimit);
        Assert.Equal(10, Bind(("RateLimits:UserLoginPermitLimit", "-5")).EffectiveUserLoginPermitLimit);
    }

    [Fact]
    public void ClipPermitLimit_UnconfiguredConfiguredAndInvalid_BehavesLikeGuestKnob()
    {
        Assert.Equal(20, Bind().EffectiveClipPermitLimit);
        Assert.Equal(200, Bind(("RateLimits:ClipPermitLimit", "200")).EffectiveClipPermitLimit);
        Assert.Equal(20, Bind(("RateLimits:ClipPermitLimit", "0")).EffectiveClipPermitLimit);
    }

    [Fact]
    public void DeviceCodePermitLimit_UnconfiguredConfiguredAndInvalid_BehavesLikeGuestKnob()
    {
        Assert.Equal(5, Bind().EffectiveDeviceCodePermitLimit);
        Assert.Equal(50, Bind(("RateLimits:DeviceCodePermitLimit", "50")).EffectiveDeviceCodePermitLimit);
        Assert.Equal(5, Bind(("RateLimits:DeviceCodePermitLimit", "0")).EffectiveDeviceCodePermitLimit);
    }

    [Fact]
    public void AccountDeletePermitLimit_UnconfiguredConfiguredAndInvalid_BehavesLikeGuestKnob()
    {
        Assert.Equal(3, Bind().EffectiveAccountDeletePermitLimit);
        Assert.Equal(50, Bind(("RateLimits:AccountDeletePermitLimit", "50")).EffectiveAccountDeletePermitLimit);
        Assert.Equal(3, Bind(("RateLimits:AccountDeletePermitLimit", "-1")).EffectiveAccountDeletePermitLimit);
    }
}
