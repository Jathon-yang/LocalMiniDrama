# 进程内 Mastra 短剧助手 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有桌面端里用对话操作当前短剧：写剧本、改角色/场景/分镜、出图、读取 skill，删除前必须确认。

**Architecture:** Electron 44 主进程继续 `require` 现有 CommonJS 后端。Mastra 放在 `.mjs`，`listen` 前 `import()`。工具直接调用现有 service，剧 id 和集 id 只来自请求上下文。前端用自己的 SSE，不挂载 Mastra 的整套 HTTP。

**Tech Stack:** Electron 44、electron-builder 27、Express、Vue 3、`@mastra/core`、`@mastra/memory`、`@mastra/libsql`、better-sqlite3、Node 内置测试。

**Spec:** `docs/superpowers/specs/2026-10-16-mastra-agent-design.md`

不拆成多份计划。规格的实现顺序是一条交付线：任务 1 结束后现有应用仍能运行，后面的任务都接在同一套上下文接口上。

## Global Constraints

- Electron `^44.0.0`，electron-builder `^27.0.0`。安装包仍是 Windows x64 的 nsis 和 portable，不增加 ia32。
- 后端保持 CommonJS。Mastra 只出现在 `backend-node/src/mastra/*.mjs`，由 `import()` 加载。
- 只增加 `/api/v1/agent/chat`、`/approve`、`/decline`、`/history`。不挂载 Mastra 的 `/api`。
- 工具只操作上下文里的那一部剧。模型参数里的剧 id、集 id 忽略。
- `delete_item` 的 `requireApproval` 为 true。不属于当前剧的删除不弹卡片，直接拒绝。
- 文本模型取 `service_type = text`、`is_default = 1`、未删除且启用的配置；多条时 `priority` 降序、`id` 升序的第一条。`url` 是去掉末尾斜杠的 `base_url`，不拼接 `endpoint` 或 `/chat/completions`，`api` 为 `chat`。
- 出图走现有图片服务，工具参数不接受 `provider` 和 `apiKey`。
- 内置 skill 在 `backend-node/skills/short-drama/SKILL.md`。用户 skill 在 `data/skills/<目录名>/SKILL.md`。不把 `openclaw-skill/` 放进 Agent。
- 每部剧一个线程，`threadId` 和 `resourceId` 都是 `drama-<id>`。记忆文件是 `data/agent.db`。
- 助手初始化失败只让助手接口返回 503 `助手未就绪`，`/health` 和其他路由保持可用。
- 不做视频、合成、导入导出、道具、新建或删除整部剧。
- 成功结果只有 `ok`、`summary`，以及需要的 `id`、`name`、`taskId`、`imageUrl`、`localPath`。失败是 `{ ok: false, error }`，error 为中文，不含堆栈。

## File Structure

| 文件 | 职责 |
|------|------|
| `desktop/package.json` | Electron 44、builder 27、与后端相同的 Mastra 依赖、必要时 `asarUnpack` |
| `desktop/scripts/copy-backend.js` | 把 `skills/` 复制进 `backend-app` |
| `desktop/main.js` | `listen` 前 `await initAgent` |
| `backend-node/package.json` | Mastra 依赖 |
| `backend-node/src/server.js` | 开发服务器同样 `await initAgent` |
| `backend-node/src/response.js` | `serviceUnavailable` → 503 |
| `backend-node/src/routes/index.js` | 注册四条助手路由 |
| `backend-node/src/routes/agent.js` | HTTP 与 SSE |
| `backend-node/src/mastra/context.mjs` | 剧/集解析、归属、聊天体校验 |
| `backend-node/src/mastra/model.mjs` | 默认文本模型 |
| `backend-node/src/mastra/skills.mjs` | 内置目录 + 用户目录 |
| `backend-node/src/mastra/tools.mjs` | 12 个工具的执行函数和 `deleteItemSpec` |
| `backend-node/src/mastra/sse.mjs` | Mastra 块 → 规格里的 SSE 事件 |
| `backend-node/src/mastra/index.mjs` | Agent、Memory、`initAgent`、流式对话、审批、历史 |
| `backend-node/skills/short-drama/SKILL.md` | 内置说明 |
| `backend-node/test/helpers/agentTestDb.js` | 内存库和两部剧的固定种子 |
| `backend-node/test/agent-context.test.js` | 归属与集选择 |
| `backend-node/test/agent-model-skills.test.js` | 模型 URL 和 skill 跳过 |
| `backend-node/test/agent-tools.test.js` | 工具行为 |
| `backend-node/test/agent-routes.test.js` | 400 / 503 / SSE / 审批归属 |
| `frontweb/src/stores/agentContext.js` | 当前集 id |
| `frontweb/src/utils/agentStream.js` | 解析一条 SSE data |
| `frontweb/src/api/agent.js` | 四个请求 |
| `frontweb/src/components/AgentDrawer.vue` | 抽屉 |
| `frontweb/test/agentStream.test.js` | SSE 解析 |

