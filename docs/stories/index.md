# The stories of TextStack

**Agreed with the owner on 2026-11-12 (#1251).** A change to a story is a change to the product: it needs the owner.

TextStack is a library you carry with you. These eight stories say how people use it. Every
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
- **TextStack**: the app itself. It keeps books and remembers things for the reader. The reader's
  own books are their *library*.
- **Helper**: an outside service the library asks to explain or translate a word.
- **Contributor** and **Maintainer**: people who change TextStack.

---

## Story 1. A reader brings a book and starts reading

1. The **Reader** picks a *book file* on their device. (today)
2. **TextStack** checks if the reader already has this exact file. If yes, it offers to open the
   book they have, or to cancel. It never replaces a book without asking. (owner)
3. TextStack adds the *book* to the reader's *library*. (today)
4. The Reader opens the book. (today)
5. The *reading screen* shows the first page. (today)
6. TextStack remembers the *reading position* as the reader moves. (today)

**After the move:** the book opens straight from the file on the device. The reader does not wait
for TextStack to prepare it, and does not need an account or a network. (owner)

**Today:** the file goes to TextStack first. TextStack cuts it into chapters, and then the book
can be opened. (today)

**Word:** the reader *adds* a book. The app still says "upload" today, and that is true today: the
file goes to TextStack first. The app text changes together with the move.

Sources: `v2-target-model.md` (stories, identity decisions of 2026-10-28), `flows.md` "Upload a book".
Existing picture: the "Upload a book" scenario of the architecture map.

---

## Story 2. A reader comes back on another device

1. The **Reader** signs in on a second device. (today)
2. **TextStack** shows the reader's *library* there. (today)
3. TextStack brings the *reading position*, the *highlights* and the *words* to the new device.
   This happens by default after sign-in. (owner)
4. TextStack brings the *book file* only if the reader turned that on. If not, the book is shown
   as "not on this device", and the reader adds the file again. (owner)
5. The Reader opens the book and continues from the saved position. (today)
6. If the reader moved in the book on both devices, TextStack does not jump by itself. It says
   there is a newer position and lets the reader choose. (today)
7. The *progress*, the furthest point read, never moves back because the reader went back a few
   pages. (owner)

**To check:** what the reader sees when two devices disagree is decided for the new reader, but the
exact words on screen are not written yet.

Sources: `v2-target-model.md` "Optional cloud sync" (owner, 2026-10-28), `reader-open-resume.md`.
Existing picture: the "Read a chapter" scenario of the architecture map.

---

## Story 3. A reader meets a hard word

1. The **Reader** taps a *word* on the reading screen. (today)
2. **TextStack** asks a **Helper** for a short *explanation* that fits this book. (today)
3. The reading screen shows the explanation. If the Helper is away, reading still works. (today)
4. The Reader may listen to how the word sounds. (today)
5. The Reader saves the word. (today)
6. TextStack puts the word into the reader's *vocabulary*, with the sentence and the book it came
   from. (today)
7. The next time the word appears, in any book, the reading screen shows a small translation next to
   it. The reader does not have to stop. (owner)
8. Later the Reader does a *review* of their words. (today)
9. Saving a word again never resets what the reader already learned. (owner)

**Words:** the list is the *vocabulary*, one item is a *word*, the practice is a *review*.
"Flashcards" is one way to do a review, not another name for it.

Sources: `v2-target-model.md` story 1 and the vocabulary row (owner), `vocabulary-srs.md`.
Existing picture: flow 6b in the system map of the 2026-10 review.

---

## Story 4. A reader marks a passage

1. The **Reader** selects a passage on the reading screen. (today)
2. The Reader marks it as a *highlight* and picks a colour. (today)
3. The Reader may write a *note* on the highlight. A note always belongs to a highlight. (owner)
4. **TextStack** keeps the highlight with the book, together with the words that were marked. (today)
5. The Reader sees all highlights of a book, and of all books, in one place. (today)
6. If the reader replaces the book file with a new edition, TextStack keeps every highlight and
   its words. It does not move a highlight to a place it is not sure about. (owner)

**Words:** *highlight* and *note*. The new database calls them "annotations"; that stays a
technical name.

A *bookmark* is a kind of highlight: a marked place with no passage and no colour. (owner)

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
6. **TextStack** confirms that it was saved. If it was not, the Assistant says so. (owner)
7. When the Reader returns, the Assistant gets those saved thoughts first, and keeps them apart
   from today's talk. It does not rewrite what the reader thought before. (owner)
8. The Assistant never marks a chapter as read, and never adds or deletes words, just because they
   talked. (owner)

**Word:** what the Assistant saves is an *insight*. An insight about one chapter is a *chapter
insight*. "Review" is kept for practising words.

Insights are kept as a list. A new one never replaces an old one. "Checkpoint" is only a
technical name for that list. (owner)

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
3. **TextStack** moves everything the guest had into the account: books, reading positions,
   words and highlights. Nothing is lost and nothing is asked twice. (owner)
4. From now on TextStack copies reading positions, words and notes between the reader's devices. (owner)
5. The Reader signs out. TextStack removes the account's data from this device and keeps the
   books that were added as a guest. If something is not saved to the account yet, it warns first. (owner)
6. The Reader closes the account. TextStack deletes the account and everything in it at once. It
   cannot be undone. (today)

**Words:** *account* and *guest*. Both are already used the same way everywhere.

Sources: `v2-sync-protocol.md` "Guest → account merge" and "Sign-out, account deletion" (owner
decisions 2 and 3), ADR-014, the delete-account page of the app.
Existing picture: none.

---

## Story 7. A reader reads with no network

1. The **Reader** keeps a book on their device. (today)
2. The network goes away. (today)
3. The Reader opens the book. The reading screen shows it from the device. It waits for no network
   and for no sign-in. (owner)
4. The Reader reads, makes highlights and saves words. The device keeps them. (today)
5. The network comes back. **TextStack** sends what the device kept to the reader's account. (today)
6. A book that is not on the device cannot be opened with no network. TextStack says so in plain
   words. (today)

**Words:** the reader *downloads* a book to keep it on the device, and reads *offline* when there
is no network. Two words for two things. (owner)

Sources: the reading-path rule in `CLAUDE.md`, `internal/claude/mobile.md` "Offline".
Existing picture: none.

---

## Story 8. A contributor changes TextStack

1. A **Contributor** picks an *issue*: a short note that says what should change. (today)
2. The Contributor makes the change on their own copy. (today)
3. The Contributor runs the *checks*. (today)
4. The Contributor offers the change as a *pull request* and says which *area* it touches. (today)
5. A **Maintainer** reads it and accepts it. (today)
6. The change goes live by itself. (today)
7. The change appears on the *changelog* page, under its area. (today)

The areas are one list now. It is in the [glossary](../glossary.md).

Sources: `start/first-pr.md`, `.github/release.yml`.
Existing picture: the delivery diagram in `architecture/delivery.md`.

---

## The words and the areas

The stories gave the project its words. They live in one place: the [glossary](../glossary.md).
One word per thing, the words not to use, and the list of areas.

## What is still open

The words are decided (owner, 2026-11-12). Two things are left:

1. Is each story right? Change any sentence. The steps marked (owner) quote earlier decisions; say
   if one has changed.
2. Story 2: the exact words on screen when two devices disagree.

Not a story, on purpose: finding a book in the public catalogue. The catalogue goes away after the
move.
