---
name: email-auto-process
description: 自动监控邮箱，收到新邮件后自动下载附件（IMAP 附件或 PDF 转图片后 OCR 识别内容），将正文摘要和附件内容通过通知通道（默认飞书）发送给用户。所有配置通过 .env 文件管理，无硬编码。适用于邮箱自动化、邮件附件处理、PDF 合同/文档内容提取。使用场景：收到合同邮件→提取内容→飞书通知→等待用户指令执行。
---

# 邮箱自动处理 Skill

## 快速开始

1. 复制 `.env.template` 为 `.env`，填入配置
2. 安装依赖：
   ```bash
   cd scripts && npm install
   pip install pymupdf>=1.23.0
   ```
3. 测试运行：
   ```bash
   node scripts/email-watch.js
   ```
4. 配置 cron（每 10 分钟检查一次）：
   ```
   openclaw cron add --name "邮箱监控" --every 10m --system-event "[email-watch] 检查新邮件定时触发"
   ```

## 工作流程

```
新邮件 → 检查附件
  ├─ 有 IMAP 附件 → 下载
  │   ├─ 文本类(.txt/.md/.csv/.json etc.) → 直接读取(最多1000字)
  │   ├─ PDF → Python pymupdf 转 JPG → tesseract.js OCR 识别文字
  │   └─ 其他 → 仅标记文件名和大小
  └─ 无附件/下载失败 → 检查云链接？
      ├─ 有云链接(QQ超大附件/网易云附件) → 展示下载链接 + 正文摘要
      └─ 无云链接 → 仅正文摘要
  └─ 拼装信息 → 发通知通道 → 等待用户回复指示
```

## 配置说明（.env）

### 邮箱配置
```ini
# IMAP
IMAP_HOST=imap.163.com
IMAP_PORT=993
IMAP_USER=your@email.com
IMAP_PASS=授权码或密码

# 163 邮箱需要 IMAP ID 伪装
# 参见 scripts/imap.js 中的 IMAP_ID 常量
```

### 通知通道配置
```ini
NOTIFY_CHANNEL=feishu       # 当前支持 feishu

# 飞书配置
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_OPEN_ID=ou_xxx
```

### 邮箱过滤
```ini
SYSTEM_MAIL_FROM=@service\.netease\.com
SYSTEM_MAIL_SUBJECT=欢迎来到|邮件办公
```

### 云附件链接模式
```ini
CLOUD_LINK_PATTERNS=wx\.mail\.qq\.com/ftn/|dashi\.163\.com/html/cloud-attachment-download/
```
多个模式用 `|` 分隔。匹配到的链接不会尝试下载，直接展示给用户。

## 迁移到其他龙虾

### 需要修改的文件

| 文件 | 说明 |
|------|------|
| `.env` | **全部配置都在这里**，IMAP/SMTP/飞书/TG 等凭证 |
| `scripts/imap.js` | `IMAP_ID` 常量——163邮箱需伪装客户端，其他邮箱可能不需要 |
| `scripts/email-watch.js` | `sendNotification()` 内的通知通道——可添加 Telegram/Discord |

### 迁移步骤
1. 复制整个 `email-auto-process/` 目录到新龙虾的 `~/.openclaw/workspace/skills/`
2. 修改 `.env`：填入新邮箱和新通知通道的凭证
3. （非 163 邮箱）修改 `scripts/imap.js`：
   - 如不需要 IMAP ID，删除 `ready` 事件中的 `sendIdCommand()` 调用
   - 如不需要 xoauth2 回退，删除 `createImapConfig()` 中的 `xoauth2: ''`
4. 运行 `node scripts/email-watch.js` 测试

### 支持其他通知通道（扩展指南）

