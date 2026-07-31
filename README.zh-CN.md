# AgentXRay

AI Agent 会话 X 光透视工具，支持 **OpenClaw**、**Codex**、**Claude Code**、**Hermes** 和 **OMP** —— 一个界面全搞定。

[English](README.md) | 中文

![Main View](screenshots/main-view.png)

## 功能特性

- **多平台支持** — 一个界面统一查看 OpenClaw、Codex、Claude Code、Hermes、OMP 的会话日志
- **会话浏览** — 浏览 Agent 列表，搜索/过滤会话，查看消息历史
- **工具调用检查** — 可展开的工具调用详情，包含参数和返回结果
- **Trace 视图** — 每轮对话的耗时瀑布图：模型推理（蓝）与工具执行（绿，出错为红）一目了然，点击色条跳转到对应消息
- **Prompt 提取** — 按 session 提取全部真人 prompt（自动过滤工具结果、斜杠命令、系统注入等噪音），按工作目录分组，支持搜索 / JSON 导出 / 复制
- **Prompt 优化** — 相似 prompt 自动聚类成模板，结合 session 效果归因（轮次、工具调用、错误率），通过本机 `claude` CLI 生成改写建议
- **Prompt 资产库** — 把值得复用的 prompt 收进 `~/.agentxray/library`，支持标签 / 编辑 / 搜索，一键安装为 Claude Code、Codex、OMP 的原生 slash command（`$ARGUMENTS` 原样保留，在目标 CLI 里 `/名字 参数` 直接可用）
- **全局搜索** — 一个搜索框同时搜五个平台，多关键词 AND 匹配，每条结果带平台色标 —— 包含从被 Claude Code 清理掉的会话里恢复出来的 prompt
- **会话洞察** — 聚合分析面板：工具统计、错误聚类、每日趋势
- **Spawn 追踪** — 检测并导航父子 Agent 之间的调用关系
- **OMP 子 Agent** — OMP 会话派生的子 Agent 会在摘要区以标签列出，点击即可查看子 Agent 的完整对话
- **消息时间线** — 可视化对话流程图，不同角色用不同颜色标识
- **Resume 命令** — 一键复制该会话在原 CLI 中的续跑命令（`codex resume`、`claude --resume`、`omp --resume=`）
- **摘要可折叠** — 需要更多阅读空间时可折叠会话摘要
- **自动刷新** — 会话列表和消息实时更新
- **设置面板** — 在页面上直接配置各平台目录，保存到 localStorage，无需重启
- **会话备份** — 增量归档会话日志到 `~/.agentxray/archive`，在设置面板一键触发（也会每天自动执行），未变化的文件自动跳过
- **键盘导航** — 使用方向键在会话之间切换

## 截图预览

### 会话浏览

侧边栏浏览 Agent 和会话列表。每个会话卡片显示按角色分类的消息数（👤 用户、🤖 助手、🔧 工具）和 spawn 标记。主面板展示会话元数据、Token 用量和热门工具概览。

![Main View](screenshots/main-view.png)

### 工具调用检查

展开任意工具调用可查看其参数和返回结果。折叠状态下按工具类型显示调用次数，方便快速扫视。

![Tool Calls](screenshots/tool-calls.png)

### Spawn 追踪

含有子 Agent 的会话会标注 🔗 徽章。点击可导航父子 Agent 调用链。

![Spawn Tracking](screenshots/spawn-tracking.png)

### 多平台支持

一键切换 OpenClaw、Codex、Claude Code、Hermes。每个平台的会话均从其原生日志格式解析。

![Codex View](screenshots/codex-view.png)

### 设置面板

在页面上配置各平台目录，保存到 localStorage，无需重启服务。

![Settings](screenshots/settings-panel.png)

## 快速开始

```bash
git clone https://github.com/alloevil/agent-xray.git
cd agent-xray
npm install
npm start
```

打开 http://localhost:3800

## 使用方法

### 基本流程

1. **选择平台** — 点击顶部 `OpenClaw`、`Codex`、`Claude Code` 或 `Hermes`
2. **选择 Agent** — OpenClaw 平台下，从下拉菜单选择 Agent（如 `xiaot`、`mimo`）
3. **浏览会话** — 会话按时间倒序排列，每张卡片显示：
   - 时间戳和状态（`active` / `archived`）
   - 消息计数：👤 用户、🤖 助手、🔧 工具调用
   - 🔗 Spawn 标记（如果该会话产生了子 Agent）
4. **查看消息** — 点击会话加载完整对话
5. **检查工具调用** — 点击 `🔧 tool_name` 按钮展开参数/结果
6. **导航 Spawn** — 点击 🔗 链接跳转到子 Agent 会话

### Prompt 视图

点击顶部 **Prompts** 标签（Sessions / Insights 旁），即可看到所有 session 的真人 prompt，按 session 所属工作目录分组。工具结果、斜杠命令回显、系统提醒、任务通知等噪音会被自动过滤。

