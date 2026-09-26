/**
 * 重新產生單檔 → 推上 Apps Script → 更新既有部署（網址不變）。
 *
 * 為什麼不寫在 package.json 的一行 `node -e "require('child_process')..."`：
 * 那個寫法跟惡意程式下載器很像，2026-09-26 被 Windows Defender 以
 * Trojan:Win32/Commando.A!ml（行為特徵誤判）攔下，程序被砍、部署沒完成。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const idFile = path.join(ROOT, '.deploy-id');
if (!fs.existsSync(idFile)) {
  console.error('找不到 .deploy-id（首次部署後把 deploymentId 存進這個檔，一行）');
  process.exit(1);
}
const deployId = fs.readFileSync(idFile, 'utf8').trim();

function run(args) {
  const r = spawnSync('npx', args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status || 1);
}

require('./bundle.js');
run(['clasp', 'push', '--force']);
run(['clasp', 'update-deployment', deployId]);
