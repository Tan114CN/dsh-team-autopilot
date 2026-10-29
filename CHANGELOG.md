# Changelog

本项目的所有值得注意的变更都会记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang-CN/)。

## [0.6.4] - 2026-10-29

### 修复

- **peer 范围静默排除了 harness 的 alpha 线。** `peerDependencies` 写的是 `>=0.2.1-rc.2 <0.3.0`，看起来覆盖 0.2.x 的所有版本——但 node-semver 只允许预发布版本满足「自身 `major.minor.patch` 元组带预发布标签」的那个比较符，于是 `0.2.2-alpha.2`（上游当前的 `alpha` tag）落在范围**之外**，且**没有任何警告**。上游 contributing 指南点名了这个坑。实测两种后果：在项目里同时存在本插件与 harness 依赖时，pnpm 会把用户明确请求的 `0.2.2-alpha.2` 悄悄换成 `0.2.1-rc.4`；宿主钉死版本时虽然能装上，但 `engines.dsh` 的同一写法会让插件管理器拒装。修法是按 contributing 指南的写法加显式 `||` 预发布分支：`>=0.2.1-rc.2 <0.3.0 || >=0.2.2-alpha.2 <0.3.0-0`，`engines.dsh` 同步。
  - 三个非 dsh 的 peer 有同样的问题，且修法要按各自的 tuple 分支写：`@deepseek-ai/cordis`（`>=4.0.5 || >=4.0.5-alpha.1 <5.0.0-0 || >=4.0.6-alpha.1 <5.0.0-0`）、`@deepseek-ai/schemastery`（`>=3.18.5 || >=3.18.5-alpha.1 <4.0.0-0 || >=3.18.6-alpha.1 <4.0.0-0`）。
  - 已核验上游 `0.2.2-alpha.2` 的团队包里，本插件用到的 8 处 API（`tryMembership` / `listTasks` / `listMembers` / `waitForChange` / `updateTask` / `sendMessage` / `agents.roots` / `tools.register`）全部健在——所以这是**写法**过时，不是真不兼容。
- **`repository` 指向了改名前的旧地址。** 仓库在 GitHub 上的 owner 是 `wooden-tan`（`Tan114CN` 是改名前的旧名，GitHub 会重定向）。`package.json` 的 `repository` / `homepage` / `bugs` 三处仍写旧名。npm↔仓库的映射靠 `repository` 字段自动采集，指回旧名会让映射取不到。README、资产脚本与 `docs/distribution.md` 里的链接一并改正。`author` 保留 `Tan114CN`——那是 npm 账号名（`tan114cn`），不是仓库地址。

### 加固

- `scripts/verify-pack.mjs` 新增三道发布期守卫：每个 `@deepseek-ai/*` peer 范围必须覆盖上游已发布的预发布版本（用真实 `semver` 判定，不是肉眼看字符串）、`engines.dsh` 必须同样覆盖、`repository` 必须指向现行仓库地址。已用「把范围退回旧写法」确认它在旧代码上为红（报 `0.2.2-alpha.2 not covered`）。
- `semver` 加入 `devDependencies`（仅发布期守卫用，不进运行时依赖）。

### 文档

- README 的「类型对账通过」补上那个 `||` 分支的由来，并说明它不是冗余。
- CHANGELOG 里那段 `[未发布]` 分节此前**错置在 0.3.6 之上**——0.3.9 那次提交把它插到了顶部，之后 0.4.0 / 0.4.1 连着发布，它没被转正，于是被越挤越深，最终卡在一个早已发布的版本中间。它描述的内容早已在 0.4.0 的文档同步里落地，留在那里只会让人以为那些改动还没发。

## [0.6.3] - 2026-10-29

### 新增

- **`up=`：这些计数数了多久。** 状态工具第一行现在是 `autopilot active health=ok version=<x> up=17m`，`StatusReport` 新增 `uptimeMs`，`src/report.ts` 新增 `formatUptime(ms)`（`42s` / `17m` / `6h` / `3d`，单单位无小数）。所有计数器都在内存里，重启归零，而任务板不归本插件管、重启后照旧——`dispatched=3` 配 `up=3m` 是刚起步，配 `up=3d` 才是三天只派了三次；「唤醒预算刚花完却看起来没动」也只有带存活时长才读得出来。

### 加固

- **启动行与首行都被断言钉住。** `verify:status` 的首行断言从 `/autopilot inactive/` 收紧到 `/autopilot inactive health=off version=\S+ up=\d+[smhd]$/m`，并加 `assert.ok(result.uptimeMs >= 0)`；`warm` 夹具用 `...result` 展开，已带 `uptimeMs`，不会渲染出 `up=NaNd`。红证明：把 ` up=${formatUptime(report.uptimeMs)}` 从首行去掉，`verify:status` 立刻报 `The input did not match the regular expression /autopilot inactive health=off version=\S+ up=\d+[smhd]$/m`。
- `tests/verify.ts` 加 `formatUptime` 边界测试（`0s` / `59s` / `1m` / `17m` / `1h` / `6h`（小单位直接丢弃、不四舍五入）/ `1d` / `3d` / 负值记 `0s`）；渲染测试的首行断言改为 `/^autopilot active health=ok version=test-build up=2m$/m`。verify 71 → 72 项。
## [0.6.2] - 2026-10-29

### 加固

- **配置表加进漂移守卫。** 同一份默认值现在有四份副本：schema、`resolveConfig` 的 `??` 回退、启动日志行、README 的配置表。前两份已经被 `verify:status` 逐键比较过了，第四份没有——而它恰恰是操作者唯一会读的那份。它漂过：`livenessEnabled` / `livenessGraceMs` / `livenessSettleGraceMs` 发版时根本没进表，`stalledRunningMs` 与 `wakeBudgetPerHour` 也是后来补的。文档里的默认值写错的失败方向还特别讨厌：照着它去覆盖，得到的是「设了值但什么都没变」。
- 守卫双向检查：`resolveConfig()` 的每个键都必须出现在表里，且**表里写的默认值与实际值逐键相等**；反过来，表里出现的键也必须仍然是配置项（删掉的配置不许在文档里留个影子）。字符串默认值按 `` `''` `` 记、对象按 `` `{}` `` 记，与表里现有写法一致。
- `dryRun` 这类布尔与 `teamBudgets` 这类对象也在覆盖范围内——`JSON.stringify` 的 `false` / `{}` 正好就是表里写的形式，不需要为它们开特例。

