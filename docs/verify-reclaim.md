# 僵死回收真机验证手册（reclaim）

针对 `reclaimAfterMs` / `reclaimOnFailed` 引入的僵死任务回收。挂载自检、dryRun 基础场景、熔断与真实派发见 [`verify-host.md`](verify-host.md)，本手册只覆盖回收。

> **先确认一件事**：`reclaimed` 涨只说明**判定成立**，不代表任务真的回了池子。回池要看任务板（`claimable` 增加、`inFlight` 减少），两者要分开验。

## 0. 观测字段

`team_autopilot_status` 输出里有两处 `reclaimed`：

```
totals rounds=N dispatched=N suppressed=N skipped=N unclaimed=N reclaimed=N
  team=<id> ... reclaimed=N unclaimed=N pending=N
    lastReclaim task=<id> from=<member> reason='<cause>' applied|dry-run (<age>)
    lastDispatch task=<id> to=<member> wakes=N sent|dry-run outcome=claimed|unclaimed|unchecked (<age>)
```

- 第一处是全局累计，第二处是按团队（多团队时逐个打印）
- `lastError` 非空 = 上一次 `reassign` 调用失败（revision 冲突最常见），**不熔断**，下一轮会重读重试
- `outcome=unchecked` 表示**还没到判定时刻**（判定要等 `wakeCooldownMs` 到期），不是「没认领」；配合 `pending=N` 看还有几条在等判定。回收场景里它很常见：任务刚被重新派出去，判定还在冷却窗口内

**判定时务必同时看 `lastReclaim`**：`reclaimed` 只回答「几次」，`lastReclaim` 回答「哪个任务、从谁手里、为什么」。回收循环（同一任务被反复收回）只有后者能看出来——否则只能盯着任务 revision 往上爬来推断。

配套看 `lastDispatch` 的 `wakes` 与 `unclaimed`：回池后若一直没人接，`wakes` 会持续累加、`outcome=unclaimed`、`unclaimed` 递增，`unclaimed>=2` 时报告会打一行 warning。

## 1. 先把等待调短（必做）

默认 `reclaimAfterMs: 300000`（5 分钟）太慢。在 profile 的 `cordis.patch.yml` 里改：

```yaml
team-autopilot:
  reclaimAfterMs: 60000      # 1 分钟；schema 允许 1000–3600000
  reclaimOnFailed: true
```

然后**完全退出** App 再启动（不是关窗口）。

## 2. tick 节奏与时序预期

tick 由 `waitForChange(lead, tickTimeoutMs, signal)` 驱动：有团队变化立即返回，否则每 `tickTimeoutMs`（默认 30000）超时返回一次。

所以最长等待 ≈ `reclaimAfterMs + tickTimeoutMs`。按上面的配置是 **60s + 30s ≈ 90 秒内必见结果**。

两条容易踩的时序细节（`0.3.1` 起）：

- **每个团队每 interval 只 tick 一次**。一轮只服务「这一轮真的被唤醒的团队」，不会被别的团队顺带 tick。所以 N 个团队不会让某个团队的 `ticks` 变快——`ticks` 涨得比「秒数 ÷ `tickMs`」快，就说明在跑 `<0.3.1`。
- **新出现的团队最多滞后一个 interval 才有第一次 tick**（它要等自己的 waiter 到期）。看到某个团队 `ticks` 比别的团队小 1、`(…ms ago)` 也更大，这是正常的，不是漏 tick。

日志文件（`statusFile`）在这两件事上都帮不上忙：没变化的轮次不写行，只按 `statusHeartbeatMs` 打心跳。**验证时序请用 status 工具的 `ticks` 与 `(age)`，不要用日志文件的稀疏程度**。

## 3. 三个触发条件与可制造性

| 条件 | 何时回收 | 真机能造出来吗 | 依赖配置 |
|---|---|---|---|
| owner 不在 roster | 立即 | **难**——官方 9 个工具里没有移除成员的入口，只能靠进程退出 / 冷恢复失败 | 无关 |
| owner `status = failed` | 立即 | 中——需要成员启动失败 | `reclaimOnFailed` |
| owner `inactive` 满 `reclaimAfterMs` | 需跨轮累计 | **容易**——认领后不派活即可 | 无关 |

**主场景是第三条**。前两条造不出来不阻塞验证，但要如实标注"未验证"。

## 4. 场景 E —— owner inactive 超时（主场景）

1. 建一个 ready 任务 `t1`，写域与其它在飞任务不重叠。
2. 让成员 **A** 认领（A 变成 `in_progress` 的持有者），然后**不要给它派新活**、让它这一轮跑完 → A 回到 `inactive`。
3. 立刻查 status，记下 `reclaimed`（应为 0）。
   - 此时 tick 会把 `t1` 记进 stalled 表（**首轮只观察，给 grace 期**），所以这里不回收是**正确行为**，不是失败。
4. 等约 90 秒，再查 status。
   - 期望：`reclaimed` +1。
5. 看任务板：`t1` 应回到 `pending` 且 **无 owner**，`claimable` +1、`inFlight` -1。

> 想加速：把 `reclaimAfterMs` 降到 `5000`（5 秒），等待时间变成约 35 秒。验证完记得调回。

## 5. 场景 F —— 回收后不还给原 owner（核心差异）

紧接场景 E：

