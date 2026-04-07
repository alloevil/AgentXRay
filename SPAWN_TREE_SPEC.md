# Spawn Tree 可视化设计稿

## 目标

将现有的扁平 spawn chip（🔗 SPAWN）升级为跨 session 的树形可视化，展示 parent → child → grandchild 的完整 spawn 链路。这是 AgentXRay 的差异化功能。

## 定位

- **独立面板**，不侵入现有的 session 消息视图
- 入口：Session 侧边栏顶部新增 "🌳 Spawn Tree" 按钮，点击切换到树形面板
- 也可从全局视图（All Sessions）进入，看整个 spawn 森林

## 数据模型

### 后端 API：`GET /api/spawn-tree`

```
返回：
{
  "trees": [
    {
      "id": "session-id-根节点",
      "agent": "xiaot",
      "label": "主 agent",
      "task": "原始任务的前 80 字符...",
      "timestamp": "2026-04-07T10:00:00Z",
      "depth": 0,
      "children": [
        {
          "id": "spawned-session-id",
          "agent": "xiaot",
          "label": "coding-agent",
          "task": "子任务描述...",
          "timestamp": "2026-04-07T10:00:05Z",
          "depth": 1,
          "children": [
            {
              "id": "grandchild-session-id",
              "agent": "codex",
              "label": null,
              "task": "孙任务...",
              "timestamp": "2026-04-07T10:00:12Z",
              "depth": 2,
              "children": []
            }
          ]
        }
      ]
    }
  ],
  "orphanCount": 3  // 有 parent 但 parent 不在数据集里的节点数
}
```

### 建树逻辑（server.js）

1. 复用 `buildSpawnMap()` 获取扁平 `spawnLinks[]`
2. 建立 `session → children` 索引 `Map<string, SpawnLink[]>`
3. 建立 `childSession → parent` 反向索引
4. 识别根节点：出现在 parent 但不出现在 child 的 session
5. 递归构建树，`maxDepth = 6`（超过截断显示 "+N more"）
6. 每个节点附加 session 元信息（从 session 文件读取：agent 名、首条消息摘要、时间戳）

### 前端渲染

#### 视觉方案：纯 CSS 竖向树（零依赖）

```
┌─────────────────────────────────────────────────┐
│ 🌳 Spawn Tree                         [Collapse]│
├─────────────────────────────────────────────────┤
│                                                  │
│  ● xiaot (主)          15:54:12                  │
│  │  "分析 CrossBeam 项目..."                     │
│  │                                               │
│  ├── ● coding-agent    15:54:15  [2m 30s]        │
│  │   │  "写 sandbox.ts 重写..."                   │
│  │   │                                           │
│  │   ├── ● codex        15:54:20  [45s]          │
│  │   │      "解析 JSON schema..."                 │
│  │   │                                           │
│  │   └── ● claude-code  15:54:22  [1m 12s]       │
│  │          "生成 Python pipeline..."             │
│  │                                               │
│  └── ● subagent        15:55:00  [8s]            │
│         "查飞书文档权限..."                       │
│                                                  │
│  ● xiaot (主)          16:20:00                  │
│  │  "第二个根任务..."                             │
│  └── ● workspace-mimo  16:20:05  [3m]            │
│        "生成报告..."                              │
│                                                  │
└─────────────────────────────────────────────────┘
```

#### 节点卡片设计

每个节点是一个可点击的卡片，深色主题：

```
┌──────────────────────────────────────┐
│ ● agent-name              HH:MM:SS  │
│   "task preview (truncated)..."      │
│   ⏱ duration    🔗 open session →   │
└──────────────────────────────────────┘
```

- **左竖线/横线**：CSS `border-left` + `border-bottom` 实现树形连接线
- **节点圆点**：根节点蓝色 `#58a6ff`，子节点橙色 `#f0883e`，叶子节点灰色 `#8b949e`
- **展开/折叠**：子节点 > 2 个时默认折叠，点击 `▸ N children` 展开
- **悬停效果**：卡片高亮，显示完整 task 和 session id
- **点击行为**：跳转到该 session 的消息详情

#### 树形连接线（纯 CSS）

```css
.tree-node {
  position: relative;
  padding-left: 24px;
  margin-left: 12px;
}
.tree-node::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  border-left: 2px solid var(--border);
}
.tree-node::after {
  content: '';
  position: absolute;
  left: 0;
  top: 16px;
  width: 12px;
  border-top: 2px solid var(--border);
}
/* 最后一个子节点去掉竖线延续 */
.tree-node:last-child::before {
  height: 16px;
}
```

### 全局森林视图（Phase 2）

在 All Sessions 页面顶部加一个 "🌳 Spawn Forest" tab，展示所有根树：
- 每棵树是一个可展开的面板
- 显示：根 agent 名、任务摘要、子树深度、总节点数
- 点击展开看完整树
- 按时间倒序排列

## 交互细节

| 操作 | 行为 |
|------|------|
| 点击节点 | 右侧跳转到该 session 消息 |
| 点击 "🔗 open" | 新 tab 或当前面板切换到 session |
| 悬停节点 | tooltip：session id、完整 task、agent、时间 |
| 点击 `▸ N children` | 展开子树 |
| 点击 `▾` | 折叠子树 |
| 空树（无 spawn） | 显示 "No spawn relationships found in loaded sessions" |

## 颜色方案

复用 AgentXRay 现有色彩系统：

```
--spawn-root:   #58a6ff  (蓝，根节点)
--spawn-child:  #f0883e  (橙，子节点)
--spawn-leaf:   #8b949e  (灰，叶子)
--spawn-line:   #30363d  (连接线)
--spawn-active: rgba(240,136,62,0.15)  (悬停背景)
--spawn-badge:  rgba(240,136,62,0.12)  (标签背景)
```

## 文件改动

| 文件 | 改动 |
|------|------|
| `server.js` | +`buildSpawnTree()` 函数，+`/api/spawn-tree` endpoint |
| `public/index.html` | CSS: 树形样式 (~80行), JS: 渲染逻辑 (~150行), HTML: 面板容器 |

- 不引入外部依赖
- 不修改现有 spawn chip 行为（树是额外视图，chip 保留）
- 现有 `buildSpawnMap()` 不动，新增函数复用其数据

## 实现优先级

1. **Phase 1（MVP）**：后端建树 API + 前端树形面板（侧边栏切换）
2. **Phase 2**：全局森林视图（All Sessions tab）
3. **Phase 3**：树与时间线联动（选中树节点同步高亮消息列表）

## 边界情况

- **缺失 session**：child session 文件已被清理/归档 → 显示 "⚠️ session not found" 灰色节点
- **循环引用**：`maxDepth=6` 硬限制 + visited set 防循环
- **深度截断**：depth > 6 显示 "+3 more at depth 7" 聚合节点
- **空树**：友好提示，不报错
- **大量节点**：> 50 个节点时根节点默认折叠非首棵树
