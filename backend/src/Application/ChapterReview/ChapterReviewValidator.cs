using System.Text.Json;
using System.Text.Json.Serialization;
using Contracts.ChapterReview;

namespace Application.ChapterReview;

/// <summary>What the validator needs to know about the book, loaded by the service.</summary>
/// <param name="BookHighlights">
/// Every highlight this user has in this book → the chapter number it sits in (null = cannot be
/// placed, which is allowed). An id not in here is not theirs, or not in this book.
/// </param>
/// <param name="TargetHighlightIds">The highlights of the chapter under review.</param>
/// <param name="OpenThreads">Threads open at this chapter — the only ids a review may close.</param>
public sealed record ReviewValidationContext(
    int TargetChapterNumber,
    IReadOnlyDictionary<Guid, int?> BookHighlights,
    IReadOnlySet<Guid> TargetHighlightIds,
    IReadOnlyCollection<OpenThreadDto> OpenThreads);

/// <summary>
/// Validates a chapter review and returns EVERY problem at once, each with a path, so the model can
/// fix them all in one retry instead of discovering them one round trip at a time. Pure. Spec §6.
/// </summary>
public static class ChapterReviewValidator
{
    public const int MinBlocks = 3, MaxBlocks = 6;
    public const int MaxTitle = 120, MaxProblem = 1200, MaxLine = 300, MaxPrompt = 500, MaxAnswer = 1500;
    public const int MaxHighlightsPerBlock = 20;
    public const int MinApplications = 1, MaxApplications = 5, MaxApplication = 400;
    public const int MaxOpenThreads = 10, MaxThread = 300, MaxClosedThreads = 20;
    public const int MinRecall = 40, MaxRecall = 3000;
    public const int MaxSerialized = 40_000;