1. 回收发生的那一轮，任务会**重新参与派发**（`reclaim` 在 `dispatch` 之前执行，释放的槽位本轮即可复用）。
2. 团队里除 A 之外至少还有一个 idle 成员 **B**。
3. 期望：`dispatched` 也在同一轮增加，且 `t1` 派给 **B 而不是 A**。
4. 若派回了 A → `previousOwner` 避让失效，是 bug，记下 status 与日志给我。

这一条是回收与 `@nanmicoder/dsh-agent-teams` 的语义分界（它 `reassign_task` 指定新 owner = 换人，我们不带 owner = 回池重排），值得单独确认。

## 6. 场景 G —— 负向：不该回收的

| 构造 | 期望 |
|---|---|
| 成员 **running**（正在跑一轮）时持有任务，且已超过 `reclaimAfterMs` | `reclaimed` **不涨**——running 不是僵死证据 |
| 成员 **provisioning**（还没启动完）持有任务 | `reclaimed` **不涨** |
| **Lead 自己**持有的任务 | **永不回收**（`owner.role !== 'teammate'` 直接跳过） |
| 无主 `pending` 任务 | 不进回收判定（它本来就谁都能领） |

最容易误判的是第一条：成员刚被唤醒、还没开始跑的瞬间是 `inactive`，所以要靠 grace 期保护；反过来，真在跑的成员不该被抢。

## 7. 场景 H —— failed 成员（可选）

若能让某个成员进入 `failed` 状态（启动失败）：

1. 期望 `reclaimed` **立即** +1（不等 `reclaimAfterMs`）。
2. 把 `reclaimOnFailed: false` 重启后重做，期望 `reclaimed` **不涨**，任务一直挂在 `failed` 成员名下。

造不出来就跳过，并在 README「仍未验证」里留一条。

## 8. dryRun 分层（重要）

`reclaim` 在 `dryRun: true` 时**只计数、不发 `reassign`**（代码里 `continue` 掉）。所以：

| 配置 | 能验什么 | 不能验什么 |
|---|---|---|
| `dryRun: true` | 判定是否正确（`reclaimed` 涨） | 任务是否真的回池 |
| `dryRun: false` | 全部，包括真实 `reassign` 与回池后重新派发 | — |

建议**分两遍跑**：先 dryRun 确认判定，再关掉 dryRun 确认副作用。直接上 `dryRun: false` 也行，但出问题更难分辨是判定错还是写入失败。

## 9. 排查表

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `reclaimed` 一直 0 | 任务 `ownerName` 为 null（未被真认领） | 确认成员真的 claim 了，不是只创建 |
| `reclaimed` 一直 0 | 成员状态不是 `inactive`（在跑 / provisioning） | 查 status 里的 `idle` 计数；等它这轮跑完 |
| `reclaimed` 一直 0 | 等得不够 | 最长 `reclaimAfterMs + tickTimeoutMs` |
| `reclaimed` 一直 0 | 插件刚重启，stalled 表已清空 | 重新等一个完整 grace 期 |
| `reclaimed` 涨了但任务没回池 | `reassign` 失败（多为 revision 冲突） | 看 `lastError`；下一轮会重读重试 |
| `reclaimed` 涨了但 breaker 也开了 | 两者独立——**回收失败不会触发熔断** | 属预期；熔断只由 `sendMessage` 连续失败驱动 |
| 回收后任务又派回 A | `previousOwner` 避让失效 | 记下 status 全文与日志，是 bug |
| `reclaimed` 一直涨、`done` 不动 | 任务被反复回收重派（`< 0.3.7` 无终点，真机 20 分钟回收 12 次 / 派发 19 次） | 升到 `0.3.7`：达到 `reclaimRetryLimit`（默认 3）后停派，日志出现 `park=<任务><owner> after=N`、`why=parked` |

## 10. 已知限制（验证时别当成 bug）

1. **stalled 表在内存**：插件重启后所有任务的 grace 期重新计时。回收计数与停派集合同样在内存，重启即清零——这也是目前放停派任务的唯一路径。
2. **回收有终点（≥0.3.7）**：同一任务被回收达到 `reclaimRetryLimit`（默认 3）后不再为它唤醒任何人，进 `parked` 集合，日志 `park=… after=N`、status 里逐条列出。**只停派发、不动任务板**：任务仍是 `claimable`，人或 Lead 认领 / 完成 / 删除它之后记录即清除。这是判断不是唤醒——反复回来说明没人能做完它，再派一次只是再烧一次 token。
2. **拒绝记录是任务级，不是成员级**：某任务派给某成员未被认领后，该成员在这**一个**任务上被跳过，其它任务照常派给它。若它对所有任务都不接，那些任务会各自停派（`declined` 上涨 + note 行），要恢复得让任务易手。此前「任务回池后被反复派回同一成员」的循环（真机撞到：task-3 的 revision 从 3 爬到 20，约 8–9 轮）已由此消除；循环期间仍可用 `unclaimed` / `lastDispatch wakes=N` / `lastReclaim` 三条互相印证。
3. **回收失败不熔断**：只写 `lastError`，下一轮重试。

## 11. 验证后回填

跑完后按结果更新：

- `README.md` → **真机验证记录**：补上 `reclaimed` 实测值、回收前后任务状态、是否派给了另一成员
- `README.md` → **仍未验证**：删掉已验证项，保留没造出来的场景（如 failed 成员）
- `CHANGELOG.md`：若验证中发现并修复了缺陷，记进对应版本段
