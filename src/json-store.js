import { copyFile, mkdir, readFile, rename, writeFile } from "fs/promises";
import path from "path";

export async function loadJsonObject(filePath, fallbackValue, options = {}) {
  const { backupOnCorrupt = false, onCorrupt = () => {} } = options;

  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON store root must be an object.");
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallbackValue;
    }

    if (backupOnCorrupt) {
      try {
        await mkdir(path.dirname(filePath), { recursive: true });
        const backupPath = `${filePath}.corrupt-${Date.now()}.json`;
        await copyFile(filePath, backupPath);
        onCorrupt(backupPath, error);
      } catch (backupError) {
        onCorrupt(null, backupError);
      }
    } else {
      onCorrupt(null, error);
    }

    return fallbackValue;
  }
}

export async function saveJsonObjectAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dir, { recursive: true });
  await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await rename(tempPath, filePath);
}
