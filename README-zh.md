# Paperclip 适配器 — Hermes Agent

一个 [Paperclip](https://paperclip.ing) 适配器，让你可以在 Paperclip 公司中将 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 作为托管员工运行。

Hermes Agent 是由 [Nous Research](https://nousresearch.com) 开发的全功能 AI 代理，具备 30+ 原生工具、持久记忆、会话持久化、80+ 技能、MCP 支持和多提供商模型接入能力。

## 核心特性

本适配器提供：

- **8 个推理提供商** — Anthropic、OpenRouter、OpenAI、Nous、OpenAI Codex、ZAI、Kimi Coding、MiniMax
- **技能集成** — 扫描 Paperclip 托管技能和 Hermes 原生技能（`~/.hermes/skills/`），支持同步/列表/解析 API
- **结构化对话解析** — 将 Hermes 原始 stdout 解析为类型化的 `TranscriptEntry` 对象，使 Paperclip 渲染带状态图标的工具卡片，支持展开/折叠
- **富文本后处理** — 将 Hermes ASCII 横幅、setext 标题和 `+--+` 表格边框转换为规范的 GFM Markdown
- **评论驱动唤醒** — 代理在收到 issue 评论时唤醒响应，而不仅限于任务分配
- **自动模型检测** — 读取 `~/.hermes/config.yaml`，自动在 UI 中预填用户配置的模型
- **会话编解码器** — 跨心跳进行会话状态的结构化校验与迁移
- **良性 stderr 重分类** — MCP 初始化消息和结构化日志被重分类，不会在 UI 中显示为错误
- **会话来源标记** — 会话被标记为 `tool` 来源，不会污染用户的交互历史
- **文件系统检查点** — 可选的 `--checkpoints` 功能，提供回滚安全性
- **思考强度控制** — 为思考/推理模型传递 `--reasoning-effort` 参数

### Hermes Agent 能力对比

| 功能 | Claude Code | Codex | Hermes Agent |
|------|------------|-------|-------------|
| 持久记忆 | ❌ | ❌ | ✅ 跨会话记忆 |
| 原生工具 | ~5 | ~5 | 30+（终端、文件、网页、浏览器、视觉、Git 等） |
| 技能系统 | ❌ | ❌ | ✅ 80+ 可加载技能 |
| 会话搜索 | ❌ | ❌ | ✅ FTS5 全文搜索历史对话 |
| 子代理委派 | ❌ | ❌ | ✅ 并行子任务 |
| 上下文压缩 | ❌ | ❌ | ✅ 自动压缩长对话 |
| MCP 客户端 | ❌ | ❌ | ✅ 连接任意 MCP 服务器 |
| 多提供商 | 仅 Anthropic | 仅 OpenAI | ✅ 开箱即用支持 8 个提供商 |

## 安装

```bash
npm install hermes-paperclip-adapter
```

### 前置条件

- 已安装 [Hermes Agent](https://github.com/NousResearch/hermes-agent)（`pip install hermes-agent`）
- Python 3.10+
- 至少一个 LLM API 密钥（Anthropic、OpenRouter 或 OpenAI）

## 快速开始

### 1. 在 Paperclip 服务器中注册适配器

在 Paperclip 服务器的适配器注册表（`server/src/adapters/registry.ts`）中添加：

```typescript
import * as hermesLocal from "hermes-paperclip-adapter";
import {
  execute,
  testEnvironment,
  detectModel,
  listSkills,
  syncSkills,
  sessionCodec,
} from "hermes-paperclip-adapter/server";

registry.set("hermes_local", {
  ...hermesLocal,
  execute,
  testEnvironment,
  detectModel,
  listSkills,
  syncSkills,
  sessionCodec,
});
```

### 2. 在 Paperclip 中创建 Hermes 代理

在 Paperclip UI 或通过 API 创建一个适配器类型为 `hermes_local` 的代理：

```json
{
  "name": "Hermes Engineer",
  "adapterType": "hermes_local",
  "adapterConfig": {
    "model": "anthropic/claude-sonnet-4",
    "maxIterations": 50,
    "timeoutSec": 300,
    "persistSession": true,
    "enabledToolsets": ["terminal", "file", "web"]
  }
}
```

### 3. 分配工作

在 Paperclip 中创建 issue 并分配给你的 Hermes 代理。每次心跳时，Hermes 会：

1. 接收任务指令
2. 使用完整的工具套件完成工作
3. 将结果报告回 Paperclip
4. 持久化会话状态以保持连续性

## 配置参考

### 核心配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `model` | string | `anthropic/claude-sonnet-4` | 模型，格式为 `provider/model` |
| `provider` | string | *（自动检测）* | API 提供商：`auto`、`openrouter`、`nous`、`openai-codex`、`zai`、`kimi-coding`、`minimax`、`minimax-cn` |
| `timeoutSec` | number | `300` | 执行超时时间（秒） |
| `graceSec` | number | `10` | SIGKILL 前的宽限期 |

### 工具配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `toolsets` | string | *（全部）* | 逗号分隔的要启用的工具集（如 `"terminal,file,web"`） |

可用工具集：`terminal`、`file`、`web`、`browser`、`code_execution`、`vision`、`mcp`、`creative`、`productivity`

### 会话与工作区

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `persistSession` | boolean | `true` | 跨心跳恢复会话 |
| `worktreeMode` | boolean | `false` | Git worktree 隔离模式 |
| `checkpoints` | boolean | `false` | 启用文件系统检查点以支持回滚 |

### 高级配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `hermesCommand` | string | `hermes` | 自定义 CLI 二进制路径 |
| `verbose` | boolean | `false` | 启用详细输出 |
| `quiet` | boolean | `true` | 静默模式（干净输出，无横幅/加载动画） |
| `extraArgs` | string[] | `[]` | 额外的 CLI 参数 |
| `env` | object | `{}` | 额外的环境变量 |
| `promptTemplate` | string | *（内置）* | 自定义提示词模板 |
| `paperclipApiUrl` | string | `http://127.0.0.1:3100/api` | Paperclip API 基础 URL |

### 提示词模板变量

在 `promptTemplate` 中使用 `{{variable}}` 语法：

| 变量 | 说明 |
|------|------|
| `{{agentId}}` | Paperclip 代理 ID |
| `{{agentName}}` | 代理显示名称 |
| `{{companyId}}` | 公司 ID |
| `{{companyName}}` | 公司名称 |
| `{{runId}}` | 当前心跳运行 ID |
| `{{taskId}}` | 分配的任务/issue ID |
| `{{taskTitle}}` | 任务标题 |
| `{{taskBody}}` | 任务指令内容 |
| `{{projectName}}` | 项目名称 |
| `{{paperclipApiUrl}}` | Paperclip API 基础 URL |
| `{{commentId}}` | 评论 ID（被评论唤醒时） |
| `{{wakeReason}}` | 本次运行的触发原因 |

条件段落：

- `{{#taskId}}...{{/taskId}}` — 仅在分配了任务时包含
- `{{#noTask}}...{{/noTask}}` — 仅在无任务时包含（心跳检查）
- `{{#commentId}}...{{/commentId}}` — 仅在被评论唤醒时包含

## 架构

```
Paperclip                          Hermes Agent
┌──────────────────┐               ┌──────────────────┐
│  心跳             │               │                  │
│  调度器           │───execute()──▶│  hermes chat -q  │
│                  │               │                  │
│  Issue 系统      │               │  30+ 工具        │
│  评论唤醒        │◀──结果─────────│  记忆系统        │
│                  │               │  会话数据库       │
│  费用追踪        │               │  技能            │
│                  │               │  MCP 客户端       │
│  技能同步        │◀──快照──────────│  ~/.hermes/skills│
│  组织架构        │               │                  │
└──────────────────┘               └──────────────────┘
```

适配器以单次查询模式（`-q`）启动 Hermes Agent 的 CLI。Hermes 使用其完整的工具套件处理任务，然后退出。适配器会：

1. **捕获** stdout/stderr 并解析 token 使用量、会话 ID 和费用
2. **解析** 原始输出为结构化的 `TranscriptEntry` 对象（带状态图标的工具卡片）
3. **后处理** Hermes ASCII 格式（横幅、setext 标题、表格边框）为规范的 GFM Markdown
4. **重分类** 良性 stderr（MCP 初始化、结构化日志）使其不显示为错误
5. **标记** 会话为 `tool` 来源，与交互使用分离
6. **报告** 结果回 Paperclip，包含费用、使用量和会话状态

会话持久化通过 Hermes 的 `--resume` 标志实现——每次运行从上次中断处继续，跨心跳维护对话上下文、记忆和工具状态。`sessionCodec` 负责在运行之间校验和迁移会话状态。

### 技能集成

适配器扫描两个技能来源并合并：

- **Paperclip 托管技能** — 随适配器捆绑，可通过 UI 切换
- **Hermes 原生技能** — 来自 `~/.hermes/skills/`，只读，始终加载

`listSkills` / `syncSkills` API 暴露统一快照，使 Paperclip UI 能在一个视图中同时展示托管技能和原生技能。

## 开发

```bash
git clone https://github.com/NousResearch/hermes-paperclip-adapter
cd hermes-paperclip-adapter
npm install
npm run build
```

## 许可证

MIT — 详见 [LICENSE](LICENSE)

## 相关链接

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — 本适配器运行的 AI 代理
- [Paperclip](https://github.com/paperclipai/paperclip) — 编排平台
- [Nous Research](https://nousresearch.com) — Hermes 背后的团队
- [Paperclip 文档](https://paperclip.ing/docs) — Paperclip 官方文档
