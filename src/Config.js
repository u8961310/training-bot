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
 *   PUSH_QUOTA_GUARD           當月推播用量超過這個數字就改寄 Email
 *   DIGEST_SKIP_EMPTY          true＝沒研習的日子不推早報（預設 false，每天都推）
 *   NOTIFY_EMAIL               備援 Email（預設部署者本人）
 *
 * setup() 自動寫入：
 *   CALENDAR_ID                「研習」日曆
 *   SHEET_ID                   研習紀錄試算表
 */
const DEFAULTS = {
  GEMINI_MODEL: 'gemini-3.5-flash-lite',
  DIGEST_HOUR: '7',
  DIGEST_MINUTE: '30',
  DEFAULT_DURATION_MIN: '120',
  REMINDER_MIN: '30',
  DEADLINE_LOOKAHEAD_DAYS: '3',
  PUSH_QUOTA_GUARD: '150',
  DIGEST_SKIP_EMPTY: 'false',
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
