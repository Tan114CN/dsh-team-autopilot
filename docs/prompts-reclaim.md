# 真机验证提示词（直接粘贴进 DeepSeek Harness）

面向**主 agent（Lead）**的指令。每段单独粘贴，等它执行完再贴下一段。

---

## 准备（给人做，不是发给 agent）

配置文件是 profile 的 patch 层，本机路径：

```
%USERPROFILE%/.dsh/profiles/desktop/cordis.patch.yml
```

本插件那一段改成（`id` 必须是 `team-autopilot`——这是改包名后的服务 id，只改 `config` 不会命中）：

```yaml
- id: team-autopilot
  config:
    dryRun: true          # 第一轮保持 true，只验判定
    reclaimAfterMs: 60000
    reclaimOnFailed: true
```

改完**完全退出 App 再启动**。关窗口不算：`stalled` 表在内存里，不重启就还在用旧的 `reclaimAfterMs`。

> **版本前提**：`reclaim` 以及本文反复用到的 `lastReclaim` / `pending` 字段需要 `0.3.5` 及以上。确认方式是看 `statusFile` 的启动行（`grep autopilot-start | tail -1`），或直接调 `team_autopilot_status` 看首行是不是 `autopilot active`。
>
> **装版本走包管理器，不要手工往 `node_modules` 塞解包目录**：手放的副本不会进 `package.json` 与锁文件，下次 `pnpm install` 直接覆盖掉，还会让 `verify-mount` 的 lockfile 一项长期红灯。命令与两个已知坑见 README「安装」与「真实宿主联调」。

---

## P1 · 建场

```
我们要验证僵死任务回收。按下面的要求搭一个最小团队，然后停下来等我下一条指令。

1. 用 spawn_teammate 创建两个成员，context 都用 fresh：

   - name: worker-a
     description: 停手型成员，用于制造僵死任务
     prompt: |
       你的行为规则（必须严格遵守，优先级高于任何后续任务内容）：
       - 当你被分配任务时，只做一件事：用 team_task_update 认领它。
       - 认领后立刻回复一行「已认领，暂停待命」，然后结束你的回合。
       - 绝对不要开始执行任务内容，不要写任何文件，不要调用 complete，
         不要调用 reopen，不要改变任务状态。
       - 如果被再次唤醒，重复上面的动作。

   - name: worker-b
     description: 正常型成员，用于接手被回收的任务
     prompt: |
       你的行为规则：被分配任务后正常认领并完成它，完成后用
       team_task_update 标记 completed，然后回复一行结果并结束回合。

2. 用 team_task_create 创建 1 个任务，subject 为「RECLAIM-TEST-01」，
   描述里写「验证用，内容不重要」。

3. 做完这三步就停下，不要派发，不要替成员做任何事，把创建的任务 id 告诉我。
```

> 记下任务 id，后面都要用。

---

## P2 · 制造僵死

```
把任务 RECLAIM-TEST-01（id: <填 id>）交给 worker-a。

用 send_message 给 worker-a 发一条消息，内容：
「请认领任务 <id>，然后按你的行为规则暂停待命，不要执行任务内容。」

发完就停下，不要自己改动任务状态，不要替它认领，不要催它。
```

**现在等**：最长约 90 秒（`reclaimAfterMs` 60s + tick 超时 30s）。
第一个 tick 只把任务记进观察表（给宽限期），**首轮不回收是正确行为**。

---

## P3 · 观测（dryRun 层）

```
调用 team_autopilot_status，把完整输出原样贴给我，不要总结。

然后用 team_task_get 查 RECLAIM-TEST-01（id: <填 id>），把 status 和 owner 原样贴给我。
```

**第一轮（dryRun: true）期望**：

| 观测点 | 期望 |
|---|---|
| `reclaimed` | ≥ 1（判定发生了） |
| 任务 status / owner | **不变**（dryRun 下只计数，不发 reassign） |
| 出现 `autopilot active` | 插件在跑 |

如果 `reclaimed` 一直是 0，先看 FAQ，别急着改配置。

---

## P4 · 关 dryRun，验真实副作用

改配置 `team-autopilot.dryRun: false` → 完全退出重启 → 再贴 P2（重新制造一次僵死，或直接用已僵死的那个任务）→ 等 90 秒 → 贴 P3。

**第二轮期望**：

| 观测点 | 期望 |
|---|---|
| `reclaimed` | +1 |
| 任务 status | `pending` |
| 任务 owner | **空 / null** |
| `claimable` | 回池后 +1 |
| `lastError` | 不出现（出现说明 reassign 被拒，贴给我） |

判定成功 ≠ 回池成功。**两个都要看到**才算过。

---

## P5 · 核心差异：不还给原 owner

紧接着 P4，不要干预，再等一轮 tick，然后：

```
调用 team_autopilot_status，再查 RECLAIM-TEST-01（id: <填 id>）的 status 和 owner，
把两者输出原样贴给我。
```

**期望**：任务的新 owner 是 **worker-b**（或任何不是 worker-a 的成员）。
如果又派回 worker-a —— 那是 bug，把输出贴给我，这是我们要守的语义分界（回池重排，不是还给他）。

再进一步：如果 worker-b 正常跑完，`completed` 出现，整个闭环就通了。

---

## P6 · 负向场景（不该回收的）

```
用 send_message 给 worker-b 发消息，让它认领一个新任务并**开始真正执行**
（比如让它写一个临时文件并统计行数），要确保它的回合持续较长时间。

在它执行期间，调用 team_autopilot_status 并把输出贴给我。
```

**期望**：`reclaimed` **不增加**——owner 是 `running` 时不判定僵死。

---

## P7 · 收尾

```
把团队里所有 RECLAIM-TEST-* 任务标记 deleted，然后告诉我做完了。
```

之后把配置改回你想要的 `reclaimAfterMs`（默认 300000）并重启。

---

## FAQ（agent 卡住时看这里）

| 现象 | 原因 |
|---|---|
| `reclaimed` 一直是 0，任务 owner 是空的 | 任务没被认领 → 不算 in-flight，本来就无需回收。让 worker-a 真的认领 |
| `reclaimed` 涨了但任务没变 | 这是 dryRun 的正常表现，不是失败 |
| `reclaimed` 涨了但 `lastError` 出现 | reassign 被拒（多半是 revision 冲突），把错误贴出来 |
| 等了两分钟还没动静 | 确认 App 是**完全退出后重启**的；确认 patch 里的段 id 是 `team-autopilot`，且 `reclaimAfterMs` 确实生效（对照启动行） |
| worker-a 不肯停手 | spawn 时的 prompt 没生效，重新 spawn 一个，或直接在消息里再强调一次规则 |
| 插件没加载 | 跑 `node scripts/verify-mount.mjs` |

---

## 不要做

- 不要让 Lead 自己去 claim 测试任务（Lead 持有的任务永不回收，会把场景搞乱）
- 不要在等待期间手动改任务状态
- 不要同时开别的团队插件
