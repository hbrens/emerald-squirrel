# design · 对话式知识库设计文档集

## 这是什么

一个全新对话式知识库的架构设计文档集。**chat 为主要交互方式**，**两层知识库**（笔记可写 + 导入只读），借鉴 open-webui 与 htwm-wiki 两边长处，前端高精度参考 WeKnora 项目。

> 本文档集是**设计**而非实施。代码引用仅作「参考」，不是「现状即对」。

## 核心需求

1. **全新软件**——不是改 htwm-wiki
2. **Chat 为主要交互方式**，web 项目——所有操作（查、记、改、删、上传）从对话框发起
3. **两层知识库**：
   - **Part 1 · 笔记层（可写）**：LLM 可读写，类似 htwm-wiki docs/ 或 open-webui notes
   - **Part 2 · 导入层（只读）**：用户上传原始不同格式文档（PDF/DOCX/MD/TXT/HTML…），LLM 不写，只用于检索
4. **借鉴 open-webui + htwm-wiki 两边长处**
5. **不用 git**（已决定移除，用别的 undo 机制或不要 undo）
6. **后台技术栈灵活**——RAG 可用可不用，看是否服务交互方便
7. **笔记层存储不强制 markdown**

## 部署 / 使用

- 局域网自用，不做用户/权限系统
- 服务端跑（不是纯本地客户端）

## 前端

- UI 细节暂不管
- 高精度参考 WeKnora（https://github.com/Tencent/WeKnora）项目本身
- 实施前端时去扒 WeKnora 源码细节

## 文档导航

| 文档 | 内容 |
|---|---|
| [01-architecture.md](01-architecture.md) | 架构总览：分层 + 两层知识库分工 + 数据流 |
| [02-notes-layer.md](02-notes-layer.md) | Part 1 笔记层：存储 / 检索 / 写入纪律挂钩点 |
| [03-imports-layer.md](03-imports-layer.md) | Part 2 导入层：上传 / 提取 / 切分 / embedding / 向量 / 检索 |
| [04-write-discipline.md](04-write-discipline.md) | 写入纪律（笔记层核心）：查重/合并/新建/放一起 + prompt 措辞 |
| [05-tools.md](05-tools.md) | 工具接口规范：分层工具 + 路径安全 + 确认机制 |
| [06-frontend.md](06-frontend.md) | 前端：粗粒度功能清单 + WeKnora 风格基准指针 |
| [07-references.md](07-references.md) | 参考对比：各项目借鉴/避开 |
| [08-operations.md](08-operations.md) | 运维：部署 + 备份 + 已知坑 |
| [09-api-contract.md](09-api-contract.md) | API 契约：endpoint + SSE 事件协议 + 错误格式 + 边界场景（服务端） |
| [10-db-schema.md](10-db-schema.md) | 数据库：完整 SQLite DDL + 索引 + migration |
| [11-tool-schemas.md](11-tool-schemas.md) | 工具 schema：7 个工具的 function calling JSON（可直接发给 LLM） |
| [12-frontend-structure.md](12-frontend-structure.md) | 前端结构：组件树 + 状态机 + SSE 消费 + 边界场景（前端） |
| [13-scaffold.md](13-scaffold.md) | 脚手架：monorepo 目录树 + package.json + 配置 + 建项目顺序 |

## 阅读顺序

- **新人**：01 → 02/03 → 04 → 06
- **维护者**：02 → 03 → 05 → 08
- **想抄作业**：07

## 参考材料

| 参考 | 用途 | 文档锚点 |
|---|---|---|
| htwm-wiki（自己的现有实现） | 工具集 / diff 卡片 / 分层参考 | 07 |
| open-webui（notes + 检索管线） | 笔记工具模式 / 导入管线 | 02, 03, 07 |
| gptme | 分层记忆设计参考 | 07 |
| WeKnora | 前端视觉基准 | 06 |
| khoj / reor / open-knowledge | 反面或同路线对照 | 07 |

## 设计原则

- **从需求正推**，htwm-wiki + open-webui 仅作参考
- **每个设计点可追溯到核心需求**
- **不凭空捏造约束**（之前误把「无 RAG」「git 管版本」当 immutable，是错的）
- **Part 1 / Part 2 给同等篇幅**，Part 2 不再一笔带过
- 中文为主，代码/字段名/路径英文
