---
name: release-prep
description: Prepare a release on a branch - bump the version, write the What's New entry that becomes the release notes, check it, open the PR - and hand the user their tag, sign and publish steps. Use for "prep the release", "/release-prep <version>", "cut beta.N" or "get a release ready".
allowed-tools: Bash(npm run check), Bash(npm run release:notes *), Bash(git log *), Bash(git tag *), Bash(gh pr list *), Bash(gh pr view *), Read, Glob, Grep
---

# Prepare a release

Agents never tag, create or publish releases, and never run `release:keygen` or `release:sign`. This skill ends at the PR; the user does the rest from the hand-over below.

## 1. The version

`<version>` from the user, else the next pre-release after `package.json` (`1.0.0-beta.3` becomes `1.0.0-beta.4`). Branch `release-<version>` off `master`. Fix forward: a bad release is replaced by a higher version, never re-tagged.

## 2. What changed

`git tag -l` for the last tag, then `git log --oneline v<last>..master` and `gh pr list --state merged --limit 30` for the titles since it. Group them into the card's sections (headings and tones as the existing entries use them; the tone names are in `src/shared/whats-new.ts`): new things users can do, things that got better, things that were broken. Each item is a bold `lead` in the user's words (what they will notice) and a plain `detail`. Leave out refactors, CI, docs, tooling and anything users cannot see; match the voice of the entries already there.

## 3. Edit

- `package.json`: `version`.
- `src/shared/whats-new-releases.ts`: the new entry first (newest first), `date` today, `image` only when a PNG was added under `src/renderer/src/assets/whats-new/`.
- `npm run release:notes -- v<version>` renders what the GitHub release will say; read it as a user would.
- `npm run check`, and the `whats-new.mjs` scenario if anything about the card itself changed (an entry alone needs no scenario).

## 4. The PR

Through the `ship` skill: title `Release <version>`, Evidence is the rendered notes. The user merges it.

## 5. Hand-over (the user's three steps)

Print these with the version filled in. The key path is in memory (`one-launch-release-runbook`); the passphrase is the one they chose at keygen, not the PEM file's text.

1. In PowerShell: `git checkout master; git pull; git tag v<version>; git push origin v<version>`. The release workflow builds the installer and drafts the release with the entry as its notes; a tag that is not on master or does not match `package.json` fails there, before the build.
2. In PowerShell or Windows Terminal (not Git Bash, the passphrase prompt needs a real console): `npm run release:sign -- v<version> --key=<primary .pem>`. It downloads the draft's installer and `latest.yml`, refuses unless they describe the same file, signs, uploads, downloads again to verify, and offers to publish.
3. Publish. That is the rollout: copies with automatic updates on see it at their next check.
