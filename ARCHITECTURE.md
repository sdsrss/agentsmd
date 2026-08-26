# agentsmd — Architecture & Build Plan

Codex 版编程全局规范**系统**（不只是一份规范文本）的架构设计与分阶段实施记录。本文只把仓库 wiring、fixture 和测试能验证的行为写成产品事实；外部运行时能力需由对应官方契约或实机证据支持。

---

## 1. 为什么需要「系统」而不只是「一份 AGENTS.md」

`spec/AGENTS.md` 的完整 core 覆盖 SPINE、原生子代理领导契约、授权、证据、安全和
路由等每轮约束；展开流程放在按需加载的 extended。系统只发布一个 full profile，
避免由外部 marker、session pointer 或其他编排运行时改变纪律与验证强度。

完整 core 的可编辑 source 位于 `spec/source/`：layout 显式排列 fragments，
generator 仅做 Buffer 拼接，不 trim、不补换行。`spec/AGENTS.md` 是随包发布的
生成产物；只读 `spec:check` 约束 source/artifact drift，`spec:generate` 负责
显式再生。版本同步先修改 source header，再由 layout 生成产物。

主要风险是 discovery 预算被 core 占用，以及规则存在但没有对应执行或测量机会。三层加载、选择性 hook 和机会/结果遥测分别约束上下文占用、可检测行为和治理证据；零命中本身不证明规则无价值。

因此本系统把「规则文本」「可检测执行」「机会与结果」连到同一条审计链；数据是 operator 复审输入，不自动证明规则价值或触发 prompt 变更。

---

## 2. 三层架构（claudemd 形态 → Codex 适配）

```
bin/        npm CLI 入口  bin/agentsmd.js（Node）：`agentsmd <cmd>` / `npx --package @sdsrs/agentsmd agentsmd <cmd>`
              —— 薄 dispatcher，spawn（而非 import）对应 L2 脚本，透传参数/输出/退出码；不属于三层，不引入 L1↔L2 耦合
L3  命令层    17 个 Codex skills（dir + SKILL.md）：init / analyze / design / audit / doctor / rules / status / restore / verify / scorecard / perf 等
              —— stub，告诉 agent 去跑对应的 L2 脚本
L2  管理脚本  scripts/*.js（Node）：install / uninstall / repair / status / audit / doctor / rules / migrate / init / analyze / design / diagnostics
              —— 处理安装、scoped merge/remove、遥测聚合与治理信号
L1  强制层    hooks/*.sh（bash，fail-open，3-8s timeout）：由 Codex harness 在 6 个已注册事件调用
              —— 确定性强制：阻断危险 Bash、扫 banned-vocab、注入 MEMORY 提示、会话引导
```

**层间隔离不变式**：L1 永不 import L2；hook 异常时 fail-open，管理命令仍可独立运行。npm CLI 入口 `bin/agentsmd.js` 通过 spawn 子进程调用 L2 脚本。

**唯一豁免（spawn-with-fail-open）**：`hooks/session-start-check.sh` 以子进程方式 spawn `scripts/lib/surface-arbitration.js` 读取 surface 仲裁结果。它不是 import——三重防护（`command -v node`、文件可读探测、`platform_timeout`）保证缺失或超时只让 banner 变短，永不阻断用户，因此符合“L1 不依赖 L2 可用性”这一不变式的实质。豁免范围到此为止：`drift.test.js` 断言引用 `scripts/` 的 hook 集合恰好等于这一个文件，并断言这三重防护仍在——新增第二处会让 CI 变红。共享 hook merge 只删除当前 install path 标识的 agentsmd command hook，再保留其他 hook object 并追加本版本条目。

**命令层为何使用 skills**：仓库把 `dir + SKILL.md(name+description frontmatter)` 作为命令元数据，并让每个 skill 路由到一个 L2 脚本；触发边界与 progressive disclosure 见 `spec/AGENTS-extended.md §E9`。runner resolver 与命令必须在同一 shell invocation 中执行，并只接受身份和版本匹配的 selected bundle、manifest deploy record 匹配的 standalone，或 package `bin.agentsmd` 匹配的 versioned CLI root；无可读 root 时输出结构化诊断并停止，CLI fallback 不导出 plugin context。

---

## 3. Codex hook 契约（仓库当前可验证范围）

这是强制层的地基。仓库测试只把已部署 wiring、stdin fixture 和 block/context 输出当作可验证契约；未被当前官方文档或本地运行验证的能力不写成产品事实。

