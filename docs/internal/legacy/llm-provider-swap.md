# LLM Provider Swap Guide

> **Historical — the code-edit recipe below no longer applies.** `DistractorGenerator` and
> `BookMetadataGenerator` now call `ILlmServiceFactory`, not Ollama's HTTP API, and the provider is
> chosen per task by config: `Ai:Routes` in `backend/src/Api/appsettings.json` (and the Worker's) —
> `distractor`, `bookmeta`, `tagsuggestion` → `ollama` today. Swapping is a route change
> (e.g. to `openai`), no code edit; the admin AI-quality page can also promote/roll back routes.
> The cost estimates and verification steps below are still a fair guide.

Default: self-hosted **Ollama** (`gemma4:e2b`) in Docker. This doc shows how to swap it for a managed LLM API (OpenAI, Anthropic, Groq, etc.) if self-hosting is undesirable.

## What the LLM does

Two fire-and-forget uses, both non-blocking — failures degrade gracefully:

| Caller | Purpose | Fallback if LLM fails |
|---|---|---|
| `DistractorGenerator` | Vocabulary MC quiz: 5 distractors + hint + explanation | Random words from user's vocab pool + hardcoded list |
| `BookMetadataGenerator` | User-uploaded books: genre, publication year, description | Fields stay `NULL`; book still usable |

No core reader feature depends on the LLM.

## Files to edit (two call sites)

### 1. `backend/src/Vocabulary/TextStack.Vocabulary/DistractorGenerator.cs`

- L24–28: HTTP POST to `{OllamaBaseUrl}/api/generate` with `{ model, prompt, stream }`
- L33: parses `OllamaResponse.Response` (free-text reply)
- Replace the POST body + response parsing to match your provider's chat-completions format

### 2. `backend/src/Worker/Services/BookMetadataGenerator.cs`

- L13–15: reads `Ollama:BaseUrl`, `Ollama:Model`, `Ollama:TimeoutSeconds` from config
- L22–23: same POST shape as DistractorGenerator
- L28: same free-text parsing

Both files use plain `IHttpClientFactory` + `System.Net.Http.Json` — no SDK lock-in.

## Swap to OpenAI-compatible API

OpenAI, Groq, Together, Anyscale, etc. all speak the same `/chat/completions` shape. Example diff for `DistractorGenerator.cs`:

```csharp
// Before (Ollama)
var request = new { model = _options.OllamaModel, prompt, stream = false };
var response = await client.PostAsJsonAsync($"{_options.OllamaBaseUrl}/api/generate", request, ct);
var result = await response.Content.ReadFromJsonAsync<OllamaResponse>(ct);
var text = result?.Response;

// After (OpenAI-compatible)
client.DefaultRequestHeaders.Authorization =
    new AuthenticationHeaderValue("Bearer", _options.ApiKey);
var request = new {
    model = _options.Model,
    messages = new[] { new { role = "user", content = prompt } },
    stream = false
};
var response = await client.PostAsJsonAsync($"{_options.BaseUrl}/v1/chat/completions", request, ct);
var result = await response.Content.ReadFromJsonAsync<ChatResponse>(ct);
var text = result?.Choices?[0]?.Message?.Content;
```

Apply the same three-line change in `BookMetadataGenerator.cs`. Parsing downstream (`ParseStructuredResponse`, `ParseResponse`) is unchanged — same DISTRACTORS/HINT/EXPLANATION and GENRE/YEAR/DESCRIPTION format works with any LLM.

## Swap to Anthropic

`/v1/messages` endpoint has a different shape:

```csharp
client.DefaultRequestHeaders.Add("x-api-key", _options.ApiKey);
client.DefaultRequestHeaders.Add("anthropic-version", "2023-06-01");
var request = new {
    model = "claude-haiku-4-5-20251001",
    max_tokens = 1024,
    messages = new[] { new { role = "user", content = prompt } }
};
var response = await client.PostAsJsonAsync($"{_options.BaseUrl}/v1/messages", request, ct);
// response shape: { content: [{ type: "text", text: "..." }] }
```

## Config changes

### `.env`

Remove:
```
Ollama__BaseUrl=http://ollama:11434
Ollama__Model=gemma4:e2b
```

Add (example for OpenAI):
```
Llm__BaseUrl=https://api.openai.com
Llm__Model=gpt-4o-mini
Llm__ApiKey=sk-...
```

### `docker-compose.yml`

- L234–241: delete the `ollama:` service block
- L69–70: update env vars on `api` and `worker` services
- L238: `./data/ollama` volume no longer needed — can purge (~8GB)

## Rate limits & cost

Managed APIs apply per-key rate limits and bill per token. Budget roughly:

- Distractor gen: ~300 input tokens + ~150 output per word save — one call per saved vocabulary word
- Book metadata: ~200 input + ~200 output per user book upload

At OpenAI `gpt-4o-mini` pricing (~$0.15/M in, $0.60/M out), ~$0.0002 per vocab save. 10k saves/mo ≈ $2.

Add rate limiting on the relevant endpoints (see `backend/src/Api/Program.cs` rate-limit config) to cap abuse.

## Verification

1. `POST /me/vocabulary/words` with a new word → row appears with `Distractors` / `Hint` / `Explanation` populated
2. Upload a user book → `UserBook.Genre` / `PublishedYear` / `Description` filled after ingestion
3. If the LLM call fails (wrong API key, rate limit), rows still save — only the LLM-generated fields are null

## Rollback to Ollama

All of the above is reversible by reverting the two `.cs` files + `docker-compose.yml` + `.env`. No DB migrations, no schema changes — LLM fields are nullable.
