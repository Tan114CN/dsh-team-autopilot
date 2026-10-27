# dsh-team-scheduler

Auto-dispatch for DeepSeek Harness **Agent Teams**. Wakes an idle teammate when a task becomes ready, and turns the advisory `writeScopes` overlap warning into an effective soft lock at dispatch time.

## 为什么需要它

原生 Agent Teams 的一个明确的空档，写在它自己的模型策略里：

> **Task readiness never starts an owner.**  
> `wait_agent` observes only changes after that call starts, never wakes a member.  
> Write-scope overlap is **advisory, not a lock**.

也就是说：任务变成可执行之后，**没有人会被自动叫醒**，得靠 Lead 手动发消息推动；而写域冲突只是提示，不会拦截。

这个插件补的正是这两件事。

## 安装

```bash
npm i dsh-team-scheduler
```

或交给 dsh 插件管理器（CLI 版 dsh）：

```bash
dsh plugin --profile web add dsh-team-scheduler
```

已发布版本自带预构建的 `dist/`，安装后无需再跑构建。

`@deepseek-ai/*` 全部声明为 **optional peer**，由宿主 profile 提供；在宿主之外单独 `import` 本包会在运行时抛 `Cannot find package '@deepseek-ai/schemastery'`——这是预期行为。

## 前置条件

必须先有一个提供 `ctx.agentTeams` 的组合：

```bash
dsh plugin --profile web add @deepseek-ai/dsh-experimental-agent-team-profile
```

然后把本插件叠在它之后：

```bash
dsh plugin --profile web add dsh-team-scheduler
```

`cordis.patch.yml` 会插入 `team-scheduler` 一行。若 `agentTeams` 不存在，插件因 `inject` 无法解析而不会加载——这是预期行为，不是 bug。

## 配置

| 键                | 默认      | 说明                         |
| ---------------- | ------- | -------------------------- |
| `enabled`        | `true`  | 关掉后只保留状态工具，不跑循环            |
| `tickTimeoutMs`  | `30000` | 每次等待窗口，原生硬限制 10000–3600000 |
| `maxConcurrent`  | `2`     | 团队并发预算默认值（见下）                  |
| `wakeCooldownMs` | `60000` | 同一任务在该窗口内不重复唤醒             |
| `dryRun`         | `false` | 只记录决策，不发消息                 |
| `teamBudgets`    | `{}`    | 按团队覆盖并发预算，key 为团队 `TeamId`（root Session 标识） |
| `errorThreshold` | `3`     | 连续 `sendMessage` 失败几次后切开熔断      |
| `openCooldownMs` | `60000` | 熔断打开后保持多久再半开探针              |
| `halfOpenProbe`  | `1`     | 半开阶段允许的探针派发次数               |

## 设计决策（都来自源码核验）

**1. 只唤醒，不代认领。**  
`updateTask` 的 `claim` 动作留给成员自己走 `list → get → claim` 流程。调度器代认领会和成员争抢所有权，而 CAS 冲突只会让成员白跑一轮。代价是多一次往返，换来的是所有权语义干净。

**2. 先挂 waiter，再读状态。**  
`waitForChange` 内部只是一个 `Map<TeamId, Set<Waiter>>`，**没有任何历史缓冲**——注册之前发生的边沿永久丢失。所以顺序必须是「先 `waitForChange`，后全量 `listTasks`」，否则会漏掉窗口期内的变化。

**3. 每轮重新解析 Lead。**  
`waitForChange` / `listTasks` / `sendMessage` 都要求一个 **live** Agent 当凭证。Lead 实例在会话重组后会被替换，缓存引用会失效。所以每轮都走 `ctx.agents.list()` + `tryMembership()` 重新找。

**4. `inactive` 才是可唤醒状态。**  
成员只有 4 态：`running` / `inactive` / `provisioning` / `failed`。**没有 `idle`**。`inactive` 表示当前没有回合在执行，`sendMessage` 会启动或恢复它。`running` 在干活、`provisioning` 还没起来、`failed` 已废。

**5. 写域判定与原生一致，但多一层防御。**  
用 `left === right || left.startsWith(right + '/') || right.startsWith(left + '/')` 的 `/` 分段规则（所以 `src/a` 不会误判与 `src/ab` 冲突）。另外 `claimableTasks` 除了看派生的 `ready` 标志，还强制要求 `status === 'pending'`——不盲目信任别的组件产出的派生值。**真机注意**：无主任务在运行时 `ownerName` 是 `null`（不是 `undefined`），所有 owner 判定统一用 `== null`，否则会把无主任务误判为"有主"而全部跳过。

