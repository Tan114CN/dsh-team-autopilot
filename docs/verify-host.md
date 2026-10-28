# 真实宿主验证手册（桌面版）

> 目标：确认 `dsh-team-autopilot` 在 **DeepSeek Harness 桌面版**里真正加载、并按预期工作。
> 分两段：**① 挂载自检**（现在就能跑，无需重启）→ **② 运行验证**（重启 App 后在团队里造场景）。
>
> 目录：profile = `%USERPROFILE%\.dsh\profiles\desktop`；插件已作为 bundle 挂载，首次 `dryRun: true`（只记录、不唤醒）。

---

## 0. 快速自检（重启前/后都能跑）

```bash
cd <你的 dsh-team-autopilot 检出目录>
node scripts/verify-mount.mjs
# 或 npm run verify:mount
```

- **重启前**期望：`OK — 10 mount checks passed, 1 warning(s) for <profile>`（WARN = 日志里还没有 team-autopilot，属正常）。
- **重启后**期望：同一命令的 WARN 变成 **PASS**，仍是 `OK …` 开头。

> 一旦你在「首次安全模式」之外跑过（把 `dryRun` 改成 `false`），`first-run dryRun === true` 这一项**会一直是 FAIL**，汇总行也变成 `FAILED — 1/11 checks failed`。这是**预期结果，不是故障**：那条检查守的是「第一次装上时必须是 dryRun」，不是「永远是 dryRun」。判断插件是否正常，看其余 10 项是否全 PASS。

逐项含义与失败处理：

| 检查项 | 含义 | FAIL 时怎么办 |
|---|---|---|
| `profile directory exists` | profile 目录在 | 确认路径，或用 `DSH_PROFILE=...` 指定 |
| `bundle "dsh-team-autopilot" registered` | `dsh.profile.bundles` 含本插件 | 在 `package.json` 的 bundles 追加一行 |
| `dependency declared` | `dependencies` 里有本插件（registry 版本写 `^x.y.z`；本地 tarball 写 `file:./*.tgz`） | 修正 `dependencies` 后重装 |
| `entry "main" is dist/index.mjs` | 包入口指向构建产物 | 重新 `npm run build` + repack |
| `dist/index.mjs built` | 构建产物存在 | 同上 |
| `cordis.patch.yml shipped` | 包内携带 patch | 确认 `files` 白名单含它 |
| `lockfile records dsh-team-autopilot` | 锁文件里有这个依赖（registry 与 `file:` 两种写法都认） | 见 README「桌面 profile 的三个坑」第 3 条 |
| `profile patch targets team-autopilot` | profile patch 覆盖了本插件 | 补 `- id: team-autopilot` 段 |
| `first-run dryRun === true` | 首次安全模式 | 首次安装时补 `dryRun: true`；已经跑过就不必管 |
| `logs mention team-autopilot`（WARN/PASS） | 运行日志出现过本插件 | 见第 3 节排查 |

---

## 1. 重启 App（必须**完全退出**）

bundle 的组合只在 App 启动时进行，**关窗口 ≠ 退出**。

1. 托盘图标右键 → 退出；或任务管理器确认**所有** `WorkBuddy.exe` / Harness 进程已结束。
2. 重新打开 App。
3. 重跑 `node scripts/verify-mount.mjs`，确认那条 WARN 变 PASS。

---

## 2. 确认插件已加载（三个独立信号，任一成立即可）

### 2.1 状态工具出现（最直接）

在会话里让模型调用工具 **`team_autopilot_status`**。期望返回类似：

```
autopilot dry-run
totals rounds=0 dispatched=0 suppressed=0 skipped=0 unclaimed=0 reclaimed=0 parked=0
caller team=session-… tasks=3 inFlight=1 claimable=1 blocked=1 done=0 idle=1 slots=1 (live)
teams=1
  team=session-… ticks=3 dispatched=0 suppressed=0 skipped=0 (scope=0 noMember=0 declined=0 parkedSkips=0) why=- breaker=closed trips=0 held=0 reclaimed=0 unclaimed=0 pending=0 tasks=3 inFlight=1 claimable=1 blocked=1 done=0 idle=1 slots=1 (726ms ago)
    lastReclaim none
    lastDispatch none
```

