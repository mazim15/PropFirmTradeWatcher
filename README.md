# PropFirm Trade Watcher

Desktop app that watches MT4/MT5 trade exports and forwards them to the
PropFirm Trade Tracker web app.

## Deployment to a new PC

1. Install Node.js 20 + npm.
2. Clone this repo, run `npm install`.
3. `npm run dist` produces `dist-electron/` with the NSIS installer.
4. Install on each PC; on first run, open settings and:
   - Set the API URL of your web app
   - Paste the API key created in the web app for this PC
5. The watcher's default watch folder is the MetaQuotes terminal common
   folder (`%APPDATA%\MetaQuotes\Terminal\Common\Files`). All MT4/MT5
   terminals on the PC write there when their EA has `UseCommonFolder=true`.

## EAs

`MT4_TradeExporter.mq4` and `MT5_TradeExporter.mq5` go in each terminal's
`MQL4\Experts\` / `MQL5\Experts\` folder. Compile in MetaEditor, attach to
any chart. They write three files per account into the terminal common
folder:

- `trades_<account>_latest.csv` — closed trades (default every 1 min)
- `open_trades_<account>_latest.csv` — open positions (default every 30s)
- `account_<account>_state.csv` — equity / margin / freeMargin / level (5s)

All writes are atomic (write to `.tmp`, then rename), so the watcher never
sees a partial file.

## Per-PC API keys

For multi-PC deployments, create one API key per PC in the web app's
Settings → API Keys page and set `allowedAccountNumbers` to just the
accounts that PC handles. The import endpoints reject batches whose
account number isn't on the key's allowlist.

## Auto-update

`electron-updater` checks for new releases on startup and every 5 min via
heartbeat. New versions are published to the GitHub releases of the
private repo configured in `package.json`'s `build.publish` block. Bump
the version in `package.json`, push a `vX.Y.Z` tag, and the
`.github/workflows/release.yml` workflow builds + publishes the NSIS
installer + `latest.yml`. Each PC picks it up on next launch.

## Symbol map

If any broker uses suffixed symbols (XAUUSDm, XAUUSD.r, GOLD#), open the
web app → Settings → Symbol Map and add variants under the canonical
symbol (XAUUSD). The watcher pulls this map on startup and every
heartbeat.
