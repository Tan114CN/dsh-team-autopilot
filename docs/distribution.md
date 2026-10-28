# 分发登记：让插件能被搜到、被装上

功能做完了不等于有人知道。这份文档只解决一件事：**让别人能在市场里找到并一键装上**。

## 一、现状（2026-10-28 实测，不是估计）

dsh 生态的插件发现**不是靠人传人，是靠一份目录数据**：

| 事实 | 数值 | 来源 |
| --- | --- | --- |
| 目录条目总数 | 7406 | `awesome-dsh-plugin.com/plugins.json` 的 `count` |
| 其中带 npm 映射（能显示下载量、按包名安装） | 3823 | 同上，`npm` 字段非空 |
| 我们所在的 `workflow` 分类条目数 | 413 | 同上次级统计 |
| `dsh-team-autopilot` 是否在其中 | **否** | 全文检索无命中 |
| GitHub `topics` | **8 个已设**（含 `dsh-plugin`） | GitHub API，2026-10-28 复核 |
| GitHub `description` | **已填**（首句 `Deterministic auto-dispatch for …`） | 同上 |

> 前三行是 2026-10-28 的目录快照，后两行是同日复核的仓库元信息——**动作 1 已完成**，表里不再留白。目录那两行（条目总数、npm 映射数）会随别人投稿变化，引用时以当次抓取为准。

这份 `plugins.json` 是 `dshmarket`、`dsh-m`、`dsh-community-plugins` 等**应用内市场**的数据源；`dshhub.dev` 之类目录站则按 GitHub 的 `dsh-plugin` topic 每日爬取。

两条路的进度不一样：**topic 那条已经铺好**（8 个 topic 已加，按 topic 爬的目录站会自己发现我们，不需要再做什么），**应用内市场那条还完全没上**——`plugins.json` 只能由投稿进入，也就是下面动作 2 要开的那个 PR。两者不能互相替代：进了应用内市场才有一键安装。

结论：现在的问题不是「描述写得不够好」，而是**在应用内市场那份索引里不存在**——`dsh-plugin` topic 只让按 topic 爬的目录站看见我们，进不了 `plugins.json`。一个不存在的条目，文案好坏没有意义。

## 二、竞争位：目录里确实空着

`workflow` 分类 413 条里团队类插件很多（`@nanmicoder/dsh-agent-teams` 2368 star、`dsh-agent-team` 70、`agent-team` 45、`dsh-plugin-teamflow` 14……），但逐条读描述，**没有一条**在做这三件事中的任何一件：

- 任务 ready 时**由后台 tick 唤醒**空闲成员（现有的都是主 agent 主动调工具）
- 持有者停摆后**自动收回**任务
- 写域重叠在**派发时刻**当软锁拦掉

最接近的两条也不重合：`dsh-task-dispatch-table` 是「定时表驱动、零模型调用」但派的是独立 session，不碰原生 Agent Teams；`dsh-agent-board` 有文件级排他锁，但是主 agent 派给一次性 subagent。

也就是说「**确定性派发 + 原生 Agent Teams + 派发时刻写域软锁**」这个组合在目录里是空的。这也解释了为什么投稿描述必须把「原生接缝、不另造团队层」写进去——否则读者会把它归进上面那一堆「又一个团队插件」。

## 三、三个动作

### 动作 1：仓库元信息（✅ 已完成 2026-10-28）

这两项是**所有自动收录的前提**：`dsh-plugin` topic 是 awesome 列表的硬性收录条件，也是目录站每日爬取的信号。

已完成：`description` 与 8 个 topic 都已写入（`curl api.github.com/repos/Tan114CN/dsh-team-autopilot` 可复核）。以下值留作存档，将来改描述时以这里为准：

打开 <https://github.com/Tan114CN/dsh-team-autopilot> → 右侧 About 旁的齿轮：

**Description**（复制这一整行）：

```
Deterministic auto-dispatch for DeepSeek Harness native Agent Teams: wake a member when a task becomes ready, reclaim the task when its owner stalls, and treat write-scope overlap as a soft lock at dispatch time.
```

**Topics**（逐个添加，共 8 个）：

```
deepseek-harness
dsh
dsh-plugin
cordis
agent-teams
multi-agent
orchestration
autopilot
```

### 动作 2：投稿到 `awesome-dsh-plugin`（有时间门槛，见下）

一个文件就是全部投稿。文件名必须是 `data/plugins/<owner>__<repo>.yml`：

**`data/plugins/Tan114CN__dsh-team-autopilot.yml`**

```yaml
url: https://github.com/Tan114CN/dsh-team-autopilot
name: Tan114CN/dsh-team-autopilot
category: workflow
icon: https://raw.githubusercontent.com/Tan114CN/dsh-team-autopilot/main/assets/icon-180.png
description:
  en: 'Deterministic auto-dispatch on the native Agent Teams seam, with no team layer of its own: a background tick wakes an idle member for each ready unowned task, reclaims tasks whose owner went quiet, and treats overlapping write scopes as a soft lock at dispatch.'
  zh: 在原生 Agent Teams 接缝上做确定性自动派发，不另造团队层：后台 tick 为每个就绪且无主的任务唤醒空闲成员，收回持有者已停摆的任务，并把写域重叠在派发时刻当作软锁处理。
```

要点：`en` 里含 `: `（冒号加空格），**必须加单引号**，否则 YAML 解析成嵌套键直接失败。`zh` 是全角冒号，无此问题。

新建文件并开 PR（链接已预填文件名）：

<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/new/main/data/plugins?filename=Tan114CN__dsh-team-autopilot.yml>

