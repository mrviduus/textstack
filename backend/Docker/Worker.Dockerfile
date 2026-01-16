FROM mcr.microsoft.com/dotnet/sdk:10.0-alpine AS build
WORKDIR /src

COPY Directory.Build.props Directory.Packages.props ./
COPY src/Api/Api.csproj src/Api/
COPY src/Worker/Worker.csproj src/Worker/
COPY src/Infrastructure/Infrastructure.csproj src/Infrastructure/
COPY src/Domain/Domain.csproj src/Domain/
COPY src/Contracts/Contracts.csproj src/Contracts/
RUN dotnet restore src/Worker/Worker.csproj

COPY src/ src/
RUN dotnet publish src/Worker/Worker.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
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
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -fv
WORKDIR /app
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "Worker.dll"]
