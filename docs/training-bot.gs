// ===== Config.js =====
/**
 * 設定都放「指令碼屬性」（專案設定 → 指令碼屬性），程式碼裡不寫任何金鑰。
 *
 * 必填：
 *   LINE_CHANNEL_ACCESS_TOKEN  LINE Messaging API 的 long-lived token
 *   GEMINI_API_KEY             Google AI Studio 的 API key
 *   ALLOWED_USER_IDS           允許使用的 LINE userId，多個用逗號分隔（留空＝設定模式，bot 會回你的 userId）
 *
 * 選填（沒設就用 DEFAULTS）：
 *   GEMINI_MODEL               Gemini 模型代碼
 *   DIGEST_HOUR / DIGEST_MINUTE 每日早報時間（改完要重跑 setupTrigger）
 *   DEFAULT_DURATION_MIN       沒寫結束時間時預設的長度（分鐘）
 *   REMINDER_MIN               日曆跳通知提前幾分鐘
 *   DEADLINE_LOOKAHEAD_DAYS    早報提醒幾天內截止的報名
 *   PUSH_QUOTA_GUARD           當月推播用量超過這個數字就改寄 Email *   NOTIFY_EMAIL               備援 Email（預設部署者本人）
 *
 * setup() 自動寫入：
 *   CALENDAR_ID                「研習」日曆
 *   SHEET_ID                   研習紀錄試算表
 *   HANDOUT_FOLDER_ID          雲端硬碟「研習講義」資料夾
 */
const DEFAULTS = {
  GEMINI_MODEL: 'gemini-3.5-flash-lite',
  DIGEST_HOUR: '7',
  DIGEST_MINUTE: '30',
  DEFAULT_DURATION_MIN: '120',
  REMINDER_MIN: '30',
  DEADLINE_LOOKAHEAD_DAYS: '3',
  PUSH_QUOTA_GUARD: '150',
  NOTIFY_EMAIL: '',
};

const TZ = 'Asia/Taipei';
const CALENDAR_NAME = '研習';
const SHEET_NAME = '研習紀錄';

function cfg(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (v !== null && v !== '') return v;
  if (key in DEFAULTS) return DEFAULTS[key];
  return '';
}

function cfgNum(key) {
  return Number(cfg(key));
}

function setCfg(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value));
}

function allowedUserIds() {
  return cfg('ALLOWED_USER_IDS').split(',').map((s) => s.trim()).filter(Boolean);
}

// ===== Line.js =====
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

// ===== Gemini.js =====
/**
 * 用 Gemini 把研習公告抽成固定格式。
 * 原則：抽不到就填 null，不准猜（日期猜錯比沒填更糟）。
 */
const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    is_training: { type: 'boolean', description: '內容是否為研習／講座／工作坊／課程公告' },
    title: { type: 'string', nullable: true },
    organizer: { type: 'string', nullable: true, description: '主辦單位或講師' },
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', nullable: true, description: '該場次子標題；與總標題相同則 null' },
          date: { type: 'string', description: 'YYYY-MM-DD，西元年' },
          start: { type: 'string', nullable: true, description: 'HH:mm 24 小時制' },
          end: { type: 'string', nullable: true, description: 'HH:mm；原文沒寫就 null' },
        },
        required: ['date', 'start', 'end'],
      },
    },
    mode: { type: 'string', enum: ['onsite', 'online', 'hybrid', 'unknown'] },
    location: { type: 'string', nullable: true, description: '實體地點含教室' },
    online_url: { type: 'string', nullable: true, description: '會議或直播網址，原文要有才填' },
    register_url: { type: 'string', nullable: true, description: '原文明確標示為報名的網址' },
    register_deadline: { type: 'string', nullable: true, description: 'YYYY-MM-DD' },
    hours: { type: 'number', nullable: true, description: '研習時數' },
    source: { type: 'string', nullable: true, description: '公文字號、貼文網址或信件主旨' },
    notes: { type: 'string', nullable: true, description: '需要使用者注意的事，例如「直播連結在留言區」' },
    confidence: { type: 'number', description: '0~1，對日期時間抽取的信心' },
  },
  required: ['is_training', 'title', 'sessions', 'mode', 'confidence'],
};

function buildPrompt_() {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd (EEE)');
  return [
    '你是研習資訊抽取器。從使用者提供的文字或圖片抽出研習資訊，輸出 JSON。',
    '今天是 ' + today + '（台北時間），用來推算沒寫年份的日期；民國年加 1911 換成西元年。',
    '規則：',
    '1. 原文沒寫的欄位一律 null，禁止推測或補完，尤其是結束時間與網址。',
    '2. 多天或多場次，每場各一筆 sessions。',
    '3. 有實體地點又有線上連結 → hybrid；只有直播／視訊 → online。',
    '4. 網址只能照抄原文出現的，不可編造。',
    '   register_url 只在原文明確寫「報名」且附該網址時才填；貼文本身的網址放 source，不是報名網址。',
    '5. 需要使用者自己處理的事（連結另外公布、需先報名等）寫進 notes，用繁體中文。',
    '6. 不是研習相關內容 → is_training=false，其他欄位可為 null。',
  ].join('\n');
}

