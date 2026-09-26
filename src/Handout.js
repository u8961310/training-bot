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
