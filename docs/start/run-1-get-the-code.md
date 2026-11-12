# Get the code

Lesson 1 of 3 in [Run TextStack locally](run-locally.md). About 3 minutes.

In this lesson you copy the project to your machine and prepare it to start.

## Steps

1. **Clone the repository.**

   ```bash
   git clone https://github.com/mrviduus/textstack
   cd textstack
   ```

2. **Create your settings file.** The file `.env` holds the settings Docker reads.

   ```bash
   cp .env.example .env
   ```

3. **Edit four lines in `.env`.**

   ```bash
   POSTGRES_PASSWORD=local-dev-password
   JWT_SECRET=local-dev-secret-at-least-32-characters
   ASPNETCORE_ENVIRONMENT=Development
   FEATURES_V2API=true
   ```

   `JWT_SECRET` signs the sign-in tokens. It must be 32 characters or longer.
   `FEATURES_V2API=true` turns on V2: the new library and reading screen the project is moving to.
   Leave the other lines as they are.

4. **Create the data folders.** The backend keeps books in `./data`.

   ```bash
   make fix-permissions
   ```

   You should see: `Done.`

## Check yourself

- [ ] The folder `textstack` is on my machine.
- [ ] The file `.env` exists and has my four lines.
- [ ] `make fix-permissions` printed `Done.`

## Next

[Lesson 2: Start it](run-2-start-it.md).
