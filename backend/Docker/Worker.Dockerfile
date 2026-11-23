# Base images are pinned by digest (tag kept for humans); Dependabot moves them.
#
# The SDK stage runs on the BUILD machine's arch and cross-publishes for the target
# (-r linux-musl-<arch>), so an amd64 image built on an arm64 laptop compiles natively
# instead of under QEMU, and the output carries only the target's native libraries.
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:11.0-alpine@sha256:52556c0fb9d0f609ae9aeab9efeeba96f4acc2f7038f7696f2235ccbdbb8e290 AS build
ARG TARGETARCH
WORKDIR /src

COPY Directory.Build.props Directory.Packages.props ./
COPY backend/src/Worker/Worker.csproj backend/src/Worker/
COPY backend/src/Infrastructure/Infrastructure.csproj backend/src/Infrastructure/
COPY backend/src/Domain/Domain.csproj backend/src/Domain/
COPY backend/src/Contracts/Contracts.csproj backend/src/Contracts/
COPY backend/src/Application/Application.csproj backend/src/Application/
RUN RID=linux-musl-$([ "$TARGETARCH" = amd64 ] && echo x64 || echo "$TARGETARCH") \
    && dotnet restore backend/src/Worker/Worker.csproj -r "$RID"

COPY backend/src/ backend/src/
RUN RID=linux-musl-$([ "$TARGETARCH" = amd64 ] && echo x64 || echo "$TARGETARCH") \
    && dotnet publish backend/src/Worker/Worker.csproj -c Release -r "$RID" --self-contained false -o /app/publish

# Alpine, like the API. The Worker has no Node, Puppeteer or browser: SSG prerendering
# went with the catalog, and nothing under backend/src starts a process. It parses no
# books either (ADR-033): the reader is the only parser.
FROM mcr.microsoft.com/dotnet/aspnet:11.0-alpine@sha256:d39b72ad1534fa0faf52b488bffb0762df7ba269d120f0338713d4dda2a41bf5 AS runtime

# icu: the alpine base runs in globalization-invariant mode, the Debian image this
# replaced did not; kept so culture-aware string handling matches the API.
# krb5-libs: Npgsql probes GSSAPI, same as the API image.
RUN apk add --no-cache icu-libs icu-data-full krb5-libs \
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
