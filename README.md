# Email Auto Process — 邮箱自动处理系统说明书

> 版本 1.0 | 最后更新 2026-04-30  
> 作者：张泽 ⚡（OpenClaw 数字助手）

---

## 一、概述

这是一个**邮箱自动监控 + PDF 合同提取 + 网页自动填表**的一体化工具。

收到带附件的邮件后，系统自动：
1. 下载附件
2. 提取文字内容（PDF 自动 OCR 识别）
3. 通过飞书通知你摘要
4. 等待你确认后，自动打开审批网页填表提交

**一句话：邮件来了→内容提取→飞书通知→等你确认→自动填表提交。**

---

## 二、系统架构

### 2.1 整体流程图

```
📧 163邮箱
   │
   ▼ (每10分钟IMAP检查)
email-watch.js ─── 有附件? ──→ 下载附件
   │                                │
   │                           ┌────┴────┐
   │                           │ 文本类   │ 直接读取内容（限1000字）
   │                           │ PDF     │ → convert_pdf_to_images.py(转图片)
   │                           │         │ → ocr.js(识别文字)
   │                           │ 其他    │ 仅记录文件名和大小
   │                           └────┬────┘
   │                                │
   ▼                                ▼
飞书通知（摘要 + 内容 + "请告诉我怎么处理"）
   │
   │ (你回复指令)
   ▼
auto_fill_form.js ──→ 打开审批网页 → 自动填入 → 截图
   │                                    │
   ▼                                    ▼
飞书通知（等待确认"提交"）        飞书回传结果
```

### 2.2 文件结构

```
C:\Users\Lenovo\.openclaw\workspace\skills\email-auto-process\
│
├── .env                          ← 所有配置（邮箱凭证、飞书凭证等）
├── .env.template                 ← 配置模板（填配置时参照）
├── .email-watch-state.json       ← 运行状态缓存（自动生成，勿删）
├── SKILL.md                      ← OpenClaw 技能定义
│
├── references/
│   └── email-to-web.md           ← 邮件→填表完整流程说明
│
└── scripts/
    ├── email-watch.js            ← 🎯 主程序（入口）
    ├── auto_fill_form.js         ← 网页自动填表（Puppeteer + Edge）
    ├── imap.js                   ← IMAP 邮箱操作
    ├── config.js                 ← 配置读取模块
    ├── ocr-local/ocr.js          ← 图片文字识别（Tesseract.js）
    ├── pdf-to-images/convert_pdf_to_images.py  ← PDF转图片（PyMuPDF）
    ├── chi_sim.traineddata       ← 中文OCR语言包（自动下载）
    ├── eng.traineddata           ← 英文OCR语言包（自动下载）
    ├── package.json              ← Node.js 依赖清单
    ├── package-lock.json         ← 依赖锁定文件
    └── node_modules/             ← 第三方依赖（npm install 生成）
```

---

## 三、使用准备

### 3.1 安装依赖

```bash
# 进入脚本目录
cd C:\Users\Lenovo\.openclaw\workspace\skills\email-auto-process\scripts

# 安装 Node.js 依赖
npm install

# 安装 Python 依赖（PDF 转图用）
pip install pymupdf>=1.23.0
```

### 3.2 配置文件（.env）

`.env` 是全部配置的唯一入口，位于 `email-auto-process/.env`。

#### 邮箱配置

```ini
IMAP_HOST=imap.163.com          # IMAP 服务器
IMAP_PORT=993                    # IMAP 端口（SSL 一般是 993）
IMAP_USER=your@163.com          # 邮箱地址
IMAP_PASS=你的授权码             # 邮箱密码或授权码
IMAP_TLS=true                    # 是否使用 SSL/TLS

SMTP_HOST=smtp.163.com          # SMTP 服务器（如需回复邮件）
SMTP_PORT=465                    # SMTP 端口
SMTP_USER=your@163.com          # 发件地址
SMTP_PASS=你的授权码             # 发件密码
```

> **关于163邮箱授权码**：需要在 163 网页端「设置→POP3/SMTP/IMAP」中开启 IMAP，并获取授权码（不是登录密码）。

#### 飞书通知配置

```ini
NOTIFY_CHANNEL=feishu

FEISHU_APP_ID=cli_xxx            # 飞书自建应用的 App ID
FEISHU_APP_SECRET=xxx            # 飞书自建应用的 App Secret
FEISHU_OPEN_ID=ou_xxx           # 你的飞书 Open ID（消息接收人）
```

> 飞书应用需要在「飞书开放平台 → 应用 → 权限管理」中开启 `im:message` 权限，并发布上线。

