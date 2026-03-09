export const REMOVE_KEYBOARD = { reply_markup: { remove_keyboard: true } };

export function createConfirmPushReplyOptions() {
  return {
    reply_markup: {
      keyboard: [[{ text: "/confirmpush" }, { text: "/cancelpush" }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  };
}

export function createPushShortcutReplyOptions() {
  return {
    reply_markup: {
      keyboard: [[{ text: "/push commit and push" }]],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

export function stagePendingPush(session, description, createdAt) {
  session.pendingPush = { description, createdAt };
  return session;
}

export function clearPendingPush(session) {
  session.pendingPush = null;
  return session;
}

export function resolvePushRequest(text, pendingPush) {
  const isConfirmPush = text === "/confirmpush";
  const isPush = isConfirmPush && Boolean(pendingPush);
  const userText = isPush
    ? pendingPush.description
    : isConfirmPush
      ? ""
      : text;

  return {
    isConfirmPush,
    isPush,
    userText,
    missingPendingPush: isConfirmPush && !pendingPush,
  };
}

export function getPostRunReplyOptions({ isPush, hasWork }) {
  if (isPush) return REMOVE_KEYBOARD;
  return hasWork ? createPushShortcutReplyOptions() : REMOVE_KEYBOARD;
}