## [0.6.1] - 2026-10-29

### 修复

- **唤醒戳只增不减，一个任务一条，永不释放。** 每发一次唤醒就记一条 `taskId → 时间戳`，但只有两条路径会删它：成员明确拒绝、以及回收成功。任务被认领、被完成、被删除之后那条记录就留在表里了——而读取路径只查「即将派发的任务」，所以永远碰不到这些死条目。宿主进程活得越久、派过的任务越多，这张表就越长，每个条目带一个任务 id。这与之前修过的状态桶、`loop` 的四张 per-team 表是同一种形状，也同样不会让任何测试变红。
- 顺带修掉一个潜在的错误抑制：任务被删除后如果复用同一个 id，新任务会继承旧任务的冷却，在窗口内表现为「被唤醒过、但没人接」，而实际上它从未被唤醒。

### 设计说明

- 清理放在每轮派发决策之前、按两条判据一次做完：戳已过期（比较的是 `now - stamp < wakeCooldownMs`，更老的戳再也不可能抑制任何事），或任务已不在这一轮的板上。前一条让表的规模从「本进程派发过的所有任务」变成「最近一个冷却窗口内派发过的任务」；后一条让删除掉的任务不留下痕迹，也顺手解决 id 复用。
- 没有改成在认领/完成时逐点删除：那要把「任务怎么离开板子」的所有路径都枚举对（认领、完成、删除、被回收、被别的 Lead 改派……），漏一条就是同一种泄漏。按「还能不能起作用」清理与路径无关，也正是读取路径真正在意的那个问题。

### 加固

- `tests/verify.ts` 71 项（+1）：`forgets wake stamps that can no longer suppress anything`——过期的戳、不在板上的任务的戳都消失，还在窗口内的保留；`wakeCooldownMs: 0`（等于「从不抑制」）下一条都不留。
- `tests/integration.ts` 45 项（+1）：`stops remembering a wake it can no longer hold back`——一条过期戳加一条孤儿戳在同一轮里被清空，而窗口内那条原样保留。已用「临时关掉清理调用」确认在旧代码上为红（`neither stamp can suppress anything again`）。
- 自检 70 → 71 项，integration 44 → 45 项。

## [0.6.0] - 2026-10-29

### 新增

- **唤醒预算 `wakeBudgetPerHour`：插件唯一花钱的动作现在有总闸了。** 唤醒就是发起一个模型回合，也就是钱，而此前所有上限都是按**任务**算的：`wakeCooldownMs` 管同一个任务不要被反复唤醒，`reclaimRetryLimit` 管同一个任务不要被无限回收。二十个就绪任务对五个空闲成员，一轮就能开出二十个回合，下一个小时再开二十个，而没有任何一处数字会说这件事。新配置按**队**统计**滚动一小时**内已发起的唤醒数，花完的那一轮直接不派发。默认 `0` = 不开——这是关于钱的策略，不该由插件的默认值替用户决定。
- 被预算挡住的轮次在日志与报告里都留名：轮次行新增 `budget=used/limit`（`off` = 没设预算），`budgetSkips` 累加进 `skipped` 的括号里，`why=budget` 说明这一轮的原因。启动标记行新增 `wakeBudget=`（即使为 `off` 也印，否则「这一版没有预算」与「这一版预算为 0」在日志里无法区分）。

### 设计说明

- 窗口用**时间戳列表**而不是「窗口起点 + 计数」：计数器在窗口边界上会少报（12:59 发 59 条、13:01 再发 59 条，一小时里其实 118 条）。列表长度由预算本身封顶——额度花完后不再追加，所以它不会长过配置的上限。
- `dryRun` 的模拟唤醒**也计入**预算：它代表同一个决定。否则打开 `dryRun` 看到的一小时派发量，第一轮真跑就复现不出来。
- 「这一轮满了」和「这一小时的钱花完了」在任务板上长得一模一样，所以两者分开说：满员是下一轮自己会好（不产生 `blocked` 条目），预算花完要人决定抬上限还是等窗口滚动（`why=budget`）。

### 修复

- **`AutopilotState.teams` 的注释还在说「buckets 永不删除」。** 0.5.3 之前确实如此，之后加了 32 个桶的上限与「最久未 tick 者先淘汰」。注释留着会让人以为上限不存在，把「加了上限」当成又一次无界增长。

### 加固

- `tests/verify.ts` 70 项（+2）：`the wake budget measures the last hour rather than the calendar hour`（窗口是半开的——正好一小时的戳算过期；`0` 仍表示不限；花完不出现负数）与 `planDispatch spends the round on the wakes it is allowed, and says why it stopped`（额度是绑定约束时任务记 `budget` 而不是静默；额度花完时每一个都记；额度宽裕时满员轮次仍然安静——两种「什么都没发」不能混为一谈）。
- `tests/integration.ts` 44 项（+1）：`a spent wake budget stops dispatch and says so, then refills`——两个空闲成员、两个就绪任务、额度 1：第一轮只发一条，第二轮一条都不发且 `skippedBudget >= 1`、`why` 含 `budget`，把时间戳老化到窗口外之后额度回来。已用「把额度改成 `Infinity`」确认在旧代码上为红。
- 漂移守卫自动覆盖新增的 `skippedBudget` / `wakesThisHour` / `wakeBudget` 三个字段，只改 schema 或只改报告会当场报错。
- 自检 68 → 70 项，integration 43 → 44 项。

## [0.5.9] - 2026-10-29

### 修复

- **回收之后，旧唤醒还在冷却里压着任务。** 按任务的唤醒戳守的是「这一次尝试」，可回收把它留着了：任务回到池子、位置空出来、空闲同事在 roster 里排着，插件却要等下个冷却窗口结束才肯发唤醒。把 `reclaimAfterMs` 调到比 `wakeCooldownMs` 短就会稳定撞上（那时回收落在窗口内），默认值不会——所以它一直没在真机上露头。这与 0.5.4 修的「拒绝之后仍占满冷却」是同一类错误，只是这里等的对象从拒绝换成了回收。现在回收成功即删戳；`dryRun` 下同步生效，那正是预测该反映的东西。

### 加固