#### 邮箱过滤（可选）

```ini
# 系统邮件发件人正则，匹配到的自动跳过
SYSTEM_MAIL_FROM=@service\.netease\.com|@club\.service\.netease\.com

# 系统邮件主题正则
SYSTEM_MAIL_SUBJECT=欢迎来到|邮件办公|新设备登录|恭喜
```

#### 云附件链接模式（可选）

```ini
# 匹配 QQ邮箱超大附件、网易云附件等，只展示链接不下载
CLOUD_LINK_PATTERNS=wx\.mail\.qq\.com/ftn/download\?[^\s\"'<>]+|dashi\.163\.com/html/cloud-attachment-download/
```

---

## 四、主要功能详解

### 4.1 邮箱监控（email-watch.js）

这是整个系统的**主入口**，按以下流程处理每封新邮件：

#### 步骤 1：检测新邮件
- 通过 IMAP 连接邮箱，获取最近 10 封邮件
- 对比 `lastUids` 状态文件，识别哪些是新邮件
- 跳过系统邮件（如欢迎邮件、安全提醒）

#### 步骤 2：处理附件
| 附件类型 | 处理方式 | 内容限制 |
|---------|---------|---------|
| .txt、.md、.csv、.json 等文本 | 直接读取文件内容 | 最多 1000 字 |
| .pdf | PyMuPDF 转 JPG → Tesseract.js OCR 识别 | 最多 2000 字 |
| 其他类型（图片、压缩包等） | 仅记录文件名和大小 | — |

#### 步骤 3：发送通知
通过飞书发送消息，格式如下：

```
📧 收到新邮件

发件人: xxx
主题: xxx
时间: 2026-04-30 09:00

正文: xxx

📎 合同样例.pdf (410.7KB)
━ 内容 ━
[第1页]
采购合同
合同编号: SYSU-CG-2026-0428
...

请告诉我怎么处理
```

#### 重复发送防抖
- 同一封邮件只会通知一次（记录在 `sentUids`）
- 最多记录最近 50 封已发送 UID

### 4.2 网页自动填表（auto_fill_form.js）

接收字段映射 JSON，用 Puppeteer 控制系统 Edge 浏览器自动填写网页表单。

#### 命令用法

```bash
# 1. 完整流程：填表 + 截图 + 飞书确认 + 等待提交
node auto_fill_form.js --url "审批页面URL" --data ./contract_data.json

# 2. 只填表不提交（填完保持浏览器打开，手动操作）
node auto_fill_form.js --url "审批页面URL" --data ./contract_data.json --fill-only

# 3. 指定截图路径
node auto_fill_form.js --url "..." --data ./data.json --screenshot result.png
```

#### 字段匹配规则

按优先级匹配表单元素：
1. **id 匹配** — `#contract_name` 找到 `<input id="contract_name">`
2. **name 匹配** — `[name="contract_name"]` 找到 `<input name="contract_name">`
3. **label 关联** — 通过 `<label for="...">` 定位（当前版本已经内建）

#### 支持的表单控件

| 控件类型 | 填表方式 |
|---------|---------|
| `<input type="text">` | 三次点击全选后逐字符输入 |
| `<input type="number">` | 同上 |
| `<input type="date">` | JS 直接设 value + 触发 input 事件 |
| `<textarea>` | 三次点击全选后逐字符输入 |
| `<select>` | 按 option value 选择 |
| `<input type="checkbox/radio">` | 根据 true/false 勾选或取消 |

#### 完整工作流（不带 --fill-only）

1. **打开页面** → 等待 `networkidle0`
2. **填写表单** → 逐字段填入，成功打印 `[OK]`，找不到打印 `[SKIP]`
3. **截图** → 保存全页面截图
4. **飞书通知** → 发送"合同已填写完成，是否点击提交？"
5. **等待回复** → 创建 `.fill_waiting.json` 标记文件，每 2 秒轮询
6. **提交表单** → 收到"提交"指令后点击提交按钮
7. **弹窗处理** → dialog 弹窗自动 accept
8. **结果通知** → 飞书发送"已提交成功"或超时提醒
9. **保持浏览器打开** → 让用户手动关闭

---

## 五、定时运行

系统配置了 cron 定时任务，每 **10 分钟**自动检查邮箱。

### 5.1 当前定时任务

```bash
openclaw cron add \
  --name "邮箱监控" \
  --every 10m \
  --system-event "[email-watch] 检查新邮件定时触发"
```

### 5.2 修改检查频率

