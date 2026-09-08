# AI Quota

A Wox plugin that shows local Codex, Cursor, and Grok quotas inside the launcher.

![Screenshot of AI Quota in Wox](./screenshot.png)

## What It Reads

- Codex live account and rate-limit windows from `codex app-server`
- Codex local account fallback from `~/.codex/auth.json`
- Codex local history totals from `~/.codex/state_5.sqlite`
- Cursor current-period usage from the local Cursor session (`state.vscdb`) plus Cursor dashboard APIs
- Grok Bot weekly included usage from the same Cursor session (`GetSandUsageStatus`)
- Grok SuperGrok weekly or monthly credits from `~/.grok/auth.json` plus the Grok CLI billing API

Cursor usage needs Cursor installed and signed in on the same machine. The plugin reads the local session from `state.vscdb` and does not store the token. Reading that database uses `sqlite3` when it is on `PATH`, or Python's built-in `sqlite3` as a fallback.

Grok usage needs `grok login` on this machine. The plugin reads the local Grok session and does not store the token.

Grok Bot usage uses the signed-in Cursor session on this machine. It is a separate weekly pool from Grok CLI credits.

## Trigger Keywords

- `aiq` — Codex, Cursor, and Grok (Cursor and Grok appear after the first successful fetch)
- `aiq codex` — Codex only
- `aiq cursor` — Cursor only
- `aiq grok` — Grok only
- `refresh` after any of the above — force a reload

## Install

```bash
wpm install Wox.Plugin.AIQuota
```

## Build

```bash
pnpm install
pnpm build
```

## Notes

- The plugin is inspired by the local-first approach used by [steipete/codexbar](https://github.com/steipete/codexbar).
- It prefers official local Codex JSON-RPC data over screen-scraping `/status`.
- Codex window labels come from the live window length. Pro often has only a weekly window; a 5-hour bar is shown only when that window actually exists.
- Cursor shows the current monthly cycle and splits remaining quota into Cursor Models and Other Models.
- Grok shows the SuperGrok weekly or monthly credit pool remaining, using the same billing endpoint as `grok` `/usage`.
- Cursor and Grok usage use undocumented product endpoints. Those responses can change without notice.