- `tests/integration.ts` 43 项（+1）：`a reclaim frees the task from the wake cooldown it was sent under`——预置一条 2 秒前的唤醒戳与 60 秒冷却，回收后必须立刻改派给另一个空闲成员。已用「撤回删戳」确认在旧代码上为红（`sent=[]`、`suppressed=1`）。
- 自检 68 项、integration 43 项。

## [0.5.8] - 2026-10-29

### 新增

- **状态工具给出一个单字判决 `health`。** 报告里每个数字单看都能解释成「正常」：`slots=0` 是满载、`parked=1` 是主动停派、`breaker=open` 是保护机制。真正的信息是它们之中哪个最坏，而这件事此前要读完整份报告才能推出来。现在第一行直接给出 `broken` > `stuck` > `blind` > `parked` > `ok` 里成立的那一个——顺序就是处置优先级，并且由 `tests/verify.ts` 断言，不是实现顺序的副产品。`halfOpen` 不算 `broken`：它还在派探针流量，能自己恢复。
- **状态工具报告 `version`。** 启动日志里有同一个值，但日志恰好是「日志出问题」时唯一读不到的地方（见 0.5.5）。从工具里读，「我看的是哪一版」就不用靠猜。

### 加固

- `healthOf` 是 `report.ts` 里的纯函数：输入「是否启用」与逐队行，输出判决；`verify-status.mjs` 的 schema↔报告漂移守卫自动覆盖新增的两个字段，只改一边会当场报错。
- 自检 67 → 68 项（新增处置顺序测试），integration 保持 42 项。

## [0.5.7] - 2026-10-29

### 修复

- **熔断打开时，整轮都被跳过了，不只是派发。** 早退发生在结算、回收、卡死观察之前，于是 `openCooldownMs` 这段静默期里，陈旧的 owner 依然占着槽位、没人被回收、卡死也不上报。代价是双份的：冷却熬过去、熔断闭合，结果第一条唤醒还是发不出去——因为唯一的槽位仍被那个陈旧 owner 拿着，得再等满一个 `reclaimAfterMs`。现在熔断只挡住派发，其余照跑；被挡的轮次照样写状态行（那是日志最该说话的时刻，`breaker=open` 本身也值得被看见）。

### 加固

- `tests/integration.ts` 42 项（+1）：`an open breaker still reclaims the slots it will need back`——熔断打开、无唤醒发出，但陈旧 owner 必须被回收，且 `slots` 在熔断期间就能看到腾出来的位置。已用「恢复旧早退」确认在旧代码上为红。
- 顺带修好一处连带症状：被熔断挡住的轮次现在也会刷新 `lastTickAt`、刷新板上的数字，所以状态行里的 `age`、`slots`、`tasks` 不再停留在熔断前那一轮——过去它们会一直冻在那，看起来像主循环已经停了。
## [0.5.6] - 2026-10-29

### 修复

- **`halfOpenProbe: 0` 会让熔断器永久卡在 half-open。** 冷却结束转入 half-open 时，探针配额直接取自配置；为 `0` 时 `canDispatch` 恒为 `false`，而 `recordSuccess` 只在真的派发之后才被调用，于是配额永远停在 `0`，团队再也不会收到一条唤醒——没有报错、没有 trip，`breaker=halfOpen` 看起来像还在试探，只有重启进程才能恢复。修法两层：`evaluate` 转入 half-open 时把配额钳到至少 1，且遇到「half-open 但配额已耗尽」的既有状态时直接闭合（那是死路，不是状态）；`resolveConfig` 增加 clamp。
- **配置兜底只覆盖了一半的键。** `resolveConfig` 自称「绕过校验时的最后一道防线」，却只钳了 5 个键，漏掉的恰好是会把槽位静默归零的那些：`maxConcurrent`、`halfOpenProbe`、`teamBudgets`（`0` 预算 = 永不出动的团队）。现在所有有界的数值都过 `clamp()`，逐队预算也逐项收敛。故意不设上限的只有 `wakeCooldownMs` / `statusHeartbeatMs`：长冷却只是慢，钳掉反而会悄悄改写操作者的意图。

### 加固

- `verify-status` 新增 clamp 断言（零预算、零探针、零阈值、超出上限的停车次数、逐队预算），并保留「零冷却 / 零心跳是合法选择」的反向断言——把合法值也钳掉，是另一种静默改语义。
- `tests/verify.ts` 67 项（+1）：half-open 无探针必闭合；`tests/integration.ts` 41 项（+1）：冷却到期后必须真的再次派发（用 `halfOpenProbe: 0` 直接喂给 `tick`，证明即使非法值抵达也不会卡死）。二者都已用「撤回修复再跑」确认在旧代码上为红。
## [0.5.5] - 2026-10-29

### 修复

- **`statusFile` 写不进去时，一声不响。** 追加失败一路被 `catch` 吞掉，`recordStatus` 也不看结果。于是路径写错、目录没人建、沙箱收走了写权限——这些都会在**每一轮以同样的方式失败**，而唯一的痕迹是「文件不存在或一直是空的」，那和无事发生的安静团队在观感上完全一样。对 headless 用户来说，这是最要命的一种假象：他以为自己看到的空日志是「今天没人干活」。现在 `appendStatusLineWith` 返回布尔（仍然从不抛），`recordStatus` 把它记进 `TeamState.statusWriteFailed`，`team_autopilot_status` 在受影响的团队下打一行 warning 说明该查路径／目录／权限；写入恢复后标记自动清除，报的是**正在发生**的问题而不是记住的问题。
- **只吞掉「追加」失败，不误报裁剪失败。** 日志被 `tail` 占住导致裁剪失败时，行其实写进去了，那有它自己的退避与 `trim=failed` 标记；把它算进写失败会在每一轮错怪错的东西。

### 加固

- 回归测试：`verify` 66 项（原 65）、`integration` 40 项（原 39）。集成侧用一个不存在的子目录做 `statusFile`，断言第一轮 `statusWriteFailed=true`、换成可写路径后 `false`、并且真文件里能读到 `team=` 行——两个方向都钉住，避免「永远为真」也能通过。渲染侧断言 warning 文案，且 `TEAM_SCHEMA` 增加 `statusWriteFailed`（`required`），漂移守卫会要求 schema 与真实报告同时带上它。

## [0.5.4] - 2026-10-29

### 修复

