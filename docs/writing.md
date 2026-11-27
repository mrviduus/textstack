# How we write

**Agreed with the owner on 2026-11-27.** All English text in TextStack uses simple technical English.
That is docs, READMEs, ADRs, `CLAUDE.md` files, skills, code comments, commits, pull requests and issues.

The rules are a light version of [ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/),
the controlled English of the aerospace industry. We use its writing rules. We do not use its closed
dictionary: our dictionary is the [glossary](glossary.md).

Why: many readers of these pages, and their owner, are not native English speakers. Short, plain
sentences are also easier for an AI assistant to follow.

## Sentences

1. An instruction has 20 words or fewer. A description has 25 words or fewer.
2. Write one instruction in one sentence. Use numbered steps for 3 or more steps.
3. Start a step with the verb: "Run `make migrate`."
4. Use the active voice. Name who does the action: "The worker deletes the file", not "The file is
   deleted".
5. Put the condition first: "If the token expired, sign in again."
6. Give the result first. Put the reason in its own sentence.
7. A paragraph has one topic and 5 sentences or fewer.

## Words

8. Use the [glossary](glossary.md) word for each thing. Do not use its "Not" words, and do not use
   synonyms for variety.
9. Use one word with one meaning. "Start" is always "start", not "launch" or "spin up".
10. Use simple verbs: use, start, stop, show, make, send, make sure. Do not use utilize, leverage,
    facilitate, ensure or perform.
11. Do not use idioms. Use one plain verb for a phrasal verb when one exists: "find", not "figure out".
12. Keep the articles "a", "an" and "the". Only titles and commit subject lines can drop them.
13. Use 3 nouns in a row at most. "The queue that retries book file uploads", not "the book file
    upload retry queue".
14. Do not use "it", "this" or "that" when the reader cannot see what the word refers to. Repeat the
    noun.
15. Do not use "e.g.", "i.e.", "etc.", "above" or "below". Write "for example", "that is", or name the
    section.

## Meaning

16. "Must" is a rule. "Can" is an option. Do not use "should" or "may": they are ambiguous.
17. Use numbers and units, not "soon", "fast" or "a few".
18. Put code names, commands, paths and API names in backticks. They are technical names, so rules
    8–15 do not apply to them. Code keeps its own names, for example `annotations` for highlights.

## Where the rules apply

- **New text:** always.
- **Old text:** a page is rewritten to these rules when a change touches it. Nobody rewrites all the
  docs at once.
- **Never rewritten:** `CHANGELOG.md` (frozen), postmortems in `docs/internal/incidents/`, and the
  decisions in accepted ADRs. They are history.
- **The text in the app** (`en.json`) changes with its screens, as the glossary says.

## Before and after

| Before | After |
|---|---|
| The file is deleted by the cleanup worker once retention has elapsed. | The cleanup worker deletes the file when the retention time ends. |
| In order to leverage the cache, ensure the key is set. | Set the key. Then the app uses the cache. |
| Annotations are synced via the outbox, e.g. on reconnect. | The outbox sends highlights to the server, for example when the phone is online again. |
| You should run the migrator before starting the API. | Run the migrator before you start the API. |
