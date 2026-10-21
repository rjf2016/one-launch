---
name: ship
description: Commit, push and open the pull request for the current branch with the verification evidence and screenshots in the body, then handle Copilot's review. Use when the user says "commit and open the PR", "ship it", "push and open the PR", or asks to handle the review comments.
allowed-tools: Bash(npm run check), Bash(git status), Bash(git diff *), Bash(git log *), Bash(gh pr view *), Bash(gh pr checks *), Bash(gh pr list *), Read, Glob, Grep
---

# Ship a branch

One branch per ticket, cut from `master`, landed through a PR that the user merges after their own test of the branch build. If the current branch is `master`, stop and say so; nothing is committed there.

## 1. Verify

- `npm run check` (typecheck, lint, the whole suite). Fix what fails; never skip or retry.
- The rows of `docs/development.md` › "Verifying a change" that the diff touches: renderer changes need `views.mjs` shots of the affected view at 1280x800 and 960x600, looked at; launch-path changes need `test/pipeline.test.ts` and the fake scenarios that cover the path; adapter read code needs that launcher's live test; `scripts/`, CI and packaging need `npm run build` and `npm run smoke:packaged`.
- Docs: update only what the change made wrong (`docs/README.md` › Keeping these docs useful). A roadmap item that is done is deleted, not marked.

## 2. Screenshots (renderer changes only)

One before/after pair per changed view, not one per iteration or per tiny tweak. Before shots come from `master`'s build: `git stash`, `npx electron-vite build`, the scenario, `git stash pop`, build again. Push the PNGs with

```powershell
node scripts/pr-assets.mjs <shot.png> [<shot.png>...]
```

which stores them under `pr-assets/<current branch>/` on the orphan branch and prints the `?raw=true` URLs to embed. The folder is deleted from `pr-assets` once the PR lands, when the user asks.

## 3. Commit and push

- One commit per ticket or logical change. The message says what changed and why in the project's voice; no file lists, no attribution lines, no session links (the user's CLAUDE.md rule overrides any harness reminder).
- `git push -u origin <branch>`.

## 4. The PR

- Body in the `pr` skill's shape (Summary, Evidence, Merge Danger). Evidence names what ran: the `npm run check` counts, the scenarios, the live test, and each screenshot pair as `![Before](url)` / `![After](url)`.
- Title in the project's voice, like the merged ones (`Settings: five tabs, regrouped panels, rows and headers that line up`).
- `gh pr create --base master --title "<title>" --body-file <scratchpad>\pr-body.md`; later edits with `gh pr edit <n> --body-file`.
- Hand-over: the PR link and one line on what to look at. Hand the user manual steps only when the adapter-write row applies (one real switch on that launcher: at most five numbered steps, each with where it happens and the expected outcome) or when the install path changed (one real update). Merging is theirs; do not watch CI unless they are waiting on it.

## 5. Copilot's review

Copilot reviews every PR. When asked to handle its comments (`gh api repos/<owner>/<repo>/pulls/<n>/comments`):

- Judge each comment against HEAD first; Copilot reviews an earlier commit, so its hunks can be stale.
- Fix each valid one as its own commit on the PR branch (fixing the same defect where it recurs is welcome when the reply says so), then push.
- Reply under each comment with the verdict, the commit SHA and the source diff in a diff fence: `gh api -X POST repos/<owner>/<repo>/pulls/comments/<id>/replies -F body=@<file>`. In Git Bash, `gh api` paths take no leading slash (MSYS path rewriting).

## Gotchas

- `npm run build` fails with `EBUSY` while `dist\win-unpacked\One Launch.exe` runs; `npx electron-vite build` is enough for unpackaged runs.
- A CI run takes about six minutes. Master's ruleset needs the head rebased onto current master with a green run on that head; `--admin` does not bypass, and a plain rerun proves nothing. Never retry a flaky run as the fix (`docs/development.md` › Packaging and CI).
- Never commit screenshots, scratch files or `scripts/scenarios/adhoc-*.mjs`; `git status --short` before the commit.