## Review Focus

这五类输入最容易伤到用户数据或把请求打到错误地址。每条都有对应用例，写在拥有该代码的任务里。

1. 保存一集剧本时若走了 `saveEpisodes`，同剧其他集会被软删除。期望：只更新目标集，其他集 `deleted_at` 仍为空。用例在任务 4。
2. 给本集加一个角色时若走了带 `episode_id` 的 `saveCharacters`，本集原有角色关联会被清掉。期望：原有关联还在，新角色被 `INSERT OR IGNORE` 加上。用例在任务 5。
3. 模型对另一部剧的角色发起删除。期望：不弹出审批卡片，立即拒绝，该角色仍在。用例在任务 7。
4. 文本配置的 `base_url` 已是 `https://example.test/v1`，`endpoint` 为 `/chat/completions`。期望：模型 `url` 仍是 `https://example.test/v1`。用例在任务 3。
5. 一部剧有两集，请求没带 `episodeId`。期望：需要集的工具返回 `请指定哪一集`，数据库无写入。用例在任务 4。

## 接口

后续任务只使用这里的名字和形状。

```js
// context.mjs
export function dramaThreadId(dramaId) // => `drama-${Number(dramaId)}`
export function resolveEpisode(db, dramaId, episodeId)
// { ok: true, episodeId: number | null } | { ok: false, error: '项目不存在' | '这一集不属于当前项目' | '请指定哪一集' | '这部剧还没有分集' }
// episodeId 为空且该剧只有一集时，返回那一集。不需要集的读取可再看 episodeId === null。
export function assertOwned(db, dramaId, type, id)
// type: 'character' | 'scene' | 'storyboard' | 'task'
// { ok: true, label: string } | { ok: false, error: string }
export function validateChatBody(db, body)
// 未传 episodeId 时 ok，episodeId 为 null。传了则必须属于该剧。
// { ok: true, dramaId, episodeId: number | null } | { ok: false, status: 400, message }

// model.mjs
export function resolveTextModel(db)
// { ok: true, model: { id, url, apiKey, api: 'chat' } }
// | { ok: false, error: '请先在 AI 配置里添加文本模型' | '文本模型的 base_url 或模型名为空' }

// skills.mjs
export function listSkillDirectories({ builtinDir, userSkillsDir, log, validate })
// validate(markdown) => { valid: boolean }
// 返回通过校验的目录绝对路径数组。非法文件跳过，并 log.warn。

// tools.mjs  — 每个 execute 的成功/失败形状见 Global Constraints
export function executeGetCurrentProject(db, dramaId, episodeId)
export function executeSaveEpisodeScript(db, dramaId, episodeId, input)
// input: { title?: string, scriptContent: string, description?: string }
export function executeUpdateCharacter(db, log, dramaId, episodeId, input)
// input: { id?: number, name: string, role?: string, appearance?: string, personality?: string, description?: string }
export function executeUpdateScene(db, log, dramaId, episodeId, input)
// input: { id?: number, location: string, time?: string, prompt?: string }
export function executeUpdateStoryboard(db, log, dramaId, input)
// input: { id: number, dialogue?: string, action?: string, description?: string, imagePrompt?: string }
export function executeGenerateStory(db, log, dramaId, deps)
export function executeGenerateCharacters(db, cfg, log, dramaId, episodeId, deps)
export function executeGenerateScenes(db, cfg, log, dramaId, episodeId, deps)
export function executeGenerateStoryboards(db, log, dramaId, episodeId, input, deps)
// input: { storyboardCount?: number }
export async function executeGenerateImage(db, log, cfg, dramaId, input, deps)
// input: { type: 'character' | 'scene' | 'storyboard', id: number, view?: 'single' | 'four', prompt?: string }
export function executeGetTask(db, dramaId, input) // input: { taskId: string }
export function executeDeleteItem(db, log, dramaId, input) // input: { type, id }
export const deleteItemSpec // { id: 'delete_item', requireApproval: true }

// sse.mjs
export function toAgentSseEvent(chunk)
// 识别 type 为 text-delta、tool-call、tool-result、tool-call-approval 的块，映射成规格中的事件。
// 其他 type 返回 null。

// index.mjs
export async function initAgent({ db, log })
export function isAgentReady()
export async function streamChat({ dramaId, episodeId, message, writeEvent })
export async function resumeApproval({ dramaId, runId, toolCallId, approved, writeEvent })
export async function getHistory(dramaId)

// response.js
serviceUnavailable(res, message) // 503 SERVICE_UNAVAILABLE

// routes/agent.js
createAgentHandlers(db, log, runtime) // runtime 默认 { isAgentReady, streamChat, resumeApproval, getHistory }
```

