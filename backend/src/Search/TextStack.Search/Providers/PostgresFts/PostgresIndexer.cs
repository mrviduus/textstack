using System.Data;
using Dapper;
using TextStack.Search.Abstractions;
using TextStack.Search.Contracts;
using TextStack.Search.Enums;

namespace TextStack.Search.Providers.PostgresFts;

public sealed class PostgresIndexer : ISearchIndexer
{
    private readonly Func<IDbConnection> _connectionFactory;
    private readonly ITextAnalyzer _textAnalyzer;
    private readonly string _tableName;

    public PostgresIndexer(
        Func<IDbConnection> connectionFactory,
        ITextAnalyzer textAnalyzer,
        string tableName = "search_documents")
    {
        _connectionFactory = connectionFactory;
        _textAnalyzer = textAnalyzer;
        _tableName = tableName;
    }

    public async Task IndexAsync(IndexDocument document, CancellationToken ct = default)
    {
        await IndexBatchAsync([document], ct);
    }

    public async Task IndexBatchAsync(IEnumerable<IndexDocument> documents, CancellationToken ct = default)
    {
        var docList = documents.ToList();
        if (docList.Count == 0)
            return;

        using var connection = _connectionFactory();

        // Build upsert SQL with ON CONFLICT
        var sql = $@"
            INSERT INTO {_tableName} (id, title, content, language, site_id, search_vector, metadata, updated_at)
            VALUES (@Id, @Title, @Content, @Language, @SiteId,
                    to_tsvector(@FtsConfig::regconfig, @Title || ' ' || @Content),
                    @MetadataJson::jsonb,
                    NOW())
            ON CONFLICT (id) DO UPDATE SET
                title = EXCLUDED.title,
                content = EXCLUDED.content,
                language = EXCLUDED.language,
                site_id = EXCLUDED.site_id,
                search_vector = EXCLUDED.search_vector,
                metadata = EXCLUDED.metadata,
                updated_at = NOW()";

        foreach (var doc in docList)
        {
            var ftsConfig = _textAnalyzer.GetFtsConfig(doc.Language);
            var metadataJson = doc.Metadata != null
                ? System.Text.Json.JsonSerializer.Serialize(doc.Metadata)
                : "{}";

            await connection.ExecuteAsync(
                new CommandDefinition(sql, new
                {
                    doc.Id,
                    doc.Title,
                    doc.Content,
                    Language = doc.Language.ToString().ToLowerInvariant(),
                    doc.SiteId,
                    FtsConfig = ftsConfig,
                    MetadataJson = metadataJson
                }, cancellationToken: ct));
        }
    }

    public async Task RemoveAsync(string documentId, CancellationToken ct = default)
    {
        using var connection = _connectionFactory();

        var sql = $"DELETE FROM {_tableName} WHERE id = @Id";

        await connection.ExecuteAsync(
            new CommandDefinition(sql, new { Id = documentId }, cancellationToken: ct));
    }

    public async Task RemoveBySiteAsync(Guid siteId, CancellationToken ct = default)
    {
        using var connection = _connectionFactory();

        var sql = $"DELETE FROM {_tableName} WHERE site_id = @SiteId";

        await connection.ExecuteAsync(
            new CommandDefinition(sql, new { SiteId = siteId }, cancellationToken: ct));
    }

    /// <summary>
    /// Gets SQL to create the search_documents table.
    /// Run this during database setup/migration.
    /// </summary>
    public static string GetCreateTableSql(string tableName = "search_documents") => $@"
        CREATE TABLE IF NOT EXISTS {tableName} (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            language TEXT NOT NULL,
            site_id UUID NOT NULL,
            search_vector TSVECTOR NOT NULL,
            metadata JSONB DEFAULT '{{}}',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_{tableName}_search_vector ON {tableName} USING GIN(search_vector);
        CREATE INDEX IF NOT EXISTS idx_{tableName}_site_id ON {tableName}(site_id);
        CREATE INDEX IF NOT EXISTS idx_{tableName}_language ON {tableName}(language);
    ";
}
