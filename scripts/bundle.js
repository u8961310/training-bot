/**
 * 把 src/ 的五個檔依序接成 docs/training-bot.gs（給老師在 Apps Script 編輯器整份複製貼上）。
 *
 *   npm run bundle          重產單檔
 *   npm run bundle:check    只檢查單檔是否跟 src/ 一致，不一致就 exit 1
 *
 * 順序有意義：Config 的常數要在最前面。新增 src 檔時記得加進 FILES。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = ['Config', 'Line', 'Gemini', 'Store', 'Main'];
const OUT = path.join(ROOT, 'docs', 'training-bot.gs');

const bundled = FILES.map((name) => {
  const src = fs.readFileSync(path.join(ROOT, 'src', name + '.js'), 'utf8');
  return '// ===== ' + name + '.js =====\n' + src + '\n';
}).join('');

// 防漏：src/ 多了沒列進 FILES 的 .js 就直接擋下
const extra = fs.readdirSync(path.join(ROOT, 'src'))
  .filter((f) => f.endsWith('.js') && !FILES.includes(f.replace(/\.js$/, '')));
if (extra.length) {
  console.error('src/ 有檔案沒列進 FILES：' + extra.join(', '));
  process.exit(1);
}

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  // Windows 上 git 可能把工作目錄換成 CRLF，比對前統一換行
  const lf = (s) => s.replace(/\r\n/g, '\n');
  if (lf(current) !== lf(bundled)) {
    console.error('docs/training-bot.gs 跟 src/ 不一致，請跑 npm run bundle');
    process.exit(1);
  }
  console.log('docs/training-bot.gs 已是最新');
} else {
  fs.writeFileSync(OUT, bundled);
  console.log('已產生 docs/training-bot.gs（' + FILES.length + ' 個檔）');
}