/**
 * @param {{text?: string, image?: {mimeType: string, base64: string}}} input
 * @return {Object} 抽取結果
 */
function geminiExtract(input) {
  const parts = [{ text: buildPrompt_() }];
  if (input.text) parts.push({ text: '---- 研習公告 ----\n' + input.text });
  if (input.image) parts.push({ inline_data: { mime_type: input.image.mimeType, data: input.image.base64 } });

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(cfg('GEMINI_MODEL')) + ':generateContent';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': cfg('GEMINI_API_KEY') },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      contents: [{ role: 'user', parts: parts }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: EXTRACT_SCHEMA,
      },
    }),
  });

  const code = res.getResponseCode();
  if (code !== 200) {
    throw new Error('Gemini ' + code + '：' + res.getContentText().slice(0, 300));
  }
  const body = JSON.parse(res.getContentText());
  const text = body.candidates && body.candidates[0] && body.candidates[0].content &&
    body.candidates[0].content.parts.map((p) => p.text || '').join('');
  if (!text) throw new Error('Gemini 沒有回傳內容：' + JSON.stringify(body).slice(0, 300));
  return JSON.parse(text);
}

// ===== Store.js =====
/**
 * 試算表當資料表，日曆當顯示與提醒。
 * 一列＝一則研習公告；status: pending（等確認）／confirmed／discarded
 */
const COLS = [
  'id', 'created_at', 'status', 'title', 'organizer', 'mode', 'location', 'online_url',
  'register_url', 'register_deadline', 'hours', 'source', 'notes', 'confidence',
  'sessions_json', 'event_ids', 'user_id', 'handout_folder',
];

function sheet_() {
  return SpreadsheetApp.openById(cfg('SHEET_ID')).getSheetByName(SHEET_NAME);
}

function calendar_() {
  return CalendarApp.getCalendarById(cfg('CALENDAR_ID'));
}

function saveDraft(data, userId) {
  // 加字母前綴，避免純數字或 1e234567 被試算表轉成數字
  const id = 't' + Utilities.getUuid().slice(0, 8);
  const row = {
    id: id,
    created_at: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'),
    status: 'pending',
    title: data.title,
    organizer: data.organizer,
    mode: data.mode,
    location: data.location,
    online_url: data.online_url,
    register_url: data.register_url,
    register_deadline: data.register_deadline,
    hours: data.hours,
    source: data.source,
    notes: data.notes,
    confidence: data.confidence,
    sessions_json: JSON.stringify(data.sessions || []),
    event_ids: '',
    user_id: userId,
  };
  sheet_().appendRow(COLS.map((c) => (row[c] === null || row[c] === undefined ? '' : row[c])));
  return id;
}

/** 找某一列，回傳 { rowIndex, record } 或 null */
function findRecord(id) {
  const values = sheet_().getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === id) {
      const rec = {};
      COLS.forEach((c, j) => { rec[c] = values[i][j] === '' ? null : values[i][j]; });
      rec.sessions = JSON.parse(rec.sessions_json || '[]');
      return { rowIndex: i + 1, record: rec };
    }
  }
  return null;
}

function updateRecord(rowIndex, fields) {
  const sh = sheet_();
  Object.keys(fields).forEach((k) => {
    sh.getRange(rowIndex, COLS.indexOf(k) + 1).setValue(fields[k]);
  });
}

function confirmedRecords() {
  const values = sheet_().getDataRange().getValues();
  return values.slice(1)
    .filter((r) => r[COLS.indexOf('status')] === 'confirmed')
    .map((r) => {
      const rec = {};
      COLS.forEach((c, j) => { rec[c] = r[j] === '' ? null : r[j]; });
      rec.sessions = JSON.parse(rec.sessions_json || '[]');
      return rec;
    });
}

// ---------- 日曆 ----------

const MODE_ICON = { onsite: '🏫', online: '💻', hybrid: '🔀', unknown: '📌' };

function toDate_(date, time) {
  // date：YYYY-MM-DD；time：HH:mm；Sheet 可能把日期讀成 Date 物件
  const d = date instanceof Date ? Utilities.formatDate(date, TZ, 'yyyy-MM-dd') : String(date);
  return new Date(d + 'T' + (time || '00:00') + ':00+08:00');
}

