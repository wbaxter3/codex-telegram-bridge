function tokenize(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .match(/[a-z0-9]+/g)?.filter((token) => token.length >= 3) || []
  );
}

function compareByRecency(a, b) {
  return String(b.updatedAt || b.createdAt || "").localeCompare(
    String(a.updatedAt || a.createdAt || "")
  );
}

export function normalizeMemoryText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function createEmptyMemoryStore() {
  return { repos: {} };
}

export function getRepoMemories(store, repoDir) {
  const entries = store?.repos?.[repoDir];
  return Array.isArray(entries) ? entries : [];
}

export function rememberRepoFact(store, repoDir, text, now = new Date().toISOString(), meta = {}) {
  const normalized = normalizeMemoryText(text);
  if (!normalized) {
    throw new Error("Memory text cannot be empty.");
  }

  const nextStore = store || createEmptyMemoryStore();
  nextStore.repos ||= {};
  const entries = getRepoMemories(nextStore, repoDir).slice();
  const existing = entries.findIndex(
    (entry) => normalizeMemoryText(entry.text) === normalized
  );

  if (existing >= 0) {
    const current = entries[existing];
    entries[existing] = {
      ...current,
      ...meta,
      text: normalized,
      updatedAt: now,
    };
    nextStore.repos[repoDir] = entries.sort(compareByRecency);
    return { store: nextStore, entry: entries[existing], created: false };
  }

  const entry = {
    id: `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    text: normalized,
    createdAt: now,
    updatedAt: now,
    source: meta.source || "manual",
    ...meta,
  };
  entries.push(entry);
  nextStore.repos[repoDir] = entries.sort(compareByRecency);
  return { store: nextStore, entry, created: true };
}

export function forgetRepoFact(store, repoDir, selector) {
  const needle = normalizeMemoryText(selector).toLowerCase();
  const entries = getRepoMemories(store, repoDir);
  if (!needle || !entries.length) return { store, removed: null };

  const exactId = entries.find((entry) => entry.id.toLowerCase() === needle);
  const removed = exactId
    || entries.find((entry) => normalizeMemoryText(entry.text).toLowerCase() === needle)
    || entries.find((entry) => normalizeMemoryText(entry.text).toLowerCase().includes(needle));

  if (!removed) return { store, removed: null };

  const nextStore = store || createEmptyMemoryStore();
  nextStore.repos ||= {};
  nextStore.repos[repoDir] = entries.filter((entry) => entry.id !== removed.id);
  if (!nextStore.repos[repoDir].length) {
    delete nextStore.repos[repoDir];
  }
  return { store: nextStore, removed };
}

export function formatRepoMemories(entries) {
  if (!entries.length) return "No saved repo memories.";
  return entries
    .map((entry, index) => {
      const source = entry.source && entry.source !== "manual" ? ` [${entry.source}]` : "";
      return `${index + 1}. ${entry.id}${source} - ${entry.text}`;
    })
    .join("\n");
}

export function buildMemoryPromptSection(entries, queryText, options = {}) {
  const repoEntries = Array.isArray(entries) ? entries : [];
  if (!repoEntries.length) return "No saved long-term memory.";

  const combinedText = `${queryText || ""}\n${options.historyText || ""}`;
  const queryTokens = tokenize(combinedText);

  const scored = repoEntries.map((entry) => {
    const entryTokens = tokenize(entry.text);
    let score = 0;
    for (const token of entryTokens) {
      if (queryTokens.has(token)) score += 1;
    }
    if (entry.source === "manual") score += 0.25;
    return { entry, score };
  });

  const ranked = scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return compareByRecency(left.entry, right.entry);
  });

  const topRelevant = ranked.filter((item) => item.score > 0).slice(0, options.limit || 5);
  const selected = topRelevant.length
    ? topRelevant.map((item) => item.entry)
    : repoEntries.slice().sort(compareByRecency).slice(0, options.fallbackLimit || 3);

  return selected
    .map((entry, index) => `- [${index + 1}] ${entry.text}`)
    .join("\n");
}
