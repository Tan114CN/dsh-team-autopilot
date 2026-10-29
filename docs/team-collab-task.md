# 多成员协作开发任务 · 观察插件行为（v1，已被 v2 取代）

> **这份已被 [`team-collab-task-v2.md`](team-collab-task-v2.md) 取代，不要照着跑。**
>
> v1 让成员在 spawn prompt 里「主动去 `team_task_list` 认领」，结果成员抢在调度器前面把活干完——任务完成了，但 **`[team-autopilot]` 唤醒消息出现 0 次**，要验的东西根本没被观察到。v2 把成员改成「被动等待」，调度器才是唯一派发来源。
>
> 保留这份文档是因为第六节的事后复盘仍然成立（「调度器派发」与「成员自发认领」是两种会竞争的协作模型），其余内容已过期。

> 目的：让 dsh 团队真的协作开发一个小工具，同时观察 `dsh-team-autopilot` 插件
> 在真实负载下的表现（尤其「熔断」和「wait_agent 共存」两项待验证行为）。

---

## 一、任务目标

让团队开发一个 **命令行 Markdown → HTML 转换器**，命名 `md2html`。
产物是可运行的 Node CLI：`node md2html.mjs <input.md> [output.html]`。

功能清单（可拆分给多个成员）：

1. **解析器**（`src/parser.mjs`）：把 Markdown 核心语法转成 AST——标题(1-6)、段落、加粗/斜体、行内代码、无序/有序列表、代码块。
2. **渲染器**（`src/renderer.mjs`）：把 AST 转成 HTML 字符串。
3. **CLI 入口**（`md2html.mjs`）：读文件 → 调解析器 → 调渲染器 → 写输出；处理参数、报错。
4. **测试**（`test/`）：给解析器和渲染器各写一组断言用例。
5. **README**：说明用法和已支持语法。

**写域（writeScopes）划分建议**——这是观察写域拦截的关键：

| 模块 | 建议 writeScope |
|---|---|
| 解析器 | `src/parser.mjs`（精确到文件，避免和其他模块误冲突） |
| 渲染器 | `src/renderer.mjs` |
| CLI | `md2html.mjs` |
| 测试 | `test` |
| README | `README.md` |

> ⚠️ 故意让「解析器」和「渲染器」的写域**边界清晰但相邻**，方便观察：当两个成员同时认领时，调度器会不会因为写域重叠而拦下其中一个。

---

## 二、怎么给 Lead 下指令

在**同一个团队会话**里，对 Lead 说（可整段复制）：

```
组建一个开发团队，开发一个命令行 Markdown → HTML 转换器 md2html。

成员分工（用 spawn 各建一个 teammate）：
- parser-dev：只写 src/parser.mjs，实现 Markdown 核心语法解析成 AST
- renderer-dev：只写 src/renderer.mjs，把 AST 渲染成 HTML
- cli-dev：只写 md2html.mjs，负责文件读写和参数处理，调用 parser 和 renderer
- tester：只写 test/ 目录，为 parser 和 renderer 各写断言用例并运行

用 team_task_create 按上面表格建任务，writeScopes 各自只写自己负责的文件。
任务之间如果有依赖（renderer 依赖 parser 的 AST 结构），在描述里写明接口约定。
建好任务后不要手动认领，让调度器自动把任务派给空闲成员。
```

关键点：**建任务时写域要精确到文件**（`src/parser.mjs` 而不是 `src`），这样写域软锁才有意义，也不会误伤。

---

## 三、观察清单（任务跑起来后，逐项记录）

### A. 派发正路径（预期正常）
- 建完任务后调 `team_autopilot_status`：
  - `dispatched` 应该涨（任务被派给空闲成员）
  - `claimable` = 还没被认领的 ready 任务数
  - `idle` = 空闲成员数
- 任务板里 `ownerName` 从 `null` 变成某个成员

### B. 写域冲突拦截（预期 `skipped` 的 `scope` 项 ≥ 1）
- 如果 parser 和 renderer 同时 ready、但只有一个空闲成员 → 第二个被拦，`skipped` 涨（且涨的是 `noMember` 那一项）
- 写域重叠（如两个任务都写 `src/auth` 前缀）时被拦，涨的才是 `scope` 那一项
- 更直接：故意让一个成员「先认领 parser，再让另一个成员试图认领 renderer」，观察有没有因为依赖/写域产生的 `writeScopeWarnings`

