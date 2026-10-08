using Api.Endpoints;
using Api.Sites;
using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Moq;
using TextStack.UnitTests.Fakes;

namespace TextStack.UnitTests;

/// <summary>
/// TR-2: the reader's word bubble may replace a saved translation only from the sentence the word was
/// saved with (a correction, e.g. an old "enterrado" fixed by "embolsou"). The server decides, because
/// the client does not know the stored sentence of a word loaded from the server.
/// </summary>
public class UpdateWordIfSentenceTests
{
    private static readonly Guid UserId = Guid.NewGuid();
    private static readonly Guid SiteId = Guid.NewGuid();
    private const string Saved = "He pocketed the coins and walked out.";

    private static HttpContext Ctx()
    {
        var ctx = new DefaultHttpContext();
        ctx.Items[Api.Middleware.McpKeyAuthMiddleware.UserIdItemKey] = UserId;
        ctx.Items["SiteContext"] = new SiteContext(SiteId, "general", "localhost", "en", "default", false, false, false, "{}");
        return ctx;
    }

    private static async Task<VocabularyWord> Patch(string? stored, UpdateWordRequest request)
    {
        var word = new VocabularyWord
        {
            Id = Guid.NewGuid(),
            UserId = UserId,
            SiteId = SiteId,
            Word = "pocketed",
            Language = "en",
            Translation = stored,
            Sentence = Saved,
        };
        var db = new Mock<IAppDbContext>();
        db.Setup(x => x.VocabularyWords).Returns(new FakeDbSet<VocabularyWord>([word]));
        var result = await VocabularyEndpoints.UpdateWord(word.Id, request, Ctx(), null!, db.Object, CancellationToken.None);
        Assert.IsType<Ok<VocabWordDto>>(result);
        return word;
    }

    [Fact]
    public async Task UpdateWord_IfSentenceMatchesStoredSentence_ReplacesTranslation()
    {
        var word = await Patch("enterrado", new UpdateWordRequest("embolsou", null, $"  {Saved} "));
        Assert.Equal("embolsou", word.Translation);
    }

    [Fact]
    public async Task UpdateWord_IfSentenceDiffers_LeavesTranslationUnchanged()
    {
        var word = await Patch("enterrado", new UpdateWordRequest("guardou", null, "She pocketed the note."));
        Assert.Equal("enterrado", word.Translation);
    }

    [Fact]
    public async Task UpdateWord_IfSentenceWithEmptyStoredTranslation_WritesTranslation()
    {
        var word = await Patch(null, new UpdateWordRequest("guardou", null, "She pocketed the note."));
        Assert.Equal("guardou", word.Translation);
    }
}
