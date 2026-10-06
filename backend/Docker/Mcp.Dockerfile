# TextStack MCP server — remote HTTP (streamable) transport (AI-049, Phase 8).
# Mirrors Api.Dockerfile (alpine sdk build → alpine aspnet runtime). The project
# is a thin, stateless MCP↔HTTP bridge: it references the MCP SDK packages and the
# dependency-free Contracts project (tool descriptions), never Application /
# Infrastructure / Domain.
FROM mcr.microsoft.com/dotnet/sdk:10.0-alpine@sha256:3cc3bbbbf93d82104892f42aa9106b6be4d120346dea0649643a97c801525256 AS build
WORKDIR /src

COPY Directory.Build.props Directory.Packages.props ./
COPY backend/src/Ai/TextStack.Ai.Mcp/TextStack.Ai.Mcp.csproj backend/src/Ai/TextStack.Ai.Mcp/
COPY backend/src/Contracts/Contracts.csproj backend/src/Contracts/
RUN dotnet restore backend/src/Ai/TextStack.Ai.Mcp/TextStack.Ai.Mcp.csproj

COPY backend/src/Ai/TextStack.Ai.Mcp/ backend/src/Ai/TextStack.Ai.Mcp/
COPY backend/src/Contracts/ backend/src/Contracts/
RUN dotnet publish backend/src/Ai/TextStack.Ai.Mcp/TextStack.Ai.Mcp.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine@sha256:f62a272ac1b46e83f56b8ed0416572f31cd1128e2c4a5e63eb34d348e4a36095 AS runtime
RUN deluser app 2>/dev/null; delgroup app 2>/dev/null; \
    addgroup -g 1000 app && adduser -D -u 1000 -G app app
WORKDIR /app
COPY --from=build /app/publish .
USER app
# Remote, multi-user transport: each connection carries its own Bearer; the
# container binds all interfaces on 8090 (compose maps it to 127.0.0.1 only,
# nginx fronts /mcp). MCP_TRANSPORT=http is supplied by compose.
ENV ASPNETCORE_URLS=http://+:8090
EXPOSE 8090
ENTRYPOINT ["dotnet", "TextStack.Ai.Mcp.dll"]
