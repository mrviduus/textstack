using Domain.Exceptions;
using Sentry;
using TextStack.Observability;

namespace TextStack.UnitTests;

/// <summary>
/// The privacy edge. TextStack handles book text, reader prompts and LLM responses, so the rule is
/// an ALLOWLIST: anything not explicitly blessed is dropped or redacted before it leaves the
/// process. These tests are the enforcement — a future `span.SetTag("prompt", userText)` must die
/// here whether or not a reviewer noticed it.
/// </summary>
public class SentryScrubberTests
{
    private static SentryEvent EventWithTags(params (string Key, string Value)[] tags)
    {
        var e = new SentryEvent();
        foreach (var (key, value) in tags)
            e.SetTag(key, value);
        return e;
    }

    [Fact]
    public void Scrub_DropsTagsOutsideAllowlist()
    {
        var e = EventWithTags(("prompt", "the whole chapter text"), ("response", "the model answer"));

        var scrubbed = SentryScrubber.Scrub(e);

        Assert.NotNull(scrubbed);
        Assert.DoesNotContain("prompt", scrubbed.Tags.Keys);
        Assert.DoesNotContain("response", scrubbed.Tags.Keys);
    }

    [Fact]
    public void Scrub_KeepsAllowlistedAiTags()
    {
        var e = EventWithTags(
            ("ai.task", "pdf.parse"),
            ("ai.provider.resolved", "ollama"),
            ("ai.provider.reason", "default_fallback"),
            ("agent.name", "tutor.agent"),
            ("rag.outcome", "failed"));

        var scrubbed = SentryScrubber.Scrub(e);

        Assert.NotNull(scrubbed);
        Assert.Equal("pdf.parse", scrubbed.Tags["ai.task"]);
        Assert.Equal("ollama", scrubbed.Tags["ai.provider.resolved"]);
        Assert.Equal("default_fallback", scrubbed.Tags["ai.provider.reason"]);
        Assert.Equal("tutor.agent", scrubbed.Tags["agent.name"]);
        Assert.Equal("failed", scrubbed.Tags["rag.outcome"]);
    }

    [Fact]
    public void Scrub_RemovesUserIdentity()
    {
        var e = new SentryEvent
        {
            User = new SentryUser
            {
                Id = Guid.NewGuid().ToString(),
                Email = "reader@example.com",
                Username = "reader",
                IpAddress = "203.0.113.7",
            },
        };

        var scrubbed = SentryScrubber.Scrub(e);

        Assert.NotNull(scrubbed);
        Assert.Null(scrubbed.User.Id);
        Assert.Null(scrubbed.User.Email);
        Assert.Null(scrubbed.User.Username);
        Assert.Null(scrubbed.User.IpAddress);
    }

    [Fact]
    public void Scrub_RedactsDisallowedExtras()
    {
        var e = new SentryEvent();
        e.SetExtra("prompt", "chapter text the reader selected");
        e.SetExtra("agent.tokens_in", 512);

        var scrubbed = SentryScrubber.Scrub(e);

        Assert.NotNull(scrubbed);
        Assert.Equal(SentryScrubber.Redacted, scrubbed.Extra["prompt"]);
        Assert.Equal(512, scrubbed.Extra["agent.tokens_in"]);
    }

    // Note: SentryEvent.SentryExceptions is populated by the SDK's exception processor at capture
    // time (before BeforeSend runs), not by the constructor — so these two exercise the same Clean()
    // path through the message, which a unit test can populate.

    [Fact]
    public void Scrub_RedactsEmailInMessage()
    {
        var e = new SentryEvent { Message = new SentryMessage { Formatted = "failed for reader@example.com" } };

        var scrubbed = SentryScrubber.Scrub(e);

        Assert.NotNull(scrubbed);
        Assert.DoesNotContain("reader@example.com", scrubbed.Message!.Formatted);
        Assert.Contains("[redacted-email]", scrubbed.Message.Formatted!);
    }

    [Fact]
    public void Scrub_TruncatesLongText()
    {
        var e = new SentryEvent { Message = new SentryMessage { Formatted = new string('x', 5000) } };

        var scrubbed = SentryScrubber.Scrub(e);

        Assert.NotNull(scrubbed);
        Assert.True(scrubbed.Message!.Formatted!.Length <= SentryScrubber.MaxTextLength + 1);
    }

    /// <summary>
    /// These are mapped to 4xx by ExceptionMiddleware with no logging, so they cannot reach Sentry
    /// today — the filter exists so a LogError added on a validation path later doesn't turn ordinary
    /// client mistakes into pages.
    /// </summary>
    [Fact]
    public void Scrub_ClientErrorExceptions_ReturnNull()
    {
        Assert.Null(SentryScrubber.Scrub(new SentryEvent(new NotFoundException("Book", Guid.NewGuid()))));
        Assert.Null(SentryScrubber.Scrub(new SentryEvent(new ValidationException("title", "is required"))));
        Assert.Null(SentryScrubber.Scrub(new SentryEvent(new OperationCanceledException())));
    }

    [Fact]
    public void Scrub_UnexpectedException_IsKept()
    {
        Assert.NotNull(SentryScrubber.Scrub(new SentryEvent(new InvalidOperationException("boom"))));
    }

