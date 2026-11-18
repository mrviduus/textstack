# Open the pull request

Lesson 3 of 3 in [Ship a first pull request](first-pr.md). About 5 minutes.

In this lesson you offer your change to the project.

## Steps

1. **Push and open the pull request.**

   ```bash
   git push -u origin fix/short-name
   gh pr create --fill
   ```

   Fill in the template. In the description write `Fixes #<issue number>`. Fill the `Docs:` line
   with `updated` or `not affected`.

   You should see: a link to your new pull request.

2. **Name the area.** Every pull request belongs to one area: `reading`, `library`, `highlights`,
   `vocabulary`, `assistant`, `account`, `data`, `ops` or `documentation`. The
   [glossary](../glossary.md) says what each area holds. Only maintainers can set the label, so
   write the area in the description. A maintainer adds the label at review. On a pull request
   from a fork the `area-label` check passes without it.

## If something goes wrong

- **The `area-label` check is red.** Your branch is in this repository, not a fork, so the check
  wants a label. Do nothing. A maintainer adds the label.
- **The `docs-links` check is red.** A link in a `.md` file points at a file that does not exist.
  Run `node tools/checks/check-doc-links.mjs`. It prints the file and the line.
- **A check fails on something you did not touch.** Say so in the pull request. A maintainer runs
  the check again.

## Check yourself

- [ ] My pull request is open.
- [ ] Every check is green, or only `area-label` is red while it waits for a maintainer.
- [ ] The description links the issue and names the area.

## Next

Before a larger change, see [how TextStack works](../architecture/index.md).
