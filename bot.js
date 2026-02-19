import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import { spawn } from "child_process";
import https from "https";
import { createReadStream } from "fs";
import { access, copyFile, mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { loadConfig } from "./src/config.js";
import {
  chunkTextByParagraph,
  isOneTapPushCommand,
  sanitizePushNarration,
} from "./src/message-utils.js";

const config = loadConfig();
const defaultRepoDef = {
  dir: config.targetRepoDir,
  branch: config.targetBranch,
  remote: config.targetRemote,
};
const RESERVED_ALIASES = new Set(["default"]);
let repoAliasStore = { aliases: {}, active: null };

// Simple single-flight lock (prevents overlapping Codex runs)
let busy = false;
let sessions = {};

if (!config.token || !config.allowedUserId) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_ALLOWED_USER_ID");
  process.exit(1);
}

const bot = new TelegramBot(config.token, { polling: true });

async function loadSessions() {
  try {
    const raw = await readFile(config.sessionPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Session store root must be an object.");
    }
    sessions = parsed;
  } catch (error) {
    if (error?.code === "ENOENT") {
      sessions = {};
      return;
    }
    try {
      await mkdir(path.dirname(config.sessionPath), { recursive: true });
      const backupPath = `${config.sessionPath}.corrupt-${Date.now()}.json`;
      await copyFile(config.sessionPath, backupPath);
      console.error(
        `Session store was unreadable. Backed up original to: ${backupPath}`
      );
    } catch (backupError) {
      console.error("Failed to back up unreadable session store.", backupError);
    }
    console.error("Failed to load session store. Starting with empty sessions.", error);
    sessions = {};
  }
}

async function saveSessions() {
  const dir = path.dirname(config.sessionPath);
  await mkdir(dir, { recursive: true });
  await writeFile(config.sessionPath, JSON.stringify(sessions, null, 2), "utf8");
}

async function ensureInputsDir() {
  await mkdir(config.inputsDir, { recursive: true });
}

function getSession(chatId) {
  const key = String(chatId);
  if (!sessions[key]) {
    sessions[key] = { history: [], pendingPush: null };
  }
  return sessions[key];
}

function addHistory(chatId, role, content) {
  const session = getSession(chatId);
  session.history.push({
    role,
    content: String(content || "").slice(0, config.resultStoreLimit),
    ts: new Date().toISOString(),
  });
  if (session.history.length > config.historyStoreLimit) {
    session.history = session.history.slice(-config.historyStoreLimit);
  }
}

function buildHistoryContext(chatId) {
  const session = getSession(chatId);
  const turns = session.history.slice(-config.historyTurns);
  if (!turns.length) return "No prior conversation context.";
  return turns
    .map(
      (t, i) =>
        `[${i + 1}] ${t.role.toUpperCase()} (${t.ts}):\n${t.content}`
    )
    .join("\n\n");
}

