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
- `CODEX_PUSH_SANDBOX` (default: `danger-full-access`)
- `TELEGRAM_MAX_MESSAGE` (default: `3900`)
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

## Testing

- `npm test`
