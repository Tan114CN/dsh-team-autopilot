# 验证 0.1.2 多团队修复

> 目的：确认 `dsh-team-autopilot@0.1.2` 修好了「调度器只盯第一个 Lead」的 bug，
> 现在能同时服务多个团队会话、各自独立派发。

---

## 一、前置

1. 已装 `0.1.2`（profile 依赖 `^0.1.2`，`verify-mount` 10 PASS）。
2. `cordis.patch.yml` 里 `team-autopilot.dryRun` 当前是 **`true`**。
   - **只验证「调度器是否盯对团队」**：`dryRun:true` 就够（`dispatched` 会涨、`team=` 会显示正确 TeamId，只是不发消息）。
   - **想验证「真的发唤醒消息」**：把 `dryRun` 改成 `false` 再重启。
3. **完全重启 Harness**（加载 0.1.2）。

---

## 二、验证步骤

### 第 1 步：开两个团队会话

- 开**会话 A**：发一句给 Lead——「组建一个开发团队，spawn 一个成员叫 worker-a（prompt：原地待命，等 [team-autopilot] 消息再认领任务），建一个 ready 任务 task-a，writeScope 写 src/a，不要手动认领。」
- 开**会话 B**：发一句给 Lead——「组建一个开发团队，spawn 一个成员叫 worker-b（prompt：原地待命，等 [team-autopilot] 消息再认领任务），建一个 ready 任务 task-b，writeScope 写 src/b，不要手动认领。」

> 两个会话要**同时开着**，这是触发多团队场景的关键（只开一个就测不出 bug）。

### 第 2 步：分别在两个会话里查状态

在**会话 A** 里：

```
调用 team_autopilot_status
```

在**会话 B** 里：

```
调用 team_autopilot_status
```

### 第 3 步：对比关键字段

| 字段 | 会话 A 预期 | 会话 B 预期 |
|---|---|---|
| `team=` | 会话 A 的 TeamId | 会话 B 的 TeamId |
| `dispatched` | **≥1**（task-a 派给 worker-a） | **≥1**（task-b 派给 worker-b） |
| `tasks` | ≥1 | ≥1 |
| `claimable` | 1（或 0，取决于是否已派） | 1（或 0） |

**通过判据**：

- 会话 A 的 `team=` 是 **A 自己的 TeamId**，会话 B 的 `team=` 是 **B 自己的 TeamId**（两者不同）；
- 两个会话的 `dispatched` **都 ≥1**（各自派各自的任务）。

**这就是修复生效的铁证**：0.1.1 会「A、B 都显示同一个旧团队的 team=、dispatched 都 0」，0.1.2 会「各自独立」。

---

## 三、如果想验「真的发消息」（可选）

把 `dryRun` 改成 `false` 再重启，然后：

- 看 `worker-a` 会话是否收到 `[team-autopilot] Task task-a is ready and unowned...`；
- 看 `worker-b` 会话是否收到 `[team-autopilot] Task task-b ...`；
- 各自 `team_task_update(action=claim)` 认领 → 完成。

两个 worker 应**各收到自己团队的那条**，而不是串到对方团队。

---

## 四、记录模板（贴回给我）

```
[会话A] team_autopilot_status = ...
[会话B] team_autopilot_status = ...
[判断] 两个 team= 是否不同？两个 dispatched 是否都≥1？
```

---

## 五、失败排查

| 现象 | 含义 | 处理 |
|---|---|---|
| 两个会话 `team=` 相同 | 修复没生效（可能还在跑旧版） | 确认 profile 版本是 0.1.2、重启 Harness |
| `dispatched=0` 但 `team=` 正确 | 没有「空闲成员」或任务没 ready | 确认 worker 是 inactive、任务是 pending+ready |
| `claimable=0` | 任务已被认领（可能成员自发认领了） | 看任务 owner 是否已变，或重开干净会话 |
