# How We Made Our React SPA Visible to Google Without Rewriting Everything

**TL;DR:** We needed Google to index 500+ book pages on our SPA. Instead of migrating to Next.js or building a complex SSR solution, we added dynamic rendering with Prerender in 3 files. Here's exactly how.

---

## The Problem: Google Can't See Your Beautiful SPA

We built [TextStack](https://textstack.app) — a free online library with a Kindle-like reader. React frontend, ASP.NET Core API, PostgreSQL. Classic stack, works great.

One problem: **Google saw nothing.**

```html
<!-- What users see -->
<title>As I Lay Dying by William Faulkner | TextStack</title>
<h1>As I Lay Dying</h1>
<p>After a woman in rural Mississippi dies...</p>
<!-- 98 chapters, rich metadata, Schema.org markup -->

<!-- What Googlebot saw -->
<title>Free Online Library | TextStack</title>
<div id="root"></div>
<!-- Empty. Nothing. Void. -->
```

We had 500+ books with beautiful SEO metadata, Schema.org structured data, Open Graph tags — all generated client-side. Googlebot executes JavaScript, but it's inconsistent and slow. Our pages weren't getting indexed.

## The Options We Considered

### Option 1: Server-Side Rendering (Next.js/Remix)

**Pros:** Industry standard, great DX, built-in optimizations

**Cons:** Complete frontend rewrite. Our React app was ~50 components, custom reader with offline sync, complex state management. Estimated time: 3-4 weeks.

### Option 2: Static Site Generation

**Pros:** Fastest possible page loads, works everywhere

**Cons:** We tried this. Built a Next.js SSG version. It worked... until we opened it in the browser. The reader was broken. Styles were wrong. We'd essentially need to maintain two frontends.

### Option 3: Dynamic Rendering (Prerender)

**Pros:** Zero changes to existing React app. Add a service, configure nginx, done.

**Cons:** Additional infrastructure, slight latency for first bot request.

We chose **Option 3**.

## What is Dynamic Rendering?

Dynamic rendering means serving different content based on who's asking:

```
Regular User (Chrome, Safari, Firefox):
  User → nginx → SPA (index.html + JS) → JS renders in browser

Search Bot (Googlebot, Bingbot):
  Bot → nginx → Prerender → Headless Chrome renders page → HTML response
```

Google [officially supports this approach](https://developers.google.com/search/docs/crawling-indexing/javascript/dynamic-rendering) and doesn't consider it cloaking (as long as the content is the same).

## The Architecture

Here's our setup:

```
┌─────────────────────────────────────────────────────────────┐
│                         nginx                                │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ Check User-Agent                                        ││
│  │ Is it Googlebot/Bingbot/etc?                           ││
│  └──────────────┬────────────────────┬────────────────────┘│
│                 │ YES               │ NO                    │
│                 ▼                   ▼                       │
│  ┌──────────────────┐    ┌──────────────────┐              │
│  │ Prerender        │    │ Static Files /   │              │
│  │ (Headless Chrome)│    │ Vite Dev Server  │              │
│  └────────┬─────────┘    └──────────────────┘              │
│           │                                                 │
│           ▼                                                 │
│  ┌──────────────────┐                                      │
│  │ Fetch & Render   │                                      │
│  │ React App        │──────► API                           │
│  └──────────────────┘                                      │
└─────────────────────────────────────────────────────────────┘
```

## The Implementation

### Step 1: Add Prerender Service

We used [tvanro/prerender-alpine](https://github.com/nickmomrik/docker-prerender) — a lightweight Docker image with headless Chrome:

```yaml
# docker-compose.yml
services:
  prerender:
    image: tvanro/prerender-alpine:7.2.0
    container_name: books_prerender
    environment:
      MEMORY_CACHE: 1      # Enable in-memory cache
      CACHE_MAXSIZE: 500   # Cache up to 500 pages
      CACHE_TTL: 3600      # 1 hour cache
    ports:
      - "3030:3000"
    deploy:
      resources:
        limits:
          memory: 1G       # Chrome is hungry
```

### Step 2: Configure nginx Bot Detection

```nginx
# Bot detection map
map $http_user_agent $prerender_ua {
    default 0;
    "~*googlebot" 1;
    "~*bingbot" 1;
    "~*yandex" 1;
    "~*facebookexternalhit" 1;
    "~*twitterbot" 1;
    "~*linkedinbot" 1;
    "~*slackbot" 1;
    "~*whatsapp" 1;
    "~*applebot" 1;
    # Add more as needed
}
```

### Step 3: Route Bots to Prerender

```nginx
server {
    listen 80;
    server_name textstack.app;

    # Internal prerender location
    location /prerender-internal/ {
        internal;
        proxy_pass http://prerender:3000/;
        proxy_set_header Host $host;
        proxy_connect_timeout 60s;
        proxy_read_timeout 60s;
    }

    location / {
        # Check if bot
        set $prerender 0;
        if ($prerender_ua) {
            set $prerender 1;
        }

        # Don't prerender static files
        if ($uri ~* "\.(js|css|png|jpg|svg|woff2)$") {
            set $prerender 0;
        }

        # Route bots to prerender
        if ($prerender = 1) {
            rewrite ^(.*)$ /prerender-internal/http://$host$1 last;
        }

        # Normal users get SPA
        try_files $uri $uri/ /index.html;
    }
}
```

## The Challenge: API Calls Inside Prerender

Here's where it got interesting. After setting everything up, our book detail pages showed:

```html
<h1>Error</h1>
<p>Failed to fetch</p>
```

**The problem:** Our SPA makes API calls to fetch book data. The API URL was configured as `http://localhost:8080`. Inside the Prerender container, `localhost` is... the container itself. Not our API.

**The solution:** Vite's dev server proxy.

```typescript
// vite.config.ts
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://api:8080',  // Docker service name
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
    // Allow prerender to access via Docker network
    allowedHosts: ['web', 'localhost'],
  },
})
```

Then we changed our API base URL:

```typescript
// Before
const API_BASE = 'http://localhost:8080'

// After
const API_BASE = '/api'  // Relative, works everywhere
```

Now when Prerender's Chrome loads our SPA:
1. JS executes and calls `/api/en/books/some-book`
2. Vite proxies to `http://api:8080/en/books/some-book`
3. API returns data
4. React renders the page
5. Prerender captures the HTML

## The Result

**Before (what Googlebot saw):**
```html
<title>Free Online Library | TextStack</title>
<div id="root"></div>
```

**After:**
```html
<title>As I Lay Dying by William Faulkner | TextStack</title>
<meta name="description" content="After a woman in rural Mississippi dies,
her husband and five children begin an arduous journey...">

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Book",
  "name": "As I Lay Dying",
  "author": {"@type": "Person", "name": "William Faulkner"},
  "description": "...",
  "inLanguage": "en"
}
</script>

<h1>As I Lay Dying</h1>
<p class="book-detail__author">William Faulkner</p>
<ul><!-- 98 chapters with links --></ul>
```

**Performance:**
- First request (cold): ~3-5 seconds (Chrome needs to render)
- Cached requests: ~50ms
- Cache hit rate: ~95% (bots recrawl the same pages)

## Quick Test

Want to see what Googlebot sees on your site?

```bash
# Your site as a regular user
curl -s "https://yoursite.com/page" | grep "<title>"

# Your site as Googlebot
curl -s -A "Googlebot" "https://yoursite.com/page" | grep "<title>"
```

If the titles are different (or the second one is empty), you have an SEO problem.

## Files Changed

The entire implementation touched **5 files**:

| File | Lines | Purpose |
|------|-------|---------|
| `docker-compose.yml` | +20 | Add prerender service |
| `nginx.conf` | +85 | Bot detection & routing |
| `vite.config.ts` | +10 | API proxy for prerender |
| `docker-compose.prod.yml` | +18 | Production prerender |
| `nginx-prod.conf` | +118 | Production bot routing |

No React components changed. No business logic touched. The SPA remains exactly as it was.

## Should You Use This?

**Yes, if:**
- You have an existing SPA that works well
- You need SEO but can't justify a rewrite
- Your content doesn't change every second
- You're comfortable with Docker/nginx

**No, if:**
- You're starting a new project (just use Next.js)
- You need real-time SEO updates
- Your pages are highly personalized
- You can't add infrastructure

## Try It Yourself

TextStack is open source. Check out the implementation:

- Live site: [textstack.app](https://textstack.app)
- GitHub: [github.com/vdovychenko/textstack](https://github.com/vdovychenko/textstack)

---

*Have questions about implementing this for your SPA? Drop a comment below or open an issue on GitHub!*

---

**Tags:** `#react` `#seo` `#docker` `#nginx` `#webdev`