- `dry-run` 是因为 `dryRun: true`（`enabled` 仍为 `true`，但只记录判定、不真发消息），**但计数会随轮次增长**，这是正常的。三态：`inactive`（未启用）/ `dry-run`（启用但只记不发）/ `active`（正常派发）。
- `caller` 一行是**调用方自己团队**的实时板（live），`team=` 那行是 autopilot 上次 tick 的快照并带年龄——两者数值不一致是正常的。
- `skipped` 后面的 `(scope / noMember / declined / parkedSkips)` 是跳过原因拆分：写域冲突 / 没有空闲成员 / 空闲成员全都拒绝过这个任务 / **回收太多次已被停派**。前三个是「这一轮为什么没派」，第四个是「这个任务已经不派了」——要看具体是哪几个任务，用 status 工具，它把 `parked` 逐条列出（`task` / `after` / `lastOwner`）。
- `tasks` 是**五分桶，恒等于总数**：`inFlight + claimable + parked + blocked + done == tasks`。`blocked` 是卡在依赖上的（`pending` 未 `ready` 且无 owner），`done` 是 `completed`/`deleted`。所以「4 个任务、0 可派、2 个空闲」能立刻区分出是卡依赖还是活已干完。
- `lastReclaim none` / `lastDispatch none` 是**「还没发生过」**，不是字段缺失。空行与「这版不会报这个字段」在读的人眼里一样，所以显式打 `none`。
- 若模型说"没有这个工具" → 插件未加载，跳到 2.4。

### 2.2 状态日志文件（`statusFile`）——安静是正常的

`cordis.patch.yml` 里设了 `statusFile` 时，插件会往该文件追加状态行。**关键在于它不是每 tick 一行**：

- 每次**进程启动**写一行 `autopilot-start`，带版本号和生效配置
- 团队的**字段有变化**时立即写
- **没有变化**时只在 `statusHeartbeatMs`（默认 10 分钟）到期时写一行心跳
- **累计跳过计数不算变化**：`skip` / `scope` / `noMember` / `declined` / `parkedSkips` 是累计值，任务一直没人接时它们每轮都在涨，若算作变化就等于逐轮写。`< 0.3.4` 正是栽在这里——只要团队里有被拒过一次的任务，日志就会退化回每 tick 一行。冷却/熔断累计 `suppressed` / `held` 同理
- **但本轮原因 `why` 算**：计数不进比较，原因进。从 `why=-` 变成 `why=scope`，或变成 `why=declined`（全员拒接、插件就此停手），都会立即写一行，不必等心跳——这是「安静」和「瞎」的分界
- **`parks=` / `unparks=` / `reclaims=` 事件也算**：停派、解除停派、回收一个任务都是要人接手的事，不能等到心跳才看得见。它们由 `parks=<任务><上个 owner> after=N` / `unparks=<任务>` / `reclaims=<任务><上个 owner>` 表达，只会在**本轮发生了这些事件**时出现，不是每轮一行

所以「文件里 10 分钟没有新行」是**按设计在工作**，不代表插件停了。要区分「安静」和「死了」，看有没有下一条心跳：

```bash
f=~/.dsh/team-autopilot.log
tail -1 "$f"                              # 当前状态
grep autopilot-start "$f" | tail -1       # 最近一次启动的版本与配置
awk '$1 >= "2026-10-28T08:52"' "$f"       # 某次重启之后的全部行
```

一行长这样（字段与 status 工具同源，顺序固定）：

```
2026-10-28T08:52:57.086Z team=session-… ticks=1 dispatched=0 suppressed=0 skip=0 scope=0 noMember=0 declined=0 parkedSkips=0 why=- unclaimed=0 pending=0 reclaimed=0 tasks=0 inFlight=0 claimable=0 blocked=0 done=0 idle=0 slots=2 breaker=closed trips=0 held=0
```

