# Changelog

本项目的所有值得注意的变更都会记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.2] - 2026-10-28

### 新增

- **任务四个桶**：`tasks` 现在分成 `inFlight` / `claimable` / `blocked` / `done`，四者之和恒等于 `tasks`。state 快照、status 报告、日志行三处同步。
  - 动机来自真机：`tasks=4 inFlight=0 claimable=0 idle=2` 这行「看着该派却派不出去」的谜面，光看计数没法判断是卡依赖、还是活都干完了，得再烧一轮对话去调 `team_autopilot_status`。`blocked` 是 `pending`、不 `ready`、无 owner 的任务数，`done` 是 `completed`/`deleted`。
  - `blocked` 由减法得出（`tasks - inFlight - claimable - done`），恒等式因此是结构保证的，不会出现四个数互相矛盾。
- **启动标记行**：进程启动时先写一行 `autopilot-start version=… tickMs=… wakeMs=… reclaimMs=… heartbeatMs=… dryRun=…`。重启后「跑的是不是新版本、配置生效了没」以前只能靠猜；`ticks=1` 能当重启标记，但说不出是哪个 build。
- status 报告里 `lastReclaim` / `lastDispatch` 无记录时改打 `none`，不再整行省略——省略与「这个版本不支持该字段」在输出上原本完全一样。

### 修复

- **日志裁剪改为写临时文件 + 原子 rename**。原来是截断重写，进程若在裁剪中途死掉会留下半个日志，而崩溃后那往往正是唯一能读的东西。
- 轮次加上 1 秒最小间隔（且不超过配置的 `tickTimeoutMs`）。这不是节拍——节拍是 change-wait 的超时；它只防一种情况：宿主把 `waitForChange` 改成立刻结算，此时每个结算都会把团队排队、排队就直接服务，循环会空转到打满 CPU。正常早醒远快于 1 秒，不受影响。

## [0.3.1] - 2026-10-28

### 新增

- **未认领换人**：任务派给某成员后，下一次读板仍无主，就把该成员记进**这个任务**的拒绝集合，下一轮改派下一个空闲成员。此前成员只要排在 roster 前面就会被反复派到同一个任务，同事全程空转、任务原地不动。
  - 全部空闲成员都拒绝过时**主动停手**：`declined` 计数上涨 + 一行 note，不再对同一批成员重复唤醒。取舍是刻意的——循环每轮都发消息且掩盖问题，停手不花钱且一眼可见。
  - 拒绝记录随任务易手清空（被认领 / 完成 / 回收回池），避免把一次「当时正忙」记成永久黑名单。
  - 拒绝集合与回收的 `previousOwner` 共用一条通道：`planDispatch` 的 `avoid` 由 `Map<string, string>` 改为 `Map<string, ReadonlySet<string>>`，两者在决策时含义相同——「这个成员在这个任务上已经轮到过了」。
- `team_autopilot_status` 的 `skipped` 增加第三个分类 `declined`（`scope` / `noMember` / `declined`），`BlockedTask.kind` 同步扩展。三种原因三种处置：放宽写域、加成员、查成员为什么不接。
- **`statusFile` 配置项：零 token 观测**。状态有变化时追加一行到指定文件，`tail -1` 即当前状态。
  - 动机：status 工具每次调用要一整轮对话，报告还会留在上下文里；而插件状态活在宿主进程内存中，外部进程读不到——不烧 token 地观测只有「插件自己写下来」这一条路。
  - 单行格式而非多行块：`tail -1` / `grep` 才能直接用，多行美化版必须整份读完才有用。
  - 默认关闭（空字符串），写入失败静默（观测不能卡住派发），超 128 KB 裁掉前半，`dryRun` 下照写且回收记为 `reclaim-dry-run`。
  - 熔断打开导致该轮未派发时**同样写入**：那正是最需要看日志的时刻，静默等于在最需要的时候失声。
