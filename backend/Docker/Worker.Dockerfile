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

# Install Node.js, fonts, and Chromium dependencies for SSG prerender
RUN apt-get update && apt-get install -y --no-install-recommends \
    fontconfig \
    libfreetype6 \
    fonts-dejavu-core \
    # Skia dependencies for PDF cover rendering
    libfontconfig1 \
    libgl1 \
    libice6 \
    libsm6 \
    libx11-6 \
    libxext6 \
    libxrender1 \
    # Node.js for SSG prerender
    nodejs \
    npm \
    # Chromium dependencies for Puppeteer (puppeteer downloads its own chromium)
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
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -fv

# Puppeteer cache location (scripts mounted via docker-compose volume)
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

WORKDIR /app
COPY --from=build /app/publish .

# Install puppeteer for SSG prerender (scripts mounted at /app/apps/web/scripts)
RUN mkdir -p /app/apps/web && \
    cd /app/apps/web && \
    npm init -y --silent && \
    npm install --silent puppeteer

ENTRYPOINT ["dotnet", "Worker.dll"]
