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
  assert.equal(cfg.pushSandbox, "workspace-write");
  assert.equal(cfg.sessionPath, "/app/data/sessions.json");
  assert.equal(cfg.inputsDir, "/tmp/repo/.codex-inputs");
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
      SESSION_STORE_PATH: "state/sessions.json",
      HISTORY_TURNS: "12",
    },
    "/app",
    "/app/src/config.js"
  );
  assert.equal(cfg.targetBranch, "develop");
  assert.equal(cfg.targetRemote, "upstream");
  assert.equal(cfg.sessionPath, "/app/state/sessions.json");
  assert.equal(cfg.historyTurns, 12);
});
