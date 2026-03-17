import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMemoryPromptSection,
  createEmptyMemoryStore,
  forgetRepoFact,
  formatRepoMemories,
  getRepoMemories,
  normalizeMemoryText,
  rememberRepoFact,
} from "./repo-memory.js";

test("rememberRepoFact stores repo-scoped memories", () => {
  let store = createEmptyMemoryStore();
  ({ store } = rememberRepoFact(store, "/repo/a", "Use npm test before pushing.", "2026-03-17T12:00:00Z"));
  ({ store } = rememberRepoFact(store, "/repo/b", "Use pnpm in this repo.", "2026-03-17T12:01:00Z"));

  assert.equal(getRepoMemories(store, "/repo/a").length, 1);
  assert.equal(getRepoMemories(store, "/repo/b").length, 1);
  assert.equal(getRepoMemories(store, "/repo/a")[0].text, "Use npm test before pushing.");
});

test("rememberRepoFact deduplicates identical facts", () => {
  let store = createEmptyMemoryStore();
  let result = rememberRepoFact(store, "/repo/a", "Keep commits small.", "2026-03-17T12:00:00Z");
  store = result.store;
  result = rememberRepoFact(store, "/repo/a", "Keep commits small.", "2026-03-17T12:05:00Z");
  store = result.store;

  assert.equal(result.created, false);
  assert.equal(getRepoMemories(store, "/repo/a").length, 1);
  assert.equal(getRepoMemories(store, "/repo/a")[0].updatedAt, "2026-03-17T12:05:00Z");
});

test("forgetRepoFact removes by id or matching text", () => {
  let store = createEmptyMemoryStore();
  let result = rememberRepoFact(store, "/repo/a", "Use Expo Go for smoke tests.", "2026-03-17T12:00:00Z");
  store = result.store;
  const entry = result.entry;

  result = forgetRepoFact(store, "/repo/a", entry.id);
  assert.equal(result.removed.id, entry.id);
  assert.equal(getRepoMemories(result.store, "/repo/a").length, 0);
});

test("buildMemoryPromptSection prefers relevant manual entries", () => {
  let store = createEmptyMemoryStore();
  ({ store } = rememberRepoFact(
    store,
    "/repo/a",
    "Prefer npm test before every push.",
    "2026-03-17T12:00:00Z",
    { source: "manual" }
  ));
  ({ store } = rememberRepoFact(
    store,
    "/repo/a",
    "Recent shipped change: fixed login spinner.",
    "2026-03-17T12:01:00Z",
    { source: "auto" }
  ));

  const promptSection = buildMemoryPromptSection(
    getRepoMemories(store, "/repo/a"),
    "Can you update login and run tests?",
    { historyText: "Earlier we discussed the spinner." }
  );

  assert.match(promptSection, /Prefer npm test before every push/);
  assert.match(promptSection, /Recent shipped change: fixed login spinner/);
});

test("formatRepoMemories and normalizeMemoryText behave predictably", () => {
  assert.equal(normalizeMemoryText("  keep   lint green \n "), "keep lint green");

  let store = createEmptyMemoryStore();
  ({ store } = rememberRepoFact(store, "/repo/a", "Keep lint green.", "2026-03-17T12:00:00Z"));
  const formatted = formatRepoMemories(getRepoMemories(store, "/repo/a"));
  assert.match(formatted, /^1\. mem_/);
  assert.match(formatted, /Keep lint green\./);
});