async function sendLongMessage(chatId, text, lastMessageOptions = {}) {
  const safe = String(text || "(no output)").replace(/```/g, "");
  const chunkSize = config.telegramMax - 20;
  const chunks = chunkTextByParagraph(safe, chunkSize);

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const isLast = i === chunks.length - 1;
    await bot.sendMessage(chatId, chunk, isLast ? lastMessageOptions : {});
  }
}

function runCodex(promptText, sandboxMode = config.defaultSandbox) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const args = [
      "exec",
      "--cd",
      config.targetRepoDir,
      "--sandbox",
      sandboxMode,
      promptText,
    ];

    const child = spawn(config.codexBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_DIR: config.primaryGitDir,
        GIT_WORK_TREE: config.targetRepoDir,
      },
    });

    let out = "";
    let err = "";

    const timeoutId = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGTERM");
      reject(
        new Error(
          `codex timed out after ${config.codexTimeoutMs}ms. Increase CODEX_TIMEOUT_MS if needed.`
        )
      );
    }, config.codexTimeoutMs);

    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });

    child.on("error", (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      reject(e);
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      if (code !== 0) {
        reject(new Error(err || `codex exited with code ${code}`));
      } else {
        resolve(out || "(no output)");
      }
    });
  });
}

function runCommand(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

function gitArgs() {
  return ["-C", config.targetRepoDir];
}

async function runGit(args) {
  return runCommand("git", [...gitArgs(), ...args]);
}

const MAX_DIFF_PREVIEW_CHARS = 3500;
const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const ACTIONS_POLL_INTERVAL_MS = 10000;
const ACTIONS_POLL_ATTEMPTS = 12;
const GITHUB_API = "https://api.github.com";

async function buildDiffPreview({ ref = null } = {}) {
  const args = ref
    ? ["show", "--stat", "--patch", "-U3", "--color=never", ref]
    : ["diff", "--stat", "--patch", "-U3", "--color=never"];
  const diff = await runGit(args);
  if (diff.code !== 0) return "";
  const trimmed = (diff.out || "").trim();
  if (!trimmed) return "";
  if (trimmed.length > MAX_DIFF_PREVIEW_CHARS) {
    return `${trimmed.slice(0, MAX_DIFF_PREVIEW_CHARS)}\n... (diff preview truncated)`;
  }
  return trimmed;
}

function normalizeAliasName(name) {
  return String(name || "").trim().toLowerCase();
}

async function saveRepoAliasStore() {
  await mkdir(path.dirname(config.repoAliasStorePath), { recursive: true });
  await writeFile(
    config.repoAliasStorePath,
    JSON.stringify(repoAliasStore, null, 2),
    "utf8"
  );
}

async function applyRepoSelection(def, aliasName, { persist = true, resetSessions = true } = {}) {
  const resolvedDir = path.resolve(def.dir);
  try {
    await access(path.join(resolvedDir, ".git"));
  } catch {
    throw new Error(`TARGET_REPO_DIR does not look like a git repo: ${resolvedDir}`);
  }
  config.targetRepoDir = resolvedDir;
  config.targetBranch = def.branch || defaultRepoDef.branch;
  config.targetRemote = def.remote || defaultRepoDef.remote;
  config.inputsDir = path.resolve(resolvedDir, config.inputsSubdir);
  config.primaryGitDir = path.resolve(resolvedDir, ".git");
  repoAliasStore.active = aliasName;
  if (persist) {
    await saveRepoAliasStore();
  }
  if (resetSessions) {
    sessions = {};
    await saveSessions();
  }
}

async function loadRepoAliasStore() {
  try {
    const raw = await readFile(config.repoAliasStorePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      repoAliasStore = {
        aliases: parsed.aliases || {},
        active: parsed.active || null,
      };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("Failed to read repo alias store:", error);
    }
    repoAliasStore = { aliases: {}, active: null };
  }
  const active = repoAliasStore.active;
  if (active && repoAliasStore.aliases[active]) {
    await applyRepoSelection(repoAliasStore.aliases[active], active, {
      persist: false,
      resetSessions: false,
    });
  }
}

async function addRepoAlias(alias, def) {
  repoAliasStore.aliases[alias] = def;
  await saveRepoAliasStore();
}

async function removeRepoAlias(alias) {
  delete repoAliasStore.aliases[alias];
  if (repoAliasStore.active === alias) {
    repoAliasStore.active = null;
    await applyRepoSelection(defaultRepoDef, null);
  } else {
    await saveRepoAliasStore();
  }
}

function formatAliasLine(name, def, isActive) {
  return `${isActive ? "✅" : "•"} ${name} -> ${def.dir} [branch: ${def.branch || "main"}, remote: ${def.remote || "origin"}]`;
}

function getAliasListMessage() {
  const active = repoAliasStore.active || "default";
  const lines = [
    formatAliasLine("default", defaultRepoDef, active === "default"),
  ];
  Object.entries(repoAliasStore.aliases).forEach(([name, def]) => {
    lines.push(formatAliasLine(name, def, active === name));
  });
  return lines.join("\n");
}

async function handleRepoCommand(chatId, text) {
  const parts = text.trim().split(/\s+/);
  const action = (parts[1] || "").toLowerCase();

  if (!action || action === "help") {
    await bot.sendMessage(
      chatId,
      "Repo commands:\n/repo list\n/repo add <alias> <path> [branch] [remote]\n/repo use <alias>\n/repo remove <alias>"
    );
    return;
  }

  if (action === "list") {
    await bot.sendMessage(chatId, getAliasListMessage());
    return;
  }

  if (busy) {
    await bot.sendMessage(
      chatId,
      "⏳ I’m busy running another request. Try the repo command again shortly."
    );
    return;
  }

  if (action === "add") {
    const aliasName = normalizeAliasName(parts[2]);
    const repoPath = parts[3];
    const branch = parts[4] || defaultRepoDef.branch;
    const remote = parts[5] || defaultRepoDef.remote;
    if (!aliasName || RESERVED_ALIASES.has(aliasName)) {
      await bot.sendMessage(chatId, "Provide a valid alias name (not 'default').");
      return;
    }
    if (!repoPath) {
      await bot.sendMessage(chatId, "Use: /repo add <alias> <absolute-path> [branch] [remote]");
      return;
    }
    const resolved = path.resolve(repoPath);
    try {
      await access(path.join(resolved, ".git"));
    } catch {
      await bot.sendMessage(chatId, "Path must be a git repo with a .git directory.");
      return;
    }
    await addRepoAlias(aliasName, { dir: resolved, branch, remote });
    await bot.sendMessage(
      chatId,
      `Alias '${aliasName}' added for ${resolved} (branch ${branch}, remote ${remote}).`
    );
    return;
  }

  if (action === "use") {
    const aliasName = normalizeAliasName(parts[2]);
    if (!aliasName) {
      await bot.sendMessage(chatId, "Use: /repo use <alias|default>");
      return;
    }
    if (aliasName === "default") {
      await applyRepoSelection(defaultRepoDef, null);
      await bot.sendMessage(
        chatId,
        `Active repo set to default (${defaultRepoDef.dir}). Session memory cleared.`
      );
      return;
    }
    const aliasConfig = repoAliasStore.aliases[aliasName];
    if (!aliasConfig) {
      await bot.sendMessage(chatId, `Alias '${aliasName}' not found. Use /repo list.`);
      return;
    }
    await applyRepoSelection(aliasConfig, aliasName);
    await bot.sendMessage(
      chatId,
      `Active repo set to '${aliasName}' (${aliasConfig.dir}). Session memory cleared.`
    );
    return;
  }

  if (action === "remove") {
    const aliasName = normalizeAliasName(parts[2]);
    if (!aliasName || RESERVED_ALIASES.has(aliasName)) {
      await bot.sendMessage(chatId, "Use: /repo remove <alias> (cannot remove default).");
      return;
    }
    if (!repoAliasStore.aliases[aliasName]) {
      await bot.sendMessage(chatId, `Alias '${aliasName}' not found.`);
      return;
    }
    await removeRepoAlias(aliasName);
    await bot.sendMessage(chatId, `Alias '${aliasName}' removed.`);
    return;
  }

  await bot.sendMessage(
    chatId,
    "Unknown /repo command. Available: list, add, use, remove."
  );
}

async function getHeadCommit() {
  const res = await runGit(["rev-parse", "HEAD"]);
  if (res.code !== 0) {
    throw new Error(`Unable to read git HEAD.\n${res.err || res.out || "(empty)"}`);
  }
  return res.out.trim();
}

async function getCurrentBranch() {
  const res = await runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (res.code !== 0) {
    throw new Error(`Unable to determine branch.\n${res.err || res.out || "(empty)"}`);
  }
  return res.out.trim();
}

async function getRepoSlug() {
  const res = await runGit(["remote", "get-url", config.targetRemote]);
  if (res.code !== 0) {
    throw new Error(`Unable to read remote URL.\n${res.err || res.out || "(empty)"}`);
  }
  const remote = (res.out || "").trim();
  const sshMatch = remote.match(/git@github.com:(.+?)\.git$/i);
  if (sshMatch) return sshMatch[1];
  try {
    const parsed = new URL(remote);
    if (parsed.hostname !== "github.com") {
      throw new Error(`Remote ${remote} is not GitHub`);
    }
    return parsed.pathname.replace(/^\//, "").replace(/\.git$/, "");
  } catch {
    throw new Error(`Unsupported remote format: ${remote}`);
  }
}

async function ensureBranchPushed(branch) {
  const res = await runGit(["push", config.targetRemote, branch]);
  if (res.code !== 0) {
    throw new Error(
      `git push failed while preparing PR.\nstdout:\n${res.out || "(empty)"}\n\nstderr:\n${res.err || "(empty)"}`
    );
  }
}

async function createPullRequest({ title, body, head, base }) {
  if (!config.githubToken) {
    throw new Error("Set GITHUB_TOKEN in .env before using /pr.");
  }
  const slug = await getRepoSlug();
  const response = await fetch(`${GITHUB_API}/repos/${slug}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      "User-Agent": "codex-telegram-bridge",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ title, head, base, body }),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = data?.message || "Failed to create pull request.";
    throw new Error(message);
  }
  return data;
}