```bash
# 例如改为每 5 分钟一次
openclaw cron update <job-id> --every 5m

# 查看任务列表
openclaw cron list

# 删除任务
openclaw cron remove <job-id>
```

---

## 六、运行状态文件

| 文件 | 位置 | 用途 | 能否删除 |
|------|------|------|---------|
| `.email-watch-state.json` | skill 根目录 | 记录已处理的邮件 UID，防止重复通知 | ❌ 不可删（已处理记录丢失） |
| `.fill_waiting.json` | skill 根目录 | 填表等待确认标记，记录等待状态 | ❌ 不可删（运行中不要动） |
| 下载的附件 | `~/Downloads/email-attachments/` | 附件暂存 | ✅ 可定期清理 |

---

## 七、迁移到新机器

### 7.1 需要拷贝的文件

只需复制 `email-auto-process/` 整个目录，所有配置和代码都在里面。

### 7.2 需要修改的设置

| 项 | 位置 | 说明 |
|---|------|------|
| 邮箱凭证 | `.env` 中 IMAP_* / SMTP_* | 换邮箱必须改 |
| 飞书凭证 | `.env` 中 FEISHU_* | 换应用必须改 |
| Edge 路径 | `auto_fill_form.js` 第 65 行 `EDGE_PATH` | 不同机器路径可能不同 |
| IMAP ID 伪装 | `imap.js` 中 `IMAP_ID` 常量 | 非 163 邮箱可能不需要 |

### 7.3 需要安装的依赖

```bash
cd scripts && npm install
pip install pymupdf>=1.23.0
```

### 7.4 对于非 163 邮箱

修改 `scripts/imap.js`：
- 如不需要 IMAP ID 伪装，删除 `ready` 事件中的 `sendIdCommand()` 调用
- 如不需要 xoauth2 回退，删除 `createImapConfig()` 中的 `xoauth2: ''`

---

## 八、常见问题

### Q1: IMAP 连接失败怎么办？

163 邮箱会检测非标准客户端。`imap.js` 已内置伪装逻辑，自动发送：
```
ID ("name" "openclaw" "version" "0.0.1")
```
如果还报错，去 163 网页端检查 IMAP 是否已开启。

### Q2: PDF OCR 中文识别失败/乱码？

第一次运行 OCR 时会自动下载语言包（`chi_sim.traineddata`），国内网络可能下载慢。也可以手动下载文件放到 `scripts/` 目录。

### Q3: 填表时元素找不到？

优先检查审批页面的 HTML 结构。字段映射 JSON 的 key 需要和页面元素的 `id` 或 `name` 一致。可以用浏览器开发者工具查看元素属性。

### Q4: 飞书没有收到通知？

检查几点：
1. `.env` 中 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_OPEN_ID` 是否正确
2. 飞书应用是否已线上发布
3. 应用权限中是否开启了 `im:message` 权限

### Q5: 填表提交时弹窗问题？

脚本已内置 `page.on('dialog')` 监听，在点击提交按钮前注册。如果还出现问题，检查：
- 弹窗是否在页面加载时就出现（需要额外处理）
- 弹窗类型是否不是简单的 confirm（alert 也支持）

---

## 九、扩展指南

### 添加 Telegram 通知通道

在 `scripts/email-watch.js` 的 `CHANNELS` 对象中添加：

```javascript
CHANNELS.telegram = {
  async notify(text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const d = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text });
    // 用 https 模块发送 POST 请求
  }
};
```

然后在 `.env` 中设置：
```ini
NOTIFY_CHANNEL=telegram
TELEGRAM_BOT_TOKEN=xxx
TELEGRAM_CHAT_ID=xxx
```

### 添加其他通知通道

实现 `notify(text)` 方法即可，无缝接入现有流程代码。

---

## 十、技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| 邮箱协议 | IMAP（`node-imap`） | 检查、下载附件 |
| 邮件解析 | `mailparser` | 解析邮件头和正文 |
| PDF 转图 | PyMuPDF（`fitz`） | Python，每页转 JPG |
| OCR | Tesseract.js | 本地识别，无需 API Key |
| 浏览器自动化 | Puppeteer | 控制 Edge 填表 |
| 通知通道 | 飞书 API（HTTPS） | 发送消息到飞书 |
| 运行环境 | Node.js + Python | 双语言配合 |

---

## 十一、版本历史

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-04-29 | 1.0.0 | 初始版本，邮箱监控 + PDF OCR |
| 2026-04-30 | 1.1.0 | 整合 auto_fill_form.js（Puppeteer），删减冗余文件 |
