# agentsmd — OpenAI Codex CLI 编程规范与原生 Hooks

**[English](./README.md) · 中文**

agentsmd 是面向 OpenAI Codex CLI 的 `AGENTS.md` 编程规范与原生 Hooks 插件。它提供证据驱动工作流、19 个有边界的安全、证据、报告与会话连续性检查、项目级指令工具，以及供人工复审的规则遥测。

![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![hooks](https://img.shields.io/badge/Codex_hooks-19-blue)

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
codex plugin list --json    # 在 "installed" 中查看 agentsmd
```

第一次可信的 `SessionStart` 会检查 agentsmd 的运行依赖，以及当前项目明确声明的
开发工具。插件不会自动安装任何工具：banner 会说明缺失项是插件运行必需，还是仅用于
项目 lint，并给出适合当前平台、可复制后手动执行的命令；工具可用后提示自动消失。

看 `installed` 数组，不要看 `available`：对 npm 来源的 marketplace 条目，Codex 在安装前后都报
`"available": []`，空的 `available` 不代表失败。

Codex 首次启用插件 hooks 时会要求审查信任。先检查 `.codex-plugin/plugin.json` 指向的 `hooks.json` 及其中 19 条本地命令，再批准；未信任 hooks 时，skills 可见，但规范 banner 与运行时检查不会执行。

偏好图形界面？在 Codex app 中打开 **插件**；或运行 `codex`，输入 `/plugins`，打开 `agentsmd` marketplace 条目并选择安装。

> 插件通过 Codex plugin cache 提供 hooks、skills 和完整规范。每次可信的 `SessionStart`（`startup`、`resume`、`clear`、`compact`）都注入唯一的完整 `spec/AGENTS.md` profile，并给出 packaged extended spec 的实际路径。旧 OMX marker 或其他 tenant 内容不会改变 profile。插件不会改写 `~/.codex/AGENTS.md`、设置 `[features] hooks = true`，也没有可逆的全局文件卸载生命周期。需要完整安装时使用 standalone/npm，它会事务式合并受管理的全局 `AGENTS.md` 块。

插件自己的 SessionStart 成功后，会在
`PLUGIN_DATA/runtime/activation.json` 写入私有激活凭据，并兼容回退到
`CLAUDE_PLUGIN_DATA`。`status`/`doctor` 将它与静态 bundle 健康分开报告为
`observed` 或 `unverified`。`observed` 只证明 SessionStart handler 已按记录选择
profile 并准备把它放入响应；它不能证明 Codex 已接纳该响应，也不代表所有 plugin
hooks 都已被信任或执行。运行时优先解析官方
`PLUGIN_ROOT`，再兼容 `CLAUDE_PLUGIN_ROOT`；两者指向不同 bundle 时健康检查
fail closed。

短生命周期 hook 状态按实际执行脚本的物理 surface 选择位置，而不是只看继承的环境变量：
plugin hook 写入 `PLUGIN_DATA/runtime`（兼容回退到 `CLAUDE_PLUGIN_DATA`），
standalone hook 写入 `$CODEX_HOME/.agentsmd-state/runtime`。迁移期 reader 仍会读取
`$CODEX_HOME/.agentsmd-state` 中的旧 ephemeral 文件，但所有新写入都进入私有 runtime；
standalone manifest、surface 仲裁缓存和遥测继续作为共享协调/运维数据。`status` 合并私有与
旧摘要；同名迁移副本以 plugin-private 版本为准。

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

升级包**不会**重新部署 spec 和 hooks——`~/.codex` 仍执行上一次
`agentsmd install`/`update` 放进去的版本。SessionStart hook 会直接说出来：
它比较已部署版本与安装来源包的版本（manifest 里的 `sourceRoot`），来源更新时补一行
提示并给出修复命令。该检查**完全离线**——只读两个本地文件，不查询 registry、不下载、
不自动更新;是否执行 `agentsmd update` 仍由你决定。早于 `sourceRoot` 字段的旧安装保持
静默，直到下次安装。

变更类生命周期操作（install / update / uninstall / `restore --confirm` /
`repair --confirm`）按 `$CODEX_HOME` 由跨进程锁串行化：并发的第二个操作以
exit 1 拒绝且不做任何改动，并指明正在进行的那一个。崩溃残留的锁会在下一次
生命周期命令时自动清除；`doctor` 会报告 stale 锁。共享 `hooks.json`、
`config.toml`、`AGENTS.md` 逻辑路径必须是普通文件或不存在；任一为 symlink
（包括断链）时，所有变更类生命周期入口都会在取得锁和恢复 journal 前拒绝，
既不跟随链接写入外部目标，也不把链接 inode 替换为普通文件。每次 commit 还会在首次
live 变更前写入持久 journal：中途被杀的运行可仅凭磁盘状态判定,并由**下一次
生命周期命令自动恢复**——staged 源完好时前滚完成,否则回滚还原,然后继续;
任意崩溃点都能通过平常的重跑自愈。仅当 journal 记录的目标被外部并发修改时
保持 fail-closed（字节保留;`doctor` 打印判定与精确恢复命令）。

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

首次通过 npm CLI 安装 standalone 前，会先只读检查
`codex plugin list --json`。若精确发现已安装且启用的
`agentsmd@agentsmd` plugin，安装以 exit 1 拒绝并保持 `$CODEX_HOME` 零改动。
先移除 plugin，再重跑安装，让一套可逆生命周期独占全局 guidance 与 hooks。
既有 standalone 仍可正常 update。若存在丢失 manifest 的 partial standalone，
guard 不会掩盖它，而会保留原有 fail-closed 恢复诊断。

standalone manifest 现在使用可加性的 schema v2，同时保留 update、repair、
restore、uninstall 所依赖的完整 v1 ownership 字段。每个 standalone bundle
只携带 full 与 extended 两份规范；新安装和 v1 升级都物化唯一的完整 profile。
旧 `auto`、`omx-compatible`、`legacy-full` 公共模式会在任何写入前被拒绝；
reader 只为把已拥有的旧双 profile manifest 迁移到新版而暂时识别旧结构。

```bash
agentsmd update --profile=full
```

standalone install/update 会把完整 core 事务式合并到
`$CODEX_HOME/AGENTS.md` 的 agentsmd sentinel 之间，块外字节原样保留。
SessionStart 不会改写全局文件。`status` 报告 configured/desired full profile
和 bundle 完整性。

直接运行 `agentsmd` 只打印帮助，不写入文件。退出码统一为：`0` 表示成功/帮助，`1` 表示负面结果或运行时失败，`2` 表示 argv/usage 错误。

自 v4.19.0 起，每个 npm 版本都由 CI 携带 [provenance 证明](https://docs.npmjs.com/generating-provenance-statements)（Sigstore / SLSA）发布，将包绑定到本仓库与该 tag；用 `npm audit signatures` 验证。

### 从本地 checkout 安装

适合贡献者或安装前审查：

```bash
node scripts/install.js
node scripts/status.js
node scripts/doctor.js
```

若要在不调用模型的情况下验证完整的公开 GitHub marketplace 生命周期：

```bash
npm run test:plugin-marketplace
```

这个联网 smoke test 需要真实的 `codex`、Node.js 与 `jq`。它使用一次性的
`CODEX_HOME`，覆盖重复安装、marketplace 更新、打包健康检查、安全清理与移除，
仅应在当前 package 版本已发布到 npm 后运行。

## 环境要求

- 支持原生 hooks 的 OpenAI Codex CLI，以及可用的 `bash`。
- `PATH` 中有 Node.js 18 或更高版本和 `jq`；Git 工作流还需要 `git`。
- standalone 安装会启用 `[features] hooks = true`；插件安装依赖 Codex plugin runtime。
- 共享分支 GitHub 状态检查可选依赖 `gh`。
- ShellCheck 是贡献者开发工具，不是插件运行依赖；只有当前项目声明了 ShellCheck lint script（或 `.shellcheckrc`）且找不到二进制时，SessionStart 才会提示。
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
- 17 个 Codex skills，用于复用诊断与项目工作流。

每个选中的 skill 会在同一 shell invocation 内解析并执行 runner，依次验证当前
plugin/repository bundle、manifest-owned standalone deploy，以及已全局安装的固定版本
`agentsmd` CLI package。校验要求 `@sdsrs/agentsmd` package 身份和语义版本有效；plugin metadata 必须与该版本
一致，standalone root 必须匹配 ownership manifest 的 deploy record，CLI root 必须回指
package `bin.agentsmd`。所有路径均不满足时，resolver 会输出 unblock 路径，不会再把未经
验证的 fallback 变成 `MODULE_NOT_FOUND` 堆栈。CLI package fallback 也不会冒充当前
选中的 plugin context。

用户明确要求 commit 并 release/publish 时，会授权指定仓库或包的标准发版流程。未命名的生产环境、live 配置和无关 scope 不在授权范围内。

## 工作方式

| 层 | 作用 | 主要内容 |
|---|---|---|
| 规范 | 定义流程、原生子代理领导契约、授权、证据、安全和报告 | `spec/AGENTS.md`、`spec/AGENTS-extended.md` |
| 原生 hooks | 在六类已注册 Codex 事件中阻断或观察部分可检测模式 | `hooks/*.sh`、`hooks.json` |
| 管理层 | 安装、诊断、恢复、审计和治理 | `scripts/*.js`、`agentsmd` CLI |
| 项目工具 | 生成项目事实、编码约定和设计令牌引用 | `agentsmd init`、`analyze`、`design` |

Stop observers 会把提示放入队列，在下一次 `UserPromptSubmit` 呈现，而不是在 `Stop` 时直接输出。遥测追加到 `$CODEX_HOME/logs/agentsmd.jsonl`。

## 原生 Hook 覆盖

agentsmd 在 `SessionStart`、`PreToolUse`、`PostToolUse`、`UserPromptSubmit`、`Stop` 和 `SessionEnd` 上注册 19 个 hooks。阻断型 hook 只处理边界明确的机械检查；语义规则仍由 agent/operator 负责。

| Hook | Event | 可检测职责 |
|---|---|---|
| `pre-bash-safety-check` | PreToolUse:Bash | 检测直接/间接变量删除、远程下载经复制或移动后执行；提示未固定版本的 `npx` |
| `banned-vocab-check` | PreToolUse:Bash | 阻断 `git commit` 消息中未量化的价值表述 |
| `ship-baseline-check` | PreToolUse:Bash | 已知 CI 基线为红色时阻断推送共享分支 |
| `memory-read-check` | PreToolUse:Bash | ship 前要求读取项目 memory index 与同仓库、经 canonical 校验的关联 memory |
| `secrets-scan` | PreToolUse:Bash | 阻断检测到 secrets 或高置信 secret 文件名的 commit |
| `pre-mutation-journal` | PreToolUse:apply_patch\|Edit\|Write | 记录有界 mutation intent、仓库相对目标及先前的 preflight/plan 观察 |
| `post-tool-journal` | PostToolUse:Bash\|apply_patch\|update_plan | 记录有界 plan、preflight、mutation、validation、review 结果，不保存原始命令或响应 |
| `session-start-check` | SessionStart | 在 startup、resume、clear、compact 时重新注入唯一的完整规范；只有全新 startup 清理旧会话状态 |
| `surface-advisories` | UserPromptSubmit | 呈现上一轮排队的提示 |
| `memory-prompt-hint` | UserPromptSubmit | 呈现与 prompt 匹配的 `MEMORY.md` 条目 |
| `residue-audit` | Stop | 标记 Codex 临时存储中的任务残留增长 |
| `sandbox-disposal-check` | Stop | 标记可能属于任务的 scratch，并排除 runtime-owned 路径 |
| `transcript-structure-scan` | Stop | 从 `last_assistant_message` 检查 §10 报告结构/词汇和 §6 证据锚点；记录 bounded transcript fallback 使用 |
| `convention-cite-scan` | Stop | 从 canonical Stop message 记录有效的 `@conv-*` 项目约定引用，并使用相同的可观测 fallback |
| `session-exit-checkpoint` | Stop | 标记修改后没有 test/lint/typecheck/build 证据的字节 |
| `mem-audit` | Stop | 检查 memory index/file 漂移和 verified header |
| `session-summary` | Stop | 保存滚动强制统计，供 `status` 显式查看；不会注入其他会话 |
| `session-handoff-capture` | Stop | 为同仓库未来的新会话保存私有、脱敏、字节受限的完成态胶囊 |
| `session-handoff-finalize` | SessionEnd | 只封存匹配会话的胶囊，不读取 transcript，也不调用模型 |

## 自动记忆与跨会话连续性

agentsmd 把记忆分成三个互补层，而不是把不同性质的信息都塞进同一个文件：

1. `AGENTS.md` 与经复审的项目 `MEMORY.md` + `memory/*.md` 保存团队共享、
   受版本控制的指令和长期项目经验。
2. [Codex 原生 Memories](https://learn.chatgpt.com/docs/customization/memories)
   提供模型智能层：Codex 判断哪些合格旧会话事实以后有用，对生成字段做脱敏，
   在后台整合，并注入后续会话。原生 Memories 默认关闭；可用 `/memories` 或
   `[features] memories = true` 开启。agentsmd 不会静默替用户改变这项隐私与
   quota 选择。
3. agentsmd 会话交接层随受信任 hooks 自动工作。每次有实质内容且已完成的
   `Stop` 只保存经过脱敏、上限 12 KiB 的 `last_assistant_message`；
   `SessionEnd` 封存该胶囊；同仓库新的 `SessionStart` 最多注入两个最近候选，
   总上下文不超过 6 KiB。

这种分层补上了原生后台记忆的时间窗口。执行 `/new` 时不依赖旧会话先触发
`SessionEnd`：新的 chat 启动前，最后一个已完成 `Stop` 已经留下 checkpoint。
正常 `/exit` 时，Codex 的 `SessionEnd` 会把匹配 checkpoint 标为已封存。如果
进程在一个完整 `Stop` 之前被强杀，就没有已完成的 assistant message 可保存。

仓库身份取自物理 Git common directory，所以同仓库 worktrees 共享交接，不同
仓库互相隔离。并行 chat 没有官方提供的 parent/predecessor ID；因此 agentsmd
明确把恢复内容标为“不可信、按时间排序的候选”，不会声称其中某条一定就是紧邻的
上一会话。胶囊不能授权操作、覆盖当前指令或仓库文件、削弱安全规则、扩大 scope。

交接层不会读取独立的 prompt、tool input、tool output、patch 或 transcript 字段。
原始 session ID 会被哈希；assistant 消息中与当前仓库一致的原始/物理绝对路径会
替换为 `[PROJECT]`。由于保存载荷就是用户可见的 assistant 消息，如果该消息引用了
命令、相对路径或代码，它们仍可能被保留，因此恢复内容始终按不可信输入处理。状态
只保存在本机且按 surface 隔离：plugin 使用
`PLUGIN_DATA/runtime`，standalone 使用
`$CODEX_HOME/.agentsmd-state/runtime`。目录权限为 `0700`、文件为 `0600`，
使用原子替换、高置信 secret 脱敏、30 天过期和每仓库最多 20 条限制；不发起网络
请求，也不调用模型。设置 `DISABLE_SESSION_HANDOFF_HOOK=1` 可同时关闭捕获、
封存和恢复；已有胶囊随后自然过期，或由其所属 surface 的 uninstall 生命周期清理。

## 项目工作流

### 生成项目 `AGENTS.md`

在项目根目录运行：

```bash
agentsmd init
```

`init` 检测 Node、Rust、Python、Go、包管理命令和常见前端技术栈。同一仓库承载多个生态时会报告每个经 manifest 验证的 stack（`Stacks:` 行 + 按运行时标注的命令）；命令只从 manifest/script 事实产生——未声明的测试运行器会被省略，从不猜测。它更新 sentinel 管理块，并保留块外内容。

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

`analyze --gather` 生成有上限、遵循 ignore 规则的源码图,按（顶层目录 × 语言）分层轮询采样,单个大目录不再挤掉多语言仓库的其余部分;超大文件跳过并计数,绝不因此终止采样。AI skill 从中提炼命名、imports、错误处理和注释；`--write --from` 把审核后的结果写入 conventions 管理块。内容超过 6 KiB 预算时，命令会拒绝而不是截断。

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

`design` 预览 CSS `:root` 变量和 Tailwind v4 `@theme` 事实；`design --write` 创建受管理的 `DESIGN.md` 块及 `AGENTS.md` 指针。非前端项目是 no-op。Tailwind v3 配置对象会被识别，但尚不解析。同一 token 跨文件定义值冲突时报告为 ambiguous 并列出每个候选的来源与选择器——生效值取决于静态扫描看不到的 CSS import 顺序，因此从不猜测；按选择器区分的主题变体（如 `:root[data-theme="dark"]`）逐上下文报告。

### 按变更文件选择验证

```bash
agentsmd verify --changed --explain
agentsmd verify --since=HEAD~1 --explain --json
agentsmd verify --changed
agentsmd verify --full
```

`verify` 读取版本化的 `qa/validation-map.json`，合并所有变更路径所需的
检查、去重，并解释每个选择原因。共享、导出、配置、未知和 release
surface 会自动扩大到 `npm run check`；release 路径不能移除 full gate。
未知路径即使完成 full gate，仍会保留明确的未覆盖风险。真实外部服务
canary 和 AUTH boundary 操作只报告，路由器不会执行。本地检查按
targeted 优先运行，第一个失败会阻止后续更宽的检查。

自动化输入和结果使用 `schemas/task-contract.schema.json` 与
`schemas/task-evidence.schema.json` 中有界的 JSON Schema。
`status=done` 的 evidence 若没有“最后一次变更之后成功”的检查记录，
就无法通过验证。人类输出从验证后的 evidence 按
`Done → Not done → Failed → Uncertain` 渲染，不会再从文本反向猜 JSON。

### 统一质量 scorecard 与 canary

```bash
agentsmd scorecard --days=30
agentsmd scorecard --days=30 --json
agentsmd scorecard --compare=scorecard-previous.json
agentsmd scorecard --conformance-candidate=candidate.json --conformance-binding=binding.json
agentsmd scorecard --outcomes=/absolute/path/to/agentsmd-outcomes.json
agentsmd outcomes list --days=30 --json
agentsmd outcomes review --event=EVENT_ID --outcome=false-block --reason=benign-action-confirmed
```

版本化 scorecard v2 通过每个 session 一条有界 `session-dimension` 记录关联现场
遥测，分开呈现 `self`、`test`、`qa`、`external` 与 `unknown` 来源，并汇总
health、runtime compatibility、完整 conformance 新鲜度、false-block 测量状态、
bypass、evidence discipline、performance、memory engagement、prompt budget、
automation、operator actions 与 measurement limits。它不会自动升降级规则：
raw hit 不代表规则价值，no-opportunity 不是成功，memory citation 不等于
adherence，sampling calibration 只是结构 proxy；没有人工审核 outcome 时，
现场 false-block rate 保持 `unmeasured`。新的 `block`/`deny` 行带不包含项目、会话或
命令内容的 correlation ID；没有 ID 的 legacy 行明确计为 unmeasurable，不按秒级
时间戳猜测关联。`outcomes list` 只呈现有界事件摘要，`outcomes review` 追加明确的
私有 revision，不改写原始遥测。现场 rate 的分母严格等于已审核 external
`true-block` 加 `false-block`；self、test、QA、unknown、unreviewed 与 unmeasurable
都会单独报告但不进入分母。测量状态只能是 `no-opportunity`、`unmeasured`、
`partial`、`measured` 或 `invalid`，不会把缺失证据推断成零。scorecard 还会把
全部 fail-open 原因归入 dependency/input missing、timeout、parse error 或 other，
同时保留 `audit` 中的精确原因。health 会记录调用根目录、Codex home，
以及 status/doctor 证据来自 runtime filesystem 还是 supplied fixture。prompt-budget
source 会区分 measured、empty、missing、invalid 与 unavailable；未解析的字节保持
`null`，汇总状态只能是 `measured`、`partial`、`unavailable` 或 `over-budget`，
因此受限 filesystem 不能再用隐藏输入制造绿色 headroom。

conformance freshness 也有严格的身份边界。只有完整 capture 中的 source
commit、tracked-clean 标记、cases hash 与 thresholds hash 都匹配当前源码树时，
结果才是 `fresh`。分发包会在 `qa/conformance/releases/` 携带有界、通过 schema
校验的 release evidence，因此 installed scorecard 无需读取原始 transcript 或任意
evidence 路径，也能呈现精确的历史发布结果与 waiver。historical 或 mismatch
证据不会变成 current-tree green；没有证据时会先建议配置或导入有界证据来源，
而不是无条件再次消耗模型调用。

新版本使用两阶段协议。发布前 candidate attestation 绑定 clean source commit/tree、
确定性的 standalone deploy-tree hash、package/version、conformance 输入、有限的运行
摘要与 decision；发布后 binding 再绑定 candidate 的精确字节，并校验 GitHub Release
与 npm tarball 字节相同，以及 npm SLSA subject、tag/ref、workflow 与 release commit
一致。只有 candidate 时 provenance 显示为 `local-candidate`，不能当作已发布证明；
匹配 binding 后显示为 `published-binding`。外部输入必须是有界、非符号链接的普通
文件；scorecard 不会隐式访问网络，离线或缺失证据保持 unavailable/historical。
旧版 package 中的 v1 record 继续作为历史证据读取。
离线 binding 校验的是 byte/hash 与已解码 SLSA payload 的一致性；release closure
仍须从声明的 release/registry 来源取得这些输入，并单独执行 npm signature/Sigstore
真实性 gate。

release closure 可用以下入口检查旧生成器和两个新阶段：

```bash
node scripts/conformance-evidence.js --help
npm run conformance:candidate -- --help
npm run conformance:binding -- --help
```

candidate 生成器只接受常规、非符号链接的
`docs/qa-captures/**/conformance-*/results.json`，输出 hashes、聚合后的
runtime/model/result/threshold/waiver provenance，并拒绝 dirty source 或覆盖内容不同
的同版本 record。binding 生成器显式读取 candidate、release tarball、registry
tarball 与 SLSA provenance 文件；byte substitution、source-tree mismatch、version
replay、provenance ref/workflow/commit mismatch、时间顺序错误和不同字节覆盖都会被拒绝。

`--compare` 只接受有界、非符号链接、常规文件形式的 scorecard v2 JSON。v1 capture
没有 measurement provenance，无法通过猜测安全升级，因此会被明确拒绝。
`automation/` 中分发每周 pinned/latest runtime canary、治理复审、report-only
release readiness 与只读 PR review 配方。定时 runtime matrix 使用隔离
`CODEX_HOME`、positive + near-negative 确定性评分、5-run 信息性性能趋势和
可保留的机器可读失败证据。pinned 失败是 release-blocking 证据；latest 失败
只生成 compatibility report。仓库 workflow 不会据此自动修改规则或获得
ship 授权。

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
| `verify` | 解释并运行变更感知的本地验证；只报告真实外部服务与 AUTH boundary |
| `scorecard` | 汇总有界的 health、compatibility、quality、performance、automation 与 measurement-limit 证据 |
| `outcomes` | 列出有界的阻断事件摘要，并追加明确、私有的 true/false/unmeasurable 评审 revision |

运行 `agentsmd --help` 查看当前选项。除 `init`、`analyze`、`design`、`exception`、`verify` 作用于当前项目外，其余命令都遵循 `$CODEX_HOME`。

## 更新、验证与卸载

### Codex 插件

```bash
# 更新
codex plugin marketplace upgrade agentsmd --json
codex plugin add agentsmd --marketplace agentsmd --json

# 卸载——趁工具还在，先请求清理 plugin 私有状态
AGENTSMD_PLUGIN_VERSION="$(codex plugin list --json | jq -er '.installed[] | select(.pluginId == "agentsmd@agentsmd") | .version')"
node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/agentsmd/agentsmd/$AGENTSMD_PLUGIN_VERSION/scripts/uninstall.js" --plugin-state-only
codex plugin remove agentsmd --marketplace agentsmd --json
codex plugin marketplace remove agentsmd --json
```

插件更新后新开一个 Codex 会话，并重新审查发生变化的 hook 命令。

卸载有先后顺序，因为 `codex plugin remove` 会连同打包清理工具一起删除 plugin cache。
先运行该工具：当 `PLUGIN_DATA`（或兼容变量）可用时，`--plugin-state-only` 只删除该
plugin 私有 `runtime` 目录中的白名单文件；未知文件、符号链接、所有旧共享状态、并存的
standalone 安装以及 `$CODEX_HOME/logs/agentsmd.jsonl` 都会保留。若拿不到 plugin data 路径，
工具会报告 `stateCleanupSkipped: "plugin-data-unavailable"`，且不会修改共享状态。
迁移期旧 ephemeral 记录仍可读取，并按原有有界保留策略自然过期；不要递归删除
`.agentsmd-state`，其中包含共享协调数据，也可能包含其他 tenant 的文件。

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
skill 从 selected bundle 解析的 `AGENTSMD_PLUGIN_ROOT`；versioned CLI fallback
会刻意保持该兼容变量未设置。CLI 不扫描 plugin cache，因为 cache 中存在
artifact 不代表 Codex 已启用它。有 context 时，`surfaceArbitration` 会给出两面
版本、健康证据、赢家、稳定 reason code，以及静态协作协议是否支持 exclusive
execution。该字段不是 runtime exact-once 证明，真实 Codex E2E 仍是独立 Gate。
仲裁不是信任边界；在实现不可变 artifact provenance 前，plugin integrity 仅为
structural。
为了 JSON 兼容，顶层旧字段 `dualSurface` 仍表示 manifest 是否同时存在；无
manifest 的 partial footprint 会出现在 `surfaceArbitration.candidates.standalone`。
doctor 的旧 `surface` 仍表示诊断调用 context，逻辑赢家使用 `selectedSurface`。

## 安全、所有权与共存

standalone 安装使用 manifest ownership 和 marker scope。它保留其他 hook tenant 与 agentsmd 管理块外的用户内容；修改前验证 owned artifact；遇到不可解析的共享文件、symlink 共享逻辑路径或 hash 不匹配的 owned file 时拒绝操作。安装与卸载使用 staged changes、snapshot checks、写入时 CAS 和 rollback；不协作的外部写入者会导致操作拒绝，而不是静默覆盖已变化的共享文件。

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

卸载会移除已注册 hooks、skills、受管理的 `AGENTS.md` 块、已知 runtime state、extended spec，以及安装时自己添加的状态栏预置——你之后自定义过的状态栏会原样保留。它保留恢复备份、未知状态、遥测、已审核 outcomes、已启用的 hook 开关（移除它可能破坏其他租户的 hooks），以及当前会话可能仍需要的未注册 no-op shims。

agentsmd 会保留其他 tenant 的 hook 条目和 sentinel 块外的全局 guidance，但不再有
任何 OMX 专用 profile 选择或运行时依赖。完整规范内建 Codex 原生子代理契约：
默认单代理；只委派独立、有边界的任务；明确 child ownership；leader 负责集成、
冲突解决与最终验证；依赖任务串行；禁止递归编排；禁止伪造 role、pointer 或 authority state。

从 `codexmd` v1.4.0–v1.4.3 升级时，standalone 安装器只迁移 legacy provenance 可验证的 artifact。项目在 v2.0.0 更名为 agentsmd。

## 治理与遥测

```bash
agentsmd audit --days=30
node scripts/audit.js --project=X
node scripts/audit.js --days=90 --trend
agentsmd rules --days=30
agentsmd sparkline --windows=6 --bucket-days=7
agentsmd scorecard --days=30
agentsmd outcomes list --days=30
```

只有在积累足够 rule-specific evaluated opportunities 后仍为零 enforcement hits，规则才进入降级候选。`--project` 对 rules 仅作信息透镜；降级信号仍跨项目。`no-opportunity`、低评估量和全局 session 数都不是降级证据。高命中只表示活跃，不代表正确。最终由 operator 依据 [`spec/OPERATOR.md`](./spec/OPERATOR.md) 决策。

`rules` 另有 **bypass governance**：对每条带 escape-hatch token 的规则，报告 token 被用来跳过拦截的比例，以及这些跳过来自多少个不同 session。比例偏高只是复核提示，且有两种相反的解法——规则过度触发，或闸门被习惯性绕过——报告不替你选。`audit --trend` 把窗口切成等长时间桶并按每百 session 归一，让纪律指标的走向可见，而不只有当前快照；桶按时间划分，不按 spec 版本。

scorecard 在不改变上述语义的前提下组合信号。只有 operator 对精确事件完成
审核后，outcome 才进入现场 false-block rate；缺失、legacy、self、test、QA、
unknown 和 unmeasurable 证据都不进入分母。runtime、model、surface、spec
和 agentsmd 版本由 SessionStart 去重维度记录提供，并通过 `session_id`
关联；缺少该记录的旧 session 仍明确显示为 missing join。历史绿色 capture
超过 freshness window 后，不会被当成当前树的新鲜证据。

## 安全与隐私

漏洞报告渠道与响应目标、支持版本、威胁模型、遥测/评审 schema、保留、删除和退出方式见 [`SECURITY.md`](./SECURITY.md)。一段话版本：agentsmd 是**fail-open 的编码纪律层，不是安全边界**；遥测和人工评审 outcome 都只保存在本地（`~/.codex/logs/agentsmd.jsonl` 与 `agentsmd-outcomes.json`，私有文件权限和有界存储，`DISABLE_RULE_HITS_LOG=1` 停止新增遥测，删除两组数据才能完全抹除）。双面安装提示：skills 的加载不经 surface 仲裁，plugin 与 standalone 同装会导致会话内 skills 重复——只装一面；`doctor` 会标红双面状态。

## 开发

运行 shell lint 前先安装 ShellCheck。Ubuntu/Debian：

```bash
sudo apt-get update && sudo apt-get install -y shellcheck
shellcheck --version
```

macOS 使用 `brew install shellcheck`；Fedora/RHEL 使用
`sudo dnf install -y shellcheck`；Arch 使用
`sudo pacman -S --needed shellcheck`。

```bash
npm test
npm --prefix /path/to/agentsmd run lint:shell
npm run spec:check
```

`spec/AGENTS.md` 是生成产物。修改
`spec/source/` 下按顺序组合的 canonical fragments 后运行
`npm run spec:generate`；`npm run spec:check` 是只读 drift gate。
发布版本同步器会先更新 canonical profile header，再从 source layout
重新生成该产物。

测试覆盖安装隔离、插件分发、hook wiring、drift、遥测、诊断、项目工作流和 shell smoke fixtures。设计边界见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)，版本记录见 [`CHANGELOG.md`](./CHANGELOG.md)。

```text
bin/          npm CLI dispatcher
spec/         canonical source、生成后的 cores、extended spec、rule manifest
hooks/        原生 hooks、共享 shell libraries、smoke tests
scripts/      生命周期、诊断、治理、项目工具、测试
skills/       17 个 Codex skill routers
automation/   随包分发的只读/定时工作流配方
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

### agentsmd 依赖编排插件吗？

不依赖。完整 profile 已包含有边界的 Codex 原生子代理领导契约；存在其他 tenant
时也会保留无关内容。

### agentsmd 会取代人工复审吗？

不会。Hooks 只覆盖部分可检测模式。语义授权、正确性以及规则升降级仍由 agent/operator 基于证据判断。

## 许可

MIT
