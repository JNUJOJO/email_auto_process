# email-to-web 邮件附件自动填表 Skill

## 场景

收到一封带合同的邮件 → 提取合同内容 → 飞书发给你确认 → 你回复"提交审批" → 打开审批网页自动填入 → 提交 → 截图发回飞书。

**核心能力**：将邮箱监控（email-auto-process）与网页自动填表（pdf-contract-auto-fill）串联为一个完整闭环。

## 工作流程

```
新邮件(带附件)
  │
  ▼
email-auto-process: 下载附件 → 提取内容(文本/PDF OCR)
  │
  ▼
整理字段映射JSON（从OCR提取的原始文本→结构化字段）
  │
  ▼
飞书通知："收到[合同名]，内容摘要如下，是否提交审批？"
  │
  ← 你回复："提交审批，页面是 http://xxx"
  │
  ▼
auto_fill_form.py --html <审批页面> --data <字段JSON>
  │
  ▼
填表 → 点击提交 → 处理弹窗 → 截图
  │
  ▼
飞书回传截图 + 结果确认
```

## 前置依赖

```bash
# 邮箱监控（已在 email-auto-process 中配好）
cd email-auto-process/scripts && npm install
pip install pymupdf

# 自动填表
pip install playwright
```

## 核心脚本

### `scripts/auto_fill_form.py`
来自 pdf-contract-auto-fill skill，接收参数：
```bash
python scripts/auto_fill_form.py \
  --html "审批页面.html" \
  --data ./contract_data.json \
  --screenshot result.png
```

支持：
- 按页面元素 `id` 或 `name` 匹配填表
- SELECT 下拉框自动选择
- 弹窗自动 accept
- 慢速模式逐字段填写
- 截图保存
- 保持浏览器打开（默认）确认结果

### `scripts/email-watch.js`
来自 email-auto-process skill，接收邮件→提取内容→飞书。
当你在飞书回复"提交"时，脚本调用 `auto_fill_form.py` 完成剩下的工作。

## 字段映射

从PDF/Word/Excel提取的原始文本需要转为字段JSON。例如：

OCR原始文本：
```
采购合同
合同编号: SYSU-CG-2026-0428
甲方: 中山大学
合同金额: 187,500.00元
```

转为字段映射：
```json
{
  "contract_name": "采购合同",
  "contract_no": "SYSU-CG-2026-0428",
  "contract_party_a": "中山大学",
  "contract_amount": "187500.00"
}
```

## 注意事项（踩坑汇总）

### 1. 先检查幂等
收到"提交审批"指令后，先看审批页面上是否已有相同合同的提交记录，避免重复提交。

### 2. 弹窗监听必须在点击前注册
```python
page.on("dialog", on_dialog)  # 先注册
await submit_btn.click()       # 再点击
```

### 3. 字段匹配优先级
```
id > name > 文本标签
```
`auto_fill_form.py` 内建了这三种匹配方式。

### 4. PowerShell Unicode 输出
脚本内用 `safe_print()` 替代 `print()`，去掉非ASCII字符避免报错。

### 5. 不杀Edge进程
填表完默认保持浏览器打开，让用户手动关闭，不要 `Stop-Process msedge`。

## 迁移指南

这套流程依赖两个技能，迁移到新龙虾需要：
1. 复制 `email-auto-process/` 目录
2. 复制 `pdf-contract-auto-fill/scripts/auto_fill_form.py`
3. 复制 `ocr-local/`（OCR用）
4. 复制 `pdf-to-images/`（PDF转图用）
5. 修改 `.env`
6. 装依赖：`npm install` + `pip install pymupdf playwright`
