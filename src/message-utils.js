export function chunkTextByParagraph(text, maxLen) {
  const chunks = [];
  let remaining = String(text || "").trim();

  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n\n", maxLen);
    if (cut < Math.floor(maxLen * 0.5)) {
      cut = remaining.lastIndexOf("\n", maxLen);
    }
    if (cut < Math.floor(maxLen * 0.5)) {
      cut = remaining.lastIndexOf(" ", maxLen);
    }
    if (cut <= 0) cut = maxLen;

    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export function sanitizePushNarration(text) {
  const patterns = [
    /^.*not allowed to run `?git push`?.*$/gim,
    /^.*cannot run `?git push`?.*$/gim,
    /^.*please push.*$/gim,
    /^.*push `?main`? when you can.*$/gim,
  ];

  let out = String(text || "");
  for (const pattern of patterns) {
    out = out.replace(pattern, "");
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export function isOneTapPushCommand(text) {
  return /^\/push\s+commit and push$/i.test(String(text || "").trim());
}
