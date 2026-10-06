# Base images are pinned by digest (tag kept for humans); Dependabot moves them.
#
# The SDK stage runs on the BUILD machine's arch and cross-publishes for the target
# (-r linux-musl-<arch>), so an amd64 image built on an arm64 laptop compiles natively
# instead of under QEMU, and the output carries only the target's native libraries:
# a portable publish shipped PDFium and Skia for Windows, macOS, iOS, Android and WASM.
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0-alpine@sha256:3cc3bbbbf93d82104892f42aa9106b6be4d120346dea0649643a97c801525256 AS build
ARG TARGETARCH
WORKDIR /src

COPY Directory.Build.props Directory.Packages.props ./
COPY backend/src/Worker/Worker.csproj backend/src/Worker/
COPY backend/src/Infrastructure/Infrastructure.csproj backend/src/Infrastructure/
COPY backend/src/Domain/Domain.csproj backend/src/Domain/
COPY backend/src/Contracts/Contracts.csproj backend/src/Contracts/
COPY backend/src/Application/Application.csproj backend/src/Application/
COPY backend/src/Search/TextStack.Search/TextStack.Search.csproj backend/src/Search/TextStack.Search/
COPY backend/src/Extraction/TextStack.Extraction/TextStack.Extraction.csproj backend/src/Extraction/TextStack.Extraction/
RUN RID=linux-musl-$([ "$TARGETARCH" = amd64 ] && echo x64 || echo "$TARGETARCH") \
    && dotnet restore backend/src/Worker/Worker.csproj -r "$RID"

COPY backend/src/ backend/src/
RUN RID=linux-musl-$([ "$TARGETARCH" = amd64 ] && echo x64 || echo "$TARGETARCH") \
    && dotnet publish backend/src/Worker/Worker.csproj -c Release -r "$RID" --self-contained false -o /app/publish

# Alpine, like the API. The Worker has no Node, Puppeteer or browser: SSG prerendering
# moved to the ssg-worker image long ago, and nothing under backend/src starts a process
# except `git` in StandardEbooksSyncService, which only the API registers. PDF work is
# PdfPig (managed) plus PDFtoImage, whose PDFium and SkiaSharp (NoDependencies build)
# ship musl binaries and need only libstdc++/libgcc, which this base already has.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine@sha256:f62a272ac1b46e83f56b8ed0416572f31cd1128e2c4a5e63eb34d348e4a36095 AS runtime

# icu: the alpine base runs in globalization-invariant mode, the Debian image this
# replaced did not. Extraction calls string.Normalize and culture-aware casing on book
# text, so keep real ICU rather than find out what invariant mode does to a Ukrainian
# EPUB. font-dejavu: PDFium falls back to system fonts for PDFs that do not embed theirs
# (cover rendering). krb5-libs: Npgsql probes GSSAPI, same as the API image.
RUN apk add --no-cache icu-libs icu-data-full font-dejavu krb5-libs \
    && deluser app 2>/dev/null; delgroup app 2>/dev/null; \
       addgroup -g 1000 app && adduser -D -u 1000 -G app app
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false

RUN mkdir -p /storage/users && chown -R app:app /storage
WORKDIR /app
COPY --from=build /app/publish .

# Sentry release. Declared last so a new SHA invalidates only this trivial layer.
ARG GIT_SHA=""
ENV SENTRY_RELEASE=$GIT_SHA

USER app
ENTRYPOINT ["dotnet", "Worker.dll"]
