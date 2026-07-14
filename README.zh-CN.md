# agentsmd — OpenAI Codex CLI 编程规范与原生 Hooks

**[English](./README.md) · 中文**

agentsmd 是面向 OpenAI Codex CLI 的 `AGENTS.md` 编程规范与原生 Hooks 插件。它提供证据驱动工作流、15 个有边界的安全与报告检查、项目级指令工具，以及供人工复审的规则遥测。

![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![hooks](https://img.shields.io/badge/Codex_hooks-15-blue)

- **证据驱动流程：** 对任务进行分级、授权检查、规划、执行、验证，并用新鲜证据报告结果。
- **有边界的原生检查：** 阻断部分可机械检测的风险并呈现结构化提示，不宣称自动执行所有语义规则。
- **项目级工具：** 生成 `AGENTS.md`、提炼编码约定、提取前端设计令牌。

## 安装

### Codex 插件——推荐

从 agentsmd 的 Codex marketplace 安装：

```bash
codex plugin marketplace add sdsrss/agentsmd --json
codex plugin add agentsmd --marketplace agentsmd --json
```

第二条也可以简写为：

```bash
codex plugin add agentsmd@agentsmd
```

安装后新开一个 Codex 会话，让插件中的 hooks 和 skills 生效。验证命令：

```bash
codex plugin list --marketplace agentsmd --json
```

Codex 首次启用插件 hooks 时会要求审查信任。先检查 `.codex-plugin/plugin.json` 指向的 `hooks.json` 及其中 15 条本地命令，再批准；未信任 hooks 时，skills 可见，但规范 banner 与运行时检查不会执行。

偏好图形界面？在 Codex app 中打开 **插件**；或运行 `codex`，输入 `/plugins`，打开 `agentsmd` marketplace 条目并选择安装。

> 插件通过 Codex plugin cache 提供 hooks、skills 和规范。可信的 `SessionStart` hook 会把打包的 core spec 加入当前会话，并给出 extended spec 的实际路径；它不会改写 `~/.codex/AGENTS.md`、设置 `[features] hooks = true` 或迁移旧 `codexmd` 安装。需要全局文件与完整生命周期时，改用 standalone/npm。

插件与 standalone 是两种安装面，建议只选一种。双面进程先验证 manifest-backed standalone 完整性，再比较 SemVer：健康的同版/新版 standalone 胜出并让 protocol-v1 plugin hooks 退出；缺失、manifest 损坏、artifact 损坏、hooks 被禁用/错接、core 内容不一致或版本较旧的 standalone 不能遮蔽健康 plugin。`status` 在不改变既有 standalone 字段语义的前提下新增 `selectedSurface` 和稳定的 `surfaceArbitration`。`doctor` 把任何 manifest-backed 双面都保留为要求清理的红色状态，即使 protocol-v1 fixture 已证明其中一份 hook 会退出。新版 plugin 无法关闭旧 standalone 已注册的命令，也无法移除 SessionStart 前已进入 discovery context 的旧 global core；逻辑选择 plugin 只会加入 packaged core，不能证明它是唯一 policy/hook。需要 update/uninstall 旧面才能消除这个不协作边界。

### 完整 standalone 安装

这个幂等安装器在 `$CODEX_HOME`（默认 `~/.codex`）中管理全局规范、原生 hook 配置、状态栏默认值、旧版迁移和 standalone 生命周期。先下载并审查，再执行：

```bash
curl -fsSLo /tmp/agentsmd-install.sh https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh
less /tmp/agentsmd-install.sh
sh /tmp/agentsmd-install.sh
```

安装器默认解析到**它自己的 release tag** 对应的不可变 GitHub release 资产，并在
执行任何下载代码**之前**校验已发布的 SHA-256。`--ref vX.Y.Z` 可固定到其他
release tag（同样校验）；40 位 commit 具备不可变身份但没有已发布 checksum，会
告警；`main` 等 mutable branch 会被拒绝，除非显式加 `--dev`（仅限开发——该路径
不固定也不校验）。

前置依赖（`jq`、Node.js 18+）在**任何文件变更之前**检查：缺失即中止，零改动。
`--degraded` 是唯一的显式降级入口（hooks 失效放行）；manifest 记录
`enforcement:false`，`status`/`doctor` 会持续告警，直到一次健康的
`agentsmd update` 恢复。

变更类生命周期操作（install / update / uninstall / `restore --confirm` /
`repair --confirm`）按 `$CODEX_HOME` 由跨进程锁串行化：并发的第二个操作以
exit 1 拒绝且不做任何改动，并指明正在进行的那一个。崩溃残留的锁会在下一次
生命周期命令时自动清除；`doctor` 会报告 stale 锁。每次 commit 还会在首次
live 变更前写入持久 journal：中途被杀的运行可仅凭磁盘状态判定
roll-forward / rollback / conflict（`doctor` 报告判定）——已落地的 commit
在下次 update 时自愈，半提交状态则 fail-closed 拒绝续建。

### npm CLI

全局安装固定版本的 CLI，再运行同一套 standalone 生命周期：

```bash
npm install -g @sdsrs/agentsmd
agentsmd install
agentsmd doctor
```

不全局安装 CLI 的一次性形式：

```bash
npx --package @sdsrs/agentsmd agentsmd install
```

直接运行 `agentsmd` 只打印帮助，不写入文件。退出码统一为：`0` 表示成功/帮助，`1` 表示负面结果或运行时失败，`2` 表示 argv/usage 错误。

### 从本地 checkout 安装

适合贡献者或安装前审查：

```bash
node scripts/install.js
node scripts/status.js
node scripts/doctor.js
```

## 环境要求

- 支持原生 hooks 的 OpenAI Codex CLI，以及可用的 `bash`。
- `PATH` 中有 Node.js 18 或更高版本和 `jq`；Git 工作流还需要 `git`。
- standalone 安装会启用 `[features] hooks = true`；插件安装依赖 Codex plugin runtime。
- 共享分支 GitHub 状态检查可选依赖 `gh`。
- 自动化覆盖 Linux 与 macOS；Windows 建议在 WSL 中运行 Bash hooks。

当输入或依赖不足以完成判断时，hooks 会 fail-open，并在可行时记录失败。

## agentsmd 能做什么

常驻 core 与按条件加载的 extended spec 定义这条流程：

```text
CLASSIFY → AUTH → ROUTE → PLAN → EXECUTE → VALIDATE → REPORT
```

系统提供：

- 按任务级别验证，并要求新鲜证据；
- 对破坏性或外部可见操作设置授权门槛；
- 针对 secrets、不安全删除和远程执行的不可降级安全底线；
- 有固定顺序、以证据为锚点的任务报告；
- 对规范中可机械检测部分执行原生检查；
- 记录规则机会与结果，供 operator 人工复审；
- 15 个 Codex skills，用于复用诊断与项目工作流。

用户明确要求 commit 并 release/publish 时，会授权指定仓库或包的标准发版流程。未命名的生产环境、live 配置和无关 scope 不在授权范围内。

## 工作方式

| 层 | 作用 | 主要内容 |
|---|---|---|
| 规范 | 定义流程、授权、证据、安全和报告 | `spec/AGENTS.md`、`spec/AGENTS-extended.md` |
| 原生 hooks | 在四类 Codex 事件中阻断或观察部分可检测模式 | `hooks/*.sh`、`hooks.json` |
| 管理层 | 安装、诊断、恢复、审计和治理 | `scripts/*.js`、`agentsmd` CLI |
| 项目工具 | 生成项目事实、编码约定和设计令牌引用 | `agentsmd init`、`analyze`、`design` |

Stop observers 会把提示放入队列，在下一次 `UserPromptSubmit` 呈现，而不是在 `Stop` 时直接输出。遥测追加到 `$CODEX_HOME/logs/agentsmd.jsonl`。

## 原生 Hook 覆盖

agentsmd 在 `SessionStart`、`PreToolUse`、`UserPromptSubmit` 和 `Stop` 上注册 15 个 hooks。阻断型 hook 只处理边界明确的机械检查；语义规则仍由 agent/operator 负责。

| Hook | Event | 可检测职责 |
|---|---|---|
| `pre-bash-safety-check` | PreToolUse:Bash | 检测直接/间接变量删除、远程下载经复制或移动后执行；提示未固定版本的 `npx` |
| `banned-vocab-check` | PreToolUse:Bash | 阻断 `git commit` 消息中未量化的价值表述 |
| `ship-baseline-check` | PreToolUse:Bash | 已知 CI 基线为红色时阻断推送共享分支 |
| `memory-read-check` | PreToolUse:Bash | ship 前要求读取项目 memory index 与同仓库、经 canonical 校验的关联 memory |
| `secrets-scan` | PreToolUse:Bash | 阻断检测到 secrets 或高置信 secret 文件名的 commit |
| `session-start-check` | SessionStart | 注入当前规范 banner，并重置提示队列 |
| `surface-advisories` | UserPromptSubmit | 呈现上一轮排队的提示 |
| `memory-prompt-hint` | UserPromptSubmit | 呈现与 prompt 匹配的 `MEMORY.md` 条目 |
| `residue-audit` | Stop | 标记 Codex 临时存储中的任务残留增长 |
| `sandbox-disposal-check` | Stop | 标记可能属于任务的 scratch，并排除 runtime-owned 路径 |
| `transcript-structure-scan` | Stop | 检查 §10 报告结构/词汇和 §6 证据锚点 |
| `convention-cite-scan` | Stop | 记录有效的 `@conv-*` 项目约定引用 |
| `session-exit-checkpoint` | Stop | 标记修改后没有 test/lint/typecheck/build 证据的字节 |
| `mem-audit` | Stop | 检查 memory index/file 漂移和 verified header |
| `session-summary` | Stop | 保存滚动强制统计，供 `status` 显式查看；不会注入其他会话 |

## 项目工作流

### 生成项目 `AGENTS.md`

在项目根目录运行：

```bash
agentsmd init
```

`init` 检测 Node、Rust、Python、Go、包管理命令和常见前端技术栈。它更新 sentinel 管理块，并保留块外内容。

- `--check` 报告漂移。
- `--dry-run` 只预览，不写文件。
- `--local` 创建加入 `.gitignore`、只创建一次的 `AGENTS.local.md`，并打印 Codex 加载该文件所需的 fallback 设置。
- `--no-frontend` 跳过 React/Vue/Svelte/Angular/Solid/Preact 及相关框架事实。

`--check`、`--dry-run` 和 `--local` 是互斥执行模式。

### 提炼编码约定

```bash
agentsmd analyze --gather
agentsmd analyze --write --from conventions.md
```

`analyze --gather` 生成有上限、遵循 ignore 规则的源码图。AI skill 从中提炼命名、imports、错误处理和注释；`--write --from` 把审核后的结果写入 conventions 管理块。内容超过 6 KiB 预算时，命令会拒绝而不是截断。

查看已知约定 anchor 是否被引用：

```bash
agentsmd analyze --adoption
agentsmd analyze --adoption --days=7 --project=X
```

零引用只触发人工复审，不会自动删除；当前尚未记录每个 anchor 的 evaluated opportunities。

### 提取设计令牌

```bash
agentsmd design
agentsmd design --write
```

`design` 预览 CSS `:root` 变量和 Tailwind v4 `@theme` 事实；`design --write` 创建受管理的 `DESIGN.md` 块及 `AGENTS.md` 指针。非前端项目是 no-op。Tailwind v3 配置对象会被识别，但尚不解析。

## CLI 参考

| 命令 | 用途 |
|---|---|
| `install`、`update`、`uninstall` | 管理 standalone 安装 |
| `status`、`doctor`、`repair`、`restore` | 检查健康状态、修复缺失的 manifest-owned artifact，或恢复共享文件快照 |
| `init`、`analyze`、`design` | 管理项目指令和设计事实 |
| `exception` | 在仓库的 `.agentsmd/exceptions.json` 登记已审核的 §8 false-positive 例外（指纹 + 过期时间；取代已移除的内联 `[allow-*]` token） |
| `audit`、`rules`、`sparkline` | 查看规则活动和治理信号 |
| `sampling-audit`、`lesson-bypass-audit` | 测量 transcript 合规与 memory hint 后续采用情况 |
| `safety-coverage-audit`、`lint-argv` | 检查静态安全 wiring 和严格 CLI 参数解析 |
| `perf-baseline`、`version-cascade` | 测量 hook 成本并检测 README 中过期的版本文本 |

运行 `agentsmd --help` 查看当前选项。除 `init`、`analyze`、`design`、`exception` 作用于当前项目外，其余命令都遵循 `$CODEX_HOME`。

## 更新、验证与卸载

### Codex 插件

```bash
# 更新
codex plugin marketplace upgrade agentsmd --json
codex plugin add agentsmd --marketplace agentsmd --json

# 卸载
codex plugin remove agentsmd --marketplace agentsmd --json
codex plugin marketplace remove agentsmd --json
```

插件更新后新开一个 Codex 会话，并重新审查发生变化的 hook 命令。

### Standalone 或 npm

```bash
# 更新并检查
agentsmd update
agentsmd status
agentsmd doctor

# standalone 损坏：先审查只读计划，再用摘要绑定 apply
agentsmd repair --plan
agentsmd repair --confirm=<planDigest>

# 先卸载 Codex footprint，再移除可选的全局 CLI
agentsmd uninstall
npm uninstall -g @sdsrs/agentsmd
```

curl 安装器提供 install/update/status/doctor/uninstall。`repair` 需要固定版本的
npm CLI 或已审查的本地 checkout，才能在修改前识别替换 artifact。若同时安装了
plugin 与 standalone，需要分别卸载两套 surface。

plugin context 只接受 Codex runtime 的 `CLAUDE_PLUGIN_ROOT`，或 status/doctor
skill 已解析的 `AGENTSMD_PLUGIN_ROOT`。CLI 不扫描 plugin cache，因为 cache 中存在
artifact 不代表 Codex 已启用它。有 context 时，`surfaceArbitration` 会给出两面
版本、健康证据、赢家、稳定 reason code，以及静态协作协议是否支持 exclusive
execution。该字段不是 runtime exact-once 证明，真实 Codex E2E 仍是独立 Gate。
仲裁不是信任边界；在实现不可变 artifact provenance 前，plugin integrity 仅为
structural。
为了 JSON 兼容，顶层旧字段 `dualSurface` 仍表示 manifest 是否同时存在；无
manifest 的 partial footprint 会出现在 `surfaceArbitration.candidates.standalone`。
doctor 的旧 `surface` 仍表示诊断调用 context，逻辑赢家使用 `selectedSurface`。

## 安全、所有权与共存

standalone 安装使用 manifest ownership 和 marker scope。它保留其他 hook tenant 与 agentsmd 管理块外的用户内容；修改前验证 owned artifact；遇到不可解析的共享文件或 hash 不匹配的 owned file 时拒绝操作。安装与卸载使用 staged changes、snapshot checks、写入时 CAS 和 rollback；不协作的外部写入者会导致操作拒绝，而不是静默覆盖已变化的共享文件。

`repair --plan` 是只读操作，会区分可普通更新的完整安装、缺少 manifest-owned
文件的安装，以及无法证明 ownership 的状态。自动 repair 只处理有效 exact-path
manifest 下缺失的文件/目录，并要求 source artifact 的版本和 deploy digest 与
该 manifest 完全相同；内容被修改、出现额外文件、manifest 损坏，以及无
manifest 的 partial install 都会阻断并要求人工复核。`--confirm=<planDigest>` 会
重新检查 source/live descriptor，先完整快照 deploy、skills、extended、manifest
和共享文件，再复用 installer transaction；artifact、目标或共享文件发生变化都会
使摘要失效。

`restore` 的语义不同：历史 pre-install backup 只包含 `hooks.json`、
`config.toml` 和 `AGENTS.md`，不能修复 deploy、skills、extended spec 或 ownership
manifest。

卸载会移除已注册 hooks、skills、受管理的 `AGENTS.md` 块、已知 runtime state 和 extended spec。它保留恢复备份、未知状态、遥测、已启用的 hook/status-line 设置，以及当前会话可能仍需要的未注册 no-op shims。

agentsmd 独立于 oh-my-codex。若存在 OMX，agentsmd 会把它的条目视为其他 tenant 并原样保留。

从 `codexmd` v1.4.0–v1.4.3 升级时，standalone 安装器只迁移 legacy provenance 可验证的 artifact。项目在 v2.0.0 更名为 agentsmd。

## 治理与遥测

```bash
agentsmd audit --days=30
node scripts/audit.js --project=X
agentsmd rules --days=30
agentsmd sparkline --windows=6 --bucket-days=7
```

只有在积累足够 rule-specific evaluated opportunities 后仍为零 enforcement hits，规则才进入降级候选。`--project` 对 rules 仅作信息透镜；降级信号仍跨项目。`no-opportunity`、低评估量和全局 session 数都不是降级证据。高命中只表示活跃，不代表正确。最终由 operator 依据 [`spec/OPERATOR.md`](./spec/OPERATOR.md) 决策。

## 开发

```bash
npm test
npm run lint:shell
```

测试覆盖安装隔离、插件分发、hook wiring、drift、遥测、诊断、项目工作流和 shell smoke fixtures。设计边界见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)，版本记录见 [`CHANGELOG.md`](./CHANGELOG.md)。

```text
bin/          npm CLI dispatcher
spec/         core、extended spec、hard-rule manifest、operator guide
hooks/        原生 hooks、共享 shell libraries、smoke tests
scripts/      生命周期、诊断、治理、项目工具、测试
skills/       15 个 Codex skill routers
.agents/      Codex marketplace metadata
.codex-plugin/plugin.json
hooks.json    plugin-root hook wiring
install.sh    standalone installer 与 lifecycle wrapper
```

## 常见问题

### agentsmd 只是一份 `AGENTS.md` 模板吗？

不是。agentsmd 组合了全局编码规范、有边界的原生检查、项目工具、诊断命令和规则复审遥测。

### Codex 插件会安装全局规范吗？

不会。插件把 hooks 和 skills 安装到 Codex plugin cache。若还需要受管理的全局 `AGENTS.md` 块和 standalone 配置生命周期，请运行 `agentsmd install` 或 standalone 安装器。

### agentsmd 依赖 oh-my-codex 吗？

不依赖。agentsmd 可以独立安装；存在其他 tenant 时也会保留它们。

### agentsmd 会取代人工复审吗？

不会。Hooks 只覆盖部分可检测模式。语义授权、正确性以及规则升降级仍由 agent/operator 基于证据判断。

## 许可

MIT