- **成员已经明确拒绝，任务仍被冷却压住。** `tick` 的结算循环把一次唤醒判成 `unclaimed`（成员读过唤醒、回合结束但没有认领）时，只把该成员记进 `declined`，却没有清掉 `lastWake` 那张按任务的抑制表。于是从下一轮起，派发循环照旧让这个任务等满 `wakeCooldownMs`（默认 60 秒）——尽管答案已经知道，别的空闲成员本可以立刻接手。卡片上看到的就是 `claimable=1 slots=1` 却一条唤醒都不发。现在判定的同一刻就删戳：冷却的存在是为了「不把成员的思考时间误判成拒绝」，而回合结束即职责结束；拒绝的成员仍由 `declined` 排除，所以删戳不会把同一个人再喊一遍。liveness 关闭时本就要等满冷却才结算，删戳在那条路径上没有副作用。

### 加固

- 回归测试：`integration` 39 项（原 38）。新增的 `a refusal frees the task for a colleague without waiting out the cooldown` 在旧实现上直接失败（`sent` 停在 `['alice']`），并且同时钉住 `suppressed === 0`——将来若只删了戳、却留下别的抑制判断，这条断言会当场报错。

## [0.5.3] - 2026-10-29

### 修复

- **状态工具顶部的「实时板」把停派任务算成了可派发任务。** `readCallerBoard` 调 `boardSummary` 时把 `parked` 传成 `undefined`，而那个参数唯一的作用就是把停派任务从 `claimable` 里摘出去。于是同一次输出里，`caller … claimable=1` 与下面团队行的 `parked=1` 说的是同一个任务，两个数字互相矛盾。0.4.0 修过团队桶的同一个问题，`caller` 那一处漏了。
- **顺带把这段逻辑从 `index.ts` 提到了纯函数 `callerBoard`（`src/select.ts`）。** 原来它藏在 `apply` 的闭包里，没有 `ctx.agentTeams` 就测不到，这正是它漏掉的原因。现在停派与已承诺槽位都由 `callerBoard` 折叠，`tests/verify.ts` 可以直接喂一个带 `parked` / `pendingWakes` 的状态桶断言结果。
- `boardSummary` 的 `parked` 参数类型放宽为 `ReadonlyMap<string, unknown>`：它只读键集合，这样状态里的 `Map<string, ParkRecord>` 能直接传进来，不必在调用处再造一份投影。
- **`caller` 行补上 `parked=`，否则修完上面那条，它自己的数字就对不上账了。** 停派任务被从 `claimable` 里摘掉之后，`caller` 行只剩下 `tasks / inFlight / claimable / blocked / done`，而这几个数相加不再等于 `tasks`——差额去哪了没人说。停派恰恰是「明明有空位却没动静」最常见的原因，所以这个计数必须出现在同一行上（`blocked` 原本就不含它）。

### 加固

- 回归测试：`verify` 65 项（原 64）。新增的 `callerBoard folds parking and promised slots into the live view` 在旧实现上会读到 `claimable=2 / parked=0`，直接失败；渲染测试现在逐字钉住整行 `caller team=… tasks=2 inFlight=1 claimable=0 parked=1 …`，少一个计数字段就红；`scripts/verify-status.mjs` 的漂移守卫同时要求 `CALLER_SCHEMA` 与真实报告都带 `parked`——只改一边，守卫当场报错。

## [0.5.2] - 2026-10-29

### 修复

- **日志裁剪会把启动标记整行弄丢。** `appendStatusLineWith` 用 `line.startsWith('autopilot-start ')` 去找启动标记，但那行的形状是 `<iso> autopilot-start …`——标记从不在行首，所以这个查找从来没有匹配到一次，第一次裁剪就把唯一能回答「跑的是哪个 build、哪套配置」的那行丢掉。README 里「裁剪后版本/配置仍可 grep」的承诺此前并不成立。现在改用 `/^\S+ autopilot-start /`。
- **同一行启动标记会被重复写入，` (trimmed)` 会层层叠加。** 如果重启不久、标记仍落在保留的尾半里，旧代码会再前置一份，文件里就出现两行 `autopilot-start`；二次裁剪又会把上一轮写入的 ` (trimmed)` 行再拼一个后缀。现在：带 ` (trimmed)` 的先剥掉后缀再判断，尾半里已有标记就不再前置。
- **裁剪失败的退避曾是一道单向开关。** `trimFailures >= TRIM_FAILURE_LIMIT` 之后直接 `return`，从此不再重试——于是一次短暂的 Windows 文件占用（一个只读共享打开日志的 `tail`）就会让本进程永久失去裁剪能力，日志随之一路无上限增长，恰好是裁剪本身要防的那件事。现在改成按时间退避（1s 起、每次失败翻倍、封顶 30s），占用解除后自动恢复；`trim=failed` 标记仍会在第 3 次连续失败时写一次。`appendStatusLineWith` 增加可选 `clock` 参数，供测试注入时间。

### 加固

- 回归测试 `verify` 64 项（原 61）、`integration` 38 项（原 37）：用假的 `StatusFs` 造 1300 行 / ~150 KB 日志，断言裁剪后启动标记恰好一行且带 ` (trimmed)`、二次裁剪不出现 `(trimmed) (trimmed)`、标记已在尾半时不再前置。这个测试在旧实现上直接失败（0 行标记），测的是真缺陷而不是形状。

## [0.5.1] - 2026-10-29

修补了四处「数字对得上、行为不对」的地方。没有配置项的默认值变动，旧配置直接可用。

### 修复

- **`dryRun` 不再伪造「拒绝」。** 模拟模式下没有人真的收到唤醒，但结算循环照样在冷却到期后把每条未答复的唤醒判成 `unclaimed`，写进 `declined`，于是后续轮次 `why=declined` 并把该成员永久排除——演示的是自己的记账污染，而 `dryRun` 恰恰是 README 推荐的首跑模式。现在模拟唤醒带 `simulated` 标记：它继续占槽（预测才忠实），但绝不被判定。
- **一个已唤醒、尚未被认领的任务不再被重复派发。** `pendingWakes` 里的任务在板上仍然是「无主且就绪」，所以下一轮会再派一次，随即被冷却抑制——那一个槽位就白白花掉了，排在后面的就绪任务因此被饿住。现在这些任务直接跳过，不再占用本轮的计划名额。
- **这类任务的写作用域现在真的被占住了。** 成员随时可能认领并开始写，而板上还看不出任何迹象；此前同一轮里作用域重叠的另一个任务照派不误，正是这套作用域规则存在的意义所在。
- **`lastStall` 终于出现在状态报告里。** `toTeamReport` 映射了 `stalled` / `stallWarnings` / `stallInterrupts`，却漏了 `lastStall`——schema 有它、渲染有它、数据没接上，于是状态工具永远不输出这一行。
- **团队状态桶有了上限（32 个）。** `AutopilotState.teams` 原本只增不减，长期存活的宿主每见到一个新 TeamId 就多一个桶，状态报告跟着一起长。现在超额时淘汰最久未 tick 的桶：活着的团队每轮都 tick，永远不会是受害者。

