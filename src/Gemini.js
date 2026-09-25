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
