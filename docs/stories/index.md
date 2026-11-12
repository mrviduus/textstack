# The stories of TextStack

**Draft for the owner to edit (#1251).** Nothing here is final until the owner says so.

TextStack is a library you carry with you. These seven stories say how people use it. Every
sentence has the same shape: **someone does something with something**. There is no code here and
no technical name. The technical pages come after the stories, not before.

Why stories come first: the words in them become the only words the project uses. The same word in
the app, in the code, in the changelog and in these docs.

## How to read a story

- **Who** is in the story is in bold the first time.
- A *thing* people work with is in italics the first time. These things become the glossary.
- Each step has a mark that says where it comes from:
  - **(owner)** the owner decided it. The source is named under the story.
  - **(today)** the app does this today. It was read in the code or the existing docs.
  - **(to check)** nobody has decided it, or two sources disagree.
- "After the move" means after the move to V2, the new library and reader. Until then some steps
  work the old way. Each story says which.

## The people

- **Reader**: reads books. May have an account, or use the app as a guest.
- **Assistant**: the reader's own AI helper, outside TextStack.
- **Library**: TextStack itself. It keeps books and remembers things for the reader.
- **Helper**: an outside service the library asks to explain or translate a word.
- **Contributor** and **Maintainer**: people who change TextStack.

---

## Story 1. A reader brings a book and starts reading

1. The **Reader** picks a *book file* on their device. (today)
2. The **Library** checks if the reader already has this exact file. If yes, it offers to open the
   book they have, or to cancel. It never replaces a book without asking. (owner)
3. The Library adds the *book* to the reader's *library*. (today)
4. The Reader opens the book. (today)
5. The *reader screen* shows the first page. (today)
6. The Library remembers the *reading position* as the reader moves. (today)

**After the move:** the book opens straight from the file on the device. The reader does not wait
for the Library to prepare it, and does not need an account or a network. (owner)

**Today:** the file goes to the Library first. The Library cuts it into chapters, and then the book
can be opened. (today)

**To check:** the app says "Upload your book". The story says "bring" or "add". Which word do we keep?

Sources: `v2-target-model.md` (stories, identity decisions of 2026-10-28), `flows.md` "Upload a book".
Existing picture: the "Upload a book" scenario of the architecture map.

---

## Story 2. A reader comes back on another device

1. The **Reader** signs in on a second device. (today)
2. The **Library** shows the reader's *library* there. (today)
3. The Library brings the *reading position*, the *highlights* and the *words* to the new device.
   This happens by default after sign-in. (owner)
4. The Library brings the *book file* only if the reader turned that on. If not, the book is shown
   as "not on this device", and the reader adds the file again. (owner)
5. The Reader opens the book and continues from the saved position. (today)
6. If the reader moved in the book on both devices, the Library does not jump by itself. It says
   there is a newer position and lets the reader choose. (today)
7. The *furthest point read* never moves back because the reader went back a few pages. (owner)

**To check:** what the reader sees when two devices disagree is decided for the new reader, but the
exact words on screen are not written yet.

Sources: `v2-target-model.md` "Optional cloud sync" (owner, 2026-10-28), `reader-open-resume.md`.
Existing picture: the "Read a chapter" scenario of the architecture map.

---

## Story 3. A reader meets a hard word

1. The **Reader** taps a *word* on the reader screen. (today)
2. The **Library** asks a **Helper** for a short *explanation* that fits this book. (today)
3. The reader screen shows the explanation. If the Helper is away, reading still works. (today)
4. The Reader saves the word. (today)
5. The Library puts the word into the reader's *vocabulary*, with the sentence and the book it came
   from. (today)
6. The next time the word appears, in any book, the reader screen shows a small translation next to
   it. The reader does not have to stop. (owner)
7. Later the Reader does a *review* of their words. (today)
8. Saving a word again never resets what the reader already learned. (owner)

**To check:** the app uses "vocabulary", "saved words", "your words" and "flashcards" for parts of
this. We need one word for the list, one for an item, one for the practice.

Sources: `v2-target-model.md` story 1 and the vocabulary row (owner), `vocabulary-srs.md`.
Existing picture: flow 6b in the system map of the 2026-10 review.

---

## Story 4. A reader marks a passage

1. The **Reader** selects a passage on the reader screen. (today)
2. The Reader marks it as a *highlight* and picks a colour. (today)
3. The Reader may write a *note* on the highlight. A note always belongs to a highlight. (owner)
4. The **Library** keeps the highlight with the book, together with the words that were marked. (today)
5. The Reader sees all highlights of a book, and of all books, in one place. (today)
6. If the reader replaces the book file with a new edition, the Library keeps every highlight and
   its words. It does not move a highlight to a place it is not sure about. (owner)

**To check:** the new database calls all of this "annotations". The app says "highlights". The old
database also has "bookmarks" as a separate thing. Is a bookmark its own thing, or a kind of highlight?

Sources: `v2-target-model.md` highlights row and replacement decisions (owner, 2026-10-28 and 29).
Existing picture: none.

---

## Story 5. A reader talks about a chapter with their assistant

1. The **Reader** gives their **Assistant** a *key* to their library, once. (today)
2. The Reader finishes a chapter and shares that *chapter* with the Assistant. Sharing is always a
   clear action by the reader. Sharing one chapter does not share any other. (owner)
3. The Assistant reads the shared chapter and what the reader worked out before. (owner)
4. The Reader and the Assistant talk. The conversation lives with the Assistant, not in TextStack. (owner)
5. When they reach a conclusion, a changed view or an open question, the Assistant saves it into
   the book. (owner)
6. The **Library** confirms that it was saved. If it was not, the Assistant says so. (owner)
7. When the Reader returns, the Assistant gets those saved thoughts first, and keeps them apart
   from today's talk. It does not rewrite what the reader thought before. (owner)
8. The Assistant never marks a chapter as read, and never adds or deletes words, just because they
   talked. (owner)

**To check, the biggest word problem in the project:** what the Assistant saves is called
"insight", "conclusion", "checkpoint" and "chapter review" in different places. Are these one thing
with kinds, or really different things?

**Honest limit, to keep in the story:** deleting something in TextStack does not delete the copy the
Assistant already has.

Sources: `mcp-discussion-checkpoints.md` "Domain story" (owner, 2026-10-29), `v2-target-model.md`
story 2 and 3, `assistant-handoff.md`.
Existing picture: the assistant scenario of the architecture map.

---

## Story 6. A guest gets an account, and later closes it

1. A **Reader** uses TextStack with no *account*. They are a *guest*. Their books stay on their
   device. (owner)
2. The guest creates an account. (today)
3. The **Library** moves everything the guest had into the account: books, reading positions,
   words and highlights. Nothing is lost and nothing is asked twice. (owner)
4. From now on the Library copies reading positions, words and notes between the reader's devices. (owner)
5. The Reader signs out. The Library removes the account's data from this device and keeps the
   books that were added as a guest. If something is not saved to the account yet, it warns first. (owner)
6. The Reader closes the account. The Library deletes the account and everything in it at once. It
   cannot be undone. (today)

**To check:** "account" or "library card"? "Guest" is used the same everywhere, which is good.

Sources: `v2-sync-protocol.md` "Guest → account merge" and "Sign-out, account deletion" (owner
decisions 2 and 3), ADR-014, the delete-account page of the app.
Existing picture: none.

---

## Story 7. A contributor changes TextStack

1. A **Contributor** picks an *issue*: a short note that says what should change. (today)
2. The Contributor makes the change on their own copy. (today)
3. The Contributor runs the *checks*. (today)
4. The Contributor offers the change as a *pull request* and says which *area* it touches. (today)
5. A **Maintainer** reads it and accepts it. (today)
6. The change goes live by itself. (today)
7. The change appears on the *changelog* page, under its area. (today)

**To check:** the areas. The changelog has eight, the code has six, the task board has six others,
and the app menu has four. They should be one list.

Sources: `start/first-pr.md`, `.github/release.yml`.
Existing picture: the delivery diagram in `architecture/delivery.md`.

---

## Words these stories need

A first list, taken from the stories. The owner picks one word per line; the others become
forbidden as synonyms.

- **Book**. Also seen: upload, user book, my book.
- **Library**. Also seen: my books, shelf.
- **Reader screen**. Also seen: reader, reading view. Note: "reader" is also the person.
- **Reading position**. Also seen: progress, location, place.
- **Highlight**, with an optional **note**. Also seen: annotation, bookmark.
- **Word**, **vocabulary**, **review**. Also seen: saved words, your words, flashcards.
- **Explanation**. Also seen: translation, definition, gloss.
- **Assistant** and **key**. Also seen: AI, connector, MCP client; connect key, access key.
- One word for what the assistant saves. Seen: insight, conclusion, checkpoint, chapter review.
- **Guest** and **account**.
- **Area**, **issue**, **pull request**, **changelog**.

## Areas the stories suggest

Each story stays inside one area, or crosses a clear line between two. That gives this list:

- **Library**: stories 1 and 2. Books and where they are.
- **Reader**: stories 1 and 2. Opening a book and keeping the place.
- **Highlights**: story 4.
- **Vocabulary**: story 3.
- **Assistant**: story 5.
- **Account**: story 6.

Not seen by readers: Mobile, Data, Ops, Docs.

## What the owner decides next

1. Is each story right? Change any sentence. The steps marked (owner) quote earlier decisions; say
   if one has changed.
2. Are seven stories the right seven? Missing candidates: listening to a book read aloud, reading
   with no network, finding a book in the library.
3. The "to check" line under each story.
