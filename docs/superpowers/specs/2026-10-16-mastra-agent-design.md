# 进程内 Mastra 短剧助手设计

日期：2026-10-16  
状态：已定稿（待实现）

## 背景

本地短剧助手已经能在界面里完成剧本、角色、场景、分镜和出图。用户希望在客户端里用对话完成这些操作，并让助手读取内置 skill 和用户自己放入的 `SKILL.md`。

桌面端目前把后端 `require` 进 Electron 28 主进程。该进程是 Node 18 + CommonJS。Mastra 需要 Node.js 22.13 或更高，并且用 ESM。本机开发用的 Node 是 22.15，开发时的后端可以加载 Mastra；打包后的 Electron 28 不行。

## 决策摘要

| 决策 | 选择 |
|------|------|
| 运行位置 | Electron 主进程里的现有 Express，不另起进程 |
| Electron | 28 → 44（Node 24）。安装包目标仍是 Windows x64，不打 ia32 |
| 打包工具 | `electron-builder` 24 → 27 |
| Mastra 加载方式 | 后端保持 CommonJS，Mastra 放在 `.mjs`，用 `import()` 加载 |
| HTTP | 只增加自己的助手接口。不挂载 Mastra 整套 `/api` |
| 操作范围 | 当前打开的一部剧：剧本、角色、场景、分镜、出图 |
| 删除 | `delete_item` 带 `requireApproval`，对话里点允许后才执行 |
| 模型 | AI 配置里 `service_type = text` 的默认项 |
| 出图 | 现有图片服务和图片模型配置。助手不另接一家图生厂商 |
| Skill | 内置一份短剧 skill，再加上 `data/skills/` 里的用户 skill |
| 对话 | 每部剧一条。记忆库用单独的 `data/agent.db` |

不做：出视频、合成、导入导出、道具、新建或删除整部剧、把 `openclaw-skill/` 交给这个助手、给助手开放 shell 或整盘文件读写。

## 运行结构

```
Electron 44 主进程
  require(backend-node/src/app.js)     CommonJS，现有业务
  await initAgent(app, db, log, cfg)   失败只标记助手不可用
  listen 127.0.0.1

initAgent
  import('./mastra/index.mjs')
    Agent drama-assistant
      model ← 默认文本配置
      tools ← 现有 service
      skills ← 内置目录 + data/skills
      memory ← data/agent.db
```

`createApp()` 保持同步。`desktop/main.js` 和 `backend-node/src/server.js` 在 `listen` 之前 `await initAgent(...)`。初始化抛错时写日志，进程继续启动。此时 `GET /health`、项目和画布仍可用；助手接口返回 503，正文说明助手未就绪。

模块：

| 路径 | 职责 |
|------|------|
| `backend-node/src/mastra/index.mjs` | 创建 Mastra、Agent、Memory，导出 `streamChat`、`approve`、`decline`、`getHistory`、`listPendingApprovals` |
| `backend-node/src/mastra/tools.mjs` | 12 个工具 |
| `backend-node/src/mastra/context.mjs` | 从 `requestContext` 取当前剧和当前集，并做归属校验 |
| `backend-node/src/routes/agent.js` | CommonJS 路由，把 Mastra 流转成 SSE |
| `backend-node/skills/short-drama/SKILL.md` | 内置 skill |
| `frontweb/src/components/AgentDrawer.vue` | 抽屉 |
| `frontweb/src/api/agent.js` | 对话、审批、历史 |
| `frontweb/src/stores/agentContext.js` | 当前集 id |

`data/skills` 和 `data/agent.db` 都相对进程当前工作目录。开发时工作目录是 `backend-node/`。打包后 `desktop/main.js` 会 `chdir` 到用户数据里的 backend 目录，因此用户 skill 落在该目录的 `data/skills/`。启动时创建这个目录。

`@mastra/libsql` 若带原生模块，按 `better-sqlite3` 的方式放进 `asarUnpack`，并由现有 `electron-builder install-app-deps` 重编译。原生模块加载失败时，按上面的初始化失败处理，不让整个应用退出。

Electron 升级同时重编译 `better-sqlite3` 和 `sharp`。升级后的第一项检查是：窗口能打开、`/health` 正常、原有项目列表和一张已有图片仍能显示。

## 当前剧边界

每次对话的 `requestContext` 只有路由传入的 `dramaId`，以及可选的 `episodeId`。剧 id 和集 id 都只从这里取。模型写在工具参数里的剧 id、集 id 一律忽略。

归属规则：

- `episodeId` 有值时，必须属于这部剧，否则接口 400。
- 工具需要某一集、而请求没带 `episodeId`：这部剧只有一集时用那一集；没有集时返回「这部剧还没有分集」；多于一集时返回「请指定哪一集」，不猜测。
- 角色、场景、分镜、任务在修改或读取前，必须能追溯到这部剧。对不上就返回 `{ ok: false, error }`，不写数据库。

