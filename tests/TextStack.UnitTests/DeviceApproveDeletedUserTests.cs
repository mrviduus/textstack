using Application.Auth;
using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Moq;

namespace TextStack.UnitTests;

/// <summary>#1119: a valid access token whose user row is gone approves nothing (401), never a 500 from the FK.</summary>
public class DeviceApproveDeletedUserTests
{
    private const string UserCode = "WDJBMQXR";

    private readonly List<User> _users = [];
    private readonly List<DeviceAuthorization> _devices = [];
    private readonly Mock<IAppDbContext> _db = new();
    private readonly AuthService _service;

    public DeviceApproveDeletedUserTests()
    {
        _db.Setup(x => x.Users).Returns(() => FakeSet(_users).Object);
        _db.Setup(x => x.DeviceAuthorizations).Returns(() => FakeSet(_devices).Object);
        _db.Setup(x => x.SaveChangesAsync(It.IsAny<CancellationToken>())).ReturnsAsync(1);
        _service = new AuthService(
            _db.Object,
            Options.Create(new JwtSettings { SecretKey = new string('k', 64) }),
            Options.Create(new GoogleSettings { ClientId = "test" }));
        _devices.Add(new DeviceAuthorization
        {
            Id = Guid.NewGuid(),
            UserCode = "WDJB-MQXR",
            Status = DeviceAuthorizationStatus.Pending,
            ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(10),
            CreatedAt = DateTimeOffset.UtcNow,
        });
    }

    private static Mock<DbSet<T>> FakeSet<T>(List<T> data) where T : class
    {
        var q = new TestAsyncEnumerable<T>(data);
        var set = new Mock<DbSet<T>>();
        var iq = set.As<IQueryable<T>>();
        iq.Setup(m => m.Provider).Returns(((IQueryable<T>)q).Provider);
        iq.Setup(m => m.Expression).Returns(((IQueryable<T>)q).Expression);
        iq.Setup(m => m.ElementType).Returns(((IQueryable<T>)q).ElementType);
        iq.Setup(m => m.GetEnumerator()).Returns(() => data.GetEnumerator());
        set.As<IAsyncEnumerable<T>>()
            .Setup(m => m.GetAsyncEnumerator(It.IsAny<CancellationToken>()))
            .Returns(() => new TestAsyncEnumerator<T>(data.GetEnumerator()));
        return set;
    }

    [Fact]
    public async Task ApproveDeviceAsync_UserRowDeleted_UnauthorizedAndRowUntouched()
    {
        var result = await _service.ApproveDeviceAsync(UserCode, Guid.NewGuid(), CancellationToken.None);

        Assert.Equal(DeviceApprovalResult.Unauthorized, result);
        Assert.Equal(DeviceAuthorizationStatus.Pending, _devices[0].Status);
        Assert.Null(_devices[0].UserId);
        _db.Verify(x => x.SaveChangesAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task ApproveDeviceAsync_UserExists_ApprovesAndBindsUser()
    {
        var user = new User { Id = Guid.NewGuid(), Email = "a@test.dev" };
        _users.Add(user);

        var result = await _service.ApproveDeviceAsync(UserCode, user.Id, CancellationToken.None);

        Assert.Equal(DeviceApprovalResult.Ok, result);
        Assert.Equal(DeviceAuthorizationStatus.Approved, _devices[0].Status);
        Assert.Equal(user.Id, _devices[0].UserId);
    }
}
