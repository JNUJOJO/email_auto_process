#!/usr/bin/env node
/**
 * email-watch.js — 邮箱自动监控（解耦版）
 * 
 * 所有配置来自 .env 文件，无硬编码。
 * 通知通道支持：feishu（默认）、可扩展添加其他通道。
 * 
 * 工作流程:
 *   newEmail → hasAttachments? → 下载+提取内容 → 通知用户
 *   newEmail → noAttachments?  → 提取云链接? → 通知用户
 *   newEmail → noAttachments+noCloudLinks → 正文摘要→通知用户
 */

const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

// ══════════════════════════════════════════
//  配置载入（从 .env 文件读取）
// ══════════════════════════════════════════

const SKILL_DIR = path.resolve(__dirname, '..');
const SCRIPTS_DIR = __dirname;
const ENV_PATH = path.join(SKILL_DIR, '.env');

// 读 .env 文件
function loadEnv(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) {
    console.error('⚠ .env 文件不存在: ' + filePath);
    console.error('   请复制 .env.template 为 .env 并填入配置');
    process.exit(1);
  }
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

const CFG = loadEnv(ENV_PATH);

// ══════════════════════════════════════════
//  路径常量
// ══════════════════════════════════════════

const OCR_SCRIPT = path.join(SCRIPTS_DIR, 'ocr-local', 'ocr.js');
const PDF2IMG_SCRIPT = path.join(SCRIPTS_DIR, 'pdf-to-images', 'convert_pdf_to_images.py');
const IMAP_SCRIPT = path.join(SCRIPTS_DIR, 'imap.js');
const STATE_FILE = path.join(SKILL_DIR, '.email-watch-state.json');
const DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'email-attachments');

// ══════════════════════════════════════════
//  通知通道接口
// ══════════════════════════════════════════

// 所有通道实现 notify(text) 方法即可
const CHANNELS = {};

// ── 飞书 ──
CHANNELS.feishu = {
  async getToken() {
    const d = JSON.stringify({ app_id: CFG.FEISHU_APP_ID, app_secret: CFG.FEISHU_APP_SECRET });
    return new Promise((resolve, reject) => {
      const r = https.request({
        hostname: 'open.feishu.cn', path: '/open-apis/auth/v3/tenant_access_token/internal',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) }
      }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b).tenant_access_token)); });
      r.on('error', reject); r.write(d); r.end();
    });
  },
  async notify(text) {
    const token = await this.getToken();
    const content = JSON.stringify({ text });
    const d = JSON.stringify({ receive_id: CFG.FEISHU_OPEN_ID, msg_type: 'text', content });
    return new Promise((resolve, reject) => {
      const r = https.request({
        hostname: 'open.feishu.cn', path: '/open-apis/im/v1/messages?receive_id_type=open_id',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Authorization': 'Bearer ' + token,
          'Content-Length': Buffer.byteLength(d)
        }
      }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b))); });
      r.on('error', reject); r.write(d); r.end();
    });
  }
};

// ── 预留接口：添加 Telegram 通道只需实现 notify() ──
// CHANNELS.telegram = {
//   async notify(text) {
//     // 用 https 请求 Telegram Bot API
//     https.get(`https://api.telegram.org/bot${CFG.TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=...&text=${encodeURIComponent(text)}`);
//   }
// };

async function sendNotification(text) {
  const channel = CHANNELS[CFG.NOTIFY_CHANNEL] || CHANNELS.feishu;
  return await channel.notify(text);
}

// ══════════════════════════════════════════
//  工具函数
// ══════════════════════════════════════════

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\n\s*\n\s*\n/g, '\n\n').replace(/[\t ]+/g, ' ')
    .replace(/^[| ]+|[| ]+$/gm, '').trim();
}

function extractCloudLinks(text, html) {
  const links = [];
  const patterns = (CFG.CLOUD_LINK_PATTERNS || '').split('|').filter(Boolean);
  for (const pattern of patterns) {
    const fullSource = (html || '') + ' ' + (text || '');
    const re = new RegExp('https?://' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    let match;
    while ((match = re.exec(fullSource)) !== null) {
      links.push({ pattern, url: match[0] });
    }
  }
  return links;
}

function isSystemMail(subject, from) {
  const fromRe = CFG.SYSTEM_MAIL_FROM ? new RegExp(CFG.SYSTEM_MAIL_FROM) : null;
  const subjectRe = CFG.SYSTEM_MAIL_SUBJECT ? new RegExp(CFG.SYSTEM_MAIL_SUBJECT) : null;
  if (fromRe && fromRe.test(from) && subjectRe && subjectRe.test(subject)) return true;
  return false;
}

// ══════════════════════════════════════════
//  附件处理
// ══════════════════════════════════════════

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.log', '.xml', '.yaml', '.yml',
  '.js', '.py', '.html', '.css', '.sh', '.bat', '.ini', '.cfg', '.conf',
  '.env', '.yml', '.yaml', '.toml'
]);

function downloadAttachment(emailUid) {
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const out = execSync(
    `node "${IMAP_SCRIPT}" download ${emailUid} --dir "${DOWNLOAD_DIR}"`,
    { cwd: SCRIPTS_DIR, stdio: 'pipe', timeout: 30000, encoding: 'utf-8' }
  );
  const dl = JSON.parse(out);
  const arr = dl.downloaded || (Array.isArray(dl) ? dl : []);
  return arr[0] || null;
}