### 加固

- **`resolveConfig` 从 `apply` 里提出来并导出。** 手写 clamp 依然是绕过校验时的最后一道防线，但现在默认值只有一处来源。
- **新增两道漂移守卫（`scripts/verify-status.mjs`）。** 其一：各输出 schema 的键集合必须与真实报告逐键相等（且 `required` 的键必须真的出现）；其二：`Config({})` 的默认值必须逐键等于 `resolveConfig()`。第一道守卫上线当场就抓出了上面那个 `lastStall` 缺陷——这类「schema 有、报告没有」的静默不一致，此前只能靠人肉对照。
- 回归测试：`verify` 61 项（原 59）、`integration` 37 项（原 36）。


## [0.5.0] - 2026-10-29

补上了「卡住但看起来在干活」这半边盲区，并清掉了两处以「看起来绿」代替「真的绿」的地方。日志格式有**新增字段**（`stalled=` / `interrupts=` / `stalls=` / 启动行 `stalledMs=` / `interrupt=`），只读旧字段的 grep 脚本不受影响。

### 新增

- **长回合卡死观测（`stall.ts`）。** 回收只处理「已经不在干活」的 owner，而卡死恰恰长成「看起来在干活」：驱动不返回、取消没写终态。此时任务永远 `in_progress`、槽位永远被占、熔断永远不 trip（没报错），团队静默停摆而每个数字都正常。现在 `stalledRunningMs`（默认 15 分钟，`0` 关闭）之后会把它报成 stall：状态日志 `stalls=task<owner`、团队行 `stalled=`/`interrupts=`、状态报告多一行 `lastStall task=… owner=… for=…ms`。**观察窗从「首次观测」与「当前回合起点」的较晚者起算**，首次看到绝不当场判罚——否则跑得久的回合中途认领新任务会被瞬间判死。
- **`interruptStalled`（默认关）。** 打开后对 stall 的成员调用官方 `interrupt`，同一 stall 只断一次（`interruptedAt` 记在观察表里）；`provisioning` 只报不断（还没有回合可取消）；`dryRun` 下永不中断。默认关的理由很直接：中断会掐掉正在做的工作，误判的代价是一个下午，漏判的代价是一个空槽等人来看。
- **槽位把未 claim 的唤醒算作已承诺。** `slots` 之前只减 `inFlight`，而唤醒到 claim 之间有空窗，这段空窗里同一批空闲成员会被重复唤醒。现在减的是 `inFlight + 仍未结算的 pendingWakes`（只计任务仍可认领的），日志 `pending=` 与 `slots=` 从此自洽。

### 修复

- **`scripts/verify-status.mjs` 的宿主桩补上 `ctx.on`。** liveness 特性加进 `apply` 后，这个脚本在 `trackLiveness` 处抛 `TypeError: ctx.on is not a function` 直接死掉，README 却仍写着 PASS——它已经有一段时间没有真正校验过输出 schema 了。
- **`tests/integration.ts` 的启动标记断言跟随启动行。** liveness 字段加进 `autopilot-start` 后断言正则没跟着改，`integration` 一直是红的。现在改成按整段设置序列断言，失败时直接打印到达的那一行。
- **`cordis.patch.yml` 不再复制默认值。** 它之前把 11 个键连同默认值抄了一遍，schema 默认值一改就悄悄覆盖掉用户意图；新加的特性（`reclaimRetryLimit` / `statusFile` / `liveness*` / `stalled*`）也从没同步进去。现在只保留 `enabled: true`，默认值只有 schema 一份。

### 文档

- README 配置表补齐 `livenessEnabled` / `livenessGraceMs` / `livenessSettleGraceMs` / `stalledRunningMs` / `interruptStalled`。
- 新增设计决策 10（卡死观测）与「为什么异常不能叫醒 Lead」：官方 `sendMessage` 禁止给自己发消息，Lead 只能被 root 的 `steer` 唤醒，而那条路要求插件冒充 teammate 说话——为了告警污染消息来源不值得。所以上报只走 `statusFile` / 状态工具 / 报告渲染三条不花 token 的通道。

## [0.4.1] - 2026-10-29

### 修复

- **「本轮排满」不再误报成「没有空闲成员」。** `planDispatch` 之前把「空闲成员都已在本轮被派出去」记成 `noMember` 并累加 `skippedNoMember`，可此时明明有成员空闲，排查者会被引导去「加人」。现在三分：成员池为空 → `noMember`；空闲成员本轮已排满 → 正常排队背压，不产生 blocked 条目、不计 `skippedNoMember`；剩余成员都拒绝过该任务 → `declined`。
- **认领后被回收不再记成「无人应答」。** 任务被唤醒 → 成员认领 → 僵死 → 被回收时，若该 wake 仍待判定（`wakeCooldownMs` 比 `reclaimAfterMs` 长），回收会清空 owner，后续 settle 读到 `ownerName == null` 就误判 `unclaimed` 并触发报告里的误告警。现在回收本身就是「有人认领过」的铁证，回收时把该任务从待判定集合移除、settle 为 `claimed`，不再累加 `unclaimed`。

### 加固

- **状态报告不再交出内部引用。** `toTeamReport` 之前把 `parked` 记录、`lastReclaim`、`lastDispatch` 作为 state 内部对象本身返回，下一轮会原地改写它们（填 `claimed`、加 `repeats`、重停派）。现在各加一层浅拷贝，持有报告行之后再改团队状态，行内容不变。
- **停派解除条件的已知限制写进注释。** 任务「原地 reopen 成无主 pending」与「回收留下的无主 pending」在 board 上无法区分，故不作为停派解除条件；人类认领即可解除停派。这是有意的边界，不是遗漏。