| 维度 | 来源形态 | agentsmd repository model | 验证边界 |
|---|---|---|---|
| 启用 | standalone config | `[features] hooks = true`；旧 `codex_hooks` 由 installer 迁移 | doctor 检查 deployed flag |
| 注册 | repository manifests | standalone 使用 `~/.codex/hooks.json` scoped merge/remove | drift 校验两份 wiring |
| 事件 | official contract + manifest keys | documented 11 个；validated 5 个；agentsmd registered 6 个 | 三组元数据不互相冒充 |
| 条目形状 | JSON wiring | `type/command/timeout`；产生 context 的 handler 另有 `additionalContextLimit` | JSON/drift test |
| matcher | JSON wiring | `Bash`、`*`、`startup\|resume\|clear\|compact` | JSON/drift test |
| stdin | official contract + fixture | common fields + event-specific `turn_id/tool_use_id/last_assistant_message/...` | versioned synthetic fixture |
| 阻断输出 | smoke assertion | canonical `permissionDecision:deny` + legacy `decision:block` compatibility fields | positive / near-negative |
| 注入 context | smoke assertion | `hookSpecificOutput.additionalContext` | synthetic fixture contract |
| Stop message | official contract + parity fixture | `last_assistant_message` canonical；bounded transcript compatibility fallback | fallback telemetry |
| SessionEnd | official contract + fixture | `reason:"other"`；advisory only；最长 3 秒；不读取 transcript、不调用模型 | synthetic fixture；尚不冒充真实 runtime validation |

证据锚点：`spec/hard-rules.json`、`qa/hook-contract-fixtures.json`、
`hooks.json`、`hooks/hooks.json`、`scripts/lib/hook-registry.js`、
`scripts/tests/hook-contract.test.js` 与 `hooks/tests/smoke.sh`。这些证明仓库模型
内部一致；`validated_codex_versions` 只记录真实验证过的 runtime，不能从 fixture
外推其他版本。官方同时明确 `transcript_path` 指向的格式不是稳定 Hook 接口，所以
消息扫描优先使用 `last_assistant_message`，fallback 每次写
`event:"compat-fallback"`。

**跨会话记忆分层**：Codex native Memories 是 opt-in 的模型智能层，负责在后台从
eligible chats 选择、脱敏和整合长期事实；agentsmd 不静默开启它。agentsmd 自己的
deterministic handoff 解决时间窗口：每个有实质完成内容的 Stop 只保存 bounded、
redacted `last_assistant_message`，SessionEnd 只把匹配胶囊标记 finalized，新的
same-repository startup 最多恢复两个候选。`/new` 不依赖旧 chat 先触发
SessionEnd；`/exit` 正常关闭时由 SessionEnd 补最终状态。并行 chat 没有 documented
predecessor ID，所以恢复内容始终标成 untrusted recency candidates，不能充当 AUTH、
当前指令、代码事实或安全规则。

`PostToolUse` 的 validated 状态来自 Codex 0.145.0 项目级真实 canary：
`qa/event-journal-runtime-canary.js` 使用临时 repo、一次性 hook-trust bypass 和
隔离 hook state，确定性核对 mutation intent/completion、其后的成功 validation、
Stop native consumer、privacy allowlist 与零 unvalidated flag；capture 只证明记录
的 runtime/model/surface 组合。

Phase 4 的 `qa/runtime-canary.js` 在这条单场景证据之上增加 pinned/latest
matrix、positive/near-negative 双场景、隔离 install/status/doctor、结构
contract 与 5-run 信息性性能趋势。每个 Codex 场景使用自己的临时
`CODEX_HOME`；失败也必须生成 versioned JSON。pinned 失败标记 release
blocking，latest 失败只改变 compatibility report，不自动改 supported
baseline。`.github/workflows/runtime-canary.yml` 提供固定周节奏。

**两段式路径解析**：plugin manifest 使用官方 `${PLUGIN_ROOT}`（旧运行时回退
`${CLAUDE_PLUGIN_ROOT}`）仅用于定位入口脚本；两者都缺失时 launcher 以 0
退出，避免空路径变成 `/hooks/...` 并触发 code 127。脚本启动后使用同一优先级，并用
`${BASH_SOURCE[0]}`/`__dirname` 自推 support、spec 与管理脚本路径。Standalone
manifest 仍写入绝对 hook 路径，不依赖 plugin runtime 变量。

---