- **预览与展开** — 每个 session 行内直接预览首条 prompt，点击展开完整列表（markdown 渲染）
- **搜索** — 实时过滤 prompt / 目录 / session
- **Export JSON** — 导出全部提取的 prompt 用于离线处理
- **分析优化** — 相似 prompt 聚类成模板，结合每个模板的 session 效果归因（平均轮次、工具调用、错误率），由 Claude 生成模板改写建议。需要服务器 PATH 中有 [`claude` CLI](https://claude.com/claude-code)；没有时聚类和归因表格仍可用
- **优化单条** — 悬停任意 prompt 点击「优化」，内联生成 Claude 改写版本

### 键盘快捷键

| 按键 | 操作 |
|------|------|
| `↑` / `↓` | 在会话间切换 |
| `Enter` | 选中高亮的会话 |

### 过滤与搜索

- **搜索框** — 按 ID 或内容过滤会话
- **包含已归档** — 切换显示/隐藏已归档（`.reset.*` / `.deleted.*`）会话
- **自动刷新** — 自动轮询获取新会话和消息
- **自动滚动** — 新内容到达时自动滚动到最新消息

## 配置

### 默认目录

| 平台        | 默认路径                      |
|-------------|-------------------------------|
| OpenClaw    | `~/.openclaw/agents`          |
| Codex       | `~/.codex/sessions`           |
| Claude Code | `~/.claude/projects`          |
| Hermes      | `~/.hermes`                   |
| OMP         | `~/.omp/agent/sessions`       |

### 自定义目录

**通过页面设置：** 点击侧边栏的齿轮图标，为每个平台设置自定义路径。保存到 localStorage，无需重启服务。

**通过环境变量：**

```bash
OPENCLAW_DIR=/custom/path/openclaw \
CODEX_DIR=/custom/path/codex \
CLAUDE_CODE_DIR=/custom/path/claude \
HERMES_DIR=/custom/path/hermes \
OMP_DIR=/custom/path/omp \
npm start
```

**通过 API：** 在任意 API 请求后附加 `?dir=/absolute/path` 参数。

## API

| 接口 | 说明 |
|------|------|
| `GET /api/agents` | 获取 OpenClaw Agent 列表 |
| `GET /api/agents/:name/sessions` | 获取指定 Agent 的会话列表 |
| `GET /api/agents/:name/sessions/:id` | 获取会话消息详情 |
| `GET /api/codex/sessions` | 获取 Codex 会话列表 |
| `GET /api/codex/sessions/:id` | 获取 Codex 会话消息详情 |
| `GET /api/claude-code/sessions` | 获取 Claude Code 会话列表 |
| `GET /api/claude-code/sessions/:id` | 获取 Claude Code 会话消息详情 |
| `GET /api/hermes/sessions` | 获取 Hermes 会话列表 |
| `GET /api/hermes/sessions/:id` | 获取 Hermes 会话消息详情 |
| `GET /api/omp/sessions` | 获取 OMP（oh-my-pi）会话列表 |
| `GET /api/omp/sessions/:id` | 获取 OMP 会话消息详情 |
| `GET /api/spawn-map` | 获取 Agent spawn 关系图 |
| `GET /api/insights` | 聚合分析（工具统计、错误聚类、趋势） |
| `GET /api/prompts` | 按目录分组的各 session 真人 prompt |
| `GET /api/prompts/analyze` | 模板聚类 + 效果归因 + Claude 建议（`?refresh=1` 重算，`?skipLlm=1` 仅聚类） |
| `POST /api/prompts/rewrite` | 通过 claude CLI 改写单条 prompt（`{ "text": "..." }`） |
| `GET /api/search` | 会话全文搜索（`?platform=all` 一次搜索全部平台，多关键词 AND） |
| `GET /api/omp/sessions/:id/children` | 获取该 OMP 会话派生的子 Agent 列表 |
| `GET /api/omp/sessions/:id/children/:name` | 获取指定子 Agent 的消息详情 |
| `GET /api/library` | 获取资产库 prompt 列表（含各目标的安装状态） |
| `POST /api/library` | 新建 prompt（`{ "name": "...", "content": "...", "description": "...", "tags": [...] }`） |
| `PUT /api/library/:name` | 更新 / 重命名 prompt（`newName`、`content`、`description`、`tags`），已安装的副本同步刷新 |
| `DELETE /api/library/:name` | 删除 prompt 及其已安装的 slash command |
| `POST /api/library/:name/install` | 安装为 slash command（`{ "targets": ["claude", "codex", "omp"] }`） |
| `POST /api/library/:name/uninstall` | 卸载已安装的 slash command（请求体同上） |
| `POST /api/library/suggest-name` | 通过 claude CLI 为 prompt 生成库内命名（`{ "text": "..." }`，CLI 不可用时返回 `null`） |
| `POST /api/backup` | 执行一次增量备份到 `~/.agentxray/archive` |
| `GET /api/backup/status` | 归档统计：文件数、总字节数、最近备份时间 |

所有列表和详情接口均支持 `?dir=` 参数来覆盖默认目录。

## 技术栈

- **后端：** Node.js + Express
- **前端：** 单文件 HTML/CSS/JS（无构建步骤，无框架依赖）
- **数据：** 直接从磁盘读取 JSONL 会话文件 / SQLite 数据库
- **零外部 CDN** — 完全自包含，离线可用

## 支持的日志格式

| 平台 | 格式 | 路径模式 |
|------|------|----------|
| OpenClaw | JSONL | `~/.openclaw/agents/{agent}/sessions/{id}.jsonl` |
| Codex | JSONL | `~/.codex/sessions/{id}.jsonl` |
| Claude Code | JSONL | `~/.claude/projects/*/sessions/*/session.jsonl` |
| Hermes | SQLite | `~/.hermes/state.db` |
| OMP | JSONL | `~/.omp/agent/sessions/*/{timestamp}_{id}.jsonl` |

启用「包含已归档」后，还会显示 `.jsonl.reset.*` 和 `.jsonl.deleted.*` 的归档会话。

## 开源协议

MIT