async function pollActionsRun(headSha) {
  if (!config.githubToken) return null;
  const slug = await getRepoSlug();
  for (let attempt = 0; attempt < ACTIONS_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetch(
      `${GITHUB_API}/repos/${slug}/actions/runs?per_page=10&branch=${config.targetBranch}`,
      {
        headers: {
          Authorization: `Bearer ${config.githubToken}`,
          "User-Agent": "codex-telegram-bridge",
          Accept: "application/vnd.github+json",
        },
      }
    );
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.message || "Failed to query workflow runs.");
    }
    const run = (data.workflow_runs || []).find((r) => r.head_sha === headSha);
    if (run) {
      if (run.status === "completed") {
        return run;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, ACTIONS_POLL_INTERVAL_MS));
  }
  return null;
}

async function monitorActionsAfterPush(chatId, headSha) {
  if (!config.githubToken) return;
  try {
    const run = await pollActionsRun(headSha);
    if (!run) {
      await bot.sendMessage(
        chatId,
        "⚠️ GitHub Actions update timed out or no run detected for this commit."
      );
      return;
    }
    const conclusion = run.conclusion || "unknown";
    const statusEmoji = conclusion === "success" ? "✅" : conclusion === "failure" ? "❌" : "⚠️";
    await bot.sendMessage(
      chatId,
      `${statusEmoji} GitHub Actions (${run.name || "workflow"}) ${conclusion}.\n${run.html_url || run.url}`
    );
  } catch (error) {
    console.error("Actions monitor failed:", error);
  }
}

