using Api.Extensions;
using Application.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http.Resilience;

namespace TextStack.UnitTests;

/// <summary>The email client sends POSTs without an idempotency key: it must give up fast and never retry.</summary>
public class EmailHttpClientTests
{
    [Fact]
    public void AddTextStackContentServices_EmailClient_HasTenSecondTimeoutAndNoRetries()
    {
        var services = new ServiceCollection().AddLogging();
        services.AddTextStackContentServices(new ConfigurationBuilder().Build());
        using var sp = services.BuildServiceProvider();
        var name = nameof(IEmailService); // typed-client name

        Assert.Equal(TimeSpan.FromSeconds(10), sp.GetRequiredService<IHttpClientFactory>().CreateClient(name).Timeout);

        HttpMessageHandler? handler = sp.GetRequiredService<IHttpMessageHandlerFactory>().CreateHandler(name);
        for (; handler is DelegatingHandler d; handler = d.InnerHandler)
            Assert.IsNotType<ResilienceHandler>(handler);
    }
}
