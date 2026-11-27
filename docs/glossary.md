# The words of TextStack

**Agreed with the owner on 2026-11-12 (#1251).** One word for one thing. The same word in the app, in the docs, in the changelog
and, in time, in the code.

The words come from [the stories](stories/index.md). Read those first.

How to read an entry:

- The heading is the word to use.
- **Not** lists words that mean the same thing and must not be used for it.
- **In code** is the technical name you will meet today. It is a map, not a second word: do not use
  it in text for readers.

## People

### Reader

The person who reads. Never the screen and never the app.

Not: user, learner.

### Guest

A reader with no account. A guest is still a real reader, with their own books.

Not: anonymous user, visitor.

### Assistant

The reader's own AI helper, outside TextStack. It reads what the reader shares and saves insights.

Not: AI, bot, connector, client.

### Contributor, maintainer

A contributor offers a change to TextStack. A maintainer accepts it.

## Things

### Book

One book in a reader's library. The reader **adds** a book.

Not: upload (as a thing), user book, my book, document.
In code: `books`. The old code says `UserBook`; it goes away with the move.
Note: the app says "upload" until the new reading screen ships. The word changes together with
that screen, not before.

### Book file

The file a book is made from: EPUB, PDF and the other formats.

Not: original, source.
In code: `book_files`.

### Library

All the books of one reader. Not the app: the app is TextStack.

Not: my books, shelf, collection.

### Reading screen

The screen where a book is read.

Not: reader, reader screen, reading view, viewer.

### Reading position

Where the reader is in a book right now.

Not: location, place, locator.
In code: `reading_state`.

### Progress

How far the reader got in a book: the furthest point read. It never moves back.

Not: reading position. They are two things. Going back ten pages changes the position, not the
progress.

### Highlight

A passage the reader marked, with a colour.

Not: annotation, mark, selection.
In code: `annotations`.

### Note

Words the reader writes on a highlight. A note always belongs to a highlight.

Not: comment, annotation.

### Bookmark

A place in a book the reader chose to find again. A reader can have many in one book.

Not: reading position. The reading position says where to continue; there is one per book and it
moves by itself. Not a highlight either.
Note: bookmarks are their own feature. They come before the switch, on the new reading screen (#1314).

### Word

One word the reader saved, with the sentence and the book it came from.

Not: saved word, card, term, entry.
In code: `vocabulary_words`.

### Vocabulary

All the words of one reader.

Not: saved words, your words, dictionary, word list.

### Review

Practising words so they stay. Flashcards are one way to do a review.

Not: study, quiz, training. And not "chapter review": that is a chapter insight.

### Explanation

A short text that says what a word means in this book.

Not: definition, gloss.

### Translation

The word in the reader's own language. A different thing from an explanation.

### Insight

A conclusion or a summary of a book or a chapter. It can be edited: a better one replaces the old
one. An insight about one chapter is a **chapter insight**.

Not: checkpoint, chapter review.
In code: `book_insight`, and the assistant tool `save_insight`.

### Checkpoint

A saved stage of a conversation between the reader and their assistant: what they thought, what
they concluded, what is still open. New checkpoints are added; earlier ones stay as they were.

Not: insight. An insight is rewritten; a checkpoint never is.
In code: `discussion_checkpoints`.

### Shared chapter

A chapter the reader chose to show to their assistant. Sharing one chapter shares no other.

In code: `shared_chapters`.

### Key

What the reader gives their assistant, once, to open their library.

Not: connect key, access key, token, API key.

### Account

What a reader creates to keep their library on more than one device.

Not: profile, library card, user.

### Download, offline

Two words for two things. To **download** is an action: the reader puts a book on the device.
**Offline** is what the reader can then do: read with no network. A downloaded book must be
readable offline.

Not: "offline book". Say "downloaded book".

## Words for the people who build it

These words are for docs, code comments and pull requests. Readers do not see them.

### Sync

The work that makes a reader's devices and the server hold the same library. Each device sends its
changes and gets the changes of the others.

Not: replication, mirroring.
In code: the `/me/v2` routes.

### Outbox

The list of changes that a device keeps until the server accepts them. Because of the outbox, a reader
can read and highlight with no network.

Not: queue, pending writes.
In code: the `outbox` table on the phone.

### Revision

A number on a highlight, a word, a reading position or a book. The server adds 1 to it when a device
edits, deletes or restores the row. A review of a word does not change it. A write names the revision it read. If the row changed since then, the write loses.

Not: version.
In code: `revision`, `expectedRevision`.

### Operation

One change that the server must apply only once, for example a review or a shared chapter. The device
gives each operation an id, so a repeated send does nothing new.

Not: request, command.
In code: `operation_id`.

### Device flow

A way to sign in on a device or an app that cannot show the sign-in page, for example the browser
extension. The extension shows a code, and the reader approves the code on textstack.app.

In code: `/auth/device/*`.

## Areas

Every change to TextStack belongs to one area. The same list is used for the changelog, the task
board and these docs.

For readers:

- **Library**: books and where they are.
- **Reading**: opening a book, the reading screen, the reading position, offline.
- **Highlights**: highlights and the notes on them.
- **Vocabulary**: words, explanations, translations, reviews.
- **Assistant**: sharing chapters, insights, keys.
- **Account**: guests, accounts, signing in, closing an account.

For the people who build it:

- **Data**: the databases and moving data between them.
- **Ops**: running TextStack, releases, checks.
- **Docs**: these pages.

How many changes an area gets does not decide if it is an area. And an area is not a separate
service: it is a part of the product with its own words.

Not an area: "mobile". The phone is a place where TextStack runs, not a part of it. A change to
highlights on the phone is a Highlights change.

In code: the folders are Library, Reading, Annotations, Vocabulary, Discussion, Identity. They
match the six reader areas one to one.

## What changes when

- **Now:** these docs.
- **With the new screens:** the text in the app.
- **After the old code is removed:** names in the code.
- **Never, only for a word:** database tables, saved history, and the names of the assistant's
  tools. The "In code" lines cover them.