async function getAheadCount() {
  const revSpec = `${config.targetRemote}/${config.targetBranch}..${config.targetBranch}`;
  const res = await runGit(["rev-list", "--count", revSpec]);
  if (res.code !== 0) return 0;
  const count = Number.parseInt(res.out.trim(), 10);
  return Number.isFinite(count) ? count : 0;
}

function buildStatusArgsExcludingInputs() {
  const relativeInputsPath = path
    .relative(config.targetRepoDir, config.inputsDir)
    .split(path.sep)
    .join("/");

  const args = ["status", "--porcelain", "--", "."];
  if (
    relativeInputsPath &&
    !relativeInputsPath.startsWith("..") &&
    !path.isAbsolute(relativeInputsPath)
  ) {
    args.push(`:(exclude)${relativeInputsPath}/**`);
  }
  return args;
}

async function hasRelevantWorkingTreeChanges() {
  const status = await runGit(buildStatusArgsExcludingInputs());
  if (status.code !== 0) return false;
  return Boolean((status.out || "").trim());
}

async function hasWorkNotOnRemote() {
  const ahead = await getAheadCount();
  if (ahead > 0) return true;
  return hasRelevantWorkingTreeChanges();
}

async function saveIncomingImage(msg) {
  let fileId = null;
  if (Array.isArray(msg.photo) && msg.photo.length) {
    fileId = msg.photo[msg.photo.length - 1].file_id;
  } else if (
    msg.document &&
    typeof msg.document.mime_type === "string" &&
    msg.document.mime_type.startsWith("image/")
  ) {
    fileId = msg.document.file_id;
  }

  if (!fileId) return null;
  return downloadToInputs(fileId);
}

async function downloadToInputs(fileId) {
  await ensureInputsDir();
  return bot.downloadFile(fileId, config.inputsDir);
}

async function transcribeMediaFile(localPath) {
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY not configured.");
  }
  const form = new FormData();
  form.append("file", createReadStream(localPath), path.basename(localPath));
  form.append("model", config.openaiTranscribeModel || "whisper-1");
  const response = await fetch(OPENAI_TRANSCRIBE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: form,
  });
  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || "Audio transcription failed.";
    throw new Error(message);
  }
  const text = String(data.text || "").trim();
  if (!text) {
    throw new Error("Transcription returned empty text.");
  }
  return text;
}

