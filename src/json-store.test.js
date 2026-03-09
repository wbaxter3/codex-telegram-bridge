import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { loadJsonObject, saveJsonObjectAtomic } from "./json-store.js";

test("saveJsonObjectAtomic writes valid JSON via temp file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ctb-json-store-"));
  const target = path.join(dir, "store.json");

  await saveJsonObjectAtomic(target, { ok: true });
  const raw = await readFile(target, "utf8");

  assert.deepEqual(JSON.parse(raw), { ok: true });
});

test("loadJsonObject falls back and reports corrupt files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ctb-json-store-"));
  const target = path.join(dir, "store.json");
  const seen = [];

  await writeFile(target, "{bad json", "utf8");
  const value = await loadJsonObject(target, { fallback: true }, {
    backupOnCorrupt: true,
    onCorrupt(backupPath, error) {
      seen.push({ backupPath, error: String(error) });
    },
  });

  assert.deepEqual(value, { fallback: true });
  assert.equal(seen.length, 1);
  assert.match(seen[0].backupPath, /\.corrupt-/);
});