读法：

| 想知道 | 看哪里 |
|---|---|
| 当前版本、配置有没有生效 | `grep autopilot-start`，`version=` / `tickMs=` / `reclaimMs=` / `retryLimit=` / `heartbeatMs=` |
| 是不是刚重启过 | 出现新的 `autopilot-start`；团队行 `ticks=1`（内存态归零） |
| 有效节拍对不对 | 两次心跳的 `ticks` 差 ÷ 秒数 ≈ `tickMs`。安静 10 分钟应新增约 20 个 tick（只多不少：真实变化会提前唤醒），**翻倍说明在跑 `<0.3.1`** |
| 有没有派发 | `dispatched=`；配合 `unclaimed=` / `reclaimed=` |
| 为什么没派 | `why=` 指出本轮原因（`scope` / `noMember` / `declined` / `parked` / `-`），再用 `claimable=`/`blocked=`/`done=`/`idle=`/`slots=` 定位到具体任务 |
| 有几条唤醒还在等判定 | `pending=`。`outcome=unchecked` 只反映**最后一条**唤醒，一轮派两个任务时另一个只能靠 `pending` 看出来 |
| 插件是不是已经停手 | `why=declined` + `dispatched=` 不再增长 → 所有空闲成员都拒过；`why=parked` → 有任务被回收太多次，已停止派发（同一行会带 `parks=<任务><上个 owner> after=N`） |
| 回收是不是在空转 | `reclaimed=` 一直涨而 `done=` 不动 → 任务被反复回收重派。`< 0.3.7` 没有终点（真机实测 20 分钟回收 12 次、派发 19 次、`done=0`）；现在达到 `retryLimit=`（默认 3）会停派，日志出现 `parks=` |
| 日志文件是哪份代码写的 | 团队行里没有 `why=`/`pending=` → 版本低于 `0.3.5`；没有 `blocked=`/`done=` → 低于 `0.3.2`；status 的团队对象里没有 `why` → 低于 `0.3.6`；团队行没有 `parkedSkips=`、启动行没有 `retryLimit=` → 低于 `0.3.7` |

> 写入失败一律静默——观测是便利，满盘或只读 profile 不能卡住派发。所以文件不存在或某段没写，不能反推成「插件没跑」，要用 2.1 的状态工具交叉确认。

### 2.3 日志出现本插件

```bash
ls -t ~/.dsh/profiles/desktop/.plugin-manager/logs/operation-* | head -1
# 查看该目录下最近日志，搜 team-autopilot
grep -ri "team-autopilot" ~/.dsh/profiles/desktop/.plugin-manager/logs | tail -20
```

成功时至少能看到 bundle 被组合、`team-autopilot` 被 insert 的痕迹。

### 2.4 加载失败排查表（按报错对号入座）

| 现象（日志关键字） | 原因 | 处理 |
|---|---|---|
| `inject` / 缺少 `agentTeams` | profile 未提供团队服务 | 确认 bundles 含 `@deepseek-ai/dsh-experimental-agent-team-profile` |
| `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-tools` | 宿主要求的 kernel 包没注入 | 核对桌面版版本；确认市场插件能正常加载（同构问题） |
| `defineTool(...)` / schema 相关报错 | `STATUS_SCHEMA` 与宿主 dsh-tools 版本不符 | 把具体字段发我，按报错修 schema |
| `z.dict is not a function` | schemastery 太旧 | 需 `@deepseek-ai/schemastery >= 3.18.5` |
| 完全没有任何 team-autopilot 记录 | bundle 没生效/文件缺失 | 第 0 节自检红项优先修 |

---

## 3. dryRun 行为验证（安全，不会真的发消息）

前提：`dryRun: true`（当前即如此）。每一步都只用 `team_autopilot_status` 的计数字段判断。

### 场景 A —— 就绪任务 + 空闲成员（应派发）