**仓库年龄门槛**：CI 要求仓库创建满 1 天。我们是 `2026-10-27T18:17:09Z` 创建的，也就是**北京时间 2026-10-29 02:17 之后**才满足。早于此提交会被 CI 挡下（不是拒绝，改完重提即可，但没必要白跑一次）。

其余前置项已核查通过，不用改代码：

| 门槛 | 状态 |
| --- | --- |
| `package.json` 声明 `dsh.bundle` | ✅ `{"bundle":{"patch":"./cordis.patch.yml"}}` |
| `cordis.patch.yml` 存在于仓库根 | ✅ |
| 发布的包 `repository` 指回本仓库 | ✅ `git+https://github.com/Tan114CN/dsh-team-autopilot.git` |
| 真实可用代码、非占位 | ✅ 50 项 verify + 29 项 integration + 28 项验收全绿 |
| 仓库年龄 ≥ 1 天 | ⏳ **唯一未满足项**：`created_at=2026-10-27T18:17:09Z`，北京时间 10-29 02:17 起达标 |
| 已加 `dsh-plugin` topic | ✅ 8 个已设（2026-10-28 复核） |

**不要**在 yml 里手写 `npm:` 字段——会被校验拒绝；npm 映射由 registry 按 `repository` 自动采集。

### 动作 3：另外两个目录（机制未经我核实，按站点入口走）

- `Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins`：双语精选清单，其 README 写明贡献方式是提 PR 或给仓库加 `dsh-plugin` topic（做完动作 1 后会被它的每日任务发现）
- `dshplugin.store`：页面自称有官方投稿表单

这两处我没有核实到确切的表单地址与字段要求，所以不写进本文档的「照做即可」部分。动作 1 + 动作 2 覆盖的是**应用内市场**这条真正会被用户看到的路，优先做那两个。

## 四、描述文案的每句话对应哪段代码

`contributing.md` 明写：描述会被当作对代码的声明，**逐句核对**，夸大是让一个本来不错的插件被打回的主要原因。所以投稿前先把账对齐：

| 文案中的主张 | 代码位置 |
| --- | --- |
| 后台 tick 驱动 | `src/dispatch.ts` 的 `loop()`；`tickTimeoutMs` 默认 30s |
| 任务就绪且无主时才派 | `src/select.ts` 的 `claimableTasks` + `availableMembers` |
| 唤醒空闲成员 | `src/dispatch.ts` 派发段；冷却 `wakeCooldownMs` 默认 60s |
| 收回停摆者的任务 | `src/reclaim.ts` 的 `planReclaim`；`reclaimAfterMs` 默认 300s |
| 写域重叠在派发时刻拦掉 | `src/select.ts` 的 `blocked.push({ kind: 'scope' })`，`writeScopes` 按 `/` 分段前缀比对 |
| 「不另造团队层」 | 无自有任务存储、成员注册表或消息通道；任务板与 roster 全部经 `ctx.agentTeams` 读写 |

表里每一条主张都能指到具体位置，没有一条是形容词。**描述里不要出现的**：星数、下载量、用户数、任何数量词（「9 个模块」这种也别说——评审会数）。

## 五、投稿之后

- CI 四步：条目数 ≤3 → `dsh.bundle` → 仓库年龄 → `awesome-lint` 与站点构建
- 需要修改时维护者打 `held: author` 标签，那表示「等修改」，不是拒绝
- 合并后 README 由 `data/plugins/*.yml` 自动生成，不要手工编辑 README
- 条目停止维护、仓库归档或长期停更会被定期扫描移除

## 六、这件事的优先级

按项目记忆里的止损条件，三个月后 GitHub 仍 0 star 就说明问题在分发而不在功能。所以：

1. **动作 1 已完成**——topic 一加，目录站的每日爬取就开始工作，其余路径都建立在它上面。现在唯一的单点是**动作 2 的仓库年龄门槛**（北京时间 10-29 02:17），到点前没有任何可提前做的准备
2. 动作 2 让插件出现在应用内市场，用户能一键装，这是从「搜到」到「用上」的关键一跳
3. 文案、截图、英文 README 都是**转化**层面的优化，在这两件事完成前没有作用对象

## 七、市场卡片视觉（已做）

条目里能声明两种图，都在**自己仓库里**声明，推自己的仓库就生效，不用再提 PR：

| 图 | 声明方式 | 规格 |
| --- | --- | --- |
| 卡片图标 | 条目 yml 的 `icon:` | GitHub 托管的 png/jpg/webp，约 96px 显示，方形最佳；**不收 SVG 与第三方图床** |
| 详情页截图 | 仓库根的 `screenshots.json` | 1–8 个相对路径，相对该文件本身，不能以 `/` 开头、不能含 `..`；也接受 GitHub 托管的 https 绝对地址 |

本仓库已有：

- `assets/icon-180.png` — 一个成员从 roster 里接下任务
- `assets/how-it-works.png` — 左右对照卡片；右侧时间线与底部三行字段是**真机日志原值**（`09:52:16.504` → `09:52:18.481`），不是示意
- `screenshots.json` — 指向上面那张卡片图
- `scripts/render-assets.py` — 生成这两张图的脚本（需要 Pillow：`python -m pip install pillow`）

为什么把数字钉在真机字段上：这是整个仓库里唯一一张会脱离代码被传播的东西。市场卡片上编出来的时间线，是唯一无法被任何人核对的主张——而那正是这个项目最不该做的事。

`assets/` 不在 npm 的 `files` 白名单里，所以 README 用 `raw.githubusercontent.com` 的绝对地址引图，npm 页面和 GitHub 都能渲染。要换图就改脚本重跑，别直接编辑 PNG。