### C. 熔断（待验证项，观察 `breaker` 字段）
- 正常跑，`breaker` 应该一直是 `closed`、无 `lastError`
- 如果某个成员 session 崩了 / 报错，观察 `breaker` 会不会 `open`、`breakerTrips` 会不会 ≥1
- **这一步是顺带观察，不要为了看它而故意搞挂成员**（搞挂了要等冷却恢复，反而打断任务）

### D. wait_agent 共存（待验证项）
- 任务进行中，看成员收到的消息：
  - 只收到 `[team-autopilot] Task ...` 一条 = 你插件在工作
  - 如果同时收到官方 `wait_agent` 的消息 = 两个机制并存
  - **重点看**：同一个任务有没有被「两个机制」重复派给两个不同成员（这才是真正的冲突）

### E. 收尾
- 所有任务完成后，查 `team_autopilot_status`：`inFlight=0`、`claimable=0`、`slots` 回满
- 确认 `md2html.mjs` 真的能跑：`node md2html.mjs README.md out.html`

---

## 四、记录模板

跑完后，把这些字段原样贴回给我（我据此判断插件行为）：

```
[任务开始时] team_autopilot_status = ...
[任务进行中] 成员收到的消息原文 = ...
[任务进行中] 任务板 ownerName 变化 = ...
[任务结束时] team_autopilot_status = ...
[最终] md2html.mjs 能否运行 = ...
[最终] 是否观察到 breaker≠closed = ...
[最终] 是否观察到重复唤醒 = ...
```

---

## 五、注意事项

1. **当前 `dryRun: true`** —— 如果你现在直接跑，调度器只会**计数、不会真的发消息**（成员不会被唤醒）。要观察真实派发，需要先把 `cordis.patch.yml` 里 `team-autopilot` 的 `dryRun` 改成 `false`，再重启 Harness。
2. 成员 spawn 时用你之前验证过的正确写法：认领任务用 `team_task_update`（`action=claim` + `expected_revision`），**不是** `team_task_claim`。
3. 任务描述里写清「接口约定」（AST 的字段结构），否则 parser 和 renderer 会各自发明一套结构、对不上。

---

## 六、第一次实测的重要发现（2026-10-28）

用上面的任务模板实测了一次，结果**任务成功完成、产物真实可运行**（`E:\text\` 下产出 `md2html.mjs` + `src/parser.mjs` + `src/renderer.mjs` + `test/*`，测试全过、CLI 能跑），但**调度器实际上没有派发**——从解压的会话日志确认：

- `[team-autopilot]` 唤醒消息出现 **0 次**；
- 4 个成员是**靠 spawn prompt 里「主动去 team_task_list 认领」的指令**把任务干完的，不是靠调度器唤醒。

### 原因（真实场景才暴露）

**「调度器派发」和「成员自发认领」是两种会竞争的协作模型。** Lead 在 spawn 成员时如果告诉它们「主动去认领任务」，成员会抢在调度器之前把任务拿走。这不算 bug，但会让我们**观察不到调度器本身的行为**。

### 如何正确观察调度器派发

要让调度器成为**唯一**的派发来源，spawn 成员的 prompt 必须写成「**被动等待**」，而不是「主动认领」：

> 原地待命，不要主动去 `team_task_list` 认领任务；等收到以 `[team-autopilot]` 开头的消息后，再按消息里的 task id 用 `team_task_update`（action=claim + expected_revision）认领并完成。

只有成员「被动等待」时，`dispatched` 才会增长、成员端才会出现 `[team-autopilot]` 唤醒消息，我们才能验证派发链路本身。

### 附带结论

- 即使调度器没派发，团队也能靠成员自发认领完成工作——这是**降级路径**，说明系统健壮。
- 本次全程 `breaker` 保持 `closed`（无失败），验证了「正常负载不误熔断」。
- 要验证「与官方 `wait_agent` 共存」，需同时满足「成员被动等待」+「Lead 真的用 wait_agent」两个条件，本次未覆盖到。
