# Start it

Lesson 2 of 3 in [Run TextStack locally](run-locally.md). About 15 minutes, mostly waiting.

In this lesson you start the backend, create its database and start the web app.

## Steps

1. **Start the backend.** The first run builds five images and downloads about 3 GB.

   ```bash
   make up
   ```

   You should see: `Container textstack_api_prod  Healthy` near the end.

2. **Create the V2 database.** `make up` does not do this.

   ```bash
   make migrate-v2
   ```

   You should see: a list of `up: …` lines, then `Done.`

3. **Check the backend.** Wait 30 seconds, then:

   ```bash
   curl http://localhost:8080/health/ready
   ```

   You should see: `"status":"ready"` and `"v2":{"status":"ok"}`.

4. **Start the web app.**

   ```bash
   pnpm install
   pnpm -C apps/web dev
   ```

   You should see: `Local: http://localhost:5173/`. Keep this terminal open.

## If something goes wrong

- **`make up` fails with `port is already allocated`.** Another program uses port 8080 or 81.
  Stop that program, then run `make up` again.
- **Step 3 shows `"v2":{"status":"unreachable"}`.** The V2 database does not exist yet, or the
  backend has not looked again. It looks every 30 seconds. Run `make migrate-v2`, wait 30 seconds,
  check again.

## Check yourself

- [ ] `make up` ended with the API container `Healthy`.
- [ ] The check in step 3 shows `"status":"ready"` and `"v2":{"status":"ok"}`.
- [ ] The web app says `Local: http://localhost:5173/`.

## Next

[Lesson 3: Open a book](run-3-open-a-book.md).