## 4. 闭环数据面（spec → hook → 遥测 → operator review）

这条链把 rule-specific opportunity、detector outcome 与 manifest 对齐，避免用无关 session 或 raw hit count 直接下治理结论：

```
spec/AGENTS*.md 的 (HARD) 规则
  └─ spec/hard-rules.json           机器可读镜像（每条规则的 section_anchor + enforcement + codex_hook_event）
      └─ hooks/*.sh + hooks/lib/*.sh 强制/支撑  命中/阻断/fail-open 时 hook_record
          └─ ~/.codex/logs/agentsmd.jsonl   append-only 遥测（规则行 + 每 session 一条 version/surface/model 维度）
              └─ scripts/audit.js    bySection 聚合
                  ├─ 治理信号         rule-specific opportunity + outcome → operator review
                  └─ scorecard        session_id join + provenance split + freshness/measurement limits
```

- 遥测写入器移植 claudemd `hooks/lib/rule-hits.sh`：改日志路径 `~/.claude/logs/claudemd.jsonl` → `~/.codex/logs/agentsmd.jsonl`，project 字段编码沿用 `tr -c 'a-zA-Z0-9-' '-'`，保留 size-capped rotation。
- manifest 的反向 drift gate 同时核对显式 HARD/MUST 行和 §8 Never 子句；`operational_sections` 单独声明 `§hooks-fail-open` 这类非规范规则的运行遥测。
- **离线兜底**（Codex 特有优势）：`codex exec` 可无交互跑，为「离线扫历史会话产出命中率」提供一条 CI/定时路径——即 `agentsmd.txt` 设想的「试运行拿稀释度信号」，无需实时 hook 也能取数。
- `hard-rules.json` 的 `last_demote_review` 现为 `null`（部署前无字段数据）；首批遥测落地后由 OPERATOR 按节奏回填。

---

## 5. 单一安装面与生命周期隔离（HARD 不变式）

agentsmd 不依赖任何外部编排插件。共享文件中的 hook 按当前
`CODEX_HOME/agentsmd` 命令路径识别；独立 deploy、extended spec 和 skills
由 manifest 的 exact path + content hash 证明所有权。所有 standalone artifact
在 mutation 前完成 preflight，无法证明所有权时中止。其他 tenant 只作为块外
guidance 或非 agentsmd hook 条目保留，不参与 profile 选择。