`runtime` 缺省时读 `index.mjs` 的导出。测试传入假的 `runtime`。

种子库 `createAgentTestDb()` / `seedTwoDramas(db)` 返回：

```js
{
  dramaA: 1, episodeA1: 1, episodeA2: 2,
  dramaB: 2, episodeB1: 3,
  characterA: 1, characterB: 2,
  sceneA: 1, sceneB: 2,
  storyboardA: 1, storyboardB: 2,
  taskA: 'task-a', taskB: 'task-b'
}
```

`taskA.resource_id` 是 `'1'`（剧 A）。另插一条 `taskEpisode`，id 为 `task-ep`，`resource_id` 是 `'1'`（集 A1）。剧 B 的任务 id 是 `task-b`，`resource_id` 是 `'2'`。

---

### Task 1: 升级 Electron

**Files:**
- Modify: `desktop/package.json`

**Interfaces:**
- Consumes: 无
- Produces: Electron 主进程的 Node 主版本 ≥ 22，`better-sqlite3` 和 `sharp` 能在该 Electron 里加载

- [ ] **Step 1: 改版本**

`desktop/package.json` 的 `devDependencies.electron` 改为 `^44.0.0`，`devDependencies.electron-builder` 改为 `^27.0.0`。`build.win.target` 保持 `["nsis", "portable"]`，不添加 ia32。

- [ ] **Step 2: 安装并确认运行时**

在 `desktop/` 用系统 Node 22 执行 `npm install`。安装脚本会复制后端并按 Electron ABI 重编译原生模块。

Run: `npx electron -e "const [major]=process.versions.node.split('.').map(Number); if(major<22) process.exit(2); require('better-sqlite3'); require('sharp'); console.log(process.versions.electron); console.log(process.versions.node)"`

Expected: 退出码 0。第一行以 `44.` 开头，第二行主版本 ≥ 22。

- [ ] **Step 3: Commit**

```bash
git add desktop/package.json desktop/package-lock.json
git commit -m "chore: upgrade Electron to 44 for Mastra"
```

### Task 2: 剧集上下文

**Files:**
- Create: `backend-node/src/mastra/context.mjs`
- Create: `backend-node/test/helpers/agentTestDb.js`
- Test: `backend-node/test/agent-context.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `dramaThreadId`、`resolveEpisode`、`assertOwned`、`validateChatBody`、`createAgentTestDb`、`seedTwoDramas`

- [ ] **Step 1: 写失败测试**

`agent-context.test.js` 用动态 `import()` 加载 `context.mjs`。断言：

- `dramaThreadId(3) === 'drama-3'`
- 剧 A 不传 `episodeId` 时 `resolveEpisode` 的 `error === '请指定哪一集'`
- 剧 B 不传 `episodeId` 时 `episodeId === episodeB1`
- 剧 A 传入 `episodeB1` 时 `error === '这一集不属于当前项目'`
- `assertOwned(db, dramaA, 'character', characterB).ok === false`，且 `characters` 里 B 的 `deleted_at` 仍为空
- `assertOwned(db, dramaA, 'task', 'task-ep').ok === true`
- `assertOwned(db, dramaA, 'task', 'task-b').ok === false`
- `validateChatBody(db, { message: 'hi', dramaId: 99 })` 的 `message === '项目不存在'`
- `validateChatBody(db, { message: 'hi', dramaId: dramaA })` 为 ok，`episodeId === null`
- `validateChatBody(db, { message: 'hi', dramaId: dramaA, episodeId: episodeB1 }).message === '这一集不属于当前项目'`

内存库至少要有 `dramas(id, title, deleted_at)`、`episodes(id, drama_id, episode_number, title, script_content, description, deleted_at)`、`characters(id, drama_id, name, deleted_at)`、`scenes(id, drama_id, location, deleted_at)`、`storyboards(id, episode_id, storyboard_number, description, deleted_at)`、`async_tasks(id, resource_id, deleted_at)`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/agent-context.test.js`（工作目录 `backend-node`）

Expected: FAIL，找不到 `context.mjs` 或导出。

- [ ] **Step 3: 实现 `context.mjs` 和种子库**

`assertOwned` 的 `label`：角色用 `name`，场景用 `location`，分镜用 `String(storyboard_number)`，任务用任务 `type`；任务类型可以没有，这时 label 用 `taskId`。任务归属：`resource_id` 等于剧 id，或等于该剧某一未删除集的 id。

