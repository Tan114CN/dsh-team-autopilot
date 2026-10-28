# Changelog

本项目的所有值得注意的变更都会记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
- `team_scheduler_status` 诊断工具（`rounds` / `dispatched` / `suppressed` / `lastBlocked` / `breaker` / 团队诊断字段）。
- 熔断状态机：连续 `sendMessage` 失败后切开电路，冷却后半开探针恢复。
- 团队级并发预算 + `teamBudgets` 覆盖。
