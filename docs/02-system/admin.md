# Admin Panel

Private tool for content management. Separate from public web app.

## Access

- URL: http://localhost:81 (dev)
- Not linked from public UI
- Not in sitemap
- Protected by:
  - Network (VPN/IP allowlist)
  - Admin auth (email/password)

## Authentication

Separate from user auth (Google OAuth).

### Endpoints
```
POST /api/admin/auth/login
POST /api/admin/auth/logout
GET  /api/admin/auth/me
POST /api/admin/auth/refresh
```

### Tables
- `admin_users`: email, password_hash, role, is_active
- `admin_refresh_tokens`: session tokens
- `admin_audit_log`: action history

### Roles
| Role | Access |
|------|--------|
| Admin | Full access |
| Editor | Content only |
| Moderator | Read + limited edit |

## Features

### Upload Books

1. Select site
2. Upload file (EPUB/PDF/FB2)
3. Set language (EN, UK)
4. Optional: link to existing Work (for translations)
5. Submit → creates Edition + IngestionJob

### Manage Editions

| Action | Description |
|--------|-------------|
| List | Filter by site, status, language |
| Edit | Title, description, authors |
| Publish | Status → Published |
| Unpublish | Status → Hidden |
| Delete | Cascade: chapters, jobs |

### Monitor Ingestion

| Column | Description |
|--------|-------------|
| Status | Queued, Processing, Succeeded, Failed |
| Edition | Linked edition |
| Error | Failure message |
| Duration | Processing time |

Actions:
- View details
- Retry failed job

### Manage Sites

- CRUD for sites
- Domain mapping
- Toggle: ads, indexing, sitemap

## API Endpoints

### Upload
```
POST /admin/books/upload
  file: multipart
  siteId: uuid
  language: string
  workId?: uuid (for translations)
```

### Editions
```
GET    /admin/editions?siteId=&status=&language=
GET    /admin/editions/{id}
PUT    /admin/editions/{id}
POST   /admin/editions/{id}/publish
POST   /admin/editions/{id}/unpublish
DELETE /admin/editions/{id}
```

### Jobs
```
GET  /admin/ingestion/jobs
GET  /admin/ingestion/jobs/{id}
POST /admin/ingestion/jobs/{id}/retry
```

### Sites
```
GET    /admin/sites
POST   /admin/sites
PUT    /admin/sites/{id}
DELETE /admin/sites/{id}
```

## UI Pages

1. **Login** — email/password
2. **Dashboard** — site overview
3. **Upload EN** — new Work
4. **Upload UK** — link to EN Edition
5. **Editions** — list with filters
6. **Jobs** — ingestion monitor
7. **Sites** — site management

## Audit Log

All admin actions logged:
- admin_user_id
- action_type (create, update, delete, publish)
- entity_type, entity_id
- payload_json
- created_at

## Key Files

| File | Purpose |
|------|---------|
| `apps/admin/` | React admin app |
| `Api/Endpoints/AdminEndpoints.cs` | Admin API |
| `Application/Admin/AdminService.cs` | Business logic |
| `Domain/Entities/AdminUser.cs` | Admin entity |

## See Also

- [Ingestion Pipeline](ingestion.md)
- [Database: Admin tables](database.md)