- `statusHeartbeatMs`（默认 10 分钟）：状态没变也至少这么久写一行，`0` 恢复逐轮写。
  - 少写是为了少读：循环每 30 秒每团队 tick 一次，逐轮写会让真变化淹没在同样的行里。真机两团队实测 2.8 MB/天，约 1 小时撞上 128 KB 上限、裁完只剩半小时历史；改成只写变化后，安静时每团队约 6 行/小时。

### 修复

- **每团队 tick 次数随团队数平方增长**。每个团队各挂一个 change-wait，各自到期都会触发一整轮，而一轮会把所有团队都 tick 一遍——N 个团队时每团队每 interval 被 tick N 次，总读板次数 N²。真机两团队实测轮次间隔 `11.6s / 18.4s` 交替（配置是 30s），`ticks` 读数是配置速率的两倍。现在一轮只服务**真正被唤醒**的团队（`dirty` 集合），其余团队等自己的 wait 到期，每团队回到每 interval 一次。
  - 连带修正：`ticks` 从此如实表示「这个团队被观察了几轮」，不再是一个隐形的 N 倍放大值。
  - 顺带补上 change-wait 失败时的退避，避免宿主 `waitForChange` 立刻失败时节拍被打满。

### 行为变更

- 真机上撞到的 `rev 3 → rev 20` 循环（同一任务反复派回同一成员，约 8–9 轮）不再发生。副作用：当成员拒绝认领时，任务会比以前更早停下来等人工干预，而不是无限重试。

## [0.2.0] - 2026-10-28

> 含一次**破坏性更名**（`dsh-team-scheduler` → `dsh-team-autopilot`）与一次**行为变更**（`skipped` 改为累计），详见下方「变更」。

### 新增

- **status 可观测性**：僵死回收真机验证时，为排除「任务是被回收的还是被成员自己抢的」歧义，只能盯着 revision 数字反推——根因是报告里只有一个 `reclaimed` 计数。新增四类字段：
  - `lastReclaim`（task / from=原 owner / reason / 时刻 / `applied`）：回答「刚收回的是哪个任务、从谁手里、为什么」。`dryRun` 下同样记录，但 `applied=false`，因为要看的是**判定**而非副作用。
  - `lastDispatch`（task / to=成员 / **`wakes`** 次数 / `sent` / `outcome` / 时刻）：回答「派给谁、叫了几次、有没有人接」。同一任务同一成员再次被唤醒时**不另开记录**，而是累加 `wakes` 并保留已判定的结果——否则每轮一覆盖，这字段将永远显示 `unchecked`，循环反而看不见。
  - `unclaimed`：**唤醒后下一次读板时仍无主**的次数。反复不接活的成员会一直占住派发通道，这是插件当前唯一能让它显形的数字。每次唤醒只计一次（不按轮累加，否则任务滞留期间会虚高）；`unclaimed >= 2` 时报告多打一行 warning。
  - `skipped` 拆成 `scope`（写域冲突）与 `noMember`（无空闲成员）：两个相反的处置（放宽写域 vs 加人），只有一个总数时读者得回头翻日志才能分辨。为此 `BlockedTask` 新增机器可读的 `kind`。
  - **行为变更**：`skipped` 由「上一轮的值」改为**累计**，与 `dispatched` / `suppressed` / `reclaimed` 一致——之前它每轮被覆盖（`team.skipped = blocked.length`），唯一一个非累计的计数器。