`validateChatBody` 要求 `message` 为非空字符串，`dramaId` 为正整数。没传 `episodeId` 时返回 ok，且 `episodeId` 为 null，不因为有多集而拒绝整次对话。传了 `episodeId` 时必须属于该剧，否则 message 为 `这一集不属于当前项目`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/agent-context.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend-node/src/mastra/context.mjs backend-node/test/helpers/agentTestDb.js backend-node/test/agent-context.test.js
git commit -m "feat: resolve the current drama for agent tools"
```

### Task 3: 文本模型与 skill 目录

**Files:**
- Create: `backend-node/src/mastra/model.mjs`
- Create: `backend-node/src/mastra/skills.mjs`
- Test: `backend-node/test/agent-model-skills.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `resolveTextModel`、`listSkillDirectories`

- [ ] **Step 1: 写失败测试**

在内存库建 `ai_service_configs(id, service_type, base_url, api_key, model, priority, is_default, is_active, deleted_at, endpoint)`。

断言：

- 无行时 `error === '请先在 AI 配置里添加文本模型'`
- 两条 `is_default = 1`：`priority` 1 的 id 为 2，`priority` 5 的 id 为 1。结果 `id === 'custom/from-priority'`，且来自 priority 5 那条
- 选中行 `base_url` 为 `https://example.test/v1/`，`endpoint` 为 `/chat/completions`，`model` 为 `qwen-plus`，`api_key` 为 `sk-test`。结果 `url === 'https://example.test/v1'`，`api === 'chat'`，`apiKey === 'sk-test'`，`id === 'custom/qwen-plus'`。结果对象上没有 `endpoint`
- `base_url` 为空时 `error === '文本模型的 base_url 或模型名为空'`
- `is_active = 0` 或 `deleted_at` 非空的行不参与选择
- 临时目录里一个合法 skill、一个 `validate` 返回 `{ valid: false }` 的 skill。返回数组只含合法目录。`log.warn` 被调用一次

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/agent-model-skills.test.js`

Expected: FAIL

- [ ] **Step 3: 实现两个模块**

`listSkillDirectories` 只收集直接子目录中的 `SKILL.md`。`builtinDir` 本身若包含 `SKILL.md`，也作为一条。`validate` 抛错时当作不合法并 `warn`，不向外抛。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/agent-model-skills.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend-node/src/mastra/model.mjs backend-node/src/mastra/skills.mjs backend-node/test/agent-model-skills.test.js
git commit -m "feat: resolve the agent text model and skill folders"
```

### Task 4: 读取项目与保存剧本

**Files:**
- Create: `backend-node/src/mastra/tools.mjs`
- Test: `backend-node/test/agent-tools.test.js`

**Interfaces:**
- Consumes: `resolveEpisode`、`seedTwoDramas`
- Produces: `executeGetCurrentProject`、`executeSaveEpisodeScript`

- [ ] **Step 1: 写失败测试**

给种子集 A1 写入 12001 个 `字`。`executeGetCurrentProject(db, dramaA, episodeA1)`：

- `project.script` 长度为 12000，`project.scriptTruncated === true`
- `project.episodes` 含 A1 和 A2 的 id、序号、标题
- 角色只有 A 的 id 和 `name`，场景只有 A 的 `location`
- 分镜摘要长度 ≤ 200

`executeGetCurrentProject(db, dramaA, null).ok === true`，`project.episodeSpecified === false`，`project.script` 为空，`project.episodes` 仍含 A1 和 A2。不猜测其中一集。`executeGetCurrentProject(db, dramaB, null)` 因为只有一集，`episodeSpecified === true`，并带上那一集的剧本。

`executeSaveEpisodeScript(db, dramaA, null, { scriptContent: '不会写入' }).error === '请指定哪一集'`，两集剧本都不变。

`executeSaveEpisodeScript(db, dramaA, episodeA1, { scriptContent: '新剧本', dramaId: dramaB })` 之后：A1 的 `script_content === '新剧本'`，A2 的 `deleted_at` 为空，B 的剧本不变。传入的 `dramaId` 不产生写入。

没有分集的新剧调用保存时，插入 `episode_number = 1`，`script_content` 为传入文本。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/agent-tools.test.js`

Expected: FAIL

- [ ] **Step 3: 实现这两个函数**

保存只用一条 `UPDATE ... WHERE id = ? AND drama_id = ?`。没有集时 `INSERT` 第 1 集。不调用 `dramaService.saveEpisodes`。

`get_current_project` 在没传集、且该剧有多集时不调用会返回「请指定哪一集」的失败路径：列出分集，`episodeSpecified` 为 false，不带剧本和分镜明细。只有一集或调用方传了集时，`episodeSpecified` 为 true。`summary` 包含剧标题。剧本字段名用 `script`，截断标记用 `scriptTruncated`。分镜摘要取 `description`，没有则取 `image_prompt`，再截到 200 字。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/agent-tools.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend-node/src/mastra/tools.mjs backend-node/test/agent-tools.test.js
git commit -m "feat: let the agent read a drama and save one script"
```