function eventDescription_(rec, endGuessed) {
  const lines = [];
  if (rec.online_url) lines.push('🔗 線上：' + rec.online_url);
  if (rec.location) lines.push('📍 地點：' + rec.location);
  if (rec.register_url) lines.push('📝 報名：' + rec.register_url);
  if (rec.register_deadline) lines.push('⏰ 報名截止：' + fmtDate_(rec.register_deadline));
  if (rec.hours) lines.push('🕒 時數：' + rec.hours);
  if (rec.organizer) lines.push('👤 主辦／講師：' + rec.organizer);
  if (rec.notes) lines.push('⚠️ ' + rec.notes);
  if (endGuessed) lines.push('（結束時間未公告，先抓 ' + cfg('DEFAULT_DURATION_MIN') + ' 分鐘）');
  if (rec.source) lines.push('📄 來源：' + rec.source);
  lines.push('#training-bot ' + rec.id);
  return lines.join('\n');
}

function fmtDate_(v) {
  return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v);
}

/** 把一筆研習寫進日曆，回傳建立的 event id 陣列 */
function writeToCalendar(rec) {
  const cal = calendar_();
  const ids = [];
  const icon = MODE_ICON[rec.mode] || MODE_ICON.unknown;
  // 地點欄：實體放地址（手機點了開地圖），線上放連結（點了進會議）
  const location = rec.mode === 'online' ? (rec.online_url || rec.source || '') : (rec.location || rec.online_url || '');

  rec.sessions.forEach((s) => {
    if (!s.start) {
      const ev = cal.createAllDayEvent(icon + ' ' + (s.title || rec.title), toDate_(s.date), {
        location: location, description: eventDescription_(rec, false),
      });
      ids.push(ev.getId());
      return;
    }
    const start = toDate_(s.date, s.start);
    const endGuessed = !s.end;
    const end = s.end ? toDate_(s.date, s.end) : new Date(start.getTime() + cfgNum('DEFAULT_DURATION_MIN') * 60000);
    const ev = cal.createEvent(icon + ' ' + (s.title || rec.title), start, end, {
      location: location, description: eventDescription_(rec, endGuessed),
    });
    ev.removeAllReminders();
    ev.addPopupReminder(cfgNum('REMINDER_MIN'));
    ids.push(ev.getId());
  });

  if (rec.register_deadline) {
    const ev = cal.createAllDayEvent('⏰ 報名截止：' + rec.title, toDate_(rec.register_deadline), {
      description: eventDescription_(rec, false),
    });
    ids.push(ev.getId());
  }
  return ids;
}

// ===== Handout.js =====
/**
 * 研習講義：LINE 傳檔案或連結 → 先放「_待整理」→ 點選是哪一場研習 → 搬進該場資料夾。
 *
 * 雲端硬碟結構：研習講義/<學年>/<YYYY-MM-DD>_<研習名稱>/
 * 連結存成 .url 捷徑；Google 文件／簡報／試算表、雲端硬碟檔案、直接的 PDF 連結會另存一份備份
 * （講師的分享常在研習後關閉）。
 */
const HANDOUT_ROOT_NAME = '研習講義';
const HANDOUT_INBOX_NAME = '_待整理';

function handoutRoot_() {
  return DriveApp.getFolderById(cfg('HANDOUT_FOLDER_ID'));
}

function handoutInbox_() {
  return subfolder_(handoutRoot_(), HANDOUT_INBOX_NAME);
}

function subfolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function safeName_(s) {
  return String(s || '未命名').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 80);
}

/** 研習的資料夾：沒有就建，並把資料夾網址寫回試算表與日曆 */
function handoutFolderFor_(found) {
  const rec = found.record;
  if (rec.handout_folder) {
    try { return DriveApp.getFolderById(rec.handout_folder); } catch (err) { /* 被刪了就重建 */ }
  }
  const first = toDate_(rec.sessions[0].date);
  const y = Number(Utilities.formatDate(first, TZ, 'yyyy'));
  const m = Number(Utilities.formatDate(first, TZ, 'M'));
  const schoolYear = (m >= 8 ? y : y - 1) - 1911;
  const yearFolder = subfolder_(handoutRoot_(), schoolYear + ' 學年');
  const folder = subfolder_(yearFolder, Utilities.formatDate(first, TZ, 'yyyy-MM-dd') + '_' + safeName_(rec.title));

  updateRecord(found.rowIndex, { handout_folder: folder.getId() });
  appendToEvents_(rec, '📂 講義：' + folder.getUrl());
  return folder;
}

