# Base images pinned by digest (tag kept for humans); Dependabot moves them.
# Build stage on the build machine's arch, cross-publishing for the target: see
# Worker.Dockerfile. RID-specific output drops ~500 MB of PDFium/Skia binaries for
# Windows, macOS, Android and other Linux flavours that a portable publish carried.
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0-alpine@sha256:cc02b814237a76c4735fb6eeee87181597b5e56f2ce458a435e527674d91f4d7 AS build
ARG TARGETARCH
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
COPY backend/src/Tts/TextStack.Tts/TextStack.Tts.csproj backend/src/Tts/TextStack.Tts/
RUN RID=linux-musl-$([ "$TARGETARCH" = amd64 ] && echo x64 || echo "$TARGETARCH") \
    && dotnet restore backend/src/Api/Api.csproj -r "$RID"

COPY backend/src/ backend/src/
# Embedded in Api.dll: /health/ready compares them with the schema_migrations ledger (ADR-026).
COPY database/migrations/ database/migrations/
RUN RID=linux-musl-$([ "$TARGETARCH" = amd64 ] && echo x64 || echo "$TARGETARCH") \
    && dotnet publish backend/src/Api/Api.csproj -c Release -r "$RID" --self-contained false -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine@sha256:254fe017495996d3abcc487ffacdcce2b73affb380d3af87af12c8dff41fe0b0 AS runtime
RUN apk add --no-cache git krb5-libs \
    && deluser app 2>/dev/null; delgroup app 2>/dev/null; \
       addgroup -g 1000 app && adduser -D -u 1000 -G app app
RUN mkdir -p /storage/users /data/textstack /data/tts-cache && chown -R app:app /storage /data/textstack /data/tts-cache
WORKDIR /app
COPY --from=build /app/publish .
# Sentry release. Declared AFTER the publish copy so a new SHA invalidates only this
# trivial layer, not the restore/build layers.
ARG GIT_SHA=""
ENV SENTRY_RELEASE=$GIT_SHA
USER app
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "Api.dll"]
