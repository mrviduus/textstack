using System.Net;
using System.Text;
using Api;
using Api.Extensions;
using Application.Common.Interfaces;
using Application.Identity;
using Domain.Entities;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Moq;
using TextStack.UnitTests.Fakes;

namespace TextStack.UnitTests;

public class WriteFreezeApiTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Api_FreezeSelects503BeforeAuthHandler_AndKeepsSessionRead(bool freeze)
    {
        var root = Path.Combine(Path.GetTempPath(), "textstack-write-freeze", Guid.NewGuid().ToString("N"));
        var guest = new User { Id = Guid.NewGuid(), Email = "freeze@guest.textstack.app", IsGuest = true };
        var db = new Mock<IAppDbContext>();
        db.Setup(d => d.Users).Returns(new FakeDbSet<User>([guest]));
        var users = new Mock<IUserRepository>();
        try
        {
            await using var api = new WebApplicationFactory<ApiMarker>().WithWebHostBuilder(builder =>
            {
                builder.UseEnvironment("Test");
                builder.UseSetting("Jwt:SecretKey", TestTokens.Secret);
                builder.UseSetting("Jwt:Issuer", TestTokens.Issuer);
                builder.UseSetting("Features:V2Api", "false");
                builder.UseSetting("ConnectionStrings:V2", "Host=127.0.0.1;Port=1;Database=textstack_v2;Timeout=1");
                builder.UseSetting("Maintenance:WriteFreeze", freeze.ToString());
                builder.UseSetting("Storage:RootPath", Path.Combine(root, "storage"));
                builder.UseSetting("Storage:LibraryRoot", Path.Combine(root, "library"));
                builder.ConfigureTestServices(services =>
                {
                    services.RemoveAll<IHostedService>();
                    services.RemoveAll<IAppDbContext>();
                    services.AddSingleton(db.Object);
                    services.RemoveAll<IUserRepository>();
                    services.AddSingleton(users.Object);
                });
            });
            using var client = api.CreateClient();
            using var body = new StringContent("{\"email\":\"\",\"password\":\"\"}", Encoding.UTF8, "application/json");

            using var write = await client.PostAsync("/auth/register", body, TestContext.Current.CancellationToken);
            using var read = await client.GetAsync("/auth/me", TestContext.Current.CancellationToken);

            Assert.Equal(freeze ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.BadRequest, write.StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized, read.StatusCode);

            client.DefaultRequestHeaders.Authorization = new("Bearer", TestTokens.Token(guest.Id, guestClaim: true));
            using var guestRead = await client.GetAsync("/auth/me", TestContext.Current.CancellationToken);
            Assert.Equal(HttpStatusCode.OK, guestRead.StatusCode);
            users.Verify(u => u.TouchActiveAsync(guest.Id, It.IsAny<DateTimeOffset>(), It.IsAny<CancellationToken>()),
                freeze ? Times.Never() : Times.Once());
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void HostedServices_FreezeOmitsApiDatabaseWriters(bool freeze)
    {
        var services = new ServiceCollection();
        services.AddTextStackHostedServices(freeze);
        Assert.Equal(freeze ? 0 : 5, services.Count(s => s.ServiceType == typeof(IHostedService)));
    }
}