**装卸语义**：
- **安装/更新 = stage + preflight + transaction**：先构建完整 release tree 并验证既有 manifest ownership，再更新共享文件和 live tree；注入失败时用快照条件检查回滚，拒绝覆盖在最终文件系统操作前已观察到的事务外写入。
- **卸载 = preflight + transaction**：先验证全部 manifest-owned artifact，任一冲突都零 mutation；通过后 quarantine owned tree 并更新共享文件，失败时以快照条件检查回滚。可移植 POSIX 不提供原子 compare-and-replace，因此 check 到 rename/unlink 之间的非协作写入仍是明确边界。
- **共享路径类型 = regular-or-absent**：`hooks.json`、`config.toml`、`AGENTS.md` 任一为 symlink 时，install/update/uninstall/restore/repair 在取得锁和处理 pending journal 前零 mutation 拒绝；原子 write/unlink 在 commit 边界再次检查，防止把链接 inode 替换为普通文件或删除链接。生命周期不自动 `realpath` 后写入任意外部目标。
- **修复 = read-only plan + digest-bound confirm**：只对 valid exact-path manifest 下“缺失而未修改”且 source version/deploy digest 与 manifest 完全一致的 owned artifact 开放 apply；确认时重算 source/live/shared descriptor，创建包含 deploy、skills、extended、manifest 和 3 个共享文件的 pre-repair snapshot，再复用 install transaction。修改、额外文件、manifest-less partial、artifact 不匹配或摘要漂移均拒绝写入。
- **双面仲裁 = health first + SemVer precedence**：`surface-arbitration.js` 对 standalone 验证 exact-path manifest、单次 deploy inventory/hash、extended/skills hash、live wiring 的 event/matcher/command/timeout/order/context limit、由隔离临时 home 中 Codex CLI 验证的 `config.toml`、`features.hooks`、required support，以及实际 discovery head 的 core 字节 identity；对 plugin 拒绝越界 symlink，并验证 manifest/package/core/extended 版本及 19 条 wiring/support/order/context limit。仅健康候选参与 SemVer precedence（无界十进制字符串比较，build metadata 不参与），同 precedence 时 standalone 确定性胜出。plugin context 按 `PLUGIN_ROOT` → `CLAUDE_PLUGIN_ROOT` → skill 解析出的 `AGENTSMD_PLUGIN_ROOT` 选择；冲突 fail closed，且不扫描 cache。结果区分逻辑赢家与静态 `exclusive` 协作条件：protocol-v1 且两份 hook 都获得 plugin context 时 loser 可退出；该字段不是 runtime exact-once 证明。legacy standalone 已注册命令和预加载 global core 无法由新 plugin 单方面移除，doctor 必须保持 degraded，最终优先级留给真实 Codex E2E。
- **运行激活证据与结构健康分离**：plugin SessionStart 仅在 plugin surface 被仲裁选中且 packaged spec 成功加载后，原子写入 `$PLUGIN_DATA/runtime/activation.json`（兼容 `$CLAUDE_PLUGIN_DATA`），目录/文件权限分别为 `0700`/`0600`。receipt 记录版本、session、时间、profile、选择原因与 extended 路径；status/doctor 的 `observed` 只证明 SessionStart handler 已选择并准备返回该 profile，不证明 Codex host 已接纳响应，也不外推为全部 hooks trusted/enforced。缺失 receipt 是 `unverified` 信息态，不改变既有 doctor 退出语义。
- **短生命周期状态按物理 surface 隔离**：hook 复用 `${BASH_SOURCE[0]}` 的物理路径判定；plugin 新写入 `$PLUGIN_DATA/runtime`（兼容 `$CLAUDE_PLUGIN_DATA`），standalone 新写入 `$CODEX_HOME/.agentsmd-state/runtime`，未知/source-tree 或缺少 plugin data 的环境保留 legacy shared-root fail-open。reader 按 private→legacy 双读，writer 只写 private，旧文件不批量移动或推断归属。handoff 文件由 Git common-dir hash + session hash 精确命名，目录/文件分别为 `0700`/`0600`，atomic replace，30 天及每仓库 20 条上限；不读取独立 prompt/tool-input/tool-output/patch/transcript 字段，raw session ID 被 hash，assistant message 中匹配当前仓库的 raw/physical absolute path 被替换。assistant 自己引用的 command、relative path 或 code 仍可能随用户可见消息保存，因此恢复内容始终 untrusted。manifest、`arbitration-cache.json` 和 telemetry 继续共享；plugin-state-only cleanup 只对白名单 private regular file/queue 生效，保留 shared、unknown 与 symlink。
- **阻止新双面，而不破坏旧面更新**：仅在 npm CLI 能证明不存在 standalone manifest、注册 hook、AGENTS sentinel、extended 文件、非 shim deploy、待迁移 `codexmd` surface 或本包同名 global skill 的 fresh install 前，使用 `codex plugin list --json` 精确检查 `installed===true`、`enabled===true` 的 `agentsmd@agentsmd`。命中时以 exit 1、零修改拒绝，明确要求移除 plugin 后重试；CLI 不可用、schema/字段不认识、disabled/近似名称均不伪造命中；已有 standalone 继续 update，manifest-less/legacy/skill partial 则进入既有 migration、ownership fail-closed 或 repair 诊断。没有双面 opt-in。
- 天然处理目标文件不存在与存在其他 tenant 两种边界：从 `{}` 起创建自己的内容；其他条目原样保留。
- 安装器把 deploy、extended spec、skills 的 exact path + hash，以及共享面变更结果写入 agentsmd **自有** manifest `~/.codex/.agentsmd-state/manifest.json`；共享配置仍由 hook path/sentinel 识别。
- standalone schema-v2 manifest 声明 `surfaceProtocolVersion: 2` 并保留全部
  v1 ownership 字段；plugin manifest 当前仍声明 `surfaceProtocolVersion: 1`。
  full + extended bundle 由健康检查证明；旧双面状态仍不能宣称 exact-once。

**每个共享面的隔离策略**：

