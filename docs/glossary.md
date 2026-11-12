# The words of TextStack

**Draft (#1251).** One word for one thing. The same word in the app, in the docs, in the changelog
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

A place the reader marked to find again. A bookmark is a kind of highlight: a marked place with
no passage and no colour. It is kept and shown with the highlights.

Not: reading position. The reading position is one per book and moves by itself. A reader can have
many bookmarks, and each stays where it was put.

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

A thought the assistant saves into a book after talking with the reader: a conclusion, a changed
view, an open question. An insight about one chapter is a **chapter insight**.

Insights are kept as a list. A new insight never replaces an old one, so the reader can see how
their view of a book changed.

Not: checkpoint, conclusion, chapter review, summary.
In code: `discussion_checkpoints` is the list. `book_insight` is the older store, where a new entry
replaces the old one for the same chapter; it stays until the move is done. The assistant tools
`save_insight` and `save_chapter_review` keep their names.

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

Two words for two things. A reader **downloads** a book to keep it on the device. They read
**offline** when there is no network.

Not: "offline book". Say "downloaded book".

## Areas

Every change to TextStack belongs to one area. The same list is used for the changelog, the task
board and these docs.

For readers:

- **Library**: books and where they are.
- **Reading**: opening a book, the reading screen, the reading position, offline.
- **Highlights**: highlights, notes and bookmarks.
- **Vocabulary**: words, explanations, translations, reviews.
- **Assistant**: sharing chapters, insights, keys.
- **Account**: guests, accounts, signing in, closing an account.

For the people who build it:

- **Data**: the databases and moving data between them.
- **Ops**: running TextStack, releases, checks.
- **Docs**: these pages.

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