### Task 5: 更新角色、场景、分镜

**Files:**
- Modify: `backend-node/src/mastra/tools.mjs`
- Modify: `backend-node/test/agent-tools.test.js`
- Modify: `backend-node/test/helpers/agentTestDb.js`（补 `episode_characters`）

**Interfaces:**
- Consumes: `assertOwned`、`executeSaveEpisodeScript` 所在模块
- Produces: `executeUpdateCharacter`、`executeUpdateScene`、`executeUpdateStoryboard`

- [ ] **Step 1: 写失败测试**

种子在 `episode_characters` 里已有 `(episodeA1, characterA)`。

`executeUpdateCharacter(db, log, dramaA, episodeA1, { name: '新人' })` 之后：新行属于剧 A；`(episodeA1, characterA)` 仍在；新 id 也有一行关联。

`executeUpdateCharacter` 更新 `characterA` 时只传 `name: '改名'`。该行 `name` 改变，`image_url` 保持原值。对 `characterB` 调用时 `ok === false`，B 的名字不变。

`executeUpdateScene` 对 `sceneB` 返回失败。对本剧新建时写入 `location`，不写一个测试从未传入的 `image_url`。

`executeUpdateStoryboard` 把 `imagePrompt: '雨夜'` 写到 `storyboardA.image_prompt`，不修改 `video_prompt`。对 `storyboardB` 返回失败。

多集且 `episodeId` 为 null 时，新建角色返回 `请指定哪一集`，`characters` 行数不变。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/agent-tools.test.js`

Expected: FAIL，新用例失败，任务 4 的用例仍通过。

- [ ] **Step 3: 实现三个函数**

更新角色调用 `characterLibraryService.updateCharacter`，参数对象只含 `name`、`role`、`appearance`、`personality`、`description` 中有值的字段。新建使用与 `saveCharacters` 单条 INSERT 相同的列，然后 `INSERT OR IGNORE INTO episode_characters`。不调用 `saveCharacters`。

更新场景调用 `sceneService.updateScene` 或 `createSceneForEpisode`，参数只有 `location`、`time`、`prompt`。

更新分镜调用 `storyboardService.updateStoryboard`，只传 `dialogue`、`action`、`description` 和把 `imagePrompt` 映射为 `image_prompt`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/agent-tools.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend-node/src/mastra/tools.mjs backend-node/test/agent-tools.test.js backend-node/test/helpers/agentTestDb.js
git commit -m "feat: let the agent edit characters, scenes, and shots"
```

### Task 6: 生成任务、出图和任务查询

**Files:**
- Modify: `backend-node/src/mastra/tools.mjs`
- Modify: `backend-node/test/agent-tools.test.js`

**Interfaces:**
- Consumes: 任务 5 的执行函数
- Produces: `executeGenerateStory`、`executeGenerateCharacters`、`executeGenerateScenes`、`executeGenerateStoryboards`、`executeGenerateImage`、`executeGetTask`

依赖对象的方法名：

```js
deps.startStoryGeneration(db, log, { drama_id }) // 返回 taskId
deps.generateCharacters(db, cfg, log, { drama_id, episode_id })
deps.extractBackgroundsForEpisode(db, cfg, log, episodeId, undefined, undefined, undefined)
deps.generateStoryboard(db, log, episodeId, undefined, undefined, storyboardCount, undefined, undefined, false, false)
deps.generateCharacterFourViewImage(db, log, cfg, characterId, undefined, undefined)
deps.generateSceneSingleImage(db, log, cfg, sceneId, undefined, undefined)
deps.generateSceneFourViewImage(db, log, cfg, sceneId, undefined, undefined)
deps.updateStoryboard(db, log, id, { image_prompt })
deps.createImage(db, log, { drama_id, storyboard_id, prompt })
```

默认 `deps` 把这些名字接到 `storyGenerationService.startStoryGeneration`、`characterGenerationService.generateCharacters`、`backgroundExtractionService.extractBackgroundsForEpisode`、`episodeStoryboardService.generateStoryboard`、`characterLibraryService.generateCharacterFourViewImage`、`sceneService` 的两个出图函数、`storyboardService.updateStoryboard`、`imageService.create`。

- [ ] **Step 1: 写失败测试**

