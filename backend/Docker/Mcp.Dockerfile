# TextStack MCP server — remote HTTP (streamable) transport (AI-049, Phase 8).
# Mirrors Api.Dockerfile (alpine sdk build → alpine aspnet runtime). The project
# is a thin, stateless MCP↔HTTP bridge: it references the MCP SDK packages, the
# dependency-free Contracts project (tool descriptions) and Observability (the
# shared Sentry setup — Sentry and nothing else), never Application /
# Infrastructure / Domain.
FROM mcr.microsoft.com/dotnet/sdk:10.0-alpine@sha256:230c3fbae0ceedc70bca04eed2bfb5694e8b248cadbb81010f41b7a993601f55 AS build
WORKDIR /src

COPY Directory.Build.props Directory.Packages.props ./
COPY backend/src/Ai/TextStack.Ai.Mcp/TextStack.Ai.Mcp.csproj backend/src/Ai/TextStack.Ai.Mcp/
COPY backend/src/Contracts/Contracts.csproj backend/src/Contracts/
COPY backend/src/Observability/TextStack.Observability/TextStack.Observability.csproj backend/src/Observability/TextStack.Observability/
RUN dotnet restore backend/src/Ai/TextStack.Ai.Mcp/TextStack.Ai.Mcp.csproj

COPY backend/src/Ai/TextStack.Ai.Mcp/ backend/src/Ai/TextStack.Ai.Mcp/
COPY backend/src/Contracts/ backend/src/Contracts/
COPY backend/src/Observability/TextStack.Observability/ backend/src/Observability/TextStack.Observability/
RUN dotnet publish backend/src/Ai/TextStack.Ai.Mcp/TextStack.Ai.Mcp.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine@sha256:819bd3649d8bf53f35527c68d62e17b348ef6f24ae73073f497f00a878348062 AS runtime
RUN deluser app 2>/dev/null; delgroup app 2>/dev/null; \
    addgroup -g 1000 app && adduser -D -u 1000 -G app app
WORKDIR /app
COPY --from=build /app/publish .
# Sentry release (see Api.Dockerfile). Declared after the publish copy so a new SHA
# invalidates only this trivial layer.
ARG GIT_SHA=""
ENV SENTRY_RELEASE=$GIT_SHA
USER app
# Remote, multi-user transport: each connection carries its own Bearer; the
# container binds all interfaces on 8090 (compose maps it to 127.0.0.1 only,
# nginx fronts /mcp). MCP_TRANSPORT=http is supplied by compose.
ENV ASPNETCORE_URLS=http://+:8090
EXPOSE 8090
ENTRYPOINT ["dotnet", "TextStack.Ai.Mcp.dll"]
