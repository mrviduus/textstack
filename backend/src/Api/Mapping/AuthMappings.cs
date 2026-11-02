using Application.Auth;
using Domain.Entities;
using Domain.Identity;

namespace Api.Mapping;

// R4: single source of truth for User -> UserDto. In-memory only (User is always
// materialised before mapping), so just the extension method — no EF Project needed.
public static class AuthMappings
{
    public static UserDto ToDto(this User user) =>
        new(user.Id, user.Email, user.Name, user.Picture, user.IsGuest, user.CreatedAt, user.NativeLanguage);

    public static UserDto ToDto(this UserAccount user) =>
        new(user.Id, user.Email, user.Name, user.Picture, user.IsGuest, user.CreatedAt, user.NativeLanguage);
}
