# TextStack Admin Panel

Admin interface for managing books, authors, and content.

## Quick Start

```bash
# From project root
pnpm -C apps/admin dev

# Or via Docker
docker compose up admin
```

**URL**: http://localhost:5174

## Folder Structure

```
src/
├── api/         # Admin API client
├── components/  # Admin UI components
├── context/     # React contexts
├── pages/       # Admin pages
└── styles/      # Admin-specific styles
```

## Key Pages

| Page | Description |
|------|-------------|
| Dashboard | Overview stats |
| Books | Book listing + management |
| Upload | Upload new EPUB/PDF/FB2 |
| Ingestion Jobs | Monitor parsing jobs |
| Authors | Author management |
| Sites | Multi-site configuration |

## Commands

```bash
pnpm dev      # Start dev server
pnpm build    # Type-check + build
pnpm preview  # Preview production build
```

## Features

### Book Upload
- Drag & drop EPUB/PDF/FB2
- Metadata extraction
- Ingestion job creation

### Ingestion Monitoring
- Job status tracking
- Error logs
- Retry failed jobs

### Content Management
- Edit book metadata
- Manage authors/genres
- SEO fields editing

## Environment Variables

```env
VITE_API_URL=http://localhost:8080
```

## Authentication

Admin panel requires authentication. Access controlled via user roles in database.
