# Releasing the Watcher

Two paths: **CI** (preferred, builds on GitHub Actions) and **local**
(fallback, builds on a Windows PC). The output is the same — an NSIS
installer + `latest.yml` uploaded to a GitHub release. The installed
watchers' auto-updater picks it up on next launch.

## A. Via GitHub Actions

Requires `GH_TOKEN` repo secret with `repo` scope (or fine-grained
`contents: read+write`).

```
git tag vX.Y.Z
git push origin vX.Y.Z
```

The workflow at `.github/workflows/release.yml` runs on the tag push and
publishes a draft release. Promote the draft to "Published" and the
update is live.

## B. Locally (Windows)

Requires Node 20 + npm, and a `GH_TOKEN` env var with the same scope.

```cmd
cd Watcher-app
set GH_TOKEN=ghp_yourtoken
npm install
npm run release
```

`npm run release` runs `electron-builder --publish=always`. It builds
`dist-electron\PropFirm Trade Watcher Setup X.Y.Z.exe` and uploads it
plus `latest.yml` to a GitHub release for the version in
`package.json`. If a release for that version doesn't exist, it's
created as a draft. Promote when ready.

To bump the version:

```
npm version patch   # 1.1.0 -> 1.1.1
npm version minor   # 1.1.0 -> 1.2.0
```

This updates `package.json` and creates a `vX.Y.Z` git tag. Push with
`git push --follow-tags`.

## Notes

- **Code signing** is off (`win.forceCodeSigning: false`). Windows
  SmartScreen will warn on first install. To remove the warning, buy
  an EV cert (~$300/yr) and set `win.certificateFile` /
  `win.certificatePassword`.
- **Differential updates** are enabled (`nsis.differentialPackage`),
  so installed clients only download the changed parts.
- **Portable target** was removed — `electron-updater` cannot update
  portable EXEs. The NSIS installer is required.
