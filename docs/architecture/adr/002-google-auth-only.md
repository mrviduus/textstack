# ADR-002: Google OAuth Only

**Status**: Accepted

> **Obsolete.** Email/password (`User.PasswordHash`, `PasswordResetToken`), Apple sign-in (`User.AppleSubject`) and anonymous guest users ([ADR-014](ADR-014-guest-sessions.md)) all shipped after this. Google is one of four ways in, not the only one.
**Date**: 2024-12

## Context

User authentication needed for:
- Reading progress sync
- Bookmarks and notes
- My Library

Options:
1. Email/password
2. Multiple OAuth providers
3. Google OAuth only

## Decision

Use **Google Sign-In only** for user authentication.

- No email/password forms
- No other social providers (initially)
- Single "Continue with Google" button

## Implementation

- ASP.NET Core external auth
- JWT access token (short-lived) + refresh token
- User record created on first login
- Email trusted from Google

## Consequences

### Pros
- No password storage/management
- Trusted email verification
- Simpler auth flow
- Reduced attack surface

### Cons
- Excludes non-Google users
- Dependency on Google services
- May need to add providers later

## Notes

- Admin panel uses separate email/password auth
- User table stores GoogleSubject for identity linking
