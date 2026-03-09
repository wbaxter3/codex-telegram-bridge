import test from "node:test";
import assert from "node:assert/strict";
import {
  REMOVE_KEYBOARD,
  clearPendingPush,
  createConfirmPushReplyOptions,
  getPostRunReplyOptions,
  resolvePushRequest,
  stagePendingPush,
} from "./push-flow.js";

test("stagePendingPush and clearPendingPush manage pending state", () => {
  const session = { history: [], pendingPush: null };
  stagePendingPush(session, "ship it", "2026-03-09T00:00:00.000Z");
  assert.deepEqual(session.pendingPush, {
    description: "ship it",
    createdAt: "2026-03-09T00:00:00.000Z",
  });

  clearPendingPush(session);
  assert.equal(session.pendingPush, null);
});

test("resolvePushRequest handles no-op confirm push", () => {
  assert.deepEqual(resolvePushRequest("/confirmpush", null), {
    isConfirmPush: true,
    isPush: false,
    userText: "",
    missingPendingPush: true,
  });
});

test("resolvePushRequest uses pending description for confirmed push", () => {
  assert.deepEqual(
    resolvePushRequest("/confirmpush", { description: "deploy", createdAt: "now" }),
    {
      isConfirmPush: true,
      isPush: true,
      userText: "deploy",
      missingPendingPush: false,
    }
  );
});

test("getPostRunReplyOptions shows or removes keyboard deterministically", () => {
  assert.deepEqual(getPostRunReplyOptions({ isPush: true, hasWork: false }), REMOVE_KEYBOARD);
  assert.deepEqual(getPostRunReplyOptions({ isPush: false, hasWork: false }), REMOVE_KEYBOARD);
  assert.deepEqual(getPostRunReplyOptions({ isPush: false, hasWork: true }), {
    reply_markup: {
      keyboard: [[{ text: "/push commit and push" }]],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  });
});

test("createConfirmPushReplyOptions builds confirm keyboard", () => {
  assert.deepEqual(createConfirmPushReplyOptions(), {
    reply_markup: {
      keyboard: [[{ text: "/confirmpush" }, { text: "/cancelpush" }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
});
