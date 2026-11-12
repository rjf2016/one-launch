# Update transcripts

What the Electron updater does on each condition of its feed: the `updates:status` states it passes through, every request it makes to the feed, its timers, and the log lines it writes. Recorded through the real engine (electron-updater) in the unpackaged build, on the dev-only loopback test feed (`ONELAUNCH_UPDATE_FEED`, `ONELAUNCH_UPDATE_KEYS`), fake launchers `none` and a scratch data folder. Each condition was recorded three times; a transcript is here only because the three normalised to the same bytes. The tooling is `scripts/oracle/updates/` on the Electron repo's `oracle-tooling` branch.

## Files

| Path | What |
| --- | --- |
| `<condition>.json` | One transcript per condition |
| `normalisation/<condition>.json` | How the three recordings were made one: the rules and the paths each changed, the sha256 of each recording's transcript (each equal to the file's), and how many transient states each recording had taken out |

## Conditions

| Condition | Feed | Ends |
| --- | --- | --- |
| `up-to-date` | A manifest naming the running version | `up-to-date` |
| `update-ready` | The signed fixture manifest and its installer, sent in three parts | `ready`; Restart to update installs with a relaunch |
| `unsigned` | The fixture manifest without `signature` and `keyId` | `failed` verify, `unsigned` |
| `wrong-key` | The signed manifest with its key id changed to one no key has | `failed` verify, `unknown-key` |
| `hash-mismatch` | The signed manifest, but other bytes of the same length as the installer | `failed` download |
| `network-failure` | Nothing listens on the feed port | `failed` check, could not be reached |
| `no-keys` | The signed manifest; the build trusts no key | `failed` verify, `no-keys` |
| `not-an-object` | `latest.yml` is a YAML scalar | `failed` check (the engine's own version check); `direct` holds `verifyManifest`'s verdict |
| `web-installer` | `packages` added | `failed` verify, `unsupported` |
| `file-count` | Two file entries | `failed` verify, `unsupported` |
| `file-entry` | The file entry is a string | `failed` verify, `malformed` |
| `admin-rights` | `isAdminRightsRequired: true` | `failed` verify, `unsupported` |
| `version-format` | `version: 1.0.0-beta.4+build.7` | `failed` verify, `malformed` |
| `file-name` | `url: downloads/<file>` | `failed` verify, `malformed` |
| `file-sha512` | The file entry has no `sha512` | `failed` verify, `malformed` |
| `file-size` | The file entry has no `size` | `failed` verify, `malformed` |
| `signature-format` | `signature: 'not-a-signature'` | `failed` verify, `malformed` |
| `key-id-format` | The key id in upper case | `failed` verify, `malformed` |
| `bad-signature` | The version changed after signing | `failed` verify, `bad-signature` |
| `auto-off-in-flight` | Automatic updates switched off while the background check waits for `latest.yml` | `idle`: the check completes its request and downloads nothing (spec 12.2); a manual check then downloads, and the update is left for a restart |
| `auto-off-during-download` | Automatic updates switched off while the background download waits for the installer, then on again | `idle`, then 15 s later a background check to `ready`, installed at quit without a relaunch |
| `feed-http-503` | Every request answered HTTP 503 | `failed` check |
| `no-manifest` | `latest.yml` answered HTTP 404 | `failed` check |

Every manifest is the fixture `fixtures/updates/latest.yml` (or `latest-unsigned.yml`), as text, with one edit; `feed.manifest` is the exact text served. The only key is the throwaway one in `fixtures/updates/README-keys.json`.

## A transcript

```json
{
  "condition": "unsigned", "title": "...", "group": "core | refusal | behaviour",
  "app": { "version": "1.0.0-beta.3", "mode": "...", "clock": "<the oracle clock>" },
  "feed": { "url": "http://127.0.0.1:{port}/", "listening": true, "keys": ["<key id>"], "manifest": "<latest.yml as served, or null for a 404>",
            "installer": { "path": "/<file>", "bytes": 50, "text": "...", "matchesManifest": true } },
  "recorded": {
    "steps": [ { "step": "timer", "by": "the first-check timer", "states": [], "requests": [], "timers": [], "log": [] } ],
    "dataFolder": { "devAppUpdateYml": "...", "updateCache": [], "updateInfoJson": null, "updaterIdFile": false }
  }
}
```

- `feed.status` is set when the feed answers every request with that status; `feed.paced` and `feed.autoOffAt` say what the feed held. `direct` (only `not-an-object`) is `verifyManifest` called on the value the engine would have loaded, because the engine never hands it a non-object.
- `steps` in order. `start` is the app starting, up to the first-check timer being armed; `timer` is that timer's background check, 15 s later; `manual` is `updates:check` (the Check for updates button), with its `answer`; `auto-on` is `settings:set updates.auto true`; `timer-again` is the check that timer arms; `install` is `updates:install` (Restart to update) to the exit; `quit` is closing the window to the exit, with `exit` the code. `actions` are the IPC calls the recording made inside a step and when (`settings:set logLevel debug` at the start of every recording, `updates.auto` where a condition switches it).
- `states`: the distinct `updates:status` values in the order they were seen within the step. The step a state belongs to is the step it was first seen in.
- `requests`: every request that reached the feed in the step, in arrival order: `method`, `path`, `query`, `headers` (the ones the engine sets: `user-agent`, `cache-control`, `accept`, `x-user-staging-id`), `transport` (the ones Chromium's network stack adds), and `answer`: the status and byte count the feed sent, or `held` with the step during which the connection closed.
- `timers`: the update timer, from the main process: `arm` with its delay in ms, `fire`, `clear`.
- `log`: the lines of the scopes `main:updates` (the service) and `main:updater` (the engine), with level. A line with `exact: true` was written by the app's code and is split into `message` and `meta`; a line with `exact: false` is electron-updater's own text, whole, as `text`.
- `dataFolder`: what the run left: the `dev-app-update.yml` the engine wrote, the files under `update-cache` with their sizes, `update-cache/pending/update-info.json`, and whether a `.updaterId` was written.

## Placeholders

| Placeholder | Stands for |
| --- | --- |
| `127.0.0.1:{port}` | The feed's port, a free one per recording |
| `<t32>` | The `noCache` query value electron-updater adds to every manifest request (`Date.now()` in base 32) |
| `<ts>` | An ISO time that differed between recordings (`checkedAt`) |
| `{data}`, `{scratch}` | The recording's data folder and its scratch folder |
| `{repo}` | The Electron repo's root, in electron-updater's stack traces |

`downloading` at 100 percent is taken out of every recording: electron-updater reports it as the body ends and the service replaces it within milliseconds, so only some recordings see it. Every other state is in every recording because the feed held its answer until the state before had been seen.

## Comparing the Rust updater

Serve the same `feed.manifest` and installer bytes on a loopback feed, holding each answer until the state before it has been seen, as these recordings did, and drive the same steps.

Exact, per step:

- `states`, in order, after collapsing repeats and dropping `downloading` at 100 percent; `checkedAt` is any ISO time.
- The number, order, `method` and `path` of `requests`, and `x-user-staging-id`: every request for `latest.yml` carries `00000000-0000-0000-0000-000000000000` and no request carries another value; no `.updaterId` file is written.
- `timers`: the first check 15000 ms after start, a background check re-arms 21600000 ms, a manual check never arms one, `ready` and switching automatic updates off leave none armed, switching them on arms 15000 ms, quitting clears an armed one.
- `log` lines with `exact: true`: level, message and meta, in order.
- The texts in `failed` states, and the `answer` of a manual check.

Advisory:

- `log` lines with `exact: false`: electron-updater's wording, its stack traces, and its DEBUG lines (only written at the `debug` log level, which each recording set). The levels are still meaningful: the engine logs its errors at WARN, never ERROR.
- `query` and the other `headers` and `transport`: they are electron-updater's and Chromium's. A Rust client sends its own `user-agent` and need not add `noCache`.
- `dataFolder.updateCache`: electron-updater's cache layout under the data folder in test-feed mode. It leaves a 0-byte `temp-<file>` behind when a download is cancelled before any byte arrives (`auto-off-during-download` shows it replaced by the next download).

These recordings use electron-updater's generic provider, which is what the test feed is. The GitHub provider of a real install (`releases.atom`, `releases/latest`, then `latest.yml` and the installer from the release's assets) is described in SPEC.md section 7.5 and is not recorded here.

## Things the transcripts show that the spec states or leaves open

- A background check that finds an update after automatic updates were switched off goes back to `idle` without downloading, but its request for `latest.yml` was made and answered (spec 12.2, item 11).
- Switching automatic updates off during a background download cancels it (`update download cancelled: automatic updates turned off`) and the state goes `idle`, but the installer request itself is not aborted: in `auto-off-during-download` the held connection stays open until the app quits.
- A checksum mismatch is caught by electron-updater during the download, so it is a `download` failure with "the downloaded file does not match the release"; the service's own post-download comparison ("the downloaded file does not match the signed release") never runs on a mismatch through this engine.
- `the release manifest is not an object` is unreachable through electron-updater: a non-object manifest fails the engine's version check first, as a `check` failure with electron-updater's message.
- A refused connection reaches the service as `net::ERR_CONNECTION_REFUSED` from Chromium, one engine error line per check. electron-updater's generic provider retries only an error whose `code` is `ECONNREFUSED`, which Chromium's error does not carry, so it is not retried (read from the library; nothing listens, so the attempts themselves cannot be counted).