function appendToEvents_(rec, line) {
  String(rec.event_ids || '').split(',').filter(Boolean).forEach((id) => {
    const ev = calendar_().getEventById(id);
    if (!ev || ev.getDescription().indexOf(line) !== -1) return;
    const desc = ev.getDescription();
    const tag = '\n#training-bot';
    const i = desc.indexOf(tag);
    ev.setDescription(i === -1 ? desc + '\n' + line : desc.slice(0, i) + '\n' + line + desc.slice(i));
  });
}

// ---------- 收件 ----------

/** LINE 傳來的檔案（PDF／PPT／Word…）→ 放進待整理，問是哪一場 */
function handleHandoutFile_(ev, msg) {
  const blob = lineGetBlob(msg.id).setName(safeName_(msg.fileName || '講義'));
  const file = handoutInbox_().createFile(blob);
  lineReply(ev.replyToken, pickTrainingMsg_('📎 收到講義「' + file.getName() + '」\n是哪一場研習的？', file.getId(), false));
}

/** 整則訊息只有網址：先存成捷徑，問是講義還是公告 */
function handleHandoutLink_(ev, url) {
  const file = handoutInbox_().createFile(urlShortcut_(url));
  lineReply(ev.replyToken, pickTrainingMsg_('🔗 收到連結。\n如果是講義，選是哪一場研習；如果是研習公告，按「📋 這是公告」。', file.getId(), true));
}

function isOnlyUrl_(text) {
  return /^https?:\/\/\S+$/.test(String(text).trim());
}

function urlShortcut_(url) {
  let name = url.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  return Utilities.newBlob('[InternetShortcut]\r\nURL=' + url + '\r\n', 'text/plain', safeName_(name) + '.url');
}

function urlFromShortcut_(file) {
  const m = file.getBlob().getDataAsString().match(/URL=(\S+)/);
  return m ? m[1] : null;
}

/** 近 30 天到未來 7 天已入曆的研習，最近的排前面 */
function recentTrainings_() {
  const now = Date.now();
  const from = now - 30 * 86400000;
  const to = now + 7 * 86400000;
  return confirmedRecords()
    .map((r) => ({ r: r, t: toDate_(r.sessions[0].date).getTime() }))
    .filter((x) => x.t >= from && x.t <= to)
    .sort((a, b) => Math.abs(a.t - now) - Math.abs(b.t - now))
    .map((x) => x.r);
}

function pickTrainingMsg_(text, fileId, isLink) {
  const items = recentTrainings_().slice(0, isLink ? 11 : 12).map((r) => ({
    type: 'action',
    action: {
      type: 'postback',
      label: (Utilities.formatDate(toDate_(r.sessions[0].date), TZ, 'M/d') + ' ' + r.title).slice(0, 20),
      data: 'action=handout&f=' + fileId + '&id=' + r.id,
      displayText: '講義 → ' + String(r.title).slice(0, 40),
    },
  }));
  if (isLink) {
    items.push({ type: 'action', action: {
      type: 'postback', label: '📋 這是公告', data: 'action=handout_announce&f=' + fileId, displayText: '這是研習公告',
    } });
  }
  items.push({ type: 'action', action: {
    type: 'postback', label: '🗂️ 先放待整理', data: 'action=handout_later&f=' + fileId, displayText: '先放待整理',
  } });
  const hint = items.length <= (isLink ? 2 : 1) ? '\n（近 30 天沒有入曆的研習，可以先放待整理）' : '';
  return { type: 'text', text: text + hint, quickReply: { items: items } };
}

// ---------- 點選後 ----------

function handleHandoutPostback_(ev, userId, p) {
  let file;
  try {
    file = DriveApp.getFileById(p.f);
  } catch (err) {
    return lineReply(ev.replyToken, textMsg('找不到這個檔案（可能已經整理過或刪掉了）。'));
  }

  if (p.action === 'handout_later') {
    return lineReply(ev.replyToken, textMsg('🗂️ 先放在「' + HANDOUT_ROOT_NAME + '/' + HANDOUT_INBOX_NAME + '」，之後再整理。'));
  }
  if (p.action === 'handout_announce') {
    const url = urlFromShortcut_(file);
    file.setTrashed(true);
    return handleAnnouncement_(ev, userId, { text: url });
  }

  const found = findRecord(p.id);
  if (!found || found.record.status !== 'confirmed') {
    return lineReply(ev.replyToken, textMsg('找不到這場研習（可能沒入曆或已刪除）。'));
  }
  lineLoading(userId, 20);
  const folder = handoutFolderFor_(found);
  file.moveTo(folder);

  const lines = ['✅ 已存進「' + folder.getName() + '」'];
  if (file.getName().endsWith('.url')) {
    const url = urlFromShortcut_(file);
    const backup = backupLink_(url, folder);
    lines.push(backup ? '💾 另存備份：' + backup : '⚠️ 這個連結沒辦法自動備份（可能要登入），研習後記得自己下載一份');
  }
  lines.push('📂 ' + folder.getUrl());
  lineReply(ev.replyToken, textMsg(lines.join('\n')));
}