在 `scripts/email-watch.js` 中 `CHANNELS` 对象里添加：
```javascript
CHANNELS.telegram = {
  async notify(text) {
    const url = `https://api.telegram.org/bot${CFG.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const d = JSON.stringify({ chat_id: CFG.TELEGRAM_CHAT_ID, text });
    // ... HTTPS 请求
  }
};
```
然后设置 `.env` 中 `NOTIFY_CHANNEL=telegram` 即可，无需修改流程代码。

## 脚本说明

| 脚本 | 说明 |
|------|------|
| `scripts/email-watch.js` | **主入口**：检查→下载→提取→通知 |
| `scripts/imap.js` | IMAP 操作：check(列新邮件)、download(下载附件)、send(回复) |
| `scripts/config.js` | IMAP 连接配置（从 .env 读取） |
| `scripts/ocr-local/ocr.js` | tesseract.js OCR 识别文字 |
| `scripts/pdf-to-images/convert_pdf_to_images.py` | PDF 转 JPG（Python + pymupdf） |

## 常见问题

### 163 邮箱 IMAP 连接失败
163 检测到非标准客户端会拒绝 SELECT 命令。需要在 IMAP ready 事件中先发送：
```
ID ("name" "Thunderbird" "version" "91.0")
```
`scripts/imap.js` 中已包含此逻辑（`IMAP_ID` 常量），不需要修改。

### PDF OCR 中文识别失败
确保 tesseract.js 下载了中文语言包：
```javascript
const Tesseract = require('tesseract.js');
await Tesseract.recognize(img, 'chi_sim+eng');
```
第一次运行会自动下载，可能需要几分钟。

### 飞书中文乱码
使用 Node.js 原生 https 模块直接发送 JSON。本 skill 已处理好编码问题。

## 网页自动填表提交流程

将 OCR 提取的合同数据自动填写到审批网页并提交。使用 `auto_fill_form.js`（Puppeteer，基于系统 Edge 浏览器）。

### 用法

```bash
# 填表 + 飞书确认 + 提交（完整流程）
node scripts/auto_fill_form.js --url "file:///path/to/form.html" --data ./contract_data.json

# 只填表不提交（--fill-only）
node scripts/auto_fill_form.js --url "file:///path/to/form.html" --data ./contract_data.json --fill-only

# 指定截图路径
node scripts/auto_fill_form.js --url "..." --data ./data.json --screenshot result.png
```

### 流程说明

默认模式（不传 `--fill-only`）：
1. **填表** — 打开页面，按字段映射 JSON 逐字段填写（优先 id → name 匹配）
2. **截图** — 截取完整页面保存
3. **飞书通知** — 发送确认消息给用户
4. **等待确认** — 写 `.fill_waiting.json` 标记文件，每 2 秒轮询（5 分钟超时）
5. **提交** — 主 agent 收到用户回复"提交"后改标记为 confirmed，脚本检测到后点击提交按钮
6. **弹窗处理** — dialog 事件触发时自动 accept，飞书通知结果

`--fill-only` 模式：只填表，保持浏览器打开，不触发提交流程。

### 字段匹配逻辑（fillField）
1. 按元素 `id` 匹配（支持 CSS 特殊字符转义）
2. 按 `name` 属性匹配
3. 跳过的字段打印 `[SKIP]`

### 支持的表单元素类型
- `<select>` — 下拉选择
- `<input type="date">` — 日期（JS 直接设 value + dispatch input 事件）
- `<input>` / `<textarea>` — 三次点击全选后 type 输入
- `<input type="checkbox/radio">` — 自动勾选/取消

### 弹窗处理
- 在点击按钮**前**注册 `page.on('dialog')` 监听
- 弹窗出现时立即 `dialog.accept()`（不要延迟）
- 否则会出现 `Protocol error: No dialog is showing` 错误

### 窗口显示
- `defaultViewport: null` — 不限制页面渲染区域
- `--start-maximized` — 窗口最大化，和手动打开的 Edge 显示一致
- 不给 `userDataDir` 时使用用户默认 Edge 配置（会与手动打开的 Edge 冲突，建议用独立配置）

### 迁移到其他机器需要修改
| 文件/变量 | 说明 |
|-----------|------|
| `auto_fill_form.js` 第 66 行 `EDGE_PATH` | Edge 可执行文件路径 |
| `.env` 中 `FEISHU_*` | 飞书应用凭证和接收人 Open ID |
| `.fill_waiting.json` 路径 | 由 `path.resolve(__dirname, '..')` 自动生成，不需手动改 |
| 默认截图路径 | `_fill_screenshot.png` 生成在 workspace 根目录 |

### 依赖
```bash
npm install puppeteer  # 或已包含在 package.json
```

### 工作流示例（邮箱→提取→填表）
```
邮件附件(PDF) → OCR提取 → contract_data.json → auto_fill_form.js → 填表 → 飞书确认 → 提交 → 完成
```
详见 [email-to-web.md](references/email-to-web.md)。

## 文件结构
```
email-auto-process/
├── .env                    # 配置（gitignore 建议忽略此文件）
├── .env.template           # 配置模板
├── package.json            # npm 依赖
├── SKILL.md
├── references/
│   └── email-to-web.md     # 邮件→提取→填表提交完整流程
└── scripts/
    ├── email-watch.js      # 邮箱监控主入口
    ├── auto_fill_form.js   # 网页自动填表提交（Puppeteer）
    ├── send-feishu.js      # 飞书消息发送工具
    ├── imap.js             # IMAP 操作
    ├── config.js           # IMAP 连接配置
    ├── test.json           # 填表测试数据
    ├── test_fill.bat       # 填表测试批处理
    ├── node_modules/
    ├── ocr-local/ocr.js
    └── pdf-to-images/convert_pdf_to_images.py
```