| 共享面 | agentsmd 隔离方式 | 空白环境 |
|---|---|---|
| `~/.codex/hooks.json` | 标记式 merge/remove（上）；只增删自己 | 不存在则创建，只含自己的条目 |
| `config.toml [features] hooks` | 缺失则 append `true`（0.142+；旧 `codex_hooks` 迁移为新名；保留其余配置）；**卸载不删**（留着无害；删了可能断其他 tenant 的 hook） | 自己设 `true`，卸载留存 |
| `config.toml [tui] status_line` | 若缺失则补 Codex built-in footer preset；已有用户值逐字保留；**卸载回退我们写入的 preset**（manifest `statusLineAddedByUs` + 当前值仍逐字等于 preset 才删；用户改过则保留），install 若同时创建了空的 `[tui]` 表头也一并撤回 | 自己设 preset，卸载按同一双重判据回退 |
| `~/.codex/AGENTS.md`（规范部署） | sentinel 托管块 `# >>> agentsmd >>> … # <<< agentsmd <<<`，块外内容逐字保留；卸载只删块 | 不存在则创建，只含自己的块 |
| MCP servers | 强制层不加 MCP（遥测是本地 jsonl）；未来若加，用 `agentsmd_*` 键 | 无影响 |
| skills（命令层） | manifest exact path + tree hash；前缀不是 ownership 证据 | 无影响 |
| state / log | manifest/cache/telemetry 共享；plugin 与 standalone ephemeral runtime 分面；legacy 双读不搬迁；backups、unknown、symlink 与 telemetry 保留 | 无碰撞 |

**打包形态**：仓库提供 `.codex-plugin/plugin.json`、顶层 `hooks.json` 和 standalone `scripts/install.js`。`.agents/plugins/marketplace.json` 固定指向已发布的 `@sdsrs/agentsmd` npm artifact；npm 包排除源码测试目录。plugin surface 的装配由 Codex plugin runtime 管理；standalone surface 使用本节的 manifest-backed transaction。两套 surface 分开卸载。

**定位**：agentsmd 是纪律、执行与证据层。它吸收适合 Codex 原生子代理的最小
编排契约，但不引入 tmux、leader-proof、session pointer 或 Stop 授权状态机。

> ⚠️ 触碰 `~/.codex/hooks.json` / `config.toml` / `AGENTS.md` = `spec/AGENTS.md §5` hard-AUTH 面。**本仓库内开发全程不改动 live `~/.codex`**；首次真正安装（Phase 3）前单独 re-AUTH。

---

## 6. 三层加载（对应 Codex discovery）

| Tier | 文件 | 何时加载 | 内容 |
|---|---|---|---|
| 0 full | `spec/AGENTS.md` → standalone 部署到 discovery；plugin 始终注入同一 profile | 每轮 / SessionStart rehydration | 完整 per-turn gates（SPINE/原生子代理/LEVEL/AUTH/VALIDATE/SAFETY） |
| 1 triggered | `spec/AGENTS-extended.md`（不在 discovery 链，零预算） | L3/ship/Override/three-strike 时 agent 显式 `cat` | 条件规则（Override 模式/L3 flow/ship 清单/证据阶梯） |
| 2 keyword | `MEMORY.md` + `memory/*.md` | 关键词/路径命中 | 召回式（feedback_/project_/reference_） |
| local intelligent | Codex native Memories（opt-in） | runtime 后台生成、后续 chat 注入 | 模型选择的机器本地长期事实；agentsmd 不代替用户开启 |
| local handoff | surface-private `session-handoff-*.json` | substantial Stop → SessionEnd finalize → fresh SessionStart restore | bounded、redacted、同仓库的近期完成态连续性 |
| operator | `spec/OPERATOR.md`（Phase 4） | 永不自动加载 | 人类维护者的升降级节奏，不占 agent 注意力 |

Codex discovery 链共享 `project_doc_max_bytes`（默认 32 KiB）且超限静默截断。core
由 drift gate 限制在 ≤16 KiB，sentinel-wrapped 实际部署另有“至少保留一半默认预算”
测试；展开流程放入 triggered extended。

---

## 7. 仓库布局

```
agentsmd/
  spec/                      正典（tracked；已脱离被 gitignore 的 docs/）
    AGENTS.md                core（Tier 0）
    AGENTS-extended.md       extended（Tier 1）
    AGENTS-CHANGELOG.md      单一 changelog（core+extended 共版本）
    hard-rules.json          ✅ HARD 规则机器可读清单（本 Phase 已建）
    OPERATOR.md              (Phase 4) 人类维护者手册
  hooks/                     L1 强制层（Phase 1-2）
    hooks.json               agentsmd 的 hook 条目（供安装器 append 进 ~/.codex/hooks.json）
    lib/{hook-common,rule-hits,platform}.sh
    *.sh
  scripts/                   L2 管理脚本（含 install/uninstall/repair/verify）
  schemas/                   task/evidence、scorecard、conformance release evidence、runtime-canary 的有界 JSON Schema
  qa/validation-map.json     路径→风险→检查的机器可读验证映射
  qa/runtime-canary.js       pinned/latest 隔离 canary 与机器可读证据
  automation/                weekly canary/governance、readiness、PR review recipes
  skills/                    L3 命令层，17 个 agentsmd-* Codex skills
  ARCHITECTURE.md            ✅ 本文件
  docs/                      设计笔记（gitignored scratch：agentsmd.txt 等）
  tasks/                     机器本地工作状态（agentsmd-build.md）
```