function readPdfContent(fp) {
  let content = '';
  // 清空旧 page_ 文件
  const existing = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith('page_') && f.endsWith('.jpg'));
  existing.forEach(f => { try { fs.unlinkSync(path.join(DOWNLOAD_DIR, f)); } catch(e) {} });
  
  execSync(`python "${PDF2IMG_SCRIPT}" --input "${fp}" --output-dir "${DOWNLOAD_DIR}" --image-format jpg --dpi 200`, { stdio: 'pipe', timeout: 30000 });
  const pages = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith('page_') && f.endsWith('.jpg')).sort();
  
  for (const p of pages) {
    try {
      const ocrOut = execSync(
        `node "${OCR_SCRIPT}" "${path.join(DOWNLOAD_DIR, p)}" --lang ${CFG.OCR_LANG || 'chi_sim+eng'}`,
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
      );
      const pageNum = (p.match(/\d+/) || ['0'])[0];
      content += `[第${pageNum}页]\n${ocrOut.trim()}\n\n`;
    } catch(e) {
      const stdout = (e.stdout || '').trim();
      if (stdout) {
        const pageNum = (p.match(/\d+/) || ['0'])[0];
        content += `[第${pageNum}页]\n${stdout}\n\n`;
      }
    }
  }
  return content.substring(0, 2000);
}

// ══════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════

async function main() {
  let state = { lastUids: [], sentUids: [] };
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); } catch(e) {}

  try {
    const output = execSync(`node "${IMAP_SCRIPT}" check --limit 10`, { cwd: SCRIPTS_DIR, stdio: 'pipe', timeout: 30000, encoding: 'utf-8' });
    const emails = JSON.parse(output);
    if (!Array.isArray(emails) || emails.length === 0) {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      return;
    }

    const knownUids = new Set(state.lastUids);
    let newEmails = emails.filter(e => !knownUids.has(e.uid));
    if (state.lastUids.length === 0 && newEmails.length > 2) newEmails = newEmails.slice(0, 2);

    state.lastUids = emails.map(e => e.uid);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

    if (newEmails.length === 0) return;

    for (const email of newEmails) {
      if (isSystemMail(email.subject, email.from)) continue;
      if (state.sentUids.includes(email.uid)) continue;
      await processEmail(email, state);
    }
  } catch(e) {
    console.error('检查失败:', e.message);
  }
}

async function processEmail(email, state) {
  const lines = [];
  lines.push('📧 收到新邮件');
  lines.push('');
  lines.push('发件人: ' + (email.from || '未知'));
  lines.push('主题: ' + (email.subject || '(无主题)'));
  lines.push('时间: ' + (email.date ? new Date(email.date).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未知'));
  lines.push('');

  // 正文
  const bodyText = email.text || email.html || '';
  const cloudLinks = extractCloudLinks(bodyText, email.html || '');
  if (!cloudLinks.length && bodyText) {
    const clean = stripHtml(bodyText).substring(0, 400);
    if (clean) { lines.push('正文: ' + clean); lines.push(''); }
  }

  // 附件处理
  const attachments = email.attachments || [];
  for (const a of attachments) {
    const fname = a.filename || a.name || '附件';
    const ext = path.extname(fname).toLowerCase();
    const sizeStr = a.size ? (a.size < 1024 ? a.size + 'B' : a.size < 1048576 ? (a.size / 1024).toFixed(1) + 'KB' : (a.size / 1048576).toFixed(1) + 'MB') : '?';
    lines.push('📎 ' + fname + ' (' + sizeStr + ')');

    try {
      const dl = downloadAttachment(email.uid);
      if (dl && dl.path && fs.existsSync(dl.path)) {
        let content = '';
        const fp = dl.path;
        if (TEXT_EXTENSIONS.has(ext)) {
          content = fs.readFileSync(fp, 'utf-8').substring(0, 1000);
        } else if (ext === '.pdf') {
          content = readPdfContent(fp);
        }
        if (content) {
          lines.push('');
          lines.push('━ 内容 ━');
          lines.push(content.trim());
        }
      }
    } catch(e) {
      // 下载失败，展示云链接
      for (const cl of cloudLinks) {
        lines.push('📎 ' + cl.type + ': ' + fname);
        lines.push('   链接: ' + cl.url);
      }
    }
    lines.push('');
  }

  // 纯云附件（没有实际附件）
  if (!attachments.length && cloudLinks.length) {
    for (const cl of cloudLinks) {
      lines.push('📎 云附件:');
      lines.push('   链接: ' + cl.url);
      lines.push('');
    }
  }

  lines.push('请告诉我怎么处理');

  const result = await sendNotification(lines.join('\n'));

  if (result && result.code === 0) {
    state.sentUids.push(email.uid);
    if (state.sentUids.length > 50) state.sentUids = state.sentUids.slice(-50);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log('已发送: ' + (email.subject || '(无主题)'));
  } else {
    console.error('发送失败' + (result ? ': ' + result.msg : ''));
  }
}

main().catch(console.error);