全部使用假 `deps`，每个方法记录参数并返回 `'task-new'` 或 `{ image_url: '/static/a.png', local_path: 'a.png' }` 或 `{ task_id: 'task-img' }`。

断言：

- `executeGenerateStory` 调用一次，参数 `drama_id` 是剧 A 的数字，即使 input 里写了剧 B
- `executeGenerateStoryboards` 的第 9、10 个参数是 `false, false`，第 4、5 个参数是 `undefined`。未传 `storyboardCount` 时第 6 个也是 `undefined`
- `executeGenerateImage` 的 character 调用里第 5、6 个参数是 `undefined`。返回 `{ ok: true, taskId` 不存在，`imageUrl: '/static/a.png' }`
- scene 且 `view: 'four'` 调用四视图函数；默认调用单图函数
- storyboard 且 `prompt: '雨夜'` 时，先 `updateStoryboard` 再 `createImage`。`createImage` 的对象没有 `provider`、`apiKey`
- `executeGetTask(db, dramaA, { taskId: 'task-ep' }).ok === true`
- `executeGetTask(db, dramaA, { taskId: 'task-b' }).ok === false`
- 剧 A 不带集时 `executeGenerateScenes(...).error === '请指定哪一集'`，假依赖调用次数为 0

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/agent-tools.test.js`

Expected: FAIL

- [ ] **Step 3: 实现六个函数**

生成函数把服务返回值规范成 `{ ok: true, taskId, summary }`。服务抛错时返回 `{ ok: false, error: err.message }`，不追加堆栈。角色和场景出图等待现有函数返回，不自己轮询。`createImage` 的返回使用 `task_id` 作为 `taskId`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/agent-tools.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend-node/src/mastra/tools.mjs backend-node/test/agent-tools.test.js
git commit -m "feat: let the agent start generation and image tasks"
```

### Task 7: 删除审批

**Files:**
- Modify: `backend-node/src/mastra/tools.mjs`
- Modify: `backend-node/test/agent-tools.test.js`
- Create: `backend-node/src/mastra/sse.mjs`
- Test: `backend-node/test/agent-routes.test.js`（本任务只放 `guardDeleteApproval` 与 `toAgentSseEvent` 的用例）

**Interfaces:**
- Consumes: `assertOwned`
- Produces: `executeDeleteItem`、`deleteItemSpec`、`guardDeleteApproval(db, dramaId, args)`、`toAgentSseEvent`

`guardDeleteApproval` 返回 `{ action: 'decline', error }` 或 `{ action: 'ask', type, id, label }`。

- [ ] **Step 1: 写失败测试**

- `deleteItemSpec.requireApproval === true`
- `guardDeleteApproval(db, dramaA, { type: 'character', id: characterB })` 的 `action === 'decline'`
- 同一调用后 `characterB` 的 `deleted_at` 仍为空
- `guardDeleteApproval(db, dramaA, { type: 'character', id: characterA }).action === 'ask'`，`label` 为角色 A 的名字
- `executeDeleteItem(db, log, dramaA, { type: 'character', id: characterB }).ok === false`，行仍在
- `executeDeleteItem` 删除 `characterA` 后，该行 `deleted_at` 非空
- `toAgentSseEvent({ type: 'text-delta', textDelta: '你' })` 得到 `{ type: 'text-delta', text: '你' }`
- `toAgentSseEvent({ type: 'unknown' }) === null`

`textDelta` 和 `payload.text` 都要能映射到 `text`。工具结果块里的 `result.summary` 映射到事件的 `summary`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/agent-tools.test.js test/agent-routes.test.js`

Expected: FAIL

- [ ] **Step 3: 实现删除和 SSE 映射**

`executeDeleteItem` 先 `assertOwned`，再调用 `characterLibraryService.deleteCharacter`、`sceneService.deleteScene` 或 `storyboardService.deleteStoryboard`。`createTool` 使用 `deleteItemSpec.requireApproval`。本任务可以先导出 spec，在任务 8 再包进 Agent。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/agent-tools.test.js test/agent-routes.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend-node/src/mastra/tools.mjs backend-node/src/mastra/sse.mjs backend-node/test/agent-tools.test.js backend-node/test/agent-routes.test.js
git commit -m "feat: require approval before the agent deletes"
```

### Task 8: 启动 Agent 并提供接口

**Files:**
- Create: `backend-node/src/mastra/index.mjs`
- Create: `backend-node/src/routes/agent.js`
- Create: `backend-node/skills/short-drama/SKILL.md`
- Modify: `backend-node/src/response.js`
- Modify: `backend-node/src/routes/index.js`
- Modify: `backend-node/src/server.js`
- Modify: `desktop/main.js`
- Modify: `desktop/scripts/copy-backend.js`
- Modify: `backend-node/package.json`
- Modify: `desktop/package.json`
- Modify: `backend-node/test/agent-routes.test.js`