## [0.4.0] - 2026-10-29

本次是只读审查（致命 1 / 中 24 / 低 24）后的一轮集中修复，覆盖 P1 行为正确性、P2 可观测性、P3 文档同步三档。日志格式有**破坏性变更**（`parked=` → `parkedSkips=`、`reclaim=`/`park=` → `reclaims=`/`parks=`/`unparks=`、新增 `sent=`/`err=`），依赖日志 grep 的运维脚本需同步更新。

### 修复（P1 行为正确性）

- **停派任务不再计入 `claimable`。** `claimable` 之前不排除 `parked`，停派后长期呈现 `claimable>0 / idle>0 / slots>0` 却 `dispatched=0`，排查者会先怀疑成员和槽位。现在 `boardSummary` 把停派任务拆进独立的 `parked` 桶、从 `claimable` 排除，任务桶恒等式变为 `inFlight + claimable + parked + blocked + done === tasks`。
- **容量满不再吞掉跳过原因。** `planDispatch` 里 `plans.length >= slots` 时 `break`，排在「填满最后一个槽位的任务」之后的停派/写域冲突任务连 `blocked` 都走不到，`why=` 显示「本轮没有原因」。现在容量满只停止派发，继续走完剩余任务并记录各自的原因。
- **`.` 写域不再 fail-open。** `normalizeScope` 之前把 `.`、`/`、`./` 都归一化成空串，而 `scopesOverlap` 把空串当「未声明」放行——`writeScopes: ['.']` 的全局写任务会与任何任务并行。现在根目录归一化成哨兵 `'.'`，与任何非空 scope 冲突；空串/空白仍是「未声明」、不冲突。
- **回收写失败不再重置宽限期。** `planReclaim` 在「计划」时就删掉 stall 表条目，`reassign` 失败只 `continue`，下一轮重新计时、默认再等一个 `reclaimAfterMs`。现在释放目标带上观察起点 `sinceAt`，写失败时把时间戳写回 stall 表，下一轮立即重试而非重等整个宽限。

### 改进（P2 可观测性）

- **回收/停派/解除停派改为事件数组。** 原来只播报最后一个 `reclaim`/`park`，一轮回收 3 个只留最后一条，且「解除停派」在日志里完全不可见。现在 `reclaims=` / `parks=` / `unparks=` 按本轮事件数组输出，解除停派与停派一样是新事件。
- **裁剪保留启动标记行。** 裁剪按「后半」切，第一次触顶就把 `autopilot-start` 启动行永久删掉，`grep` 判「是否重启/版本」失效。现在裁剪时保留最近一条启动行（标 `(trimmed)`）。
- **日志行输出 `err=`。** 失败轮此前与「没人可派」形状完全相同，`lastError` 只进 status 不进日志。现在 `lastError` 存在时行尾追加 `err=<折叠空白的前 120 字>`。
- **唤醒段加 `sent=`。** dryRun 下 `dispatched` 照涨、`sent=false`，日志与真实唤醒逐字段相同。现在 `sent=0/1` 区分「消息真离开进程」与「只记判定」。
- **report 首行三态。** `dryRun` 之前渲染成 `inactive`，健康判据会把它读成「插件没加载」。现在 `inactive` / `dry-run` / `active` 三态。
- **累计停派计数改名 `parkedSkips=`。** 同一个 `parked=` 承担三种含义（日志累计跳过数、团队行累计跳过数、totals 当前停派任务数），极易误读。现在日志与团队行的累计计数改名 `parkedSkips=`，`totals parked=` 保留「当前停派任务数」，`parks=` 是事件。
- **启动行补全生效配置。** 新增 `reclaimOnFailed=` / `maxConcurrent=` / `errorThreshold=`，`slots=` / `breaker=open` 这些日志字段从此有据可查。

### 清理

- 删除无调用方的 `findLead` 死导出。
- `releasedTargets` 循环变量改名 `entry`，消除对 `released` 计数器的遮蔽。

### 测试

- `verify.ts` 46 → 50：新增停派拆桶、容量满记录原因、`.` 写域、`sinceAt` 携带四组断言。
- 日志相关断言同步新格式（`parks=`/`unparks=`/`reclaims=`/`sent=`/`err=`/`parkedSkips=`）。

## [0.3.9] - 2026-10-28

### 修复

- **`rounds` 不再双计。** `state.rounds` 的语义是「跨所有团队的派发轮次」，但它在 `tick` 内（每团队一次）和 `loop` 迭代内（每次循环一次）各 `+1`，多团队时一轮循环会 tick N 个团队、再 +1，导致 `totals rounds=` 虚高且随团队数漂移。现在只保留 `tick` 内计数——`rounds` 等于各团队 `ticks` 之和，loop 空转或一轮服务多团队都不再额外 +1。
- **熔断退避按团队，不再被健康团队清零。** `teamFailures` 之前只写不读，退避用的是全局 `failures`，而任意团队成功都会把它归零——持续失败的团队退避恒为 2s，健康团队还会掩盖另一个团队的连败。现在 `tick` 失败的退避改用该团队自己的 `teamFailures` 计数，`failures` 只留给 change-wait 失败的宿主级退避。
- **`suppressed` / `held` 从日志签名剥离。** 熔断打开期间 `held`（`breakerBlocked`）逐轮 +1、冷却期内 `suppressed` 逐轮 +1，都会让签名每轮变化 → 每 tick 一行，把心跳退化回逐轮写。「熔断打开」这个事件已由 `breaker=open` 字段本身承载（它仍在签名内），后续的 `held` 累计增长是纯计数，不该重新打开日志。

### 测试

- `integration` 里「熔断打开写日志」的断言收紧：验证的是「closed→open 那一轮写一行（`breaker=open`），之后 `held` 累计增长保持安静」——旧的断言把「熔断打开」和「held 逐轮写」混在了一起。
- 补断言：`rounds === 各团队 ticks 之和`；`suppressed`/`held` 累计增长不改变签名。

## [0.3.8] - 2026-10-28

### 修复

