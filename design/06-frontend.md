# 06 · 前端

本篇只列粗粒度功能清单 + 风格基准指针。**不画细 UI**——实施期去扒 WeKnora 源码。

## 风格基准

- **高精度参考 WeKnora 项目本身**（https://github.com/Tencent/WeKnora）
- 实施前端时直接看 WeKnora 源码（特别是 `frontend/` 目录）
- 本设计文档不重复扒 WeKnora 样式数据（颜色/圆角/字体等都在 WeKnora 自己的 `frontend/src/assets/theme/theme.css` 里）

## 页面结构（粗粒度）

参考 htwm-wiki App.tsx 的 shell 结构，符合 WeKnora 风格：

```
┌─────────┬──────────────────────────────────┐
│         │  顶栏（标题 / 模型 tag）           │
│ sidebar ├──────────────────────────────────┤
│         │                                   │
│ - 新对话 │  主区（聊天 / 笔记 / 导入 切换）  │
│ - 文档   │                                   │
│ - 导入   │                                   │
│         │                                   │
│ 会话列表 │                                   │
│ / 笔记列 │                                   │
│ 表 / 导入│                                   │
│ 列表     ├──────────────────────────────────┤
│         │  输入区（大圆角卡片 + 工具栏）     │
│ 用户    │                                   │
└─────────┴──────────────────────────────────┘
```

## 功能清单（粗粒度）

### 聊天页（主入口，需求 #2）

- 流式输出（SSE）
- Markdown 渲染（marked + DOMPurify sanitize，参考 htwm-wiki App.tsx:4，**注意 sanitize 防 XSS**）
- 工具调用时间线（WeKnora 风竖向 step，每个工具有 icon + label + preview）
- 写入确认卡片（diff / newFile / delete preview，4 种 preview 类型，参考 htwm-wiki App.tsx:242-263）
- 错误展示（流内 ⚠ 提示）

### 会话管理

- 会话列表（按「今天 / 近 7 天 / 更早」分组，参考 htwm-wiki App.tsx:36 `groupSessions`）
- 新建 / 切换 / 删除会话
- 会话标题自动取首条消息前 24 字符

### 笔记浏览（需求 #3）

- 笔记列表（按 title 排序，显示 title + updated_at + 一句话定位）
- 笔记详情视图（DocView，只读 markdown 渲染）
- 笔记搜索框（人类用，调 `GET /api/notes/search?q=...`）—— 这是 htwm-wiki 没有的功能，open-webui 有

### 导入管理（需求 #3）

- 上传按钮（拖拽 + 点击，支持多文件）
- 已导入文档列表（filename / size / status / chunks_count / uploaded_at）
- 状态显示（processing / ready / failed）
- 删除按钮（删文档 + 关联 chunks）

### 输入区

- 大圆角卡片（参考 htwm-wiki App.tsx:272 `.composer`）
- 内部工具栏（写明「写入需确认」标签 + 模型 tag + 发送按钮）
- Enter 发送 / Shift+Enter 换行
- busy 时禁用发送

## 待定项（实施期定）

- **人工编辑笔记入口**：当前 DocView 只读。要不要加人工编辑器？倾向暂不加，让所有写入走 chat；如果用户强烈需要，未来加一个「在 DocView 旁开编辑模式」的功能。
- **暗色模式**：WeKnora 已支持浅深双模，本设计照搬。
- **移动端适配**：WeKnora 是响应式的，照搬即可。
- **会话历史工具时间线展示**：决策 1 要求持久化 tool_calls + 结果，会话重开时要展示历史工具时间线（不只是当前轮）。

## 不画的东西

- 不写 CSS（用 WeKnora 风格）
- 不画具体布局图（看 WeKnora 截图）
- 不定义组件层级（实施期再定）

## UI 不在本设计文档集的范围

架构定清楚后，前端 UI 是实施期独立任务。本篇只标注「功能清单 + WeKnora 基准」。
