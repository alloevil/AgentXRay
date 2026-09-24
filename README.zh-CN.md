# AgentXRay

**看清 coding agent 执行了什么，以及日志究竟验证了什么。**

直接读取本机会话日志，把失败、后台退出和修改后的检查追溯到原始证据。无需接入 SDK、调用模型或人工标注。

<p align="center">
  <img src="assets/readme/hero.svg" width="100%" alt="AgentXRay 执行证据：检查通过后又发生修改，下一次检查仍未知。概念时间线，不是任务通过的判定。">
</p>

[**在线体验**](https://alloevil.github.io/AgentXRay/) · [快速开始](#快速开始) · [证据与边界](#证据与边界) · [路线图](docs/ROADMAP.md) · [English](README.md)

[![测试](https://img.shields.io/github/actions/workflow/status/alloevil/AgentXRay/test.yml?label=tests)](https://github.com/alloevil/AgentXRay/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/@alloevil/agent-xray)](https://www.npmjs.com/package/@alloevil/agent-xray)
![Node.js](https://img.shields.io/badge/Node.js-22.13+-339933)
[![MIT 协议](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## 检查通过，不是故事的全部

一次会话可能同时记录了三件事：

1. 测试命令成功返回。
2. **测试之后**，修改工具又成功返回。
3. 没有记录到与这次修改关联的后续可识别检查。

AgentXRay 把这些记录放在一起，并提供原始调用与结果的跳转。它**不会**据此宣判代码有 bug、测试覆盖了修改文件，或任务已经完成。

我们关注的不是有多少个绿色结果，而是支持结论的执行证据。

## 快速开始

**无需安装：**打开[在线 Demo](https://alloevil.github.io/AgentXRay/)，点击 **体验自动体检 / Try diagnostics**。合成案例把 **7 条待闭合失败记录归为 2 个事件**，每条原始证据仍可访问。示例不含真实用户会话。

**查看自己的日志** — 需要 Node.js ≥ 22.13：

```sh
npx @alloevil/agent-xray --host 127.0.0.1
```

打开 **http://localhost:3800**，选择平台与会话，查看自动会话体检。默认读取受支持平台的常用目录，可在设置中修改；无需先填写人工标签。[其他安装方式与配置 →](docs/usage.zh-CN.md#安装)

**供 Agent、脚本或 CI 使用** — 不启动看板，只检查一个文件：

```sh
npx @alloevil/agent-xray inspect --platform omp /path/to/session.jsonl --json
```

将路径替换为你的日志；平台也可选 `codex` 或 `claude-code`。`npx` 可能联网下载包，安装后的 `inspect` 本身不发网络或模型请求，也不执行日志中的命令。

**退出码 0 表示报告生成成功，不代表任务通过。**[JSON 契约、覆盖检查与退出策略 →](docs/offline-inspect.md)

## 直接看证据

![AgentXRay 真实界面中的合成会话：修改—检查面板展示先前成功的测试、之后发生的修改，以及缺少可识别后续检查。](screenshots/verification-chronology.png)

*真实界面，合成数据。展开的面板区分先前测试、与修改重叠的检查和修改记录。[查看原尺寸截图](screenshots/verification-chronology.png)，或[运行可交互的时序演示](docs/diagnostics.md#修改与验证的先后顺序)。*

### 可以复现的报告

在安装好依赖的源码仓库中，检查已提交的合成 OMP 案例：

```sh
node bin/agentxray.js inspect --platform omp \
  frontend/demo/sample-logs/omp/-demo-diagnostics/2026-09-23T08-00-00-000Z_0199demo-diagnostics.jsonl --json
```

实际生成的 JSON 节选（其他字段省略）：

```json
{
  "summary": {
    "failureRecords": 8,
    "pendingRecords": 7,
    "pendingEvents": 2,
    "recoveredRecords": 1
  }
}
```

这里有 **8 条历史失败**；其中 **7 条仍待闭合，归为 2 个事件**，另 **1 条已有匹配的后续成功证据**。完整报告还包含原始行号、调用状态和规则哈希。这是日志事实，不是“8 个失败任务”，也不是完成度评分。

## 能检查什么

- **合并重复失败，不丢证据。**按工具、完整参数和用户轮次组织未闭合操作，保留每条原始结果；分组不等于根因诊断。
- **后台任务是否有结束证据。**追踪受支持的 Codex 启动 → 轮询 → 退出记录；启动不等于完成，ID 冲突保持未知。
- **修改前后的验证。**区分先前、重叠和后续检查；管道整体成功，不等于其中测试片段通过。
- **哪些情况仍未知。**显式展示缺失、执行中、取消和有歧义的结果，不把不完整日志涂成绿色。
- **完整会话上下文。**浏览工具参数、返回值、Trace 和子 Agent；跨平台搜索，按轮次查看 token 及日志已报告的费用。
- **可选工具，不是使用门槛。**添加复核笔记、迁移精确匹配的复核、整理 prompt 或归档会话；不使用这些功能也能查看自动证据。

[完整功能与截图集 →](docs/usage.zh-CN.md#功能特性) · [诊断规则及适用边界 →](docs/diagnostics.md)

## 兼容范围

**看板支持：**OpenClaw、Codex、Claude Code、Hermes、OMP、DeepSeek Harness、Gemini CLI。Hermes 使用 SQLite，其余六个适配器读取 JSONL 类日志。DeepSeek Harness 压缩日志需要 Node.js ≥ 22.15。

**离线 `inspect`：**仅支持 Codex、OMP、Claude Code；一次读取一个稳定的 UTF-8 JSONL 文件，上限 64 MiB。已知适配器信息丢失会报告覆盖不完整，不会假装结果干净。看板支持某种格式，不等于所有格式拥有同等诊断覆盖。

[默认目录与覆盖配置](docs/usage.zh-CN.md#配置) · [日志格式与路径](docs/usage.zh-CN.md#支持的日志格式)

## 证据与边界

**已实现并有测试：**本地浏览、确定性的执行证据规则、离线报告。UI 与 CLI 共用诊断源码；测试覆盖证据行号、保守匹配及先后顺序反例。[CLI 测试](test/inspect.test.js) · [界面与样例验证](docs/diagnostics-verification.md) · [公开数字的复算依据](claims.json)

**尚未证明：**提高真实 Agent 任务完成率、降低费用或节省开发者时间。[首轮合成实验](experiments/effectiveness-pilot/RESULTS.md)中，三组均通过 **12/12** 个任务，未证明 AgentXRay 优于机械摘要。实验代码位于 `experiments/`，不包含在 npm 安装包中，也不是产品默认行为。

**不是完成判官：**不推断根因、不自动修复、不证明测试覆盖，也不实时探测进程。缺少记录只是缺少证据，不能证明某件事没有发生。如果你需要埋点式生产 tracing 或托管团队服务，本机日志查看器不是那类产品。

### 本地优先，明确外发边界

核心日志浏览和 `inspect` 不把日志发给模型，UI 无外部 CDN 依赖。可选的 prompt 改写与建议会调用你配置的端点，或回退到可能访问远程服务的 `claude` CLI；Fabric 导入从 GitHub 下载内容，安装依赖可能访问包仓库。要求零模型外发时，请勿使用模型驱动的 prompt 功能。

单独运行的研究实验可使用通过门禁的脱敏副本调用远程模型，但不会随正常浏览或 `inspect` 启动。信息最小化和自动脱敏都**不是匿名保证**。[隐私与使用细节 →](docs/usage.zh-CN.md#常见问题)

## 文档与贡献

- [使用、配置与 HTTP API](docs/usage.zh-CN.md) · [English reference](docs/usage.md)
- [离线报告契约](docs/offline-inspect.md) · [自动证据与可选复核](docs/diagnostics.md)
- [路线图与验收标准](docs/ROADMAP.md) · [实验评测协议](experiments/prospective-study/REMOTE.md)
- [开发、测试与平台适配](docs/usage.zh-CN.md#开发) · [提交问题](https://github.com/alloevil/AgentXRay/issues)

反馈解析或证据问题时，请提供 CLI/版本、预期行为，以及**最小合成或谨慎脱敏的复现样本**。不要上传完整个人会话日志或凭据；可执行的复现比没有上下文的截图更有帮助。

## 开源协议

[MIT](LICENSE)
