# Releasing 0rqestra

The model is the one used for Trader_go and Vinstly Desktop. 0rqestra is built for Windows
(x64) and macOS (universal: Apple Silicon and Intel), and both are listed in the same
`latest.json`.

**Nothing is published on push.** Everything is started by hand on GitHub:
**Actions → Publish 0rqestra release → Run workflow**. The workflow must be on `main` to be
started.

Status: the release scripts and the app's update logic are covered by unit tests. The workflow
itself, the Windows installer step, and the macOS bundle swap have **not** been run yet. The first
`test` release is that test.

## Channels

| Channel | What it does |
|---|---|
| `test` | Builds and publishes `test/latest.json` on the update feed. Creates a pre-release `test-vX.Y.Z` under Releases (not "Latest") and no `v` tag. Skips the approval. The test app is called **0rqestra Updater Test** and has its own app id, so it only follows the test channel. |
| `stable` | Builds, **pauses for approval**, creates a regular release tagged `vX.Y.Z`, shown as "Latest" on the repository page. Everyone who has the app receives the update. |

## How to release

1. **Prepare the version.** Leave the *version* field blank in Run workflow to get the previous
   version +1 (patch). Both stable and test releases count, so numbers only go up. Write a number
   yourself only to change the minor or major version (for example `0.2.0`). Write
   `apps/desktop/RELEASE_NOTES.md` for your own notes; otherwise the latest commit messages are
   used.
2. **Run `test` first.** Run workflow with `channel = test`. Wait until `version`,
   `build-windows`, `build-macos`, and `publish` are green, and `approve` is **skipped** (grey).
3. **Check the test.**
   - `https://raw.githubusercontent.com/SEASTICK/0rqestra/update-feed/test/latest.json` exists
     and contains `windows-x86_64`, `darwin-aarch64`, and `darwin-x86_64` (only when the update
     key is set up, see below).
   - The pre-release `test-vX.Y.Z` is under Releases. Download the `.exe` or `.dmg`, install,
     start.
   - Run `test` again with a higher version. Start the installed test app, choose
     **Check for Updates…** (Help menu on Windows, app menu on macOS), and confirm that it
     installs, restarts, and shows the new version.
4. **Release `stable`** (only after step 3 worked). Run workflow with `channel = stable`.
5. **Approve.** After the build, an issue **"Godkänn uppdatering vX.Y.Z till användarna"** is
   created, assigned to whoever started the run (or both approvers if someone else started it).
   Answer with a comment:
   - `approve` publishes.
   - `deny` cancels. The run turns red and nothing is published.

   Only `SEASTICK` and `edwinfighter42-star` count. The first decision applies. The job waits at
   most 300 minutes and closes the issue if the run is cancelled.
6. **Check.** The release `vX.Y.Z` is "Latest" on the repository page with the `.exe` and `.dmg`,
   and `https://raw.githubusercontent.com/SEASTICK/0rqestra/update-feed/latest.json` shows the
   new version.

Pushing a tag `vX.Y.Z` starts a stable release of that version, with the same approval step.
Tags that start the workflow must be `v*` only. The version calculation reads only tags of the
form `vX.Y.Z` and `test-vX.Y.Z`.

First-time download: the "Latest" release on the repository page,
`https://github.com/SEASTICK/0rqestra/releases/latest`.

## Where things are published

- **Installers and update files** are attached to this repository's GitHub releases (`vX.Y.Z`
  for stable, `test-vX.Y.Z` for test). No separate releases repository or deploy key is needed.
- **`latest.json`**, the small file the installed apps read, is committed by the workflow to the
  branch `update-feed` (`test/latest.json` for the test channel) and read through
  `raw.githubusercontent.com`. It is written last, after the release files answer.
- This works because the repository is public. If it is made private, installed apps can no
  longer read the feed or download updates.

## One-time setup of the update key (done by a person, never by Claude)

1. **Create the key:** `node tools/releasing/generate-update-key.mjs 0rqestra-updater.key`
   (set `UPDATE_SIGNING_PRIVATE_KEY_PASSWORD` first to protect it with a password). Do not reuse
   the Trader_go or Vinstly key.
2. Put the **public** key it prints in `apps/desktop/update-config.json` as `publicKey`, and
   commit that.
3. **Secrets** in this repository (Settings → Secrets and variables → Actions):
   - `UPDATE_SIGNING_PRIVATE_KEY`: the contents of `0rqestra-updater.key`.
   - `UPDATE_SIGNING_PRIVATE_KEY_PASSWORD`: the password, if you set one.
4. Keep the private key outside Git. If it is lost, existing installations cannot be updated and
   must be reinstalled.

**Before this is done** (no `publicKey` and no secret), a release still publishes the installers,
with a warning on the run, but that build has in-app updates switched off: whoever installs it
must download the next version by hand once. With only one of the two set, or a key that does not
match, the workflow stops in the `version` job.

## How the app updates itself

- It checks at startup, every 30 minutes, and when the window gets focus (at most every 10
  minutes). Only a packaged app checks; a development run and the smoke check never do.
- A strictly newer version is downloaded in the background right away and verified against the
  public key built into the app. Only then does the app ask: **Restart now** or **Later**.
  "Later" stays quiet about that version for a day; **Check for Updates…** always shows it.
- A file that cannot be verified is deleted and never installed. Without a network nothing is
  shown unless you asked by hand.
- `latest.json` is read only from the app's own feed address, and update files are fetched only
  over HTTPS from this repository's release downloads.
- The signature covers the version number and the file's SHA-512 (Ed25519). An older signed file
  cannot be republished as a newer version.
- Windows: the NSIS installer runs silently and starts the app again. macOS: the new app bundle
  replaces the installed one and the app restarts; if the swap fails the previous bundle is put
  back.
- The update downloads the whole installer. There is no delta update.

## Good to know

- The Windows installer is **not code signed**, so SmartScreen may show "unknown publisher"
  (More info → Run anyway). Updates are still verified with the app's own signature.
- The macOS app is **ad hoc signed** (no Apple Developer account). Gatekeeper asks the first time
  a downloaded dmg is opened (right-click → Open). Updates the app fetches itself are not
  affected. Apple signing and notarization are not wired up yet.
- The app must be in a folder the user can write to (normally Applications) for macOS updates.
- The releases are public, so anyone can download the installers.
- The signing key is used only in the `publish` job, after the approval, on a Linux runner.
- macOS and Windows minutes cost more than Linux minutes in private repositories. Collect
  changes and run one release, not one per change.
- Test the approval script locally: `bash .github/scripts/test_wait_for_approval.sh`.
