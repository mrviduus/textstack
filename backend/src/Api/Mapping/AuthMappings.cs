using Application.Identity;
using Domain.Identity;

namespace Api.Mapping;

// Single source of truth for UserAccount -> UserDto.
public static class AuthMappings
{
    public static UserDto ToDto(this UserAccount user) =>
        new(user.Id, user.Email, user.Name, user.Picture, user.IsGuest, user.CreatedAt, user.NativeLanguage);
}