/** 能備份就存一份到資料夾，回傳檔名；不行回 null */
function backupLink_(url, folder) {
  try {
    const g = url.match(/docs\.google\.com\/(document|presentation|spreadsheets)\/d\/([\w-]+)/);
    if (g) {
      const res = UrlFetchApp.fetch('https://docs.google.com/' + g[1] + '/d/' + g[2] + '/export?format=pdf', {
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true,
      });
      if (res.getResponseCode() !== 200 || res.getBlob().getContentType() !== 'application/pdf') return null;
      const name = safeName_(DriveApp.getFileById(g[2]).getName()) + '.pdf';
      return folder.createFile(res.getBlob().setName(name)).getName();
    }
    const d = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=)([\w-]+)/);
    if (d) return DriveApp.getFileById(d[1]).makeCopy(folder).getName();

    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() === 200 && /application\/pdf/.test(res.getHeaders()['Content-Type'] || '')) {
      const name = safeName_(decodeURIComponent(url.split(/[?#]/)[0].split('/').pop()) || '講義') ;
      return folder.createFile(res.getBlob().setName(/\.pdf$/i.test(name) ? name : name + '.pdf')).getName();
    }
  } catch (err) {
    console.error('備份連結失敗：' + url + ' ' + err);
  }
  return null;
}

// ---------- 查詢 ----------

/** 「講義」列最近有講義的 5 場；「講義 關鍵字」搜研習名稱與主辦 */
function handoutSearch_(keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  const hits = confirmedRecords()
    .filter((r) => r.handout_folder)
    .filter((r) => !kw || (String(r.title) + ' ' + String(r.organizer || '')).toLowerCase().indexOf(kw) !== -1)
    .sort((a, b) => toDate_(b.sessions[0].date) - toDate_(a.sessions[0].date))
    .slice(0, kw ? 10 : 5);
  if (hits.length === 0) {
    return kw ? '找不到名稱含「' + keyword.trim() + '」的講義。' : '還沒有存過講義。研習後把檔案或連結傳給我就好。';
  }
  const head = kw ? '📂 「' + keyword.trim() + '」的講義' : '📂 最近的講義';
  return head + '\n' + hits.map((r) =>
    Utilities.formatDate(toDate_(r.sessions[0].date), TZ, 'yyyy/M/d') + ' ' + r.title +
    '\n   https://drive.google.com/drive/folders/' + r.handout_folder).join('\n');
}

// ===== Main.js =====
/**
 * 研習小秘書 LINE bot（Google Apps Script 版）
 *
 * 流程：傳文字／截圖 → Gemini 抽取 → 確認卡片 → ✅ 寫進「研習」日曆
 * 指令：本週、下一場、時數、說明
 * 每日早報：setup() 建觸發器，每天檢查（含假日），當天有研習才推
 */

// ---------- Webhook 入口 ----------

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    (body.events || []).forEach(handleEvent_);
  } catch (err) {
    console.error('doPost 失敗：' + (err && err.stack || err));
  }
  // GAS 會回 302 轉址，LINE 仍收得到事件；一律回 OK
  return ContentService.createTextOutput('OK');
}

/** 瀏覽器直接開網址時的健康檢查 */
function doGet() {
  return ContentService.createTextOutput('training-bot OK');
}

function handleEvent_(ev) {
  const userId = ev.source && ev.source.userId;
  if (!userId || ev.source.type !== 'user') return;

  // GAS 拿不到 X-Line-Signature header，改用 userId 白名單擋外人
  const allowed = allowedUserIds();
  if (allowed.length === 0) {
    if (ev.replyToken) {
      lineReply(ev.replyToken, textMsg('🔧 設定模式\n你的 userId：\n' + userId +
        '\n\n把它填進指令碼屬性 ALLOWED_USER_IDS 就能開始用。'));
    }
    return;
  }
  if (allowed.indexOf(userId) === -1) return;

  if (ev.type === 'postback') return handlePostback_(ev, userId);
  if (ev.type !== 'message') return;

  const msg = ev.message;
  if (msg.type === 'text') {
    const cmd = msg.text.trim();
    if (COMMANDS[cmd]) return lineReply(ev.replyToken, COMMANDS[cmd]());
    if (/^講義/.test(cmd) && cmd.length <= 30) return lineReply(ev.replyToken, textMsg(handoutSearch_(cmd.slice(2))));
    if (isOnlyUrl_(cmd)) return handleHandoutLink_(ev, cmd);
    return handleAnnouncement_(ev, userId, { text: msg.text });
  }
  if (msg.type === 'image') {
    return handleAnnouncement_(ev, userId, { image: lineGetImage(msg.id) });
  }
  if (msg.type === 'file') return handleHandoutFile_(ev, msg);
  lineReply(ev.replyToken, textMsg('請傳研習公告的文字或截圖、或研習講義檔；輸入「說明」看用法。'));
}