**Interfaces:**
- Consumes: 任务 2 至 7 的全部导出
- Produces: `initAgent`、`isAgentReady`、`streamChat`、`resumeApproval`、`getHistory`、`createAgentHandlers`、`serviceUnavailable`

- [ ] **Step 1: 写失败测试**

用假 `runtime` 调用 `createAgentHandlers`，mock 的 `res` 记录 `status` 和 `json`：

- `ready: false` 时 chat 返回 503，message 为 `助手未就绪`
- 剧不存在时 400，message 为 `项目不存在`
- `resolveTextModel` 会失败的库上，ready 为 true 时 400，message 为 `请先在 AI 配置里添加文本模型`
- `resumeApproval` 的假实现未被调用，当 `runId` 不是 `drama-1` 开头的这次请求所属线程。请求 `dramaId: 1`、`runId: 'other-run'` 返回 404
- `getHistory` 的假实现返回的 `pendingApprovals` 原样放进 `response.success` 的 data

内置 skill 文件包含前言 `name: short-drama`，正文包含 12 个工具名，并包含句子：`没有出视频、导入导出、道具、新建或删除整部剧的工具`。

`copy-backend.js` 的 `dirsToCopy` 包含 `'skills'`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/agent-routes.test.js`

Expected: FAIL

- [ ] **Step 3: 安装依赖并实现启动与路由**

在 `backend-node` 安装 `@mastra/core`、`@mastra/memory`、`@mastra/libsql`、`zod`。把安装得到的版本原样写入 `desktop/package.json` 的 `dependencies`。若 `desktop/node_modules` 里出现 `@libsql` 的 `.node` 文件，把该包路径加入 `asarUnpack`，与 `better-sqlite3` 并列。

`initAgent` 创建 `data/skills` 和 `data`。Memory 的文件 URL 指向 `path.join(process.cwd(), 'data', 'agent.db')`。Agent 的 `skills` 使用 `listSkillDirectories`，`builtinDir` 由 `import.meta.url` 解析到 `../../skills/short-drama`。返回列表里不加入 `openclaw-skill`。`model` 函数每次调用 `resolveTextModel(db)`。

`initAgent` 抛错时捕获、记日志、`isAgentReady()` 为 false。

`streamChat` 在写 SSE 前不做 HTTP 状态；路由负责 400 和 503。流里的审批块先经过 `guardDeleteApproval`：`decline` 时调用 Mastra 的 `declineToolCall` 并 `writeEvent` 一条失败的 `tool-result`；`ask` 时 `writeEvent` 规格中的 `tool-call-approval`。结束时写 `{ type: 'done' }`。

`resumeApproval` 只接受 `runId` 能由 `getHistory` 或 Mastra 的 suspended run 证明属于 `dramaThreadId(dramaId)` 的情况，否则路由 404。允许走 `approveToolCall`，拒绝走 `declineToolCall`。

`server.js` 改为异步启动：`const { app, config, db } = createApp()`，`await initAgent({ db, log: logger })`，再 `listen`。`desktop/main.js` 的 `startBackend` 在 `createServer` 之前同样 `await initAgent`。初始化失败不 `process.exit`。

`setupRouter` 在返回前注册：

```js
r.post('/agent/chat', handlers.chat)
r.post('/agent/approve', handlers.approve)
r.post('/agent/decline', handlers.decline)
r.get('/agent/history', handlers.history)
```

`serviceUnavailable` 使用 `error(res, 503, 'SERVICE_UNAVAILABLE', message)`。

12 个执行函数包成 `createTool`。除 `delete_item` 外 `requireApproval` 不设置。工具的 `inputSchema` 不包含 `dramaId` 和 `episodeId`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/agent-context.test.js test/agent-model-skills.test.js test/agent-tools.test.js test/agent-routes.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

只加入本任务的文件和两个 lockfile。不要加入工作区里与助手无关的改动。

```bash
git add backend-node/src/mastra/index.mjs backend-node/src/routes/agent.js backend-node/src/routes/index.js backend-node/src/response.js backend-node/src/server.js backend-node/skills/short-drama/SKILL.md backend-node/package.json backend-node/package-lock.json backend-node/test/agent-routes.test.js desktop/main.js desktop/scripts/copy-backend.js desktop/package.json desktop/package-lock.json
git commit -m "feat: stream the drama agent from the existing API"
```

### Task 9: 助手抽屉

**Files:**
- Create: `frontweb/src/stores/agentContext.js`
- Create: `frontweb/src/utils/agentStream.js`
- Create: `frontweb/src/api/agent.js`
- Create: `frontweb/src/components/AgentDrawer.vue`
- Modify: `frontweb/src/App.vue`
- Modify: `frontweb/src/views/FilmCreate.vue`
- Modify: `frontweb/src/views/DramaCanvas.vue`
- Modify: `frontweb/src/views/DramaDetail.vue`
- Test: `frontweb/test/agentStream.test.js`

**Interfaces:**
- Consumes: 任务 8 的四条接口和 SSE 事件
- Produces: `parseSseBlock`、`useAgentContextStore`、`AgentDrawer`

- [ ] **Step 1: 写失败测试**

`parseSseBlock('data: {"type":"text-delta","text":"你"}')` 返回该对象。空行返回 null。`data: {` 这种坏 JSON 返回 null，不抛错。六种 `type`（含 `done` 和 `error`）都原样返回。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/agentStream.test.js`（工作目录 `frontweb`）

Expected: FAIL

- [ ] **Step 3: 实现抽屉和页面接线**

`useAgentContextStore` 的 id 是 `agentContext`，state 只有 `episodeId`，actions 是 `setEpisodeId` 和 `clear`。

`FilmCreate.vue` 监听 `useFilmStore().currentEpisode` 的 id，写入 `setEpisodeId`；`onBeforeUnmount` 调用 `clear`。`DramaCanvas.vue` 对 `filterEpisodeId` 做同样的事。`DramaDetail.vue` 进入时不自动写入。剧集页的抽屉额外显示「当前集」下拉，选项来自现有剧集详情接口里的 `episodes`（id、序号、标题）。用户选定后 `setEpisodeId`，未选则为 null。制作页和画布页不显示这个下拉。

`App.vue` 挂载 `AgentDrawer`。路由名是 `drama-detail`、`film`、`film-canvas` 时显示右下角按钮「助手」，否则不显示。抽屉宽 400px。

`api/agent.js` 导出 `chat`（POST，`responseType: 'stream'` 或 fetch 读 body）、`approve`、`decline`、`history`。路径是 `/agent/chat`、`/agent/approve`、`/agent/decline`、`/agent/history`，走现有 `request` 的 `/api/v1` 前缀。聊天的流若 `axios` 不便读取，这条用 `fetch`，其他三条用 `request`。

抽屉打开时请求 history，渲染 `messages` 和 `pendingApprovals`。审批卡片显示 `label`、按钮「允许」和「拒绝」。`tool-result.ok === true` 且工具不是 `get_current_project`、`get_task` 时，`window.dispatchEvent(new CustomEvent('lmd-agent-changed', { detail: { dramaId } }))`。

三个页面监听该事件，且 `detail.dramaId` 等于当前剧时：`DramaDetail` 调用 `loadDrama`、`loadCharList`、`loadSceneList`；`FilmCreate` 调用 `loadDrama`；`DramaCanvas` 调用 `loadDrama(true)`。

`tool-result` 或后续任务对象里的 `taskId` 用 `taskAPI.get` 每 3 秒查询，直到 `completed` 或 `failed`，把状态写回同一条工具行。组件卸载时停止计时器。`imageUrl` 或 `localPath` 用现有静态地址方式显示缩略图。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/agentStream.test.js`

Expected: PASS

再在 `backend-node` 运行任务 8 的四条测试，Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add frontweb/src/stores/agentContext.js frontweb/src/utils/agentStream.js frontweb/src/api/agent.js frontweb/src/components/AgentDrawer.vue frontweb/src/App.vue frontweb/src/views/FilmCreate.vue frontweb/src/views/DramaCanvas.vue frontweb/src/views/DramaDetail.vue frontweb/test/agentStream.test.js
git commit -m "feat: add the drama assistant drawer"
```

### Task 10: 桌面手测记录

**Files:**
- 无新代码。这一项只在任务 1 和任务 9 都完成后执行。

**Interfaces:**
- Consumes: 可启动的 Electron 应用和抽屉

- [ ] **Step 1: 启动桌面端**

在 `desktop/` 执行 `npm start`。窗口打开，项目列表能看见原有项目。

- [ ] **Step 2: 走三条对话**

打开一部剧。点「助手」，发送「看看这个项目」，回复里出现剧标题。再让它删除一个测试角色：卡片停住；点「拒绝」，角色还在；再次删除并点「允许」，角色消失，当前页列表刷新。

- [ ] **Step 3: 确认失败不影响原功能**

若本机没有文本模型，发送消息时看到 `请先在 AI 配置里添加文本模型`，项目页仍可打开。不把这次手测写成自动化测试，也不要为了手测去调用真实出图接口，除非操作者自己要点一次。
