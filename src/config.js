import path from "path";
import { fileURLToPath } from "url";

function parseRequiredString(env, key) {
  const value = String(env[key] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function parseRequiredNumber(env, key) {
  const value = Number.parseInt(String(env[key] || ""), 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Environment variable must be a positive number: ${key}`);
  }
  return value;
}

function parseOptionalNumber(env, key, fallback) {
  const raw = String(env[key] || "").trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable must be a positive number: ${key}`);
  }
  return parsed;
}

function parseOptionalString(env, key, fallback) {
  const raw = String(env[key] || "").trim();
  return raw || fallback;
}

export function parseConfig(env, cwd, currentFilePath) {
  const repoDir = path.resolve(parseRequiredString(env, "TARGET_REPO_DIR"));
  const sessionStore = path.resolve(
    cwd,
    parseOptionalString(env, "SESSION_STORE_PATH", "data/sessions.json")
  );
  const inputsSubdir = parseOptionalString(env, "BOT_INPUTS_SUBDIR", ".codex-inputs");

  return {
    token: parseRequiredString(env, "TELEGRAM_BOT_TOKEN"),
    allowedUserId: parseRequiredNumber(env, "TELEGRAM_ALLOWED_USER_ID"),
    codexBin: parseOptionalString(env, "CODEX_BIN", "codex"),
    targetRepoDir: repoDir,
    targetBranch: parseOptionalString(env, "TARGET_REPO_BRANCH", "main"),
    targetRemote: parseOptionalString(env, "TARGET_REPO_REMOTE", "origin"),
    defaultSandbox: parseOptionalString(env, "CODEX_DEFAULT_SANDBOX", "workspace-write"),
    pushSandbox: parseOptionalString(env, "CODEX_PUSH_SANDBOX", "workspace-write"),
    sessionPath: sessionStore,
    inputsDir: path.resolve(repoDir, inputsSubdir),
    primaryGitDir: path.resolve(repoDir, ".git"),
    appDir: path.dirname(currentFilePath),
    telegramMax: parseOptionalNumber(env, "TELEGRAM_MAX_MESSAGE", 3900),
    historyTurns: parseOptionalNumber(env, "HISTORY_TURNS", 8),
    historyStoreLimit: parseOptionalNumber(env, "HISTORY_STORE_LIMIT", 24),
    resultStoreLimit: parseOptionalNumber(env, "RESULT_STORE_LIMIT", 6000),
    codexTimeoutMs: parseOptionalNumber(env, "CODEX_TIMEOUT_MS", 600000),
  };
}

export function loadConfig(env = process.env) {
  const thisFile = fileURLToPath(import.meta.url);
  const cwd = process.cwd();
  return parseConfig(env, cwd, thisFile);
}