async function processAudioVideoAttachments(msg) {
  const targets = [];
  if (msg.voice?.file_id) targets.push({ type: "voice", fileId: msg.voice.file_id });
  if (msg.audio?.file_id) targets.push({ type: "audio", fileId: msg.audio.file_id });
  if (msg.video?.file_id) targets.push({ type: "video", fileId: msg.video.file_id });
  if (msg.video_note?.file_id) targets.push({ type: "video_note", fileId: msg.video_note.file_id });

  if (!targets.length) return { summary: "", warnings: [] };

  const transcripts = [];
  const warnings = [];
  for (const target of targets) {
    try {
      const localPath = await downloadToInputs(target.fileId);
      const text = await transcribeMediaFile(localPath);
      transcripts.push(`[${target.type}] ${text}`);
    } catch (error) {
      warnings.push(`[${target.type}] ${error.message || error}`);
    }
  }

  return {
    summary: transcripts.join("\n"),
    warnings,
  };
}

async function ensureStartupReady() {
  try {
    await access(config.primaryGitDir);
  } catch {
    throw new Error(
      `TARGET_REPO_DIR does not look like a git repo: ${config.targetRepoDir}`
    );
  }
  await loadSessions();
}

await loadRepoAliasStore();
await ensureStartupReady();

bot.on("message", async (msg) => {
  const fromId = msg.from?.id;
  const chatId = msg.chat.id;

  // Only allow DMs
  if (msg.chat.type !== "private") return;

  // Allowlist: only configured user
  if (fromId !== config.allowedUserId) return;

  const hasImage =
    (Array.isArray(msg.photo) && msg.photo.length > 0) ||
    (msg.document &&
      typeof msg.document.mime_type === "string" &&
      msg.document.mime_type.startsWith("image/"));
  const hasMedia =
    Boolean(msg.voice) ||
    Boolean(msg.audio) ||
    Boolean(msg.video) ||
    Boolean(msg.video_note);

  const text = (msg.text || msg.caption || "").trim();
  if (!text && !hasImage && !hasMedia) return;

  if (text === "/start") {
    await bot.sendMessage(
      chatId,
      "✅ Codex bridge online.\n\nCommands:\n/new or /clear - reset this chat's memory\n/state - show memory + pending push\n/push <description> - stage a push request\n/confirmpush - run staged push\n/cancelpush - cancel staged push\n\nYou can also send a screenshot (with optional caption), and I’ll pass it to Codex."
    );
    return;
  }

  if (text === "/new" || text === "/clear") {
    sessions[String(chatId)] = { history: [], pendingPush: null };
    await saveSessions();
    await bot.sendMessage(chatId, "Session memory cleared for this chat.");
    return;
  }

  if (text === "/state") {
    const session = getSession(chatId);
    const pending = session.pendingPush
      ? `yes (${session.pendingPush.createdAt})`
      : "no";
    await bot.sendMessage(
      chatId,
      `History entries: ${session.history.length}\nPending push: ${pending}`
    );
    return;
  }

  if (text.startsWith("/repo")) {
    await handleRepoCommand(chatId, text);
    return;
  }

  const isOneTapPush = isOneTapPushCommand(text);
  const isPushIntent = text === "/push" || text.startsWith("/push ");
  if (isPushIntent) {
    const description = text.replace(/^\/push\s*/, "").trim();
    if (!description) {
      await bot.sendMessage(chatId, "Use: /push <description>");
      return;
    }
    const session = getSession(chatId);
    session.pendingPush = {
      description,
      createdAt: new Date().toISOString(),
    };
    await saveSessions();
    if (isOneTapPush) {
      await bot.sendMessage(chatId, "Push staged. Confirm to run commit + push:", {
        reply_markup: {
          keyboard: [[{ text: "/confirmpush" }, { text: "/cancelpush" }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      });
      return;
    }

    await bot.sendMessage(
      chatId,
      `Push request staged:\n"${description}"\n\nSend /confirmpush to execute, or /cancelpush to cancel.`
    );
    return;
  }

  if (text === "/cancelpush") {
    const session = getSession(chatId);
    session.pendingPush = null;
    await saveSessions();
    await bot.sendMessage(chatId, "Pending push canceled.");
    return;
  }

  if (text.startsWith("/pr")) {
    const titleAndBody = text.replace(/^\/pr\s*/, "");
    const [titleRaw, bodyRaw = ""] = titleAndBody.split("|", 2).map((part) => part.trim());
    if (!titleRaw) {
      await bot.sendMessage(chatId, "Use: /pr <title> [| optional body]");
      return;
    }
    if (!config.githubToken) {
      await bot.sendMessage(
        chatId,
        "Set GITHUB_TOKEN in .env (GitHub PAT with repo scope) before using /pr."
      );
      return;
    }
    if (busy) {
      await bot.sendMessage(
        chatId,
        "⏳ I’m still working on the last request. Send again in a moment."
      );
      return;
    }
    busy = true;
    try {
      await bot.sendMessage(chatId, "📤 Creating pull request...");
      const branch = await getCurrentBranch();
      await ensureBranchPushed(branch);
      const headSha = await getHeadCommit();
      const diffPreview = await buildDiffPreview({ ref: headSha });
      const diffSection = diffPreview ? `\n\nDiff preview:\n${diffPreview}` : "";
      const body = bodyRaw || `Created via Codex Telegram Bridge.${diffSection}`;
      const pr = await createPullRequest({
        title: titleRaw,
        body,
        head: branch,
        base: config.targetBranch,
      });
      await bot.sendMessage(
        chatId,
        `✅ Pull request created.\nTitle: ${pr.title}\nURL: ${pr.html_url || pr.url}`
      );
    } catch (err) {
      const msg = String(err?.message || err);
      await bot.sendMessage(chatId, `❌ Failed to create PR:\n${msg}`);
    } finally {
      busy = false;
    }
    return;
  }

  const isConfirmPush = text === "/confirmpush";
  const session = getSession(chatId);
  const isPush = isConfirmPush && !!session.pendingPush;
  const userText = isPush
    ? session.pendingPush.description
    : isConfirmPush
      ? ""
      : text;

  if (isConfirmPush && !session.pendingPush) {
    await bot.sendMessage(chatId, "No pending push. Use /push <description> first.");
    return;
  }

  if (busy) {
    await bot.sendMessage(
      chatId,
      "⏳ I’m still working on the last request. Send again in a moment."
    );
    return;
  }

  await bot.sendMessage(chatId, hasImage ? "🖼️ Screenshot received. Running..." : "🧠 Running...");

  busy = true;
  try {
    let headBefore = "";
    if (isPush) {
      headBefore = await getHeadCommit();
      const codexAheadProbe = await runCommand("git", [
        "--git-dir",
        path.join(config.targetRepoDir, ".git-codex"),
        "--work-tree",
        config.targetRepoDir,
        "rev-list",
        "--count",
        `${config.targetRemote}/${config.targetBranch}..${config.targetBranch}`,
      ]);
      if (codexAheadProbe.code === 0) {
        const codexAhead = Number.parseInt((codexAheadProbe.out || "").trim(), 10);
        if (Number.isFinite(codexAhead) && codexAhead > 0) {
          throw new Error(
            "Detected commits ahead in .git-codex. Clean this up before using /confirmpush so only .git is the source of truth."
          );
        }
      }
    }

    const historyContext = buildHistoryContext(chatId);
    const policy = isPush
      ? `
You may:
- Modify files inside this repo.
- Stage changes.
- Create a commit with a clear commit message.

You MUST NOT:
- Run git push
- Clone the repo elsewhere
- Use .git-codex or any alternate git-dir/work-tree

After committing, summarize:
- Files changed
- Commit message
- Git commands used.
- Note that the Telegram bot handles the final push step.
`
      : `
You may:
- Modify files inside this repo.
- Run tests or read files.

You MUST NOT:
- Run git commit
- Run git push

After changes, summarize:
- Files modified
- Suggested commit message
- Next steps.
`;

    let imagePath = null;
    if (hasImage) {
      imagePath = await saveIncomingImage(msg);
    }
    const mediaInfo = await processAudioVideoAttachments(msg);
    if (mediaInfo.summary) {
      await bot.sendMessage(chatId, `🎙️ Transcription:\n${mediaInfo.summary}`);
    } else if (mediaInfo.warnings.length) {
      await bot.sendMessage(
        chatId,
        `⚠️ Could not transcribe audio/video:\n${mediaInfo.warnings.join("\n")}`
      );
    }
    const mediaContext = mediaInfo.summary
      ? mediaInfo.summary
      : mediaInfo.warnings.join("\n");
    const mediaPromptSection = mediaContext
      ? mediaContext
      : "No audio/video attachments.";

    const guardedPrompt = `
You are working ONLY inside:
${config.targetRepoDir}

${policy}

Response style requirements:
- Write for Telegram chat (not terminal).
- Use short sections and bullets where helpful.
- Do NOT wrap the full answer in triple-backtick code fences.
- Be concise and natural.

Screenshot input:
${imagePath ? `User attached a screenshot at: ${imagePath}` : "No screenshot attached."}

Audio/video transcription:
${mediaPromptSection}

Conversation context from this Telegram chat:
${historyContext}

User request:
${userText || "(no caption text provided; use the screenshot context)"}
`.trim();

    const historyUserText = [
      isPush ? `/confirmpush ${userText}` : userText || "(image-only message)",
      imagePath ? `[screenshot: ${imagePath}]` : "",
    ]
      .filter(Boolean)
      .join("\n");

    addHistory(chatId, "user", historyUserText);
    const codexSandbox = isPush ? config.pushSandbox : config.defaultSandbox;
    const resultRaw = await runCodex(guardedPrompt, codexSandbox);
    const result = isPush ? sanitizePushNarration(resultRaw) : resultRaw;
    addHistory(chatId, "assistant", result);

    let finalMessage = result;
    let diffPreview = "";
    if (isPush) {
      const headAfter = await getHeadCommit();
      const ahead = await getAheadCount();
      if (headAfter === headBefore && ahead === 0) {
        const status = await runGit(["status", "--porcelain"]);
        const statusSummary = (status.out || "").trim();
        finalMessage =
          result +
          "\n\nPush status:\n- Skipped: no new commit was created in .git.\n" +
          (statusSummary
            ? "- Working tree still has uncommitted changes."
            : "- Working tree is clean.");
      } else {
        const pushResult = await runGit([
          "push",
          config.targetRemote,
          config.targetBranch,
        ]);
        if (pushResult.code !== 0) {
          throw new Error(
            `Codex completed, but git push failed.\n\nstdout:\n${pushResult.out || "(empty)"}\n\nstderr:\n${pushResult.err || "(empty)"}`
          );
        }

        finalMessage =
          result +
          `\n\nPush status:\n- Ran: git -C ${config.targetRepoDir} push ${config.targetRemote} ${config.targetBranch}\n- Result: success`;
        diffPreview = await buildDiffPreview({ ref: headAfter });
        monitorActionsAfterPush(chatId, headAfter).catch((err) =>
          console.error("Failed to monitor Actions:", err)
        );
      }
    } else {
      diffPreview = await buildDiffPreview();
    }

    if (isPush) {
      session.pendingPush = null;
    }
    await saveSessions();

    let responseOptions = {};
    if (!isPush) {
      const hasWork = await hasWorkNotOnRemote();
      if (hasWork) {
        responseOptions = {
          reply_markup: {
            keyboard: [[{ text: "/push commit and push" }]],
            resize_keyboard: true,
            one_time_keyboard: false,
          },
        };
      }
    }

    if (diffPreview) {
      const label = isPush
        ? "Diff preview (latest commit):"
        : "Diff preview (working tree):";
      finalMessage += `\n\n${label}\n${diffPreview}`;
    }

    if (mediaPromptSection && mediaPromptSection !== "No audio/video attachments.") {
      finalMessage += `\n\nMedia transcription:\n${mediaPromptSection}`;
    }

    await sendLongMessage(chatId, finalMessage, responseOptions);
  } catch (e) {
    if (isConfirmPush) {
      session.pendingPush = null;
      await saveSessions();
    }
    const msgText = String(e?.message || e).slice(0, config.telegramMax);
    await bot.sendMessage(chatId, "❌ Error:\n" + msgText);
  } finally {
    busy = false;
  }
});
