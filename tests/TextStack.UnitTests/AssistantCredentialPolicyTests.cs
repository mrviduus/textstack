using System.Net;
using Api.Extensions;
using Api.Middleware;
using Microsoft.AspNetCore.Http;

namespace TextStack.UnitTests;

/// <summary>
/// Account routes refuse assistant credentials (<c>tso_</c> and <c>tsk_</c> alike — the middleware
/// marks both the same way); per-IP rate limits key IPv6 by /64.
/// </summary>
public class AssistantCredentialPolicyTests
{
    private static async Task<int?> RunFilterAsync(bool marked)
    {
        var http = new DefaultHttpContext();
        if (marked) http.Items[McpKeyAuthMiddleware.OAuthTokenItemKey] = true;

        var reachedEndpoint = false;
        var result = await new RejectOAuthTokenFilter().InvokeAsync(
            new DefaultEndpointFilterInvocationContext(http),
            _ => { reachedEndpoint = true; return ValueTask.FromResult<object?>(Results.Ok()); });

        return reachedEndpoint ? null : (result as IStatusCodeHttpResult)?.StatusCode;
    }

    [Fact]
    public async Task RejectFilter_AssistantCredential_Returns403()
    {
        Assert.Equal(StatusCodes.Status403Forbidden, await RunFilterAsync(marked: true));
    }

    [Fact]
    public async Task RejectFilter_JwtOrAnonymous_ReachesEndpoint()
    {
        Assert.Null(await RunFilterAsync(marked: false));
    }

    [Theory]
    [InlineData("203.0.113.7", "203.0.113.7")]
    [InlineData("::ffff:203.0.113.7", "203.0.113.7")]
    [InlineData("2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64")]
    [InlineData("2001:db8:1:2::1", "2001:db8:1:2::/64")]
    [InlineData("::1", "::/64")]
    public void IpPartitionKey_Address_KeysAsExpected(string address, string expected)
    {
        Assert.Equal(expected, ServiceCollectionExtensions.IpPartitionKey(IPAddress.Parse(address)));
    }

    [Fact]
    public void IpPartitionKey_SameIpv6Slash64_SharesPartition()
    {
        Assert.Equal(
            ServiceCollectionExtensions.IpPartitionKey(IPAddress.Parse("2001:db8:0:5::1")),
            ServiceCollectionExtensions.IpPartitionKey(IPAddress.Parse("2001:db8:0:5:ffff::9")));
        Assert.NotEqual(
            ServiceCollectionExtensions.IpPartitionKey(IPAddress.Parse("2001:db8:0:5::1")),
            ServiceCollectionExtensions.IpPartitionKey(IPAddress.Parse("2001:db8:0:6::1")));
    }

    [Fact]
    public void IpPartitionKey_Null_ReturnsNull()
    {
        Assert.Null(ServiceCollectionExtensions.IpPartitionKey(null));
    }
}