`get_task` 允许的 `async_tasks.resource_id`：等于当前 `dramaId`，或等于这部剧里某一集的 id。故事生成和角色生成的资源 id 是剧 id；场景提取和分镜生成的资源 id 是集 id。

## 工具

工具执行失败时返回 `{ ok: false, error: "中文原因" }`，不把堆栈交给模型。成功时返回 `{ ok: true, ... }`，只包含 id、名称、状态、任务号、图片地址。已有异步任务的调用立刻返回任务号，工具内部不轮询。

| 工具 | 调用 | 说明 |
|------|------|------|
| `get_current_project` | `dramaService.getDrama`、分集列表、角色、场景、当前集分镜 | 见下方摘要限制 |
| `generate_story` | `storyGenerationService.startStoryGeneration` | 返回已有或新建的任务号 |
| `save_episode_script` | 单行更新 `episodes.script_content` | 见下方，禁止走 `saveEpisodes` |
| `generate_characters` | `characterGenerationService.generateCharacters` | 返回任务号 |
| `update_character` | 单条插入或 `characterLibraryService.updateCharacter` | 见下方，禁止走会重写 `episode_characters` 的 `saveCharacters` |
| `generate_scenes` | `backgroundExtractionService.extractBackgroundsForEpisode` | 返回任务号。该集没有剧本时返回错误 |
| `update_scene` | `sceneService.createScene` / `createSceneForEpisode` / `updateScene` | 只写 `location`、`time`、`prompt` |
| `generate_storyboards` | `episodeStoryboardService.generateStoryboard` | `model`、`style` 不传，沿用项目元数据。`includeNarration = false`，`universalOmni = false`。用户指定镜数时才传 `storyboardCount` |
| `update_storyboard` | `storyboardService.updateStoryboard` | 只改台词、动作、画面描述和出图提示词 |
| `generate_image` | 见下方三种 | 不接受 provider、apiKey |
| `get_task` | `taskService.getTask` | 先做归属校验 |
| `delete_item` | 对应现有删除函数 | `requireApproval: true` |

`get_current_project` 的体积：

- 剧：标题、风格、比例。
- 分集：id、序号、标题。当前集额外带剧本，超过 12000 字截断并注明。
- 角色：id、名字、身份、是否已有图。
- 场景：id、`location`、是否已有图。
- 当前集分镜：id、镜号、200 字以内的画面摘要、是否已有图。

`save_episode_script` 只执行一条 `UPDATE episodes SET title, script_content, description WHERE id = ? AND drama_id = ?`。没有分集时插入第 1 集，不调用 `dramaService.saveEpisodes`。该函数会软删除这次没提交的其他集。

`update_character` 更新时只提交名字、身份、外貌、性格、简介。不改 `image_url`、`local_path`、资产字段。新建时按 `saveCharacters` 里单条 `INSERT` 的字段插入一行；若有当前集，再用 `INSERT OR IGNORE` 写入 `episode_characters`。不删除该集已有的角色关联。

`generate_image`：

| `type` | 行为 |
|--------|------|
| `character` | `characterLibraryService.generateCharacterFourViewImage`，与现有「生成角色图」相同。等待现有函数返回，把图片地址放进结果 |
| `scene` | 参数 `view` 为 `single`（默认）或 `four`。分别调用 `sceneService.generateSceneSingleImage`、`generateSceneFourViewImage` |
| `storyboard` | 参数可带 `prompt`。有则先用 `updateStoryboard` 写入该镜出图提示词。然后 `imageService.create`，只传 `drama_id`、`storyboard_id` 和这条提示词。返回任务号 |

`delete_item` 的参数只有 `type`（`character`、`scene`、`storyboard`）和 `id`。Mastra 会在 `execute` 之前发出审批。翻译 SSE 时先按当前剧查这个 id：不属于当前剧就立刻 `declineToolCall`，并发送失败的 `tool-result`，不弹出卡片。属于当前剧才发送 `tool-call-approval`，`label` 用角色名、场景 `location` 或分镜镜号。用户允许后，`execute` 再查一次归属，然后分别调用 `characterLibraryService.deleteCharacter`、`sceneService.deleteScene`、`storyboardService.deleteStoryboard`。

## Skill

内置目录是 `backend-node/skills/short-drama/`，里面只有一份 `SKILL.md`。它按 Agent Skills 规范写前言（`name`、`description`），正文教助手何时调用上面的工具。明确写出：只能操作当前剧；没有出视频、导入导出、道具、新建或删除整部剧的工具；用户 skill 如果要求这些，就说明做不到。删除必须走审批，不能用清空字段代替删除。

用户 skill 是 `data/skills/<目录名>/SKILL.md`。加载时用 Mastra 的校验函数检查；不合法的跳过并写日志，不让对话失败。用户 skill 只是说明，不会注册新工具。

