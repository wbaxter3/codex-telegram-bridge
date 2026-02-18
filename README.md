# Codex Telegram Bridge

Telegram bot that forwards messages to Codex for work in a target repo, keeps short chat memory per user, supports screenshot intake, and offers a staged commit+push flow from chat.

## Features

- Private, allowlisted Telegram access.
- Stateful conversation memory persisted to disk.
- Screenshot uploads passed to Codex via local file path.
- Safer `/push` flow with `/confirmpush` and `/cancelpush`.
- Optional one-tap keyboard action: `/push commit and push`.
- Push button appears only when there is real work not on remote.

## Requirements

- Node.js 20+
- `codex` CLI available on PATH
- Telegram bot token from BotFather
- A local git repo to operate on

## Create Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Run `/newbot` and follow prompts (bot name + username ending in `bot`).
3. Copy the bot token BotFather returns.
4. Find your numeric Telegram user ID (needed for allowlist):
   - Message [@userinfobot](https://t.me/userinfobot), or
   - Message your bot once, then inspect `msg.from.id` in logs if you temporarily log incoming updates.
5. Set required `.env` values:
   - `TELEGRAM_BOT_TOKEN=<token from BotFather>`
   - `TELEGRAM_ALLOWED_USER_ID=<your numeric user id>`
   - `TARGET_REPO_DIR=<absolute path to your project repo>`
6. Start the bot with `npm run dev`.
7. In Telegram, open a DM with your bot and send `/start`.
8. Verify allowlist works:
   - Your account should get responses.
   - Other users should be ignored.

## Setup

1. Install dependencies:
   - `npm install`
2. Copy env template:
   - `cp .env.example .env`
3. Fill `.env` values.
4. Start bot:
   - Dev hot reload: `npm run dev`
   - Normal: `npm start`

## Environment Variables

Required:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID`
- `TARGET_REPO_DIR`

Optional:

- `TARGET_REPO_BRANCH` (default: `main`)
- `TARGET_REPO_REMOTE` (default: `origin`)
- `SESSION_STORE_PATH` (default: `data/sessions.json`)
- `BOT_INPUTS_SUBDIR` (default: `.codex-inputs`)
- `CODEX_DEFAULT_SANDBOX` (default: `workspace-write`)
- `CODEX_PUSH_SANDBOX` (default: `workspace-write`)
- `TELEGRAM_MAX_MESSAGE` (default: `3900`)
- `CODEX_TIMEOUT_MS` (default: `600000`)
- `HISTORY_TURNS` (default: `8`)
- `HISTORY_STORE_LIMIT` (default: `24`)
- `RESULT_STORE_LIMIT` (default: `6000`)

## Telegram Commands

- `/start`
- `/new` or `/clear`
- `/state`
- `/push <description>`
- `/confirmpush`
- `/cancelpush`

Send a screenshot (photo or image document) with optional caption to include visual context in the Codex request.

## Safety Notes

- Bot only responds in private chats from `TELEGRAM_ALLOWED_USER_ID`.
- In push mode, Codex is instructed to commit only; the bot performs the final `git push`.
- If a `.git-codex` repo is detected ahead of your main repo, push is blocked to avoid split history.
- Default sandbox mode for both standard and push flows is `workspace-write`.
- `CODEX_PUSH_SANDBOX=danger-full-access` is optional and should only be enabled when you trust prompts and need elevated git behavior.
- Long-running Codex invocations are terminated after `CODEX_TIMEOUT_MS`.
- Treat this bot as privileged automation. It can execute Codex actions against your target repository.

## Testing

- `npm test`

## OSS Project Files

- License: `LICENSE`
- Contribution guide: `CONTRIBUTING.md`
- Security policy: `SECURITY.md`
- Code of conduct: `CODE_OF_CONDUCT.md`

## Manual Smoke Test

1. Start the bot with `npm run dev`.
2. Send a normal request that edits files in `TARGET_REPO_DIR`.
3. Confirm the `/push commit and push` keyboard button appears in the same final response.
4. Tap `/push commit and push` and verify bot asks for `/confirmpush`.
5. Tap `/cancelpush` and verify no commit/push occurs.
6. Repeat, then tap `/confirmpush` and verify commit + push status appears.