**6. 同轮去重 + 冷却窗口。**  
一轮内多个任务可能写域重叠，先分配的会占住作用域；跨轮则用 `wakeCooldownMs` 抑制重复唤醒——因为发消息本身会触发 activity 通知，不设冷却会反复叫同一个还没 claim 的成员。

**7. 团队级并发预算 + 错误率熔断。**  
`maxConcurrent` 改成「默认预算」，新增 `teamBudgets` 按团队覆盖——`teamKey` 取 `ctx.agentTeams.tryMembership(lead).id`（即 `TeamId`，绑定 root Session；不用 Lead 显示名，因为名字可改、TeamId 稳定）。另外 `breaker.ts` 是一台独立纯状态机：连续 `errorThreshold` 次 `sendMessage` 失败后切开电路（`breaker=open`），暂停唤醒 `openCooldownMs`，随后进入 `halfOpen` 用 `halfOpenProbe` 次探针试探——全成功则闭合、任一失败立即重开。`breaker` / `breakerTrips` / `breakerBlocked` 进 `team_scheduler_status` 可观测。

**8. 主循环与 Cordis 接线分离。**  
单轮 `tick` 与主循环 `loop` 放在 `src/dispatch.ts`，只依赖类型与零依赖纯模块（`select.ts` / `lead.ts` / `breaker.ts`），**不 import `dsh-tools`**；`src/index.ts` 只保留 `Config` 校验、`team_scheduler_status` 工具与 `apply` 接线。这样联调 harness 能直接驱动真实 `tick`，无需拉起整个宿主依赖树。

## 构建

```bash
npm run build        # tsdown → dist/index.mjs + dist/index.d.mts
```

`main` / `types` / `exports` 均指向 `dist/`，`dsh.bundle.patch` 指向 `cordis.patch.yml`。从 registry 安装时 `prepack` 已保证 `dist/` 是新鲜的；只有以本地路径 / git 方式挂载才需要手动 `npm run build`（`dist/` 被 `.gitignore` 忽略，但 `files` 白名单会把它带进发布包）。

## 发布

```bash
npm run verify:pack     # 打包内容断言（不落盘）
npm publish --dry-run   # 走一遍 prepublishOnly + prepack，看清最终清单
npm publish             # prepack 自动重建 dist；prepublishOnly 跑类型检查与两套测试
```

- `dist/` 被 `.gitignore` 忽略，但 `prepack` 会在打包前强制重建，所以**从干净检出发布也安全**。
- 版本号手动改 `package.json`（本项目不使用 changesets）。请用 `npm publish`，不要用 `pnpm publish`。
- 发布后自检：`npm view dsh-team-scheduler dist.tarball`，或 `npm pack dsh-team-scheduler && tar -tzf dsh-team-scheduler-*.tgz`。

## 已验证

```bash
node node_modules/typescript/bin/tsc --noEmit   # → 零错误
node tests/verify.ts                            # → OK — 21 checks passed
node tests/integration.ts                       # → OK — 4 integration checks passed
```

- **类型对账通过**：代码按 rc.3 源码结构编写，类型来自 npm 上的 `0.2.1-rc.2`，两者完全兼容，无 API 偏差。
- **零依赖自检**：纯函数核心（选任务、选成员、写域冲突、并发预算、同轮去重、熔断状态机）有 21 项断言覆盖。`select.ts` / `breaker.ts` 只有 `import type` 或无外部依赖，所以 `node tests/verify.ts` 不需要任何 `node_modules` 也能跑。
- **进程内联调**：`tests/integration.ts` 驱动真实 `tick()`（来自 `dispatch.ts`），用一个可控宿主桩覆盖 4 条关键路径——唤醒空闲成员、写域冲突拦截、连续失败触发熔断、`TeamId` 级预算覆盖。`dispatch.ts` 不 import `dsh-tools`，所以同样零 `node_modules` 可跑。

## 开发环境注意事项

**1. node-linker 必须是 hoisted**

`package.json` 里声明了 `"pnpm": { "nodeLinker": "hoisted" }`。在当前的 Windows 环境上，pnpm 默认的 `isolated` 模式会创建 junction，而这一步**静默失败**——`node_modules/@deepseek-ai/` 会变成空目录，`tsc` 报 `Cannot find module`。hoisted 模式直接写真实目录，绕开该问题。