    [Fact]
    public void ScrubBreadcrumb_DropsStructuredDataAndRedactsMessage()
    {
        var crumb = new Breadcrumb(
            "indexing book for reader@example.com",
            "default",
            new Dictionary<string, string> { ["title"] = "The Death of Ivan Ilyich" });

        var scrubbed = SentryScrubber.ScrubBreadcrumb(crumb);

        Assert.NotNull(scrubbed);
        Assert.Null(scrubbed.Data);
        Assert.DoesNotContain("reader@example.com", scrubbed.Message);
    }

    /// <summary>
    /// Regression: first-run verification found `Executed DbCommand … SELECT …` in a real event's
    /// breadcrumb trail. EF Core puts the SQL in the breadcrumb MESSAGE, so nulling `data` didn't
    /// stop it — the same SetDbStatementForText leak we avoided by not using Sentry's OTel exporter.
    /// </summary>
    [Fact]
    public void ScrubBreadcrumb_EfCoreCommand_ReturnsNull()
    {
        var crumb = new Breadcrumb(
            "Executed DbCommand (1ms) [Parameters=[], CommandType='Text']\nSELECT m.feature_tag FROM models AS m",
            "default",
            category: "Microsoft.EntityFrameworkCore.Database.Command");

        Assert.Null(SentryScrubber.ScrubBreadcrumb(crumb));
    }

    [Fact]
    public void ScrubBreadcrumb_SqlInMessageWithoutEfCategory_ReturnsNull()
    {
        var crumb = new Breadcrumb("Executed DbCommand (3ms) SELECT * FROM user_books", "default");

        Assert.Null(SentryScrubber.ScrubBreadcrumb(crumb));
    }

    /// <summary>
    /// Regression from the FIRST production event this integration ever captured: dropping the EF
    /// Core BREADCRUMB was not enough. EF logs a failed command at Error level, Sentry's ILogger
    /// integration turns that into an EVENT, and the SQL rides in the event message — so
    /// `INSERT INTO reading_progresses (id, chapter_id, …)` reached Sentry from PUT /me/progress.
    /// </summary>
    [Fact]
    public void Scrub_EfCoreCommandEvent_ReturnsNull()
    {
        var e = new SentryEvent
        {
            Logger = "Microsoft.EntityFrameworkCore.Database.Command",
            Message = new SentryMessage
            {
                Formatted = "Failed executing DbCommand (8ms) [Parameters=[@p0='?' (DbType = Guid)]]\n"
                    + "INSERT INTO reading_progresses (id, chapter_id, edition_id) VALUES (@p0, @p1, @p2);",
            },
        };

        Assert.Null(SentryScrubber.Scrub(e));
    }

    [Fact]
    public void Scrub_DbCommandInMessageWithoutEfLogger_ReturnsNull()
    {
        var e = new SentryEvent
        {
            Message = new SentryMessage { Formatted = "Executed DbCommand (3ms) SELECT * FROM user_books" },
        };

        Assert.Null(SentryScrubber.Scrub(e));
    }

    /// <summary>
    /// The signal must survive: the same failure is reported by ExceptionMiddleware as a
    /// DbUpdateException — stack trace, SQLSTATE and constraint name, no SQL — and that event is kept.
    /// </summary>
    [Fact]
    public void Scrub_DbUpdateExceptionFromMiddleware_IsKept()
    {
        var e = new SentryEvent(new InvalidOperationException(
            "23505: duplicate key value violates unique constraint \"ix_reading_progresses_user_id_site_id_edition_id\""))
        {
            Logger = "Api.Middleware.ExceptionMiddleware",
        };

        var scrubbed = SentryScrubber.Scrub(e);

        Assert.NotNull(scrubbed);
        Assert.Contains("ix_reading_progresses", scrubbed.SentryExceptions?.FirstOrDefault()?.Value
            ?? scrubbed.Exception!.Message);
    }

    [Fact]
    public void ScrubBreadcrumb_ApplicationLogLine_IsKept()
    {
        var crumb = new Breadcrumb(
            "Metadata enrichment: enriching 38 user books", "default",
            category: "Worker.Services.MetadataEnrichmentWorker");

        Assert.NotNull(SentryScrubber.ScrubBreadcrumb(crumb));
    }

    [Fact]
    public void ScrubTransaction_RequestQueryString_Removed()
    {
        var t = new SentryTransaction("GET /api/search", "http.server")
        {
            Request = new SentryRequest
            {
                Url = "https://textstack.app/api/search?q=private",
                QueryString = "q=private",
            },
        };

        var scrubbed = SentryScrubber.ScrubTransaction(t);

        Assert.NotNull(scrubbed);
        Assert.Null(scrubbed.Request.QueryString);
        Assert.Equal("https://textstack.app/api/search", scrubbed.Request.Url);
    }

    [Theory]
    [InlineData("GET https://openlibrary.org/search.json?title=Secret", "GET https://openlibrary.org/search.json")]
    [InlineData("GET /api/tts#frag", "GET /api/tts")]
    [InlineData("POST https://api.openai.com/v1/chat/completions", "POST https://api.openai.com/v1/chat/completions")]
    [InlineData(null, null)]
    public void StripQuery_RemovesQueryAndFragment(string? input, string? expected) =>
        Assert.Equal(expected, SentryScrubber.StripQuery(input));
}
