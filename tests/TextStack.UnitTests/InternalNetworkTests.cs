using System.Net;
using Api.Extensions;

namespace TextStack.UnitTests;

public class InternalNetworkTests
{
    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("::1")]
    [InlineData("172.18.0.1")]   // docker bridge gateway (host pollers)
    [InlineData("10.0.0.5")]
    [InlineData("::ffff:172.18.0.1")]
    public void IsLocal_DockerOrHost_True(string ip) =>
        Assert.True(InternalNetwork.IsLocal(IPAddress.Parse(ip)));

    [Theory]
    [InlineData("8.8.8.8")]
    [InlineData("172.32.0.1")]
    [InlineData("192.168.1.10")]
    // Public IPv6 whose last 32 bits look like 10.0.0.1 / 172.16.0.1 — the old MapToIPv4 hole.
    [InlineData("2001:db8::a00:1")]
    [InlineData("2001:db8::ac10:1")]
    public void IsLocal_Public_False(string ip) =>
        Assert.False(InternalNetwork.IsLocal(IPAddress.Parse(ip)));

    [Fact]
    public void IsLocal_NoAddress_False() => Assert.False(InternalNetwork.IsLocal(null));
}