    private static readonly JsonSerializerOptions ParseOptions = new(JsonSerializerDefaults.Web)
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    // Size is measured unescaped: the default encoder writes non-ASCII as \uXXXX, which would make a
    // Cyrillic review six times "larger" than the same review in English.
    private static readonly JsonSerializerOptions SizeOptions = new(JsonSerializerDefaults.Web)
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>
    /// Deserializes the raw review. An unknown property or a wrong type becomes one located error
    /// (<c>unknown_property</c> / <c>invalid_json</c>) rather than a silent drop.
    /// </summary>
    public static (ChapterReviewInput? Input, ReviewFieldErrorDto? Error) Parse(JsonElement review)
    {
        if (review.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
            return (null, new("review", "required", "is required"));
        if (review.ValueKind != JsonValueKind.Object)
            return (null, new("review", "invalid_json", "must be an object"));

        try
        {
            return (review.Deserialize<ChapterReviewInput>(ParseOptions), null);
        }
        catch (JsonException ex)
        {
            var path = ex.Path is { Length: > 0 } p ? "review" + p.TrimStart('$') : "review";
            return ex.Message.Contains("could not be mapped", StringComparison.Ordinal)
                ? (null, new(path, "unknown_property", "is not a field of a chapter review — remove it"))
                : (null, new(path, "invalid_json", "has the wrong type"));
        }
    }

    public static IReadOnlyList<ReviewFieldErrorDto> Validate(ChapterReviewInput review, ReviewValidationContext ctx)
    {
        var errors = new List<ReviewFieldErrorDto>();
        void Add(string path, string code, string message) => errors.Add(new(path, code, message));

        // Blocks
        var referencesTargetHighlight = false;
        var promptHashes = new HashSet<string>(StringComparer.Ordinal);
        if (review.Blocks is null)
            Add("blocks", "required", $"is required ({MinBlocks}–{MaxBlocks} blocks)");
        else
        {
            if (review.Blocks.Count is < MinBlocks or > MaxBlocks)
                Add("blocks", "count", $"must have {MinBlocks}–{MaxBlocks} blocks (got {review.Blocks.Count})");

            for (var i = 0; i < review.Blocks.Count; i++)
            {
                var p = $"blocks[{i}]";
                var b = review.Blocks[i];
                if (b is null) { Add(p, "required", "must be an object"); continue; }

                Text(errors, $"{p}.title", b.Title, MaxTitle);
                Text(errors, $"{p}.problem", b.Problem, MaxProblem);
                Text(errors, $"{p}.rootCause", b.RootCause, MaxLine, singleLine: true);
                Text(errors, $"{p}.rule", b.Rule, MaxLine, singleLine: true);

                if (b.HighlightIds is null)
                    Add($"{p}.highlightIds", "required", "is required (use [] when the block covers none)");
                else
                {
                    if (b.HighlightIds.Count > MaxHighlightsPerBlock)
                        Add($"{p}.highlightIds", "count", $"must have at most {MaxHighlightsPerBlock} ids");
                    for (var j = 0; j < b.HighlightIds.Count; j++)
                    {
                        var hp = $"{p}.highlightIds[{j}]";
                        if (!Guid.TryParse(b.HighlightIds[j], out var id) || !ctx.BookHighlights.TryGetValue(id, out var number))
                            Add(hp, "unknown_highlight", "is not one of the reader's highlights in this book — use only ids get_chapter_review returned");
                        else if (number > ctx.TargetChapterNumber)
                            Add(hp, "highlight_beyond_chapter", "is in a later chapter — a review may only use this chapter and earlier ones");
                        else if (ctx.TargetHighlightIds.Contains(id))
                            referencesTargetHighlight = true;
                    }
                }

                if (b.Question is null)
                    Add($"{p}.question", "required", "is required ({ prompt, answer })");
                else
                {
                    Text(errors, $"{p}.question.prompt", b.Question.Prompt, MaxPrompt);
                    Text(errors, $"{p}.question.answer", b.Question.Answer, MaxAnswer);
                    if (!string.IsNullOrWhiteSpace(b.Question.Prompt)
                        && !promptHashes.Add(OpenThreads.PromptHash(b.Question.Prompt)))
                        Add($"{p}.question.prompt", "duplicate_question", "repeats another block's question — every question must be different");
                }
            }
        }

        // Highlights vs recall: a chapter the reader marked is reviewed around their marks; a chapter
        // with none (the audiobook path) needs what they remember.
        if (ctx.TargetHighlightIds.Count > 0)
        {
            if (review.Blocks is not null && !referencesTargetHighlight)
                Add("blocks", "highlight_required", "the reader has highlights in this chapter — at least one block must reference one by id");
            if (review.Recall is { Length: > MaxRecall })
                Add("recall", "too_long", $"must be at most {MaxRecall} characters");
        }
        else if (string.IsNullOrWhiteSpace(review.Recall))
            Add("recall", "recall_required", "the chapter has no highlights — ask the reader what they remember and put their answer here");
        else if (review.Recall.Trim().Length < MinRecall)
            Add("recall", "too_short", $"must be at least {MinRecall} characters — the reader's own recollection, in their words");
        else if (review.Recall.Length > MaxRecall)
            Add("recall", "too_long", $"must be at most {MaxRecall} characters");

        // Applications
        if (review.Applications is null)
            Add("applications", "required", $"is required ({MinApplications}–{MaxApplications} items)");
        else
        {
            if (review.Applications.Count is < MinApplications or > MaxApplications)
                Add("applications", "count", $"must have {MinApplications}–{MaxApplications} items (got {review.Applications.Count})");
            for (var i = 0; i < review.Applications.Count; i++)
                Text(errors, $"applications[{i}]", review.Applications[i], MaxApplication);
        }

        // Threads
        if (review.OpenThreads is { } opened)
        {
            if (opened.Count > MaxOpenThreads)
                Add("openThreads", "count", $"must have at most {MaxOpenThreads} threads");
            for (var i = 0; i < opened.Count; i++)
            {
                if (opened[i] is null) Add($"openThreads[{i}]", "required", "must be an object ({ text })");
                else Text(errors, $"openThreads[{i}].text", opened[i]!.Text, MaxThread);
            }
        }

        if (review.ClosedThreadIds is { } closed)
        {
            if (closed.Count > MaxClosedThreads)
                Add("closedThreadIds", "count", $"must have at most {MaxClosedThreads} ids");
            var valid = ctx.OpenThreads.Select(t => t.Id).ToHashSet(StringComparer.Ordinal);
            var validList = valid.Count == 0 ? "none are open" : "open: " + string.Join(", ", valid);
            for (var i = 0; i < closed.Count; i++)
            {
                if (closed[i] is not { } id || !valid.Contains(id))
                    Add($"closedThreadIds[{i}]", "unknown_thread", $"is not an open thread ({validList})");
            }
        }

        if (JsonSerializer.Serialize(review, SizeOptions).Length > MaxSerialized)
            Add("review", "too_large", $"must serialize to at most {MaxSerialized} characters — tighten the blocks");

        return errors;
    }

    private static void Text(List<ReviewFieldErrorDto> errors, string path, string? value, int max, bool singleLine = false)
    {
        if (string.IsNullOrWhiteSpace(value))
            errors.Add(new(path, "required", "is required"));
        else if (singleLine && value.Trim().Contains('\n'))
            errors.Add(new(path, "multiline", $"must be one line (≤{max} chars)"));
        else if (value.Length > max)
            errors.Add(new(path, "too_long", $"must be at most {max} characters (got {value.Length})"));
    }
}