// ---------- 抽取 → 確認卡片 ----------

function handleAnnouncement_(ev, userId, input) {
  lineLoading(userId, 30);
  let data;
  try {
    data = geminiExtract(input);
  } catch (err) {
    console.error(err);
    return lineReply(ev.replyToken, textMsg('😵 AI 解析失敗，稍後再試一次。\n' + String(err.message || err).slice(0, 200)));
  }
  if (!data.is_training || !data.sessions || data.sessions.length === 0) {
    return lineReply(ev.replyToken, textMsg('🤔 看不出研習的日期時間。\n如果是研習公告，請改傳含日期的截圖或文字。'));
  }
  // 保險：報名網址跟來源一樣，多半是 AI 把貼文網址誤當報名連結
  if (data.register_url && data.register_url === data.source) data.register_url = null;
  const id = saveDraft(data, userId);
  data.id = id;
  lineReply(ev.replyToken, confirmCard_(data));
}

function handlePostback_(ev, userId) {
  const p = {};
  ev.postback.data.split('&').forEach((kv) => {
    const [k, v] = kv.split('=');
    p[k] = decodeURIComponent(v || '');
  });
  if (String(p.action).indexOf('handout') === 0) return handleHandoutPostback_(ev, userId, p);
  const found = findRecord(p.id);
  if (!found) return lineReply(ev.replyToken, textMsg('找不到這筆研習（可能已刪除）。'));
  const rec = found.record;
  if (rec.status !== 'pending') {
    return lineReply(ev.replyToken, textMsg('這筆已經處理過了（' + (rec.status === 'confirmed' ? '已入曆' : '已丟掉') + '）。'));
  }

  if (p.action === 'discard') {
    updateRecord(found.rowIndex, { status: 'discarded' });
    return lineReply(ev.replyToken, textMsg('🗑️ 已丟掉：' + rec.title));
  }
  if (p.action === 'confirm') {
    const ids = writeToCalendar(rec);
    updateRecord(found.rowIndex, { status: 'confirmed', event_ids: ids.join(',') });
    const lines = ['✅ 已寫進「研習」日曆：' + rec.title];
    rec.sessions.forEach((s) => lines.push('・' + sessionLabel_(s)));
    if (rec.register_deadline) lines.push('⏰ 另建報名截止提醒：' + fmtDate_(rec.register_deadline));
    if (rec.notes) lines.push('⚠️ ' + rec.notes);
    return lineReply(ev.replyToken, textMsg(lines.join('\n')));
  }
}

function sessionLabel_(s) {
  const d = toDate_(s.date);
  const wk = '日一二三四五六'.charAt(Number(Utilities.formatDate(d, TZ, 'u')) % 7);
  let label = Utilities.formatDate(d, TZ, 'M/d') + '（' + wk + '）';
  if (s.start) label += ' ' + s.start + '–' + (s.end || '?');
  if (s.title) label += ' ' + s.title;
  return label;
}

function row_(label, value, opts) {
  if (!value) return null;
  const v = {
    type: 'text', text: String(value), size: 'sm', flex: 5, wrap: true,
    color: (opts && opts.color) || '#333333',
  };
  if (opts && opts.uri) v.action = { type: 'uri', label: label, uri: opts.uri };
  return {
    type: 'box', layout: 'baseline', spacing: 'sm',
    contents: [{ type: 'text', text: label, size: 'sm', color: '#888888', flex: 2 }, v],
  };
}

function isUrl_(s) {
  return /^https?:\/\/\S+$/.test(String(s || ''));
}

