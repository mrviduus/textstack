# User Authentication

Google OAuth for users, JWT tokens with HttpOnly cookies.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      Frontend (React)                         │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   AuthContext                                                │
│     ├── user: User | null                                    │
│     ├── isLoading: boolean                                   │
│     ├── isAuthenticated: boolean                             │
│     └── logout: () => Promise<void>                          │
│                                                              │
│   Google Sign-In Button                                      │
│     └── One Tap / Button renders via google.accounts.id      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼ POST /auth/login (credential)
┌──────────────────────────────────────────────────────────────┐
│                      Backend (API)                            │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   1. Validate Google ID token                                │
│   2. Find or create User (by google_subject)                 │
│   3. Issue JWT access token (15min)                          │
│   4. Issue refresh token (7 days)                            │
│   5. Set HttpOnly cookies                                    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Auth Flow

### Login

```
1. User clicks "Sign in with Google"
2. Google popup → user authenticates
3. Google returns credential (ID token)
4. Frontend sends POST /auth/login { credential }
5. Backend validates token, creates/finds user
6. Backend sets cookies:
   - access_token (HttpOnly, 15min)
   - refresh_token (HttpOnly, 7 days)
7. Frontend receives user object
```

### Token Refresh

```
1. API request returns 401
2. Frontend calls POST /auth/refresh
3. Backend validates refresh_token cookie
4. Backend issues new access_token
5. Original request retried
```

### Logout

```
1. Frontend calls POST /auth/logout
2. Backend clears cookies
3. Frontend clears user state
4. Google.accounts.id.disableAutoSelect()
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth/login` | POST | Exchange Google credential for session |
| `/auth/refresh` | POST | Refresh access token |
| `/auth/logout` | POST | Clear session |
| `/auth/me` | GET | Get current user |

### POST /auth/login

**Request:**
```json
{
  "credential": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response:**
```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "John Doe"
  }
}
```

**Cookies Set:**
- `access_token` - JWT, HttpOnly, Secure, SameSite=Strict, 15min
- `refresh_token` - opaque token, HttpOnly, Secure, SameSite=Strict, 7 days

## Frontend Implementation

### AuthContext

```typescript
interface AuthContextValue {
  user: User | null
  isLoading: boolean
  isAuthenticated: boolean
  logout: () => Promise<void>
}
```

### Google Sign-In Setup

```typescript
// Initialize Google Sign-In
google.accounts.id.initialize({
  client_id: GOOGLE_CLIENT_ID,
  callback: handleGoogleCallback,
  auto_select: false,
  cancel_on_tap_outside: true,
})

// Render button
google.accounts.id.renderButton(
  document.getElementById("google-signin"),
  { theme: "outline", size: "large" }
)
```

### Protected Routes

```tsx
function ProtectedRoute({ children }) {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) return <Spinner />
  if (!isAuthenticated) return <Navigate to="/login" />

  return children
}
```

## User Features

### Library

- `POST /me/library` - Add book to library
- `DELETE /me/library/{editionId}` - Remove from library
- `GET /me/library` - List saved books

### Reading Progress

- `POST /me/progress` - Save reading position
- `GET /me/progress` - Get all progress
- `GET /me/progress/{editionId}` - Get specific book progress

### Bookmarks & Notes

- `POST /me/bookmarks` - Create bookmark
- `DELETE /me/bookmarks/{id}` - Delete bookmark
- `GET /me/bookmarks` - List all bookmarks
- `POST /me/notes` - Create note
- `GET /me/notes` - List all notes

## Database

### Users Table

```sql
users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255),
  google_subject VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL
)
```

### User Refresh Tokens

```sql
user_refresh_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  token VARCHAR NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
)
```

## Security

- **HttpOnly cookies** - tokens not accessible via JS
- **SameSite=Strict** - CSRF protection
- **Secure flag** - HTTPS only in production
- **Short-lived access tokens** - 15 minutes
- **Token rotation** - new refresh token on each refresh

## Key Files

| File | Purpose |
|------|---------|
| `apps/web/src/context/AuthContext.tsx` | React auth context |
| `apps/web/src/api/auth.ts` | API client auth functions |
| `backend/src/Api/Endpoints/AuthEndpoints.cs` | Auth API endpoints |
| `backend/src/Application/Auth/AuthService.cs` | Auth business logic |
| `backend/src/Domain/Entities/User.cs` | User entity |

## Environment Variables

```env
# Frontend
VITE_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com

# Backend
Google__ClientId=xxx.apps.googleusercontent.com
Jwt__Secret=your-secret-key
Jwt__Issuer=https://textstack.app
Jwt__Audience=https://textstack.app
```