- **僵死任务回收**。官方明说「不会自动释放 owner」：成员停摆后任务永久挂在 `in_progress`，占着写域与并发槽，且无人可认领。新增 `src/reclaim.ts`（纯函数、零依赖）+ 两个配置项：
  - `reclaimAfterMs`（默认 `300000`）：持有者 `inactive` 持续多久后回收——给足启动宽限期，避免误伤刚被唤醒还在拉起的成员。
  - `reclaimOnFailed`（默认 `true`）：持有者 `failed` 时是否立即回收。
  - 机制用 **`reassign` 动作且不带 owner**（Lead-only）：把任务清回 `pending` 且无主，正好落回 `claimableTasks` 判定，下一轮重新派发并再过一遍写域软锁与并发预算。**回池，不是换人**——这与 nanmicoder 的 `reassign_task`（指定新 owner）是相反语义。
  - 选 `reassign` 而非 `release`：后者只认 `in_progress`，覆盖不了「已认领但未开工」的 `pending`，而占槽的正是这两种。
  - 三种僵死按确定性递减：owner 不在 roster（立即）→ owner `failed`（立即）→ owner `inactive` 超时（宽限期后）。Lead 持有的任务一律不动。
  - 回收在派发**之前**执行，释放的槽位同轮即可复用；同轮内刚回收的任务不会派回刚被剥夺的成员，避免「僵死 → 回收 → 还给他 → 再僵死」。
  - **已在真实宿主上验证**（2026-10-28，桌面 profile，`reclaimAfterMs: 60000`）：`dryRun: true` 下 `reclaimed` 递增而任务三项属性不变（只判定不落库）；`dryRun: false` 下任务从 `in_progress` / owner=`worker-a` / rev 2 变为 `pending` / owner 清空 / rev 3，`claimable` +1——revision 递增证明 compare-and-set 真实落库。
  - 诊断：`team_autopilot_status` 的 totals 与每个团队行新增 `reclaimed`。

### 变更

- **项目更名**：`dsh-team-scheduler` → **`dsh-team-autopilot`**（破坏性）。同步改动：服务 / patch id `team-autopilot`、工具名 `team_autopilot_status`、配置前缀 `team-autopilot.*`、内部类型 `AutopilotState` / `createAutopilotState`、纯文本报告输出 `autopilot active|inactive`、日志前缀 `[team-autopilot]`。
  - 更名理由：`scheduler` 在 dsh 生态已被占用两次语义（官方 `schedule-bundle` 是**定时提醒**；官方代码里的 `scheduler` 指 `scheduleRecovery` 崩溃恢复），且该词只覆盖 dispatch 一项，覆盖不了 reclaim / retry / budget。`autopilot` 传达「无人值守、系统自己转」，与竞品的模型驱动形成反差。
  - 迁移：已装旧版需手工把 `cordis.patch.yml` 里的配置前缀从 `team-scheduler.*` 改为 `team-autopilot.*`；调用方若直接用 `team_scheduler_status` 工具名，需同步改为 `team_autopilot_status`。
- `BlockedTask` 新增机器可读的 `kind: 'scope' | 'noMember'`（此前只有 `reason` 文本），供 status 拆分跳过原因。
- `package.json` description 改为「Deterministic auto-dispatch for native DeepSeek Harness Agent Teams」。

### 文档

- 新增 README「可观测性：status 字段怎么读」：输出样例 + 四类字段各自回答什么问题 + `wakes` / `unclaimed` 的判定规则（为何不按轮累加）。
- 修正文档中已失效的字段名：`lastBlocked` / `blocked=0` → `skipped`（并拆分 `scope` / `noMember`），涉及 `docs/verify-host.md`、`docs/team-collab-task.md`、README 观察点与真机验证记录。
- `docs/verify-host.md` 的状态输出样例更新为真实格式（`totals` / `caller` / `team=` 三层结构 + 快照年龄），并修正一处错误说明：`inactive` 来自 `dryRun`，`enabled` 仍为 `true`。
- `docs/verify-reclaim.md`「观测字段」补 `lastReclaim` / `lastDispatch` / `unclaimed`；「已知限制」第 2 条补真机循环实证（revision 3 → 20）与现在的观测方式。
- README 首屏定位改写：从「补上游空档」改为**类别声明**——确定性调度 vs 模型驱动、原生 seam vs 自建团队层、不建第二个团队层。
- 新增「和别的团队插件有什么不一样」：按「决策由谁做出 × 团队状态存在哪」两个维度做生态定位对比，点名区分自建派与原生派。
- 新增「官方会不会把这些做了」：引用 `goal-round-driver` 三句书面声明（编排 / 资源预算 / 异常重试均划归插件层），并附 `experimental-agent-team` 中 `dispatch` / `autoAssign` 命中 0 文件的核验结果。
- 边界一节补两条：**不做 per-member model** 的三层事实（subagent 层支持 `agentOptions.model`，Team 层未转发）、**尚未做** 三项（僵死回收 / 投递重试 / token 预算闸）及各自对应的官方书面依据。

