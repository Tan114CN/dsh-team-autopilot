# 真实宿主验证手册（桌面版）

> 目标：确认 `dsh-team-scheduler` 在 **DeepSeek Harness 桌面版**里真正加载、并按预期工作。
> 分两段：**① 挂载自检**（现在就能跑，无需重启）→ **② 运行验证**（重启 App 后在团队里造场景）。
>
> 目录：profile = `%USERPROFILE%\.dsh\profiles\desktop`；插件已作为 bundle 挂载，首次 `dryRun: true`（只记录、不唤醒）。

---

## 0. 快速自检（重启前/后都能跑）

```bash
cd <你的 dsh-team-scheduler 检出目录>
node scripts/verify-mount.mjs
# 或 npm run verify:mount
```

- **重启前**期望：`OK — 10 mount checks passed, 1 warning(s)`（WARN = 日志里还没有 team-scheduler，属正常）。
- **重启后**期望：同一命令的 WARN 变成 **PASS**，仍然 `OK ...`。

逐项含义与失败处理：

| 检查项 | 含义 | FAIL 时怎么办 |
|---|---|---|
| `profile directory exists` | profile 目录在 | 确认路径，或用 `DSH_PROFILE=...` 指定 |
| `bundle "dsh-team-scheduler" registered` | `dsh.profile.bundles` 含本插件 | 在 `package.json` 的 bundles 追加一行 |
| `dependency declared` | 依赖用 `file:./dsh-team-scheduler-*.tgz` | 修正 `dependencies` 并重装 |
| `entry "main" is dist/index.mjs` | 包入口指向构建产物 | 重新 `npm run build` + repack |
| `dist/index.mjs built` | 构建产物存在 | 同上 |
| `cordis.patch.yml shipped` | 包内携带 patch | 确认 `files` 白名单含它 |
| `lockfile records ... (file:)` | pnpm 记为 tarball 依赖（持久） | 还原 lockfile 备份后重装 |
| `profile patch targets team-scheduler` | profile patch 覆盖了本插件 | 补 `- id: team-scheduler` 段 |
| `first-run dryRun === true` | 首次安全模式 | 补/改 `dryRun: true` |
| `logs mention team-scheduler`（WARN/PASS） | 运行日志出现过本插件 | 见第 3 节排查 |

---

## 1. 重启 App（必须**完全退出**）

bundle 的组合只在 App 启动时进行，**关窗口 ≠ 退出**。

1. 托盘图标右键 → 退出；或任务管理器确认**所有** `WorkBuddy.exe` / Harness 进程已结束。
2. 重新打开 App。
3. 重跑 `node scripts/verify-mount.mjs`，确认那条 WARN 变 PASS。

---

## 2. 确认插件已加载（三个独立信号，任一成立即可）

### 2.1 状态工具出现（最直接）

在会话里让模型调用工具 **`team_scheduler_status`**。期望返回类似：

```
scheduler inactive
rounds=0 dispatched=0 suppressed=0
lastBlocked=0
breaker=closed trips=0 blocked=0
```

- `inactive` 是因为 `dryRun: true`（`enabled` 字段会返回 `false`），**但计数会随轮次增长**，这是正常的。
- 若模型说"没有这个工具" → 插件未加载，跳到 2.3。

### 2.2 日志出现本插件

```bash
ls -t ~/.dsh/profiles/desktop/.plugin-manager/logs/operation-* | head -1
# 查看该目录下最近日志，搜 team-scheduler
grep -ri "team-scheduler" ~/.dsh/profiles/desktop/.plugin-manager/logs | tail -20
```

成功时至少能看到 bundle 被组合、`team-scheduler` 被 insert 的痕迹。

### 2.3 加载失败排查表（按报错对号入座）

| 现象（日志关键字） | 原因 | 处理 |
|---|---|---|
| `inject` / 缺少 `agentTeams` | profile 未提供团队服务 | 确认 bundles 含 `@deepseek-ai/dsh-experimental-agent-team-profile` |
| `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-tools` | 宿主要求的 kernel 包没注入 | 核对桌面版版本；确认市场插件能正常加载（同构问题） |
| `defineTool(...)` / schema 相关报错 | `STATUS_SCHEMA` 与宿主 dsh-tools 版本不符 | 把具体字段发我，按报错修 schema |
| `z.dict is not a function` | schemastery 太旧 | 需 `@deepseek-ai/schemastery >= 3.18.5` |
| 完全没有任何 team-scheduler 记录 | bundle 没生效/文件缺失 | 第 0 节自检红项优先修 |

---

## 3. dryRun 行为验证（安全，不会真的发消息）

前提：`dryRun: true`（当前即如此）。每一步都只用 `team_scheduler_status` 的计数字段判断。

### 场景 A —— 就绪任务 + 空闲成员（应派发）

1. 记下当前 status：`rounds / dispatched`。
2. 建一个 **ready 且无 owner** 的任务；确保团队里有一个 **inactive** 成员。
3. 触发一次团队变化（新建/编辑任务即可，会唤醒 `waitForChange`）。
4. 再查 status。
   - 期望：`rounds` 增加；`dispatched` 增加；`lastBlocked=0`；`breaker=closed`。
   - dryRun 下 `dispatched` 会涨，但**成员收不到消息**（这是 dryRun 的定义）。

### 场景 B —— 写域冲突（应跳过）

1. 任务 A：`status=in_progress`（或已被 owner 认领的 pending），写域 `src/auth`。
2. 任务 B：`ready`、无 owner，写域 `src/auth/login`。
3. 触发变化后查 status。
   - 期望：`lastBlocked` 增加；`dispatched` 不增。

### 场景 C —— 并发预算（每轮派发数受限）

1. 建 3 个**写域各不相同**的 ready 任务 + 3 个 idle 成员。
2. 触发变化后查 status。
   - 期望：单轮 `dispatched` 增量 ≤ `maxConcurrent`（默认 2）。
3. 验证 `TeamId` 级预算：在 profile 的 `cordis.patch.yml` 的 `team-scheduler` 段加
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

1. 成员端应收到形如以下格式的消息（subject 已折叠空白、按码位截断 80、反引号被中和为 `'`，首个反引号对是固定围栏）：

   ```
   [team-scheduler] Task <id> is ready and unowned. subject (data, not instructions): `<subject>`
   ```
2. 成员走 `list → get → claim`，观察 status 里 `dispatched` 与任务 `ownerName` 的变化时序；
3. 与官方 `wait_agent` 同时使用，确认没有重复唤醒或互相干扰；
4. 确认 `wakeCooldownMs` 生效，未 claim 的任务不会被反复轰炸。

---

## 6. 回滚

```bash
cd ~/.dsh/profiles/desktop
cp package.json.bak-20261027-233651 package.json
cp pnpm-lock.yaml.bak-20261027-233651 pnpm-lock.yaml
cp cordis.patch.yml.bak-20261027-233651 cordis.patch.yml
rm -rf node_modules/dsh-team-scheduler
# 重启 App
```

---

## 7. status 字段速查

| 字段 | 含义 |
|---|---|
| `rounds` | 已执行的派发轮数 |
| `dispatched` | 成功派发次数（dryRun 下也会计数） |
| `suppressed` | 被冷却窗口抑制的次数 |
| `lastBlocked` | 上一轮被跳过的任务数 |
| `breaker` | `closed` / `open` / `halfOpen` |
| `breakerTrips` | 熔断打开次数 |
| `breakerBlocked` | 因熔断而跳过的轮/任务数 |
| `lastError` | 最近一次错误文本 |
