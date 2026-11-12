# Pick the work

Lesson 1 of 3 in [Ship a first pull request](first-pr.md). About 5 minutes.

In this lesson you choose what to change and get a place to change it.

## Steps

1. **Pick an issue, or open one.** Every change starts from an issue: a short note that says what
   should change. Look at the [open issues](https://github.com/mrviduus/textstack/issues), or
   [open a new one](https://github.com/mrviduus/textstack/issues/new/choose) and say what you want to
   change. For anything bigger than a small fix, wait for an answer before you write code.

2. **Fork the repository and clone your fork.** A fork is your own copy on GitHub.

   ```bash
   gh repo fork mrviduus/textstack --clone
   cd textstack
   ```

3. **Create a branch from `main`.** Name it `fix/<what>`, `feat/<what>` or `docs/<what>`.

   ```bash
   git switch -c fix/short-name
   ```

## Check yourself

- [ ] I know the number of my issue.
- [ ] My fork is on my machine.
- [ ] I am on my own branch, not on `main`.

## Next

[Lesson 2: Change and check](pr-2-change-and-check.md).