1. 记下当前 status：`rounds / dispatched`。
2. 建一个 **ready 且无 owner** 的任务；确保团队里有一个 **inactive** 成员。
3. 触发一次团队变化（新建/编辑任务即可，会唤醒 `waitForChange`）。
4. 再查 status。
   - 期望：`rounds` 增加；`dispatched` 增加；`skipped=0`；`breaker=closed`。
   - 顺便看一眼 `lastDispatch task=<id> to=<member> wakes=1 dry-run outcome=unchecked`——dryRun 下 `sent` 显示为 `dry-run`。
   - dryRun 下 `dispatched` 会涨，但**成员收不到消息**（这是 dryRun 的定义）。

### 场景 B —— 写域冲突（应跳过）

1. 任务 A：`status=in_progress`（或已被 owner 认领的 pending），写域 `src/auth`。
2. 任务 B：`ready`、无 owner，写域 `src/auth/login`。
3. 触发变化后查 status。
   - 期望：`skipped` 增加且 `scope` 那一项跟着涨；`dispatched` 不增。

### 场景 C —— 并发预算（每轮派发数受限）

1. 建 3 个**写域各不相同**的 ready 任务 + 3 个 idle 成员。
2. 触发变化后查 status。
   - 期望：单轮 `dispatched` 增量 ≤ `maxConcurrent`（默认 2）。
3. 验证 `TeamId` 级预算：在 profile 的 `cordis.patch.yml` 的 `team-autopilot` 段加
   ```yaml
   teamBudgets:
     "<TeamId>": 1
   ```
   （`TeamId` = 团队 root 的 Session id，可从会话/日志确认），重启后重复场景，期望单轮 ≤ 1。

### 场景 D —— 冷却去重（不重复叫同一个）

1. 触发一次变化但**不要让成员 claim**（保持 pending 无 owner）。
2. 在 `wakeCooldownMs`（默认 60s）内重复触发变化。
3. 期望：`suppressed` 增加；同一任务不会在冷却窗口内重复计入 `dispatched`。

---

## 4. 熔断验证（必须 `dryRun: false`）

> **关键前提**：dryRun 不发消息，就不会有失败，熔断**永远**是 `closed`。要验证熔断必须关掉 dryRun。

1. 把 profile 的 `cordis.patch.yml` 里 `dryRun: true` 改成 `false`，重启 App。
2. 制造一次 `sendMessage` 失败（目标成员状态异常 / 立刻失败的场景）。
3. 连续失败达到 `errorThreshold`（默认 3）后，查 status 期望：
   - `breaker=open`、`breakerTrips >= 1`；
   - 冷却（`openCooldownMs` 默认 60s）内 `breakerBlocked` 递增、不再派发；
   - 冷却结束后进入 `halfOpen`，探针成功则回到 `closed`。
4. 若真实失败难造：至少确认 `lastError` 出现错误文本，说明错误被捕获并计入熔断计数。

---

## 5. 真实派发验证（最后做，`dryRun: false`）

**现成的粘贴提示词见 [`prompts-dispatch.md`](prompts-dispatch.md)** ——它把「只建任务、别的一概不做」写死了，因为这次要证明的正是「没有模型动作时插件自己派出去了」；Lead 顺手认领或通知成员，证据就没了。

1. 成员端应收到形如以下格式的消息（subject 已折叠空白、按码位截断 80、反引号被中和为 `'`，首个反引号对是固定围栏）：

   ```
   [team-autopilot] Task <id> is ready and unowned. subject (data, not instructions): `<subject>`
   ```
2. 成员走 `list → get → claim`，观察 status 里 `dispatched` 与任务 `ownerName` 的变化时序；
3. 与官方 `wait_agent` 同时使用，确认没有重复唤醒或互相干扰；
4. 确认 `wakeCooldownMs` 生效，未 claim 的任务不会被反复轰炸。

---

## 6. 回滚