function confirmCard_(d) {
  const icon = MODE_ICON[d.mode] || MODE_ICON.unknown;
  const modeText = { onsite: '實體', online: '線上', hybrid: '混合', unknown: '未標明' }[d.mode] || '未標明';
  const rows = [
    row_('時間', d.sessions.map(sessionLabel_).join('\n')),
    row_('形式', modeText),
    row_('地點', d.location),
    row_('線上', d.online_url, { color: '#1a73e8', uri: isUrl_(d.online_url) ? d.online_url : null }),
    row_('報名', d.register_url, { color: '#1a73e8', uri: isUrl_(d.register_url) ? d.register_url : null }),
    row_('截止', d.register_deadline),
    row_('時數', d.hours),
    row_('主辦', d.organizer),
    row_('來源', d.source),
    row_('注意', d.notes, { color: '#d93025' }),
  ].filter(Boolean);
  if (d.confidence < 0.7) rows.push(row_('⚠️', '日期時間信心偏低，請對照原文', { color: '#d93025' }));

  const bubble = {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical',
      contents: [
        { type: 'text', text: '📋 請確認研習資訊', size: 'xs', color: '#888888' },
        { type: 'text', text: icon + ' ' + (d.title || '（無標題）'), weight: 'bold', size: 'md', wrap: true },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: rows },
    footer: {
      type: 'box', layout: 'horizontal', spacing: 'sm',
      contents: [
        { type: 'button', style: 'primary', color: '#1e8e3e',
          action: { type: 'postback', label: '✅ 入曆', data: 'action=confirm&id=' + d.id, displayText: '入曆' } },
        { type: 'button', style: 'secondary',
          action: { type: 'postback', label: '❌ 丟掉', data: 'action=discard&id=' + d.id, displayText: '丟掉' } },
      ],
    },
  };
  return { type: 'flex', altText: '請確認研習：' + (d.title || ''), contents: bubble };
}

// ---------- 指令（全部走 reply，不耗推播額度） ----------

const COMMANDS = {
  '本週': () => textMsg(listEvents_(7, '📅 未來 7 天的研習')),
  '下一場': () => textMsg(nextEvent_()),
  '時數': () => textMsg(hoursSummary_()),
  '說明': () => textMsg([
    '📖 研習小秘書',
    '・傳研習公告的文字或截圖 → 我整理成卡片，按 ✅ 就寫進「研習」日曆',
    '・本週：未來 7 天的研習',
    '・下一場：最近一場研習',
    '・時數：本學年已入曆的研習時數',
    '・研習後傳講義檔或連結 → 選是哪一場，存進雲端「研習講義」資料夾',
    '・講義 關鍵字：找以前的講義（只打「講義」列最近 5 場）',
    '・每天 ' + cfg('DIGEST_HOUR') + ':' + ('0' + cfg('DIGEST_MINUTE')).slice(-2) + ' 檢查，當天有研習才推播（含假日）',
    'FB 等要登入的網址我打不開，請貼文字或截圖。',
  ].join('\n')),
};

function trainingEvents_(from, to) {
  return calendar_().getEvents(from, to).filter((e) => e.getTitle().indexOf('⏰ 報名截止') !== 0);
}

function eventLine_(e) {
  const s = e.getStartTime();
  const wk = '日一二三四五六'.charAt(s.getDay());
  const when = e.isAllDayEvent()
    ? Utilities.formatDate(s, TZ, 'M/d') + '（' + wk + '）'
    : Utilities.formatDate(s, TZ, 'M/d') + '（' + wk + '）' + Utilities.formatDate(s, TZ, 'HH:mm');
  const loc = e.getLocation();
  return when + ' ' + e.getTitle() + (loc ? '\n   ' + loc : '');
}

function listEvents_(days, heading) {
  const now = new Date();
  const events = trainingEvents_(now, new Date(now.getTime() + days * 86400000));
  if (events.length === 0) return heading + '\n（沒有）';
  return heading + '\n' + events.map(eventLine_).join('\n');
}

function nextEvent_() {
  const now = new Date();
  const events = trainingEvents_(now, new Date(now.getTime() + 180 * 86400000));
  if (events.length === 0) return '半年內沒有排入的研習。';
  const e = events[0];
  return '⏭️ 下一場\n' + eventLine_(e) + '\n\n' + e.getDescription().split('\n#training-bot')[0];
}

/** 學年從 8/1 起算 */
function hoursSummary_() {
  const now = new Date();
  const y = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  const start = new Date(y + '-08-01T00:00:00+08:00');
  const recs = confirmedRecords().filter((r) => r.sessions.some((s) => toDate_(s.date) >= start));
  const total = recs.reduce((sum, r) => sum + (Number(r.hours) || 0), 0);
  const noHours = recs.filter((r) => !r.hours).length;
  return '🕒 ' + (y - 1911) + ' 學年研習時數：' + total + ' 小時（' + recs.length + ' 筆）' +
    (noHours ? '\n其中 ' + noHours + ' 筆公告沒寫時數，未計入。' : '');
}

// ---------- 每日早報（唯一會耗推播額度的地方） ----------

