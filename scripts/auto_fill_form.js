#!/usr/bin/env node
/**
 * auto_fill_form.js — 自动填表（支持 --fill-only 只填不提交）
 * 
 * 迁移前请修改：
 *   - EDGE_PATH（第 65 行）— 系统 Edge 可执行文件路径
 *   - .env 中的 FEISHU_* — 飞书应用凭证和接收人
 * 
 * 用法:
 *   node auto_fill_form.js --url <URL> --data <data.json>        # 填表 + 飞书确认 + 提交
 *   node auto_fill_form.js --url <URL> --data <data.json> --fill-only  # 只填不提交
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const https = require('https');

function loadEnv(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    env[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
  }
  return env;
}
const CFG = loadEnv(path.resolve(__dirname, '../.env'));
const FEISHU_APP_ID = CFG.FEISHU_APP_ID;
const FEISHU_APP_SECRET = CFG.FEISHU_APP_SECRET;
const FEISHU_OPEN_ID = CFG.FEISHU_OPEN_ID;

async function getFeishuToken() {
  return new Promise((resolve, reject) => {
    const d = JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET });
    const req = https.request({
      hostname: 'open.feishu.cn', path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) }
    }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b).tenant_access_token)); });
    req.on('error', reject); req.write(d); req.end();
  });
}

async function sendFeishuText(token, text) {
  return new Promise((resolve, reject) => {
    const content = JSON.stringify({ text });
    const d = JSON.stringify({ receive_id: FEISHU_OPEN_ID, msg_type: 'text', content });
    const req = https.request({
      hostname: 'open.feishu.cn', path: '/open-apis/im/v1/messages?receive_id_type=open_id',
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': `Bearer ${token}`, 'Content-Length': Buffer.byteLength(d) }
    }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b))); });
    req.on('error', reject); req.write(d); req.end();
  });
}

// ── 参数 ──
const args = process.argv.slice(2);
const FORM_URL = args[args.indexOf('--url') + 1] || null;
const DATA_PATH = args[args.indexOf('--data') + 1] || null;
const fillOnly = args.includes('--fill-only');
if (!FORM_URL || !DATA_PATH) { console.error('用法: node auto_fill_form.js --url <URL> --data <data.json> [--fill-only]'); process.exit(1); }

const DATA = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

function CSSEscape(str) { return String(str).replace(/([!"#$%&'()*+,.\/:;<=>?@[\]^`{|}~])/g, '\\$1'); }

async function fillField(page, key, value) {
  let el = await page.$('#' + CSSEscape(key));
  if (el) { console.log('  [OK] ' + key); await doFill(page, el, value); return; }
  el = await page.$(`[name="${CSSEscape(key)}"]`);
  if (el) { console.log('  [OK] ' + key + ' (name)'); await doFill(page, el, value); return; }
  console.log('  [SKIP] ' + key);
}

async function doFill(page, el, value) {
  const tagName = await el.evaluate(el => el.tagName.toLowerCase());
  const type = await el.evaluate(el => (el.type || '').toLowerCase());
  if (tagName === 'select') { await el.select(String(value)); }
  else if (tagName === 'input' && type === 'date') { await el.evaluate((el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }, String(value)); }
  else { await el.click({ clickCount: 3 }); await el.type(String(value), { delay: 20 }); }
}

// ── 主流程 ──
(async () => {
  console.log('启动浏览器...');
  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: false, defaultViewport: null, args: ['--start-maximized'] });
  const page = await browser.newPage();
  page.on('dialog', async dialog => { console.log('  弹窗: ' + dialog.message().substring(0, 80)); await dialog.accept(); });

  console.log('打开页面...');
  await page.goto(FORM_URL, { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1000));

  console.log('\n填写表单...');
  for (const [key, value] of Object.entries(DATA)) await fillField(page, key, value);

  await page.evaluate(() => { if (typeof updatePreview === 'function' && typeof getContractFormData === 'function') updatePreview(getContractFormData()); });

  if (fillOnly) {
    console.log('\n✅ 填写完成。浏览器保持打开。');
    setInterval(async () => { try { const pages = await browser.pages(); if (pages.length === 0) process.exit(0); } catch(e) { process.exit(0); } }, 5000);
    return;
  }

  // ── 完整流程：截图 → 飞书通知 → 等待确认 → 提交 ──
  const SCREENSHOT_PATH = args[args.indexOf('--screenshot') + 1] || path.resolve(__dirname, '../../_fill_screenshot.png');
  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
  console.log('\n已截图: ' + SCREENSHOT_PATH);

  const token = await getFeishuToken();
  const msg = `📋 合同已填写完成\n\n合同: ${DATA.contract_name || DATA.contract_no || '合同'}\n金额: ¥${DATA.contract_amount || '?'}\n\n是否点击提交？回复"提交"确认。`;
  const result = await sendFeishuText(token, msg);
  if (result.code !== 0) {
    console.log('飞书通知失败:', result.msg);
    setInterval(async () => { try { const pages = await browser.pages(); if (pages.length === 0) process.exit(0); } catch(e) { process.exit(0); } }, 5000);
    return;
  }
  console.log('飞书通知已发送，等待回复"提交"...');

  const waitFile = path.resolve(__dirname, '../.fill_waiting.json');
  fs.writeFileSync(waitFile, JSON.stringify({ status: 'waiting', pid: process.pid, timestamp: Date.now() }));
  console.log('标记文件已创建');

  const startTime = Date.now();
  let confirmed = false;
  while (Date.now() - startTime < 300000) {
    await new Promise(r => setTimeout(r, 2000));
    try { const state = JSON.parse(fs.readFileSync(waitFile, 'utf-8')); if (state.status === 'confirmed') { confirmed = true; break; } } catch(e) {}
  }

  if (confirmed) {
    console.log('\n点击提交...');
    let clicked = false;
    try {
      const btn = await page.$('#submitApprovalBtn');
      if (btn && await btn.isVisible()) { await btn.click(); clicked = true; console.log('已点击 #submitApprovalBtn'); }
    } catch(e) {}
    if (!clicked) {
      try {
        const btns = await page.$$('button');
        for (const btn of btns) { const t = await btn.evaluate(b => b.textContent.trim()); if (t.includes('模拟推送')) { await btn.click(); clicked = true; console.log('已点击: ' + t); break; } }
      } catch(e) {}
    }
    if (!clicked) await sendFeishuText(token, '⚠️ 未找到提交按钮');
    else { await new Promise(r => setTimeout(r, 1500)); await sendFeishuText(token, '✅ 已提交成功！'); }
  } else {
    console.log('超时');
    await sendFeishuText(token, '⏰ 超时，请手动提交。');
  }
  try { fs.unlinkSync(waitFile); } catch(e) {}

  setInterval(async () => { try { const pages = await browser.pages(); if (pages.length === 0) process.exit(0); } catch(e) { process.exit(0); } }, 5000);
})();
