export const RESERVED_ALIASES = new Set(["default"]);

export function normalizeAliasName(name) {
  return String(name || "").trim().toLowerCase();
}

export function formatAliasLine(name, def, isActive) {
  return `${isActive ? "ACTIVE" : "IDLE"} ${name} -> ${def.dir} [branch: ${def.branch || "main"}, remote: ${def.remote || "origin"}]`;
}

export function getAliasListMessage(defaultRepoDef, aliases, activeAlias) {
  const active = activeAlias || "default";
  const lines = [formatAliasLine("default", defaultRepoDef, active === "default")];

  Object.entries(aliases).forEach(([name, def]) => {
    lines.push(formatAliasLine(name, def, active === name));
  });

  return lines.join("\n");
}
