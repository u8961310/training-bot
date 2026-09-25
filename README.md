# 研習小秘書 training-bot

把研習公告（文字或截圖）傳給 LINE bot → Gemini 抽出時間、地點、線上網址 → 確認卡片 → 寫進 Google「研習」日曆。
每天 07:30 有研習或報名快截止才推播一則早報。

全免費：Google Apps Script（主機＋日曆＋試算表＋排程）、LINE 輕用量方案、Gemini 免費層。

## 架構

```
LINE ──webhook──▶ GAS doPost ──▶ Gemini（JSON schema 抽取）
                     │
                     ├─ reply 確認卡片（免費）
                     ├─ ✅ → CalendarApp「研習」日曆 ＋ 試算表記錄
                     └─ 時間觸發器 07:30 → dailyDigest → push（有事才推）
```

| 檔案 | 內容 |
|---|---|
| `src/Config.js` | 指令碼屬性與預設值（所有可調參數都在這） |
| `src/Line.js` | reply／push／圖片下載／額度查詢 |
| `src/Gemini.js` | 抽取 prompt 與 schema |
| `src/Store.js` | 試算表與日曆寫入 |
| `src/Main.js` | webhook、確認卡片、指令、早報、`setup()` |

## 推播額度

台灣輕用量每月 200 則 push，**reply 不計**。本 bot 只有早報用 push，且沒事不推，
每次推播前查 `/v2/bot/message/quota/consumption`，超過 `PUSH_QUOTA_GUARD`（預設 150）改寄 Email。
開課前提醒交給 Google 日曆內建通知（`REMINDER_MIN`，預設 30 分）。

## 安全

GAS 的 `doPost` 拿不到 HTTP header，**無法驗 `X-Line-Signature`**。
補救：只處理 `ALLOWED_USER_IDS` 白名單內的 userId；Web app 網址不要外流。

## 首次安裝

1. 開 <https://script.google.com/home/usersettings> → 開啟「Google Apps Script API」
2. `npm install`
3. `npx clasp login`（瀏覽器登入個人 Gmail）
4. `npm run create`（建 GAS 專案，產生 `.clasp.json`）→ `git checkout src/appsscript.json`
   （create 會拉回預設 manifest 蓋掉本機的，要還原）→ `npm run push`
5. `npm run open` → 專案設定 → 指令碼屬性，新增：
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `GEMINI_API_KEY`
6. 編輯器執行 `setup()`（第一次會要授權）→ 建「研習」日曆、試算表、早報觸發器
7. 編輯器執行 `testExtract()` → 看記錄確認 Gemini 抽取正常
8. `npm run deploy:first` → 記下 deploymentId；Web app 網址＝`https://script.google.com/macros/s/<deploymentId>/exec`
9. LINE Developers → Messaging API → Webhook URL 填上網址、開啟 Use webhook；
   LINE Official Account Manager → 關閉「自動回應訊息」
10. 傳任意訊息給 bot → 回你的 userId → 填進 `ALLOWED_USER_IDS`

## 改版

```
npm run redeploy    # push ＋ update-deployment，讀 .deploy-id（不進 git），網址不變
```

首次部署後把 deploymentId 存進 `.deploy-id`（一行）。

只 push 不 redeploy 的話，webhook 仍跑舊版本。