function dailyDigest() {
  const now = new Date();
  const todayStart = new Date(Utilities.formatDate(now, TZ, 'yyyy-MM-dd') + 'T00:00:00+08:00');
  const dayMs = 86400000;
  const today = trainingEvents_(todayStart, new Date(todayStart.getTime() + dayMs));
  const tomorrow = trainingEvents_(new Date(todayStart.getTime() + dayMs), new Date(todayStart.getTime() + 2 * dayMs));
  const deadlines = calendar_()
    .getEvents(todayStart, new Date(todayStart.getTime() + (cfgNum('DEADLINE_LOOKAHEAD_DAYS') + 1) * dayMs))
    .filter((e) => e.getTitle().indexOf('⏰ 報名截止') === 0);

  // 當天有研習才推（含假日）；明天與報名截止只在有推時順便附上
  if (today.length === 0) return;

  const lines = ['☀️ 研習早報 ' + Utilities.formatDate(now, TZ, 'M/d')];
  lines.push('', '【今天】', ...today.map(eventLine_));
  if (tomorrow.length) lines.push('', '【明天】', ...tomorrow.map(eventLine_));
  if (deadlines.length) {
    lines.push('', '【報名快截止】', ...deadlines.map((e) =>
      Utilities.formatDate(e.getStartTime(), TZ, 'M/d') + ' ' + e.getTitle().replace('⏰ 報名截止：', '')));
  }
  const text = lines.join('\n');

  const quota = lineQuota();
  if (quota === null || quota.used >= cfgNum('PUSH_QUOTA_GUARD')) {
    const to = cfg('NOTIFY_EMAIL') || Session.getEffectiveUser().getEmail();
    MailApp.sendEmail(to, '研習早報 ' + Utilities.formatDate(now, TZ, 'M/d'),
      text + '\n\n（LINE 推播額度' + (quota ? '已用 ' + quota.used + ' 則' : '查詢失敗') + '，改寄 Email）');
    return;
  }
  allowedUserIds().forEach((uid) => linePush(uid, textMsg(text)));
}

// ---------- 一次性設定（在 GAS 編輯器手動執行） ----------

function setup() {
  if (!cfg('CALENDAR_ID')) {
    const cal = CalendarApp.createCalendar(CALENDAR_NAME, { timeZone: TZ, color: CalendarApp.Color.TEAL });
    setCfg('CALENDAR_ID', cal.getId());
    console.log('已建立日曆：' + CALENDAR_NAME);
  }
  if (!cfg('SHEET_ID')) {
    const ss = SpreadsheetApp.create('研習小秘書資料');
    const sh = ss.getSheets()[0].setName(SHEET_NAME);
    sh.appendRow(COLS);
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@');
    setCfg('SHEET_ID', ss.getId());
    console.log('已建立試算表：' + ss.getUrl());
  }
  // 舊版建的試算表少了後來加的欄位，補上表頭
  const sh = sheet_();
  if (sh.getLastColumn() < COLS.length) {
    sh.getRange(1, 1, 1, COLS.length).setValues([COLS]);
  }
  if (!cfg('HANDOUT_FOLDER_ID')) {
    const folder = DriveApp.createFolder(HANDOUT_ROOT_NAME);
    folder.createFolder(HANDOUT_INBOX_NAME);
    setCfg('HANDOUT_FOLDER_ID', folder.getId());
    console.log('已建立講義資料夾：' + folder.getUrl());
  }
  setupTrigger();
  const missing = ['LINE_CHANNEL_ACCESS_TOKEN', 'GEMINI_API_KEY', 'ALLOWED_USER_IDS'].filter((k) => !cfg(k));
  console.log(missing.length ? '⚠️ 還沒設定：' + missing.join(', ') : '✅ 設定完成');
}

/** 重建每日早報觸發器（改 DIGEST_HOUR / DIGEST_MINUTE 後要重跑） */
function setupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'dailyDigest')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  // GAS 的 nearMinute 會有 ±15 分鐘誤差，這是平台限制
  ScriptApp.newTrigger('dailyDigest').timeBased()
    .atHour(cfgNum('DIGEST_HOUR')).nearMinute(cfgNum('DIGEST_MINUTE')).everyDays(1)
    .inTimezone(TZ).create();
  console.log('早報觸發器：每天 ' + cfg('DIGEST_HOUR') + ':' + cfg('DIGEST_MINUTE') + ' 左右');
}

/** 不經 LINE 直接測抽取：在編輯器執行，看記錄 */
function testExtract() {
  const sample = '中秋節 & 教師節 教師AI 底層能力雙講堂\n講師：數位敘事力期刊 吳奇\n' +
    '9/28 （ㄧ）19:00\nAgent skill：為何需要skill？與skill的極限\n' +
    '直播連結在貼文留言區，煩請自行保留連結唷～\nhttps://www.facebook.com/share/p/19GNHrU88f/';
  console.log(JSON.stringify(geminiExtract({ text: sample }), null, 2));
}

