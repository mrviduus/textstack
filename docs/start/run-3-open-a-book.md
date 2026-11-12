# Open a book

Lesson 3 of 3 in [Run TextStack locally](run-locally.md). About 2 minutes.

In this lesson you add a book and read its first page. This is
[story 1](../stories/index.md) on your own machine.

## Steps

1. **Add a book.** Open <http://localhost:5173>. Click **Upload your book** and choose an EPUB
   file. The repository has one: `tests/TextStack.Extraction.Tests/Fixtures/frankenstein.epub`.
   You do not need an account. The app lets you in as a guest.

   You should see: the book's page, with its chapters listed.

2. **Open the book.** Click **Open in the V2 reader**.

   You should see: the first page of the book, at an address that ends in `/read-v2`.

## If something goes wrong

- **"Upload failed" next to the button.** The web app cannot reach the backend. The backend
  answers only a web app on port 5173. Check step 3 of [lesson 2](run-2-start-it.md). Check that the
  web app says port 5173. If it chose another port, stop what uses 5173 and start the web app again.
- **There is no "Open in the V2 reader" link.** `FEATURES_V2API` was not `true` when the backend
  started. Fix `.env`, then run `docker compose up -d --force-recreate api worker`. A plain restart
  does not read `.env` again.

## Check yourself

- [ ] My book is in the library.
- [ ] The first page of the book is on my screen.

## Next

TextStack runs on your machine. Now change it: [Ship a first pull request](first-pr.md).