- **循环保活：一次宿主异常不再静默杀死调度器。** `loop()` 的 `while` 体里，`findLeads`（session recomposition 时 `tryMembership` 会抛）、`Promise.race`（change-wait 竞速）和 `pause` 都不在任何 `try` 内——任何一处 reject 都会一路传播到 `loop` 的 async 边界，`while` 永久退出，派发、回收、停派同时失效，而且 `lastError` 根本没机会写（它只在 `tick` 的 catch 里）。这是最坏的失效形态：静默。现在把整轮抽成 `runRound()`，外层 `while` 用一条 fence 兜住，失败记 `lastError` + 固定 2 秒退避（不用指数退避——那是留给「连续 send/wait 失败」的，recomposition 是毫秒级瞬态，重退避反而会把恢复后的宿主拖 30 秒）。`index.ts` 的 `void loop(...)` 再加一道 `.catch` 兜底。
- **裁剪失败退避，防 O(n²) 无界增长。** 裁剪失败（Windows 上 `rename` 覆盖被 `tail` 类进程只读打开的文件会失败）被静默吞掉后，每轮 append 都重复「stat → 读整个超限文件 → 写一半 → 再失败」，日志无界增长且反复读整个文件。现在连续失败 3 次后停止重试裁剪，并写一行 `trim=failed` 让异常可见；一旦某次裁剪或低于上限的 stat 成功，计数归零。
- **状态写入超时，观测不再能挂死调度循环。** `recordStatus` 的 `appendStatusLine` 在 tick 关键路径上，只承诺不抛错、没承诺不挂住——statusFile 落在网络盘或被 AV 扫描时，一次 append 就能拖垮整轮。现在用 `Promise.race` 加 2 秒超时，超时丢弃本行而非丢弃派发轮。

### 测试

- `integration` 26 → **29**：新增「宿主异常后循环保活并恢复」「状态写入超时不阻塞」「裁剪失败退避」三条。`appendStatusLine` 拆出 `appendStatusLineWith(path, line, fs)` 供测试注入失败宿主；`resetTrimFailures()` 导出供测试隔离进程级退避计数。

## [0.3.7] - 2026-10-28

### 新增

- **回收有上限：反复回收的任务会被停派。** 回收一个僵死的 owner 是对的，无限回收不是。真机上发生过：一个只会认领不会干活的成员，让同一个任务在 20 分钟里被回收 12 次、派发 19 次，`done` 始终为 0——每圈一次模型唤醒，全部烧在同一件事上。原因是回收后没有终止条件：`avoid` 只排除本轮的前主人，而回收分支会清掉该任务的拒绝记录（理由是「任务换了手，旧拒绝作废」），于是原主人下一轮又合格，环就此闭合。现在按任务记回收次数，达到 `reclaimRetryLimit`（默认 3，`0` = 不限，上限 32）就不再为它唤醒任何人。
- **停派是可见的、可逆的、不动任务板。** 日志写 `park=task-1<scope-a after=3`，`why=parked`，`parked=N` 进状态行与 status 工具（逐条列出 `task` / `after` / `lastOwner`）。任务本身仍是 `claimable`——插件只是不再**替它**找人，Lead 或人类随时可以自己认领。一旦任务易手、完成、或从板上消失，停派记录即清除；重启插件也会清空，这是目前唯一的人工放行路径。之所以选「看得见地停下」而不是加退避继续悄悄重试：一个任务反复回来不是缺槽位，是没人能做完它，这是判断，不是再一次唤醒。
- **启动行新增 `retryLimit=`**。日志里出现 `park=… after=3` 时，不知道上限是多少就读不出它是「刚到线」还是「早就该停了」。

### 文档

- `docs/verify-host.md`：状态样例、`statusFile` 日志行样例、字段速查表补 `parked=`；排查表新增一行「`reclaimed` 一直涨、`done` 不动」（`< 0.3.7` 无终点）；版本指纹补「团队行没有 `parked=`、启动行没有 `retryLimit=` → 低于 `0.3.7`」。
- `docs/verify-reclaim.md`：已知限制新增「回收有终点」并写明它只停派发不动任务板；排查表新增同一条空转现象。
- README 的 status 字段表补 `parked` 一类（`reclaimed` 涨是**正确判定**的结果，看不出空转），「仍未验证」新增回收停派未跑真机一项。
- 断言数订正：`verify` 45 → **46**、`integration` 24 → **26**。

### 真机实证

- **回收停派已在真实宿主上验证**（2026-10-28，桌面 0.2.1-rc.3，`reclaimAfterMs: 60000`、`reclaimRetryLimit: 3`，`dryRun: false`）。两个停手成员 `stall-a` / `stall-b` 让任务空转，`ticks=9/23/29` 三圈回收后 `park=task-1<stall-a after=3`、`why=parked`、`parked=1`，`reclaimed` 停在 3（没有第 4 次），`dispatched` 冻结在 2、停派后日志安静。任务停派时仍 `claimable=1`——只停派发、不动任务板。README「仍未验证」里该条移除，`docs/verify-reclaim.md` 已知限制第 2 条补实测值。

## [0.3.6] - 2026-10-28

### 新增

- **`team_autopilot_status` 新增 `why`：这一轮为什么没派出去**。`0.3.5` 只把它写进了日志行，所以读 status 的人看到的仍是三个**累计**计数——「全员拒接、插件就地停手」和「同一次拒接被数了六十遍」在数据上长得一模一样。现在两个面对同一件事用同一个词：日志行 `why=declined,scope`，status 里 `why: ["declined", "scope"]`（数组，空数组等于 `-`）。
- **`toTeamReport()` 从 `index.ts` 移到 `report.ts`**。它是「状态桶 → 报告行」的纯映射，而 `why` 取自本轮原因集合、`pending` 取自唤醒记账表的长度——两者都无法从旁边的计数推出来，也只能在没有宿主的情况下才测得动。迁移后新增的断言直接覆盖这条映射，包括「返回的对象不与后续轮次就地修改的状态共享数组」。

### 文档

- **README 与 `docs/` 全量对账**（`0.3.5` 发布后逐份核到代码），修正三类问题：样例输出与真实格式不一致、字段说明张冠李戴、版本前提与失效链接。三处最影响阅读的：
  - README 的 status 样例把**一整行**的团队行排成了三行，照它 `grep 'breaker=open'` 永远 grep 不到；`caller` 行还缺 `blocked=` / `done=`。
  - `why` 被列进「status 字段」表、实际上**只在日志行**里，而真正在 status 里的 `pending` 反倒漏了速查表——两处输出面的词汇表已经分叉。这个缺口这次直接补进代码（见上），文档改为如实描述两个面。
  - `docs/prompts-dispatch.md` 声称「`idle` 可能包含 Lead 自己」。`availableMembers()` 只取 `role === 'teammate' && status === 'inactive'`，**Lead 永远不在派发候选里**，`idle` 也不含它；连带「一个成员都没有时任务不会派出去」也写清楚（`noMember` 上涨）。