助手因此自带 `skill`、`skill_read`、`skill_search`。`openclaw-skill/` 保持原样，给外部 OpenClaw 用，不放进这个 Agent 的 `skills` 列表。

## 模型与记忆

每次请求读取 `ai_service_configs` 里 `service_type = text`、`is_default = 1`、未删除且启用的配置。有多条时按 `priority` 降序、`id` 升序取第一条。一条都没有则 `POST /agent/chat` 返回 400，说明先去 AI 配置添加文本模型。

传给 Mastra 的模型对象：

- `id`：`custom/` 加上配置里的模型名
- `url`：该配置的 `base_url`，去掉末尾斜杠。不拼接 `endpoint`，也不拼接 `/chat/completions`
- `apiKey`：该配置的密钥
- `api`：`chat`

一部剧一个线程，`threadId` 和 `resourceId` 都是 `drama-<id>`。记忆存在 `data/agent.db`。审批中的运行也写在这里，刷新抽屉后可以用 `listSuspendedRuns` 把未确认的删除重新显示出来。

## 接口

都在现有 `/api/v1` 下。

### `POST /api/v1/agent/chat`

请求体：`{ message: string, dramaId: number, episodeId?: number }`。

响应是 `text/event-stream`。每行 `data: {JSON}\n\n`。事件名写在 JSON 的 `type` 里：

| type | 字段 |
|------|------|
| `text-delta` | `text` |
| `tool-call` | `toolName` |
| `tool-result` | `toolName`、`ok`、`summary` |
| `tool-call-approval` | `runId`、`toolCallId`、`toolName`、`type`、`id`、`label` |
| `error` | `message` |
| `done` | 无 |

路由把 Mastra 的流翻译成上表，前端不解析 Mastra 原始块。

### `POST /api/v1/agent/approve` 与 `POST /api/v1/agent/decline`

请求体：`{ dramaId, runId, toolCallId }`。`runId` 必须属于这部剧的线程，否则 404。允许调用 `approveToolCall`，拒绝调用 `declineToolCall`。继续产生的流用同一套 SSE 事件。

### `GET /api/v1/agent/history?dramaId=`

返回该剧消息列表，以及仍在等待的审批（`runId`、`toolCallId`、删除对象的类型、id、显示名）。

## 界面

`App.vue` 挂载 `AgentDrawer`。仅在 `/drama/:id`、`/film/:id`、`/film/:id/canvas` 显示右下角「助手」按钮。`dramaId` 来自路由参数。制作页和画布页在切换当前集时写入 Pinia store `agentContext.episodeId`，离开这两页时清空。抽屉发送时带上这个 `episodeId`。剧集管理页不写它。

抽屉宽 400px，内容是消息列表、输入框和工具状态行。删除事件渲染成卡片：对象类型、名字、允许、拒绝。出图结果里的本地图片地址显示成缩略图。结果里的 `task_id` 用现有任务接口轮询，结束后在同一条工具状态下补一句结果。

写操作成功后，抽屉派发 `lmd-agent-changed`，带 `dramaId`。剧集页、制作页、画布页监听并重新拉取当前数据。

## 错误

| 情况 | 行为 |
|------|------|
| 未配置文本模型 | 400，提示去 AI 配置 |
| 剧不存在，或集不属于该剧 | 400 |
| 助手初始化失败 | 助手接口 503，其余功能照常 |
| 工具业务失败 | SSE 的 `tool-result` 为失败，模型用返回的中文原因向用户说明 |
| 用户 skill 不合法 | 跳过该文件 |
| 用户拒绝删除 | `declineToolCall`，助手告知未删除 |

## 测试

不调用真实模型厂商。

`backend-node/test/agent-tools.test.js`：

- 工具拿到的剧 id 来自上下文。模型若在参数里写了另一部剧的 id，写入仍只发生在上下文那一部。
- 其他剧的角色、场景、分镜、任务号调用更新、删除、查询时返回失败且数据库不变。
- `delete_item` 的定义带 `requireApproval: true`。
- `save_episode_script` 更新一集后，同剧其他集仍在。
- `update_character` 给当前集追加一个角色后，该集原有角色关联还在。
- 不合法的用户 `SKILL.md` 被跳过，合法的目录仍出现在 skill 列表。
- 没有默认文本配置时，聊天入口返回 400。

桌面端手测：升级后的窗口能打开；在一部剧里发出「看看这个项目」；删除一个角色时卡片停住，拒绝后角色还在，允许后角色消失，当前页列表刷新。

## 实现顺序

1. 升级 Electron 44 和 electron-builder 27，确认原有窗口、数据库和图片仍可用。
2. 接入 Mastra、记忆、内置 skill、聊天与历史接口。工具先只做 `get_current_project`。
3. 补齐其余工具和删除审批。
4. 做抽屉、任务状态和 `lmd-agent-changed` 刷新。
