# 真机验证提示词：派发路径（`0.3.5`）

面向**主 agent（Lead）**的指令，逐段粘贴，等它执行完再贴下一段。

**验的是哪件事**：`0.3.1` 起循环改成「一轮只服务这一轮真的被唤醒的团队」。派发本身没改，但它走的是这条新路径，上线后若没有真机跑过一次，就等于只有模拟 ctx 的集成测试在背书。

**为什么提示词要写成「什么都不要做」**：本次观测的唯一价值是——**没有任何模型动作时，插件自己把任务派出去了**。一旦 Lead 顺手认领、`send_message` 通知、或自己 spawn 一个成员去做，证据就没了，你测到的是模型，不是插件。

---

## 前提

| 条件 | 怎么确认 |
|---|---|
| 插件是 `0.3.5` | 日志里有 `autopilot-start version=0.3.5`；团队行里有 `why=` 与 `pending=` |
| **不是** dryRun | 启动横幅 `dryRun=false`；`status` 首行是 `autopilot active` |
| 会话里至少 1 个空闲成员 | `team_autopilot_status` 里 `idle≥1`、`slots≥1` |
| 任务能真的被执行完 | 写域不要和其它在飞任务重叠，否则会以 `scope` 为由跳过 |

**Lead 永远不会被派发**：候选成员只取 `role === 'teammate'` 且 `status === 'inactive'` 的，Lead 既不在候选里，也不计入 `idle`。所以 `idle=1` 就是「有一个成员在等活」，不必担心把 Lead 算进去——这也意味着**一个成员都没有时，任务不会派给任何人**（`noMember` 上涨）。

---

## P1 · 建场（只建任务，别的一概不做）

```
我们要验证插件的自动派发。这一步只做一件事：建一个就绪任务，然后停下来。

1. 用 team_task_create 建 1 个任务：
   - subject: DISPATCH-TEST-01
   - description: 验证用任务，内容不重要，不需要真的实现
   - 不要设置 blockedBy（保持无依赖）
2. 用 team_task_get 查这个任务，把完整输出原样贴给我（我要看 status / ready / owner）。
3. 到此为止。不要认领、不要 send_message 通知任何成员、不要 spawn 新成员、
   不要用 wait_agent 等谁、不要替成员派活。

这次要观测的是插件自己在没有模型动作的情况下有没有派出去，任何主动帮忙都会让
观测失效。请严格执行，把任务 id 和上面那份 team_task_get 输出贴给我后结束回合。
```

记下任务 id。**发完就不要再动那个会话**，让它自己待着。

---

## 期望：四条独立证据，缺一条都不算过

| # | 证据 | 在哪看 |
|---|---|---|
| 1 | `dispatched=1`，且带 `wake=<task>>worker-<x> wakes=1` | 日志新行，或 `team_autopilot_status` |
| 2 | `claimable` 从 1 变 0，`idle` 减 1（任务被占住） | 同上 |
| 3 | 任务 `ownerName` 变成某个成员 | `team_task_get` |
| 4 | 成员收到 `[team-autopilot] Task <id> is ready and unowned. …` | 成员自己的会话 |

第 4 条是**端到端**的唯一证据：前三项都可能只证明「插件认为它派出去了」。

成员认领后下一轮会翻成 `outcome=claimed`、`inFlight=1`——这是第 5 条，顺带确认「判定」也对了。

---

## 没派出去时怎么判（四分桶就是拿来干这个的）

看日志里那几个字段，组合只有一种解释（先看 `why=` 指了哪一类，再用对应的计数确认）：

| 现象 | 含义 | 处理 |
|---|---|---|
| `why=scope` / `scope` 上涨 | 写域与在飞任务重叠 | 换一个不冲突的写域 |
| `why=noMember` / `idle=0` | 没有空闲成员（都忙，或团队里根本没有 teammate） | spawn 一个成员，或等一个跑完 |
| `why=declined` | 所有空闲成员都拒绝过这个任务 | **插件故意停手**，不是 bug；换成员或新建任务 |
| `blocked=1` | 任务没 ready（依赖没清） | `team_task_get` 看 `ready` / `blockedBy` |
| `slots=0` | 并发预算满了 | 提高 `maxConcurrent` 或减少在飞任务 |
| `dispatched=0` 且以上全不成立 | 派发路径真的坏了 | 把 `status` 全文 + 日志尾部贴出来 |

---

## P2 · 收尾（把四分桶走完一整圈）

```
让接手 DISPATCH-TEST-01 的成员把任务做完并 team_task_update 标记 completed，
然后把 team_task_get 的输出贴给我。
```

期望：`done` +1、`inFlight` 回到 0、`slots` 回满、`claimable=0`。

> 不要用 `team_task_update(action=reassign)` 手动改状态来「制造」结果——那会绕过被观测的代码路径本身。

---

## 变体：会话里没有成员

先让 Lead 建一个：

```
用 spawn_teammate 创建一个成员，context 用 fresh：

  name: worker-c
  description: 响应型成员，用于验证自动派发
  prompt: |
    你的行为规则：收到以 [team-autopilot] 开头的消息时，按消息里给的任务 id
    用 team_task_update 认领它，完成任务，然后标记 completed，回复一行结果后结束回合。
    不要主动去 list 任务，也不要自己找活干。
```

然后照 P1 建任务。
