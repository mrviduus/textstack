# EF Core migrations bundle on runtime-deps: the SDK, the source and dotnet-ef stay in the build
# stage (delivery.md "Images"; migrate.sh runs it). Base images pinned by digest; Dependabot moves them.
# Build stage on the build machine's arch, cross-publishing for the target: see Worker.Dockerfile.
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0-alpine@sha256:3cc3bbbbf93d82104892f42aa9106b6be4d120346dea0649643a97c801525256 AS build
ARG TARGETARCH
WORKDIR /src

COPY Directory.Build.props Directory.Packages.props ./
# dotnet-ef at the EF Core version the code builds against (a bundle from a newer tool than the
# runtime it embeds is unsupported). Read from Directory.Packages.props so a bump moves both.
RUN EF_VERSION=$(sed -n 's/.*"Microsoft.EntityFrameworkCore.Design" Version="\([^"]*\)".*/\1/p' Directory.Packages.props) \
    && test -n "$EF_VERSION" \
    && dotnet tool install --global dotnet-ef --version "$EF_VERSION"
ENV PATH="$PATH:/root/.dotnet/tools"

COPY backend/src/ backend/src/

# Infrastructure is both the migrations and the startup project: AppDbContextFactory (design-time)
# lives there, so the Api's own dependencies stay out of the bundle (Application's still come in).
# dotnet ef does not restore; the bundle restores its own RID-specific build.
# /app/known-migrations: every migration this image contains, for migrate.sh's step 0 and pending
# list (the bundle can only update, not list).
RUN RID=linux-musl-$([ "$TARGETARCH" = amd64 ] && echo x64 || echo "$TARGETARCH") \
    && mkdir /app \
    && dotnet restore backend/src/Infrastructure \
    && dotnet ef migrations list --no-connect \
        --project backend/src/Infrastructure --startup-project backend/src/Infrastructure \
       | grep -E '^[0-9]{14}_' > /app/known-migrations \
    && test -s /app/known-migrations \
    && dotnet ef migrations bundle --self-contained -r "$RID" -o /app/efbundle \
        --project backend/src/Infrastructure --startup-project backend/src/Infrastructure

FROM mcr.microsoft.com/dotnet/runtime-deps:10.0-alpine@sha256:f23f2bc63f69aca51ae93beccf344123d9a0d79c114a5c4f24835bdbc43b9101 AS runtime
# postgresql-client: migrate.sh reads __EFMigrationsHistory (step 0, pending list).
# krb5-libs: Npgsql loads libgssapi_krb5 (same as the Api image).
RUN apk add --no-cache krb5-libs postgresql-client
WORKDIR /app
COPY --from=build /app/efbundle /app/known-migrations ./
COPY --chmod=755 backend/Docker/migrate.sh /migrate.sh
# runtime-deps ships the non-root `app` user (APP_UID).
USER $APP_UID
ENTRYPOINT ["/migrate.sh"]