**2. pnpm install 可能需要在沙箱外执行**

若 `pnpm install` 报成功但 `node_modules` 里没有条目，说明写入被沙箱拦截（pnpm 不报错）。换到非沙箱环境重装一次即可。

**3. 不要用 `pnpm run typecheck`**

`pnpm run` 会先触发一次自动 `install`，在上述环境下可能把 `node_modules` 又破坏掉。直接调用：

```bash
node node_modules/typescript/bin/tsc --noEmit
```

## 真实宿主联调

真机端到端需要真实 `dsh` 宿主 + 可用的 LLM provider（`dsh web` 要起真实会话），无法在无头环境跑。进程内已用真实 `tick()` 覆盖调度判定（见上），剩下的是「在真实宿主里观察」。

> **桌面版注意**：`~/.dsh` 桌面 App（如 `0.2.1-rc.3`）**没有 `dsh` CLI**，由 App 驱动，且已内置 `@deepseek-ai/dsh-experimental-agent-team-profile`（团队前置条件天然满足）。挂载方式是把本包加进 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 与 `dsh.profile.bundles`，在 profile 内 `pnpm install`（pnpm 由 runtime 自带、不在 PATH），再重启 App。下面的 CLI 命令仅适用于 CLI 版 dsh。

```bash
# 1) 装宿主与团队 profile（版本对齐 0.2.1-rc.2）
npm i -g @deepseek-ai/dsh@0.2.1-rc.2
dsh plugin --profile web add @deepseek-ai/dsh-experimental-agent-team-profile

# 2) 叠上本插件（cordis.patch.yml 会自动插入 team-scheduler 一行）
dsh plugin --profile web add dsh-team-scheduler
# 未发布时改用本地 tarball：dsh plugin --profile web add ./dsh-team-scheduler-0.1.0.tgz

# 3) 先开 dryRun 观察判定（把 patch 里 config.dryRun 设为 true），再起宿主
dsh web
```

逐场景验证（含失败排查表、dryRun 各场景、熔断、真实派发）见 [`docs/verify-host.md`](docs/verify-host.md)；挂载自检：`node scripts/verify-mount.mjs`（`npm run verify:mount`）。

观察点：

- 一个 ready 且无 owner 的任务 + 一个 `inactive` 成员 → 下一轮 `team_scheduler_status` 应看到 `rounds` 递增、`dispatched` 递增、`breaker=closed`。
- 一个写域与在飞任务重叠的 ready 任务 → `lastBlocked≥1`，且不产生唤醒。
- 故意让 `sendMessage` 失败 → 连续 `errorThreshold` 次后 `breaker=open`、`trips≥1`；冷却期内 `blocked` 递增且不再派发。
- 关掉 `dryRun` 后，确认成员端实际 claim 时序，以及和官方 `wait_agent` 是否互相干扰。

## 真机验证记录

在 DeepSeek Harness 桌面版 `0.2.1-rc.3` 上（`dryRun: true`）实测：

- 写域冲突拦截：`lastBlocked=1`（task-2 被 in_progress 的 task-1 挡住）
- 正路径派发：`dispatched=1`（task-3 派给 idle 成员）
- 冷却去重：`suppressed=2`
- 诊断：`team=session-… tasks=3 inFlight=1 claimable=2 idle=1 slots=1`
- 熔断保持 `closed`（dryRun 不发消息，符合预期）

真机还揪出并修复了一个单测没覆盖的 bug：无主任务的 `ownerName` 是 `null` 而非 `undefined`（详见设计决策 #5）。

真机第二个体检项：`wakeMessage` 曾误用不存在的 `team_task_claim` 工具，已改为真实的 `team_task_update`（`action: "claim"`, `expected_revision`）。

`dryRun: false` 下实测：真实 `sendMessage` 成功唤醒成员，`task-3` 被队友认领并 `completed`（`ownerId` 为队友 session），确认 **sendMessage → claim → complete** 闭环；修正后的 `team_task_update` 文本已生效。

## 仍未验证

- 真实宿主上熔断与 `sendMessage` 错误形态的对应关系（真实失败较难人为制造）
- 与官方 `wait_agent` 工具共存是否互相干扰

## 边界

- 不修改原生状态机，不用内部符号，不写自定义 SessionEvent
- 不做独立工作目录（`SpawnTeammateRequest` 无 `cwd` 字段，Team 层不支持）
- 不做成员自治（原生 Explicit authority：只有 Lead 能 spawn / interrupt）
