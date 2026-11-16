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

## Where things are published

- **Installers and update files** (`.exe`, `.dmg`, `.zip`, `.sig`) are attached to this repository's
  GitHub releases: `vX.Y.Z` for stable, `test-vX.Y.Z` for test. They cannot live on the Pages
  branch, because a Git branch rejects files over 100 MB and the installers are larger.
- **`latest.json` and `downloads.html`**, the small files the installed apps and the download page
  read, are published to the `gh-pages` branch of `SEASTICK/0rqestra-realeases` (under `/test` for
  the test channel). They are written last, after every file they name answers.
- The `.exe`/`.dmg` links on the download page point to the release files in this repository.

## Channels

| Channel | What it does |
|---|---|
| `test` | Builds and publishes `/test/latest.json` on the update site. Creates a pre-release `test-vX.Y.Z` under Releases (not "Latest") and no `v` tag. Skips the approval. The test app is called **0rqestra Updater Test** and has its own app id, so it only follows the test channel. |
| `stable` | Builds, **pauses for approval**, publishes at the root of the update site, and creates a regular release tagged `vX.Y.Z`, shown as "Latest" on the repository page. Everyone who has the app receives the update. |

## How to release

1. **Prepare the version.** Leave the *version* field blank in Run workflow to get the previous
   version +1 (patch). Both stable and test releases count, so numbers only go up. Write a number
   yourself only to change the minor or major version (for example `0.2.0`). Write
   `apps/desktop/RELEASE_NOTES.md` for your own notes; otherwise the latest commit messages are
   used.
2. **Run `test` first.** Run workflow with `channel = test`. Wait until `version`,
   `build-windows`, `build-macos`, and `publish` are green, and `approve` is **skipped** (grey).
3. **Check the test.**
   - `https://seastick.github.io/0rqestra-realeases/test/latest.json` exists and contains
     `windows-x86_64`, `darwin-aarch64`, and `darwin-x86_64`.
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
6. **Check.** `https://seastick.github.io/0rqestra-realeases/latest.json` shows the new version
   and the release `vX.Y.Z` exists.

Tags that start the workflow must be `v*` only. The version calculation reads only tags of the
form `vX.Y.Z` and `test-vX.Y.Z`.

First-time download: `https://seastick.github.io/0rqestra-realeases/downloads.html`, or the
"Latest" release on the repository page.

## One-time setup (done by a person, never by Claude)

1. **Public repository** `SEASTICK/0rqestra-realeases` (created, spelling as created). The branch
   `gh-pages` exists. Still to do by hand: Settings → Pages → *Deploy from a branch* → `gh-pages`
   → `/ (root)`. The repository holds only `latest.json` and the download page, never the source code or the installers.
2. **Deploy key:** create a key pair
   (`ssh-keygen -t ed25519 -f 0rqestra-deploy-key -N ""`). Add the **public** key as a deploy
   key with **write access** in `0rqestra-realeases`.
3. **Update signing key:** `node tools/releasing/generate-update-key.mjs 0rqestra-updater.key`
   (set `UPDATE_SIGNING_PRIVATE_KEY_PASSWORD` first to protect it with a password). Do not reuse
   the Trader_go or Vinstly key. Put the **public** key it prints in
   `apps/desktop/update-config.json` as `publicKey`, and commit that.
4. **Secrets** in this repository (Settings → Secrets and variables → Actions):
   - `RELEASES_DEPLOY_KEY`: the contents of the **private** deploy key.
   - `UPDATE_SIGNING_PRIVATE_KEY`: the contents of `0rqestra-updater.key`.
   - `UPDATE_SIGNING_PRIVATE_KEY_PASSWORD`: the password, if you set one.
5. Keep private keys outside Git. If the signing key is lost, existing installations cannot be
   updated and must be reinstalled.

Until step 3 is done, `publicKey` is empty: the workflow stops in the `version` job, and a
locally built app has updates switched off.

If the releases repository gets another name, change `RELEASES_REPO` and `RELEASES_PAGES_URL` in
`.github/workflows/desktop-release.yml` and `feedUrl` in `apps/desktop/update-config.json`.

## How the app updates itself

- It checks at startup, every 30 minutes, and when the window gets focus (at most every 10
  minutes). Only a packaged app checks; a development run and the smoke check never do.
- A strictly newer version is downloaded in the background right away and verified against the
  public key built into the app. Only then does the app ask: **Restart now** or **Later**.
  "Later" stays quiet about that version for a day; **Check for Updates…** always shows it.
- A file that cannot be verified is deleted and never installed. Without a network nothing is
  shown unless you asked by hand.
- `latest.json` is read only from the app's own update address, and update files are fetched only
  over HTTPS from this repository's release downloads (`downloadBase` in
  `apps/desktop/update-config.json`). Anything else in a manifest is refused.
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
- The update site is public, so anyone can download the installers.
- The signing key is used only in the `publish` job, after the approval, on a Linux runner.
- macOS and Windows minutes cost more than Linux minutes in private repositories. Collect
  changes and run one release, not one per change.
- Test the approval script locally: `bash .github/scripts/test_wait_for_approval.sh`.