- 断言数订正：`verify` 42 → **45**、`integration` 16 → **24**（README、`docs/distribution.md` 及各处的「有 21 项断言」「覆盖 4 条关键路径」同步改掉）。
- `docs/prompts-reclaim.md` 删掉整段「旧包迁移 + 手工把解包目录塞进 `node_modules`」的过时流程——改名与升级早已完成，手放的副本不进 `package.json` 与锁文件、下次 `pnpm install` 就被覆盖，现在改为版本前提 + 走包管理器的指引。
- `docs/verify-host.md`：回滚段落原本让人 `cp *.bak-20261027-233651`，那批备份已清理，且锁文件备份本身可能正是问题源头；改为 `pnpm add dsh-team-autopilot@<版本>`，并补「只想停掉插件就把 `enabled` 设 false」。另补一句：一旦离开首次安全模式，`first-run dryRun === true` 这一项**会一直 FAIL**，属预期不是故障。
- `docs/verify-multiteam.md` 去掉「验证 `0.1.2` 修复」的一次性框架，改为可反复执行的回归手册（回归触发点写明：改动主循环或 Lead 解析时重跑）。
- `docs/verify-reclaim.md` 的 `outcome` 取值补 `unchecked`，并说明它表示「还没到判定时刻」而非「没人认领」。
- `docs/team-collab-task.md` 标注已被 v2 取代，并写明原因（v1 让成员主动认领，抢在调度器前面把活干完，`[team-autopilot]` 0 次）。
- README 新增「桌面 profile 的三个坑」：用 runtime 自带 pnpm（`corepack pnpm` 是另一个大版本）、`minimumReleaseAgeExclude` 做版本级豁免而非关掉全局策略、换包名后锁文件必须重解析（残留旧条目会让 pnpm 在解析**之前**整体拒装，报错点名的是旧包，等满冷却期也不会好）。
- `dsh-agent-dispatch` 引用处理：该包已从 registry 下架（`npm view` 返回 404），README 里以它为样本的 `inject` / 工具名 / channels 默认值等逐字段断言无法复现，压缩为类别级结论并标注引用变化；「可以叠加」的判据改成看它写哪套状态。

## [0.3.5] - 2026-10-28

### 新增

- **日志行里多一个 `why=`：这一轮为什么没派出去**。`skip` / `scope` / `noMember` / `declined` 是累计值，说不清「此刻」。0.3.4 把它们移出签名后露出一个副作用——「所有空闲成员都拒过、插件就此停手」这种最需要人介入的时刻，日志反而一个字都不写，只能等 10 分钟后的心跳。
  - 改用**本轮去重后的原因集合**：`why=scope`、`why=declined,scope`、无跳过时 `why=-`（显式打出来，省略会被读成旧版本）。
  - 它只在原因变化时才变，所以既不逐轮刷屏，`why=-` → `why=declined` 这类转变又能立刻落一行。四个累计计数仍在行里，`grep declined=[1-9]` 照样可用。
- **`pending=`：还有几条唤醒在等判定**。判定被推迟到冷却到期后（0.3.3），而 `lastDispatch` 只能记住最后一条唤醒——一轮唤醒两个任务时，另一个在 `outcome` 上完全不可见。`team_autopilot_status` 与日志行都加了 `pending`，它是纯数量，不暴露是哪个任务、哪个成员。

### 说明

- 两条新回归测试：`why` 不变时三轮只写两行（计数涨了也不算变化）；签名比较里「计数上涨不等于变化、原因变化等于变化」。
- `SkipKind` 成为 `state.ts` 的导出类型，`BlockedTask.kind` 复用它，避免两处字面联合各自漂移。

## [0.3.4] - 2026-10-28

### 修复

- **只要有一个任务被跳过，日志就退回每 tick 一行**。「没变化就不写」是按整行比较实现的（只剥掉时间戳与 `ticks`），而 `skip` / `scope` / `noMember` / `declined` 是**累计**计数：任务一直没人接时它们每一轮都在涨，于是每一轮都被判定为「状态变了」，`statusHeartbeatMs` 形同失效。
  - 在真机验证 0.3.3 的未认领判定时撞出来的：11 个 tick 写了 11 行，其中相邻两行除了这两个计数**每个字段都相同**，凭这一对就能定案。修复前该场景的回归测试是「期望 1 行，实际 3 行」。
  - 现在这四个累计值不参与比较。总数仍留在行里，供 `grep declined=[1-9]` 使用，只是「单独上涨」不再算一条新闻——心跳行会带上它。0.3.2 那次「安静」在无跳过团队上成立，在有拒接成员的团队上其实从未生效。
- 同一个状态在日志里叫 `unchecked`、在 `team_autopilot_status` 里叫 `not-checked-yet`，读两种输出的人得自己对词。统一为 `unchecked`。

## [0.3.3] - 2026-10-28

### 修复

- **未认领的判定跑得比成员反应还快**。唤醒后的判定原本在「下一次读板」就执行，而真机上变化驱动的轮次可以只隔 1 秒——等于在判成员的思考时间。后果是连锁的：每一次唤醒都被算成未认领（真机 15 分钟内 5 次 `unclaimed` 全部是误判）、正在认领的成员被记进该任务的拒绝集合、任务随即改派给同事，造成同一任务被两个人接手。
  - 现在判定要求唤醒**过了冷却窗口**（`wakeCooldownMs`）才做。这不是新配置项：冷却到期正是判定第一次能改变决策的时刻——在此之前任务本来也不允许改派给任何人，早判只会判错。
  - 顺带修掉同源的第二个洞：待判记录原本是**一个标志位**，一轮唤醒多个任务时只有最后一个会被判定，前面那些永远没有答案。改成按任务 id 记（`pendingWakes`），每次唤醒各自结算。
  - 语义变化：`unclaimed` 现在是「唤醒后过了冷却仍无主」，`unclaimed >= 2` 的告警因此只在真的没人接时出现。判据与阈值都没变，只是不再虚高。

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
