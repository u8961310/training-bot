/**
 * 研習小秘書 LINE bot（Google Apps Script 版）
 *
 * 流程：傳文字／截圖 → Gemini 抽取 → 確認卡片 → ✅ 寫進「研習」日曆
 * 指令：本週、下一場、時數、說明
 * 每日早報：setup() 建觸發器，有事才推播
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
    return handleAnnouncement_(ev, userId, { text: msg.text });
  }
  if (msg.type === 'image') {
    return handleAnnouncement_(ev, userId, { image: lineGetImage(msg.id) });
  }
  lineReply(ev.replyToken, textMsg('請傳研習公告的文字或截圖；輸入「說明」看用法。'));
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
    '・每天 ' + cfg('DIGEST_HOUR') + ':' + ('0' + cfg('DIGEST_MINUTE')).slice(-2) + ' 有研習或報名快截止才會推播',
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

  // 沒事就不推，省額度
  if (today.length + tomorrow.length + deadlines.length === 0) return;

  const lines = ['☀️ 研習早報 ' + Utilities.formatDate(now, TZ, 'M/d')];
  if (today.length) lines.push('', '【今天】', ...today.map(eventLine_));
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