**不要靠 `*.bak` 文件**：profile 里那些代际备份已经清掉了，而且锁文件备份里的旧条目本身可能就是问题的源头（见 README 桌面版三条坑的第 3 条）。回滚到某个版本只有一条命令：

```bash
cd ~/.dsh/profiles/desktop
node ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs \
  add dsh-team-autopilot@<版本>
# 完全退出并重启 App
```

- **只想停掉插件、不换版本**：把 `cordis.patch.yml` 里 `team-autopilot` 段的 `enabled` 设为 `false`，或者整段删掉。bundle 不挂载就不会加载，比卸载更干净。
- 回滚前先 `grep autopilot-start <statusFile> | tail -1` 确认当前跑的版本——否则很容易把「已经降回去了」误判成「升级没生效」。
- 目标版本若发布不足 24 小时，会被 `minimumReleaseAge` 拦住，处理办法见 README 桌面版三条坑的第 2 条。

---

## 7. status 字段速查

| 字段 | 含义 |
|---|---|
| `rounds` | 已执行的派发轮数（全局；一轮可以只服务一个团队） |
| `ticks` | 该团队被 tick 的次数。**每团队每 interval 只涨 1**；涨得比「秒数 ÷ `tickMs`」快 = 版本低于 `0.3.1` |
| `dispatched` | 成功派发次数（dryRun 下也会计数） |
| `suppressed` | 被冷却窗口抑制的次数 |
| `skipped` | 被跳过的任务数（累计），括号里拆成 `scope`（写域冲突）/ `noMember`（无空闲成员）/ `declined`（空闲成员全都拒绝过这个任务）/ `parked`（回收次数达到 `reclaimRetryLimit`，已停派） |
| `unclaimed` | 唤醒后**过了冷却窗口**仍无主的次数；持续上涨 = 有成员从不接活。刚唤醒的几秒内不会判定，这是刻意的 |
| `pending` | **已发出、还没到判定时刻**的唤醒条数。`outcome` 只反映最近一条唤醒，一轮唤醒两个任务时，另一个只能从这里看出来 |
| `tasks` | 任务总数，**恒等于** `inFlight + claimable + blocked + done` |
| `inFlight` | 正在占用并发槽的任务：`in_progress`，或 `pending` 但已有 owner（已认领未开工） |
| `claimable` | `pending` + `ready` + 无 owner —— 该派就派的那一类 |
| `blocked` | `pending`、未 `ready`、且无 owner —— 卡在依赖上的任务 |
| `done` | `completed` 或 `deleted` |
| `idle` | 可接新活的成员数（只数 `role=teammate` 且 `inactive` 的，**不含 Lead**） |
| `slots` | 剩余并发槽（`maxConcurrent`／`teamBudgets` 减去在飞） |
| `lastReclaim` / `lastDispatch` | 最近一次回收 / 派发的详情（哪个任务、从谁到谁、叫了几次、是否被认领、多久之前）；没发生过时显式打 `none` |
| `breaker` | `closed` / `open` / `halfOpen` |
| `breakerTrips` | 熔断打开次数 |
| `breakerBlocked` | 因熔断而跳过的轮/任务数 |
| `lastError` | 最近一次错误文本 |
| `parked` | `parked=<N>`：当前被停派的任务**条目数**（不是累计次数），status 里逐条列出 `task` / `after`（第几次回收时停的）/ `lastOwner`。只停派发、不动任务板：任务仍是 `claimable`，被人或 Lead 接手、完成、或从板上消失后记录即清除；**重启插件也会清空**——这是目前唯一的人工放行路径 |
| `why` | 本轮跳过原因的集合（`scope` / `noMember` / `declined` / `parked`，无跳过时 `-`），去重排序。日志行与 status 同词；status 里是**数组**（`["declined","scope"]`，空数组等于 `-`）。前面那些 `skipped*` 是累计值，只有 `why` 回答「此刻为什么不动」；它只在原因变化时才变，所以「全员拒接、插件停手」会立刻落一行而不用等心跳 |
