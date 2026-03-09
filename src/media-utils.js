export function hasIncomingMedia(msg) {
  return Boolean(msg?.voice || msg?.audio || msg?.video || msg?.video_note);
}

export function buildMediaPromptSection(mediaInfo) {
  const mediaContext = mediaInfo.summary
    ? mediaInfo.summary
    : mediaInfo.warnings.join("\n");

  return mediaContext || "No audio/video attachments.";
}

export function buildMediaReply(mediaInfo) {
  if (mediaInfo.summary) {
    return `🎙️ Transcription:\n${mediaInfo.summary}`;
  }
  if (mediaInfo.warnings.length) {
    return `⚠️ Could not transcribe audio/video:\n${mediaInfo.warnings.join("\n")}`;
  }
  return null;
}
