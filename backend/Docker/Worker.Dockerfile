FROM mcr.microsoft.com/dotnet/sdk:10.0-alpine AS build
WORKDIR /src

COPY Directory.Build.props Directory.Packages.props ./
COPY backend/src/Api/Api.csproj backend/src/Api/
COPY backend/src/Worker/Worker.csproj backend/src/Worker/
COPY backend/src/Infrastructure/Infrastructure.csproj backend/src/Infrastructure/
COPY backend/src/Domain/Domain.csproj backend/src/Domain/
COPY backend/src/Contracts/Contracts.csproj backend/src/Contracts/
COPY backend/src/Application/Application.csproj backend/src/Application/
COPY backend/src/Search/TextStack.Search/TextStack.Search.csproj backend/src/Search/TextStack.Search/
COPY backend/src/Extraction/TextStack.Extraction/TextStack.Extraction.csproj backend/src/Extraction/TextStack.Extraction/
RUN dotnet restore backend/src/Worker/Worker.csproj

COPY backend/src/ backend/src/
RUN dotnet publish backend/src/Worker/Worker.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime

# Install Node.js, fonts, and Chromium dependencies for SSG prerender.
# Retry the whole sequence up to 5× to ride out transient archive.ubuntu.com
# flakiness in CI (apt update + install can fail mid-fetch; `--fix-missing`
# resumes partial fetches on retry).
RUN set -eux; \
    for i in 1 2 3 4 5; do \
        apt-get update && apt-get install -y --no-install-recommends --fix-missing \
            fontconfig \
            libfreetype6 \
            fonts-dejavu-core \
            libfontconfig1 \
            libgl1 \
            libice6 \
            libsm6 \
            libx11-6 \
            libxext6 \
            libxrender1 \
            nodejs \
            npm \
            ffmpeg \
            ca-certificates \
            libnss3 \
            libatk1.0-0 \
            libatk-bridge2.0-0 \
            libcups2 \
            libdrm2 \
            libxkbcommon0 \
            libxcomposite1 \
            libxdamage1 \
            libxrandr2 \
            libgbm1 \
            libasound2t64 \
            libxfixes3 \
            libxcursor1 \
            libxi6 \
            libxtst6 \
            libpango-1.0-0 \
            libpangocairo-1.0-0 \
            libcairo2 \
        && break || { echo "apt attempt $i failed — retrying in 15s"; sleep 15; }; \
    done; \
    rm -rf /var/lib/apt/lists/*; \
    fc-cache -fv

# Puppeteer cache location (scripts mounted via docker-compose volume)
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

RUN userdel -r app 2>/dev/null; userdel -r ubuntu 2>/dev/null; \
    groupadd -g 1000 app && useradd -u 1000 -g app -m app

RUN mkdir -p /storage/users && chown -R app:app /storage
WORKDIR /app
COPY --from=build /app/publish .

# Install puppeteer for SSG prerender (scripts mounted at /app/apps/web/scripts).
# Pinned to the same major as apps/web/package.json (puppeteer ^24.36.0).
# Bare `npm install puppeteer` resolves to puppeteer 25.x today — 25 requires
# Node >=22.12, but Ubuntu noble's apt nodejs package is still Node 18, so the
# postinstall (chrome-headless-shell download) crashes mid-extract and the
# whole install exits 1. Pinning to 24.x matches the version the web prerender
# scripts were authored against.
#
# Two steps on purpose, because they fail for unrelated reasons and at unrelated
# rates. `npm install` talks to the npm registry and is quick; the browser download
# pulls ~150 MB of chrome-headless-shell from storage.googleapis.com and is the part
# that actually flakes. Bundling them meant a CDN hiccup re-downloaded nothing and
# re-ran everything, and the old loop — 3 attempts, 5s apart — covered about 15
# seconds of outage. On 2026-08-20 Google served 504s for longer than that, all three
# attempts burned inside the window, and a production deploy was blocked by it.
#
# Now: install with the download skipped, then fetch the browser in its own loop with
# exponential backoff (10s, 20s, 40s, 80s, 160s ≈ 5 minutes of cover).
RUN mkdir -p /app/apps/web && \
    cd /app/apps/web && \
    npm init -y && \
    PUPPETEER_SKIP_DOWNLOAD=true npm install puppeteer@^24.36.0 && \
    test -d node_modules/puppeteer

# Retry puppeteer's OWN installer — the exact thing that failed — rather than a
# hand-picked `browsers install <name>`. puppeteer 24 downloads BOTH `chrome` and
# `chrome-headless-shell`, and prerender.mjs calls launch({ headless: true }), which
# resolves to full `chrome`; `chrome-headless-shell` is only used for
# headless: 'shell'. Installing just the shell would leave SSG unable to launch a
# browser at all — the same silent failure that kept SSG dead for five weeks.
RUN cd /app/apps/web && \
    delay=10; \
    for i in 1 2 3 4 5; do \
        node node_modules/puppeteer/install.mjs && break || \
        { echo "puppeteer browser download attempt $i failed; retrying in ${delay}s" >&2; \
          sleep "$delay"; delay=$((delay * 2)); }; \
    done; \
    # Fail loudly rather than ship an image whose SSG cannot launch a browser.
    test -d "$PUPPETEER_CACHE_DIR/chrome" || \
      { echo "FATAL: no chrome in $PUPPETEER_CACHE_DIR after 5 attempts" >&2; \
        ls -la "$PUPPETEER_CACHE_DIR" 2>/dev/null; exit 1; }

RUN chown -R app:app /app

# Sentry release. Declared last so a new SHA invalidates only this trivial layer,
# not the .NET build or the ~150 MB puppeteer install above.
ARG GIT_SHA=""
ENV SENTRY_RELEASE=$GIT_SHA

USER app
ENTRYPOINT ["dotnet", "Worker.dll"]
