FROM mcr.microsoft.com/dotnet/sdk:10.0-alpine AS build
WORKDIR /src

COPY Directory.Build.props Directory.Packages.props ./
# Copy project files for restore
COPY src/Api/Api.csproj src/Api/
COPY src/Worker/Worker.csproj src/Worker/
COPY src/Infrastructure/Infrastructure.csproj src/Infrastructure/
COPY src/Domain/Domain.csproj src/Domain/
COPY src/Contracts/Contracts.csproj src/Contracts/
COPY src/Application/Application.csproj src/Application/
COPY src/Search/TextStack.Search/TextStack.Search.csproj src/Search/TextStack.Search/
RUN dotnet restore src/Api/Api.csproj

# Copy source and build
COPY src/ src/

# Install EF Core tools
RUN dotnet tool install --global dotnet-ef
ENV PATH="$PATH:/root/.dotnet/tools"

# Copy migration script
COPY Docker/migrate.sh /migrate.sh
RUN chmod +x /migrate.sh

WORKDIR /src
ENTRYPOINT ["/migrate.sh"]