---

## 8. 分阶段实施计划（每阶段 checkpoint）

| Phase | 交付 | 触及 live ~/.codex? | 状态 |
|---|---|---|---|
| **0** | 研究 + 结构 + 设计：本文件 · `hard-rules.json` · `spec/` 就位 · 任务文件 | 否 | ✅ 本会话 |
| **1** | hook 地基：实测 2 协议细节 → `hooks/lib/*.sh` Codex 适配 → 首批 3 hook（pre-bash-safety 阻断 / banned-vocab / session-start） | 否（仓库内 + 沙箱测试） | ✅ 已完成 |
| **2** | 其余 hooks 移植（ship-baseline/memory-read/residue/sandbox-disposal/transcript-structure-scan/mem-audit/memory-prompt-hint） | 否 | ✅ 已完成 |
| **3** | L2 脚本（install/status/audit/doctor/rules）+ **标记式 merge/remove 安装器**（§5，只增删 `/agentsmd/` 自有条目）+ 自有 manifest + kill-switch；首次 **re-AUTH** 触碰 live hooks.json/config.toml/AGENTS.md | 是（re-AUTH） | ✅ 已完成 |
| **4** | 遥测闭环 + `OPERATOR.md` + 命令层 skills | 是（re-AUTH） | ✅ 已完成 |
| **5** | 标准 Codex plugin + marketplace + GitHub Actions CI（Node 18/20/22/24 全套测试 + shellcheck）+ drift gates | 部署时 | ✅ 已完成 |
| **6** | Surface Protocol v2：manifest/profile capability、混合版本迁移与 lifecycle 兼容设计 | 否 | ✅ schema-v2 单 full writer、旧双 profile reader migration 与单面 guard 已完成 |

每个 hook 移植遵循 `spec/AGENTS.md §6` 证据规则：先对 temp fixture 灌样例 stdin 冒烟（§8.V3 destructive-smoke），再接 live。

Protocol v2 的完整 ADR 与“功能零损失”验收矩阵分别见
[`PROTOCOL-V2.md`](PROTOCOL-V2.md) 和
[`qa/PROTOCOL_V2_TEST_MATRIX.md`](qa/PROTOCOL_V2_TEST_MATRIX.md)。其核心边界是：
v2 保留可加性 schema/能力协商，只发布 full + extended artifact；standalone
install/update 事务式物化 global guidance，SessionStart 不改写全局文件。旧
dual-profile metadata 只作为迁移输入读取，不能重新启用旧 profile。

---

## 9. 开放问题（阻断对应 Phase）

已解决（Phase 1 fixture + smoke 验证）：
- ✅ **#1 PreToolUse deny 字段**：当前 canonical
  `hookSpecificOutput.permissionDecision:"deny"` 与 reason 字段已接入；旧
  `decision:"block"` 同义字段仅作为兼容层保留。
- ✅ **#2 stdin payload 形状**：common 与 event-specific 字段按当前 Codex
  契约分开；`turn_id`、`tool_use_id`、`last_assistant_message` 有 versioned
  fixture，transcript 只保留 bounded fallback。
- ✅ **#3 事件语义**：manifest 分开记录 official documented、agentsmd
  validated 与 registered 集合，不再把项目验证子集写成 Codex 的事件全集。

已解决（实现落地）：
- ✅ **[Phase 3/5]** 打包/安装机制 = **双路径**：plugin 携带的顶层 `hooks.json`（相对路径）由 Codex plugin 系统自动装配 + `scripts/install.js` 标记式 merge 手动并入 `~/.codex/hooks.json`；两份布线由 `drift.test.js` gate #4 保持一致。
- ✅ **[Phase 3]** 规范部署形态 = `~/.codex/AGENTS.md` 的 sentinel 托管块（`# >>> agentsmd >>> … # <<< agentsmd <<<`），块外内容逐字保留；卸载只删块。
