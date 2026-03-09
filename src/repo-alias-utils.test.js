import test from "node:test";
import assert from "node:assert/strict";
import {
  RESERVED_ALIASES,
  getAliasListMessage,
  normalizeAliasName,
} from "./repo-alias-utils.js";

test("normalizeAliasName trims and lowercases", () => {
  assert.equal(normalizeAliasName("  Work  "), "work");
});

test("reserved aliases include default", () => {
  assert.equal(RESERVED_ALIASES.has("default"), true);
});

test("getAliasListMessage marks active repo", () => {
  const output = getAliasListMessage(
    { dir: "/repo/default", branch: "main", remote: "origin" },
    {
      app: { dir: "/repo/app", branch: "develop", remote: "upstream" },
    },
    "app"
  );

  assert.match(output, /IDLE default -> \/repo\/default/);
  assert.match(output, /ACTIVE app -> \/repo\/app/);
});