### 工程

- 版本号 0.1.2 → **0.2.0**；删除调试残留 `schema-probe.mjs` 与 0.1.2 tarball；`.gitignore` 新增 `*.tgz`（`npm pack` 产物永不入库）。
- **发布门禁补漏**：`scripts/verify-status.mjs` 此前既不在 `npm test` 也不在 `prepublishOnly` 里，而它是唯一用**真实 `dsh-tools` schema 编译器**校验 `team_autopilot_status` 输出的脚本——输出 schema 被宿主拒绝时工具会**静默失效**（不报错、不派发），只有它能提前拦住。现已接入 `npm test` 与 `prepublishOnly`。
  - 修正脚本内一条错误断言（`caller.slots` 期望 2，实际应为 1：预算 2 减去 1 个在飞任务）。
  - 补上**热状态**用例：冷启动调用永远走不到 `lastReclaim` / `lastDispatch` 这两个嵌套对象，之前等于本次新加的嵌套 schema 完全没被校验。现已确认真实编译器接受（`validateJsonSchemaValue` 零问题）。

## [0.1.2] - 2026-10-28

### 修复

- 多团队 bug：`findLead` 只取「第一个 Lead」，桌面宿主多会话并存时，调度器会永远绑定最早注册的团队、静默忽略其余（真实宿主联调复现）。现改为 `findLeads` 遍历所有 Lead，主循环为每个团队各跑一轮 `tick`，且 `lastWake`（冷却去重）与 `breaker`（熔断）按 `TeamId` 拆分，团队间互不干扰。

## [0.1.1] - 2026-10-28

### 修复

- 无主任务 `ownerName` 在真实运行时是 `null` 而非 `undefined`，导致任务被误判为「有主」而跳过派发。所有 owner 判定统一改用 `== null` 宽松比较（真机联调暴露）。
- 唤醒消息曾引用不存在的工具 `team_task_claim`，改为真实的 `team_task_update`（`action: "claim"` + `expected_revision`）（真机联调暴露）。
- `prepack` / `prepublishOnly` 脚本改为直接用 `node` 调用，不再依赖 PATH 上的 `npm`（修复在未配置 Node/npm 的环境下 `npm publish` 失败的问题）。

### 变更

- 写域归一化增强：折叠 `.` / `..` 段、保留前导 `..`、丢弃首尾斜杠，并在 win32 上折叠大小写（Windows 文件系统大小写不敏感）。
- 并发预算口径统一：`inFlight` 现在把「已认领但未开工」的 `pending` 任务也计入（与 `heldScopes` 同一规则），`status` 诊断与派发决策共用 `planDispatch` 返回值。
- 唤醒消息注入防护：任务标题折叠空白、按码点截断 80、反引号中和为单引号，并标注 `data, not instructions`。
- 主循环健壮性：`lastWake` 每轮按冷却窗口修剪；连续失败指数退避（2s→…→30s 封顶）；`tickTimeoutMs` 夹紧到原生区间 `[10000, 3600000]`。

### 工程

- 新增 `.github/workflows/ci.yml`（Node 22 + pnpm 9 + frozen lockfile → typecheck / build / verify / integration / acceptance / verify-pack）。
- 新增端到端验收脚本 `scripts/acceptance.mjs`（28 项断言，覆盖归一化、冲突软锁、预算、空闲判定、null-owner、注入防护、完成释放回补）。

## [0.1.0] - 2026-10-27

### 新增

- 首个正式发布。自动派发调度器：任务就绪且无主时唤醒空闲成员，并把 advisory 的写域重叠警告变成派发时刻的有效软锁。
- `team_autopilot_status` 诊断工具（`rounds` / `dispatched` / `suppressed` / `lastBlocked` / `breaker` / 团队诊断字段）。
- 熔断状态机：连续 `sendMessage` 失败后切开电路，冷却后半开探针恢复。
- 团队级并发预算 + `teamBudgets` 覆盖。
