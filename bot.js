import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import { spawn } from "child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { loadConfig } from "./src/config.js";
import {
  chunkTextByParagraph,
  isOneTapPushCommand,
  sanitizePushNarration,
} from "./src/message-utils.js";

const config = loadConfig();

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

async function getHeadCommit() {
  const res = await runGit(["rev-parse", "HEAD"]);
  if (res.code !== 0) {
    throw new Error(`Unable to read git HEAD.\n${res.err || res.out || "(empty)"}`);
  }
  return res.out.trim();
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
  await ensureInputsDir();

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
  return bot.downloadFile(fileId, config.inputsDir);
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

  const text = (msg.text || msg.caption || "").trim();
  if (!text && !hasImage) return;

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
      }
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
