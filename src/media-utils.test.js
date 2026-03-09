import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMediaPromptSection,
  buildMediaReply,
  hasIncomingMedia,
} from "./media-utils.js";

test("hasIncomingMedia detects audio-only messages", () => {
  assert.equal(hasIncomingMedia({ voice: { file_id: "abc" } }), true);
  assert.equal(hasIncomingMedia({}), false);
});

test("buildMediaReply prefers transcript over warnings", () => {
  assert.equal(
    buildMediaReply({ summary: "[voice] hello", warnings: ["bad"] }),
    "🎙️ Transcription:\n[voice] hello"
  );
});

test("buildMediaReply returns warning message when transcription fails", () => {
  assert.equal(
    buildMediaReply({ summary: "", warnings: ["[voice] failed"] }),
    "⚠️ Could not transcribe audio/video:\n[voice] failed"
  );
});

test("buildMediaPromptSection returns explicit default", () => {
  assert.equal(
    buildMediaPromptSection({ summary: "", warnings: [] }),
    "No audio/video attachments."
  );
  assert.equal(
    buildMediaPromptSection({ summary: "[voice] hello", warnings: [] }),
    "[voice] hello"
  );
});
