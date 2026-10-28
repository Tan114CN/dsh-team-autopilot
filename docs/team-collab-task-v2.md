# 开发任务 v2 · 真正触发「调度器自动派发」

> 目的：v1 实测发现，成员若被 spawn prompt 告知「主动认领」，会抢在调度器之前把活干完，
> 导致观察不到调度器本身。本版把成员改成「**被动等待**」，让 `team-scheduler` 成为唯一派发来源，
> 从而验证派发链路 + 熔断 + wait_agent 共存。

---

## 一、与 v1 的关键差异

| 维度 | v1（已失败于观察派发） | v2（本版） |
|---|---|---|
| 成员认领方式 | spawn prompt 让成员「主动去 team_task_list 找活」 | spawn prompt 让成员「**原地待命，等调度器消息**」 |
| 调度器角色 | 被成员抢先，0 次派发 | 唯一派发来源 |
| 观察目标 | 产物能否完成 | 派发链路 / 熔断 / wait_agent 共存 |

---

## 二、任务目标

开发一个命令行 **JSON → CSV 转换器**，命名 `json2csv`（比 md2html 更小、更快，减少成员干活时间，把「观察窗口」留给调度器）。

功能拆 4 个模块（写域精确到文件）：

| 成员 | 负责 | writeScope |
|---|---|---|
| `parser-dev` | 解析 JSON 数组 → 表头 + 行 | `src/parse.mjs` |
| `writer-dev` | 把表头+行拼成 CSV 字符串（转义逗号/引号/换行） | `src/write.mjs` |
| `cli-dev` | 入口：读文件→parse→write→输出 | `json2csv.mjs` |
| `tester` | 写 test/ 断言并运行 | `test` |

产物可运行：`node json2csv.mjs <input.json> -o <out.csv>`

---

## 三、给 Lead 的指令（整段复制）

```
组建一个开发团队，开发命令行 JSON → CSV 转换器 json2csv。

成员分工（用 spawn 各建一个 teammate，prompt 一律用「被动等待」模式）：
每个成员的 prompt 都写成：
「原地待命，不要主动去 team_task_list 认领任务。等收到以 [team-scheduler] 开头的消息后，
 按消息里的 task id 用 team_task_update（action=claim，expected_revision 用消息里给的 revision）认领，
 只写自己负责的文件，完成后用 team_task_update（action=complete）标记，再 send_message 向 lead 汇报。」

- parser-dev：只写 src/parse.mjs，实现 JSON 数组 → 表头+行
- writer-dev：只写 src/write.mjs，实现表头+行 → CSV 字符串（正确转义逗号/引号/换行）
- cli-dev：只写 json2csv.mjs，读文件→parse→write→输出
- tester：只写 test/，为 parse 和 write 各写断言并运行

用 team_task_create 建 4 个任务，writeScopes 精确到各自文件。
任务描述里写清接口约定：parse 输出 { headers: string[], rows: string[][] }，write 接收这个结构。
建好任务后不要手动认领，也不要给成员发任何「去干活」的指令，让调度器自动派发。
```

**关键**：这段指令里有两个「不要」——① 不要让成员主动认领；② 建完任务后 Lead 不要再手动催成员。这样调度器才是唯一驱动者。

---

## 四、观察清单（这次真正要看的东西）

### A. 调度器派发（核心）
- 建完任务后，**等 30 秒**，然后调 `team_scheduler_status`：
  - `dispatched` 应该 **> 0**（任务被派给空闲成员）
  - `claimable` 从 4 递减
  - `idle` 对应变化
- 成员会话里应出现 **`[team-scheduler] Task ...`** 唤醒消息（这是 v1 没看到的）

### B. 熔断（待验证）
- 正常跑全程，`breaker` 应一直 `closed`、无 `lastError`
- **这次不要故意搞挂成员**，先确认正常路径

### C. wait_agent 共存（待验证）
- 看成员收到的消息：是只有 `[team-scheduler]` 一条，还是官方 `wait_agent` 也发了
- 重点：同一任务有没有被「两个机制」重复派给两个成员

---

## 五、记录模板（跑完贴回）

```
[任务开始时] team_scheduler_status = ...
[30秒后] team_scheduler_status = ...（重点看 dispatched 是否 >0）
[成员会话] 收到的第一条唤醒消息原文 = ...
[任务结束] team_scheduler_status = ...
[最终] json2csv.mjs 能否运行 = ...
[最终] breaker 是否 ≠ closed = ...
[最终] 是否观察到重复唤醒 = ...
```

---

## 六、前置

1. `cordis.patch.yml` 里 `team-scheduler.dryRun` 必须是 `false`（当前已改好）。
2. 重启 Harness 后新开团队会话跑（不要复用旧会话）。
3. 认领用 `team_task_update`（action=claim + expected_revision），不是 `team_task_claim`。
