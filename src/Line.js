/**
 * LINE Messaging API 包裝。
 * 計費重點：reply 免費；push 算每月額度（台灣輕用量 200 則），只有每日早報用 push。
 */
const LINE_API = 'https://api.line.me/v2/bot';
const LINE_DATA_API = 'https://api-data.line.me/v2/bot';

function lineFetch_(url, method, payload) {
  const opts = {
    method: method,
    headers: { Authorization: 'Bearer ' + cfg('LINE_CHANNEL_ACCESS_TOKEN') },
    muteHttpExceptions: true,
  };
  if (payload) {
    opts.contentType = 'application/json';
    opts.payload = JSON.stringify(payload);
  }
  const res = UrlFetchApp.fetch(url, opts);
  const code = res.getResponseCode();
  if (code >= 300) {
    // 不印 token，只印狀態碼與回應內容
    console.error('LINE API ' + method + ' ' + url + ' → ' + code + ' ' + res.getContentText());
  }
  return res;
}

function lineReply(replyToken, messages) {
  return lineFetch_(LINE_API + '/message/reply', 'post', {
    replyToken: replyToken,
    messages: [].concat(messages).slice(0, 5),
  });
}

function linePush(to, messages) {
  return lineFetch_(LINE_API + '/message/push', 'post', {
    to: to,
    messages: [].concat(messages).slice(0, 5),
  });
}

/** 「對方正在輸入…」動畫，免費，讓 Gemini 慢的時候不會像當機 */
function lineLoading(userId, seconds) {
  return lineFetch_(LINE_API + '/chat/loading/start', 'post', {
    chatId: userId,
    loadingSeconds: seconds || 20,
  });
}

/** 取得使用者傳來的圖片或檔案內容（Blob） */
function lineGetBlob(messageId) {
  return lineFetch_(LINE_DATA_API + '/message/' + messageId + '/content', 'get').getBlob();
}

/** 取得使用者傳來的圖片，回傳 { mimeType, base64 } */
function lineGetImage(messageId) {
  const blob = lineGetBlob(messageId);
  return {
    mimeType: blob.getContentType() || 'image/jpeg',
    base64: Utilities.base64Encode(blob.getBytes()),
  };
}

/** 本月推播用量與上限；查不到回 null（當作未知） */
function lineQuota() {
  try {
    const used = JSON.parse(lineFetch_(LINE_API + '/message/quota/consumption', 'get').getContentText());
    const quota = JSON.parse(lineFetch_(LINE_API + '/message/quota', 'get').getContentText());
    return { used: used.totalUsage, limit: quota.type === 'limited' ? quota.value : null };
  } catch (err) {
    console.error('查詢推播額度失敗：' + err);
    return null;
  }
}

function textMsg(text) {
  return { type: 'text', text: String(text).slice(0, 5000) };
}
