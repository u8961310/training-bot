/**
 * 試算表當資料表，日曆當顯示與提醒。
 * 一列＝一則研習公告；status: pending（等確認）／confirmed／discarded
 */
const COLS = [
  'id', 'created_at', 'status', 'title', 'organizer', 'mode', 'location', 'online_url',
  'register_url', 'register_deadline', 'hours', 'source', 'notes', 'confidence',
  'sessions_json', 'event_ids', 'user_id',
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
