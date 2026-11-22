using System.Runtime.CompilerServices;
using Application.Ai;
using TextStack.Ai.Core;

namespace TextStack.UnitTests;

public class LegacyLlmAdapterTests
{
    [Fact]
    public async Task CompleteAsync_MapsToLlmRequestWithFeatureTag_AndReturnsText()
    {
        var stub = new CapturingLlm("translated text");
        var adapter = new LegacyLlmAdapter(stub, "translate");

        var result = await adapter.CompleteAsync("sys prompt", "user prompt", 123, CancellationToken.None);

        Assert.Equal("translated text", result);
        Assert.NotNull(stub.Last);
        Assert.Equal("sys prompt", stub.Last!.SystemPrompt);
        Assert.Equal("translate", stub.Last.FeatureTag);
        Assert.Equal(123, stub.Last.MaxOutputTokens);
        var msg = Assert.Single(stub.Last.Messages);
        Assert.Equal("user", msg.Role);
        Assert.Equal("user prompt", msg.Content);
    }

    private sealed class CapturingLlm(string text) : ILlmService
    {
        public LlmRequest? Last { get; private set; }

        public Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct)
        {
            Last = request;
            return Task.FromResult(new LlmResponse(text, Array.Empty<ToolCall>(), new LlmUsage(0, 0, 0m), "stub", Guid.NewGuid()));
        }

        public async IAsyncEnumerable<LlmDelta> StreamAsync(LlmRequest request, [EnumeratorCancellation] CancellationToken ct)
        {
            await Task.CompletedTask;
            yield break;
        }
    }
}
