import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "./config.js";

const baseEnv = {
  TELEGRAM_BOT_TOKEN: "token",
  TELEGRAM_ALLOWED_USER_ID: "12345",
  TARGET_REPO_DIR: "/tmp/repo",
};

test("parseConfig uses defaults for optional values", () => {
  const cfg = parseConfig(baseEnv, "/app", "/app/src/config.js");
  assert.equal(cfg.targetBranch, "main");
  assert.equal(cfg.targetRemote, "origin");
  assert.equal(cfg.codexBin, "codex");
  assert.equal(cfg.githubToken, "");
  assert.equal(cfg.openaiApiKey, "");
  assert.equal(cfg.openaiTranscribeModel, "whisper-1");
  assert.equal(cfg.inputsSubdir, ".codex-inputs");
  assert.equal(cfg.pushSandbox, "workspace-write");
  assert.equal(cfg.sessionPath, "/app/data/sessions.json");
  assert.equal(cfg.inputsDir, "/tmp/repo/.codex-inputs");
  assert.equal(cfg.codexTimeoutMs, 600000);
});

test("parseConfig throws on missing required env", () => {
  assert.throws(
    () => parseConfig({ ...baseEnv, TARGET_REPO_DIR: "" }, "/app", "/app/src/config.js"),
    /TARGET_REPO_DIR/
  );
});

test("parseConfig supports overrides", () => {
  const cfg = parseConfig(
    {
      ...baseEnv,
      TARGET_REPO_BRANCH: "develop",
      TARGET_REPO_REMOTE: "upstream",
      CODEX_BIN: "/usr/local/bin/codex",
      GITHUB_TOKEN: "gho_123",
      OPENAI_API_KEY: "sk-live",
      OPENAI_TRANSCRIBE_MODEL: "gpt-4o-transcribe",
      SESSION_STORE_PATH: "state/sessions.json",
      HISTORY_TURNS: "12",
      CODEX_TIMEOUT_MS: "45000",
      BOT_INPUTS_SUBDIR: "artifacts",
      REPO_ALIAS_STORE_PATH: "state/repos.json",
    },
    "/app",
    "/app/src/config.js"
  );
  assert.equal(cfg.targetBranch, "develop");
  assert.equal(cfg.targetRemote, "upstream");
  assert.equal(cfg.codexBin, "/usr/local/bin/codex");
  assert.equal(cfg.githubToken, "gho_123");
  assert.equal(cfg.openaiApiKey, "sk-live");
  assert.equal(cfg.openaiTranscribeModel, "gpt-4o-transcribe");
  assert.equal(cfg.inputsSubdir, "artifacts");
  assert.equal(cfg.sessionPath, "/app/state/sessions.json");
  assert.equal(cfg.historyTurns, 12);
  assert.equal(cfg.codexTimeoutMs, 45000);
  assert.equal(cfg.repoAliasStorePath, "/app/state/repos.json");
});
