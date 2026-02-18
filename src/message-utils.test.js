import test from "node:test";
import assert from "node:assert/strict";
import {
  chunkTextByParagraph,
  isOneTapPushCommand,
  sanitizePushNarration,
} from "./message-utils.js";

test("chunkTextByParagraph splits long text into bounded chunks", () => {
  const input = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda";
  const chunks = chunkTextByParagraph(input, 20);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 20));
});

test("sanitizePushNarration removes manual push instructions", () => {
  const input = `
Changes done.
I’m not allowed to run git push here.
please push main when you can
`;
  const output = sanitizePushNarration(input);
  assert.equal(output, "Changes done.");
});

test("isOneTapPushCommand matches only the one-tap command", () => {
  assert.equal(isOneTapPushCommand("/push commit and push"), true);
  assert.equal(isOneTapPushCommand("/push Commit And Push"), true);
  assert.equal(isOneTapPushCommand("/push tweak copy"), false);
});
