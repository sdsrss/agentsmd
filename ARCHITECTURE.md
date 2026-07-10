# agentsmd — Architecture & Build Plan

Codex 版编程全局规范**系统**（不只是一份规范文本）的架构设计与分阶段实施记录。本文只把仓库 wiring、fixture 和测试能验证的行为写成产品事实；外部运行时能力需由对应官方契约或实机证据支持。

---

## 1. 为什么需要「系统」而不只是「一份 AGENTS.md」

`spec/AGENTS.md` 的 core 覆盖 SPINE、授权、证据、安全和路由等每轮约束；展开流程放在按需加载的 extended。两层内容仍需由 drift、测试和人工复审持续校准。

主要风险是 discovery 预算被 core 占用，以及规则存在但没有对应执行或测量机会。三层加载、选择性 hook 和机会/结果遥测分别约束上下文占用、可检测行为和治理证据；零命中本身不证明规则无价值。

因此本系统把「规则文本」「可检测执行」「机会与结果」连到同一条审计链；数据是 operator 复审输入，不自动证明规则价值或触发 prompt 变更。

---

## 2. 三层架构（claudemd 形态 → Codex 适配）

```
bin/        npm CLI 入口  bin/agentsmd.js（Node）：`agentsmd <cmd>` / `npx --package @sdsrs/agentsmd agentsmd <cmd>`
              —— 薄 dispatcher，spawn（而非 import）对应 L2 脚本，透传参数/输出/退出码；不属于三层，不引入 L1↔L2 耦合
L3  命令层    Codex skills（dir + SKILL.md）：agentsmd-audit / doctor / rules / status
              —— stub，告诉 agent 去跑哪个 L2 脚本
L2  管理脚本  scripts/*.js（Node）：install / uninstall / status / audit / doctor / toggle
              —— 处理安装、scoped merge/remove、遥测聚合与治理信号
L1  强制层    hooks/*.sh（bash，fail-open，3-8s timeout）：由 Codex harness 在 4 个已注册事件调用
              —— 确定性强制：阻断危险 Bash、扫 banned-vocab、注入 MEMORY 提示、会话引导
```

**层间隔离不变式**：L1 永不 import L2；hook 异常时 fail-open，管理命令仍可独立运行。npm CLI 入口 `bin/agentsmd.js` 通过 spawn 子进程调用 L2 脚本。共享 hook merge 只删除当前 install path 标识的 agentsmd command hook，再保留其他 hook object 并追加本版本条目。

**命令层为何使用 skills**：仓库把 `dir + SKILL.md(name+description frontmatter)` 作为命令元数据，并让每个 skill 路由到一个 L2 脚本；触发边界与 progressive disclosure 见 `spec/AGENTS-extended.md §E9`。

---

## 3. Codex hook 契约（仓库当前可验证范围）

这是强制层的地基。仓库测试只把已部署 wiring、stdin fixture 和 block/context 输出当作可验证契约；未被当前官方文档或本地运行验证的能力不写成产品事实。

| 维度 | 来源形态 | agentsmd repository model | 验证边界 |
|---|---|---|---|
| 启用 | standalone config | `[features] hooks = true`；旧 `codex_hooks` 由 installer 迁移 | doctor 检查 deployed flag |
| 注册 | repository manifests | standalone 使用 `~/.codex/hooks.json` scoped merge/remove | drift 校验两份 wiring |
| 事件 | manifest keys | supported 5 个；agentsmd registered 4 个 | fixture 不证明外部事件全集 |
| 条目形状 | JSON wiring | `{"type":"command","command":"...","timeout":N}` | JSON/drift test |
| matcher | JSON wiring | `Bash`、`*`、`startup\|resume` | JSON/drift test |
| stdin | smoke fixture | snake_case `tool_name/tool_input/session_id/...` | synthetic fixture contract |
| 阻断输出 | smoke assertion | `decision:block` + reason/systemMessage | synthetic fixture contract |
| 注入 context | smoke assertion | `hookSpecificOutput.additionalContext` | synthetic fixture contract |

证据锚点：`hooks.json`、`hooks/hooks.json`、`scripts/lib/hook-registry.js` 与 `hooks/tests/smoke.sh`。这些证明仓库模型内部一致；外部 Codex harness compatibility 仍需对应版本的官方契约或脱敏实机 capture。

**路径自派生**（沿用 claudemd 不变式）：脚本用 `${BASH_SOURCE[0]}`/`__dirname` 自推基址，不依赖 `${CLAUDE_PLUGIN_ROOT}` 类变量——跨版本安全，也回避 Codex plugin-root 变量的不确定性。

---

## 4. 闭环数据面（spec → hook → 遥测 → operator review）

这条链把 rule-specific opportunity、detector outcome 与 manifest 对齐，避免用无关 session 或 raw hit count 直接下治理结论：

```
spec/AGENTS*.md 的 (HARD) 规则
  └─ spec/hard-rules.json           机器可读镜像（每条规则的 section_anchor + enforcement + codex_hook_event）
      └─ hooks/*.sh 强制             命中/阻断/fail-open 时 hook_record
          └─ ~/.codex/logs/agentsmd.jsonl   append-only 遥测（ts/hook/event/project/session_id/spec_section/extra）
              └─ scripts/audit.js    bySection 聚合
                  └─ 治理信号         rule-specific opportunity + outcome → operator review
```

- 遥测写入器移植 claudemd `hooks/lib/rule-hits.sh`：改日志路径 `~/.claude/logs/claudemd.jsonl` → `~/.codex/logs/agentsmd.jsonl`，project 字段编码沿用 `tr -c 'a-zA-Z0-9-' '-'`，保留 size-capped rotation。
- **离线兜底**（Codex 特有优势）：`codex exec` 可无交互跑，为「离线扫历史会话产出命中率」提供一条 CI/定时路径——即 `agentsmd.txt` 设想的「试运行拿稀释度信号」，无需实时 hook 也能取数。
- `hard-rules.json` 的 `last_demote_review` 现为 `null`（部署前无字段数据）；首批遥测落地后由 OPERATOR 按节奏回填。

---

## 5. 插件独立性与生命周期隔离（HARD 不变式）

**agentsmd 是一个独立的 Codex 插件，与 oh-my-codex(OMX) 完全解耦。** 用户可能**根本没装 OMX**，agentsmd 必须能独立安装运行；装了 OMX 时，两者的**安装/更新/卸载互不冲突、互不影响**。这是 HARD 不变式，不是「尽量」。

**agentsmd 不依赖 OMX**。共享文件中的 hook 仍按当前 `CODEX_HOME/agentsmd` 命令路径识别；独立 deploy、extended spec 和 skills 则由 manifest 的 exact path + content hash 证明所有权。所有 standalone artifact 在 mutation 前完成 preflight，无法证明所有权时中止。

**装卸语义**：
- **安装/更新 = stage + preflight + transaction**：先构建完整 release tree 并验证既有 manifest ownership，再更新共享文件和 live tree；注入失败时用 compare-and-swap 快照回滚，避免覆盖事务外并发写入。
- **卸载 = preflight + transaction**：先验证全部 manifest-owned artifact，任一冲突都零 mutation；通过后 quarantine owned tree 并更新共享文件，失败时以 compare-and-swap 回滚，不覆盖并发外部写入。
- 天然处理两种边界：目标文件**不存在**（从 `{}` 起，创建自己的）· **有没有 OMX**（OMX 条目只是「其他条目」，原样保留）。
- 安装器把 deploy、extended spec、skills 的 exact path + hash，以及共享面变更结果写入 agentsmd **自有** manifest `~/.codex/.agentsmd-state/manifest.json`；共享配置仍由 hook path/sentinel 识别。

**每个共享面的隔离策略**：

| 共享面 | agentsmd 隔离方式 | 无 OMX 时 |
|---|---|---|
| `~/.codex/hooks.json` | 标记式 merge/remove（上）；只增删自己 | 不存在则创建，只含自己的条目 |
| `config.toml [features] hooks` | 缺失则 append `true`（0.142+；旧 `codex_hooks` 迁移为新名；保留其余配置）；**卸载不删**（留着无害；删了可能断 OMX/用户的 hook） | 自己设 `true`，卸载留存 |
| `config.toml [tui] status_line` | 若缺失则补 Codex built-in footer preset；已有用户值逐字保留；**卸载不删**（这是用户可见 TUI 偏好） | 自己设 preset，卸载留存 |
| `~/.codex/AGENTS.md`（规范部署） | sentinel 托管块 `# >>> agentsmd >>> … # <<< agentsmd <<<`，块外内容（OMX/用户的）逐字保留；卸载只删块 | 不存在则创建，只含自己的块 |
| MCP servers | 强制层不加 MCP（遥测是本地 jsonl）；未来若加，用 `agentsmd_*` 键 | 无影响 |
| skills（命令层） | manifest exact path + tree hash；前缀不是 ownership 证据 | 无影响 |
| state / log | manifest/known runtime 可移除；backups 与 unknown entries 保留；telemetry log 不随 uninstall 删除 | 无碰撞 |

**打包形态**：仓库提供 `.codex-plugin/plugin.json`、顶层 `hooks.json` 和 standalone `scripts/install.js`。plugin surface 的装配由 Codex plugin runtime 管理；standalone surface 使用本节的 manifest-backed transaction。两套 surface 分开卸载。

**定位**：OMX（若在）是编排框架，agentsmd 是纪律/执行力层——互补而非竞争；但 agentsmd **不依赖** OMX。

> ⚠️ 触碰 `~/.codex/hooks.json` / `config.toml` / `AGENTS.md` = `spec/AGENTS.md §5` hard-AUTH 面。**本仓库内开发全程不改动 live `~/.codex`**；首次真正安装（Phase 3）前单独 re-AUTH。

---

## 6. 三层加载（对应 Codex discovery）

| Tier | 文件 | 何时加载 | 内容 |
|---|---|---|---|
| 0 always | `spec/AGENTS.md` → 部署到 `~/.codex` discovery 链 | 每轮 | per-turn gates（SPINE/LEVEL/AUTH/VALIDATE/SAFETY） |
| 1 triggered | `spec/AGENTS-extended.md`（不在 discovery 链，零预算） | L3/ship/Override/three-strike 时 agent 显式 `cat` | 条件规则（Override 模式/L3 flow/ship 清单/证据阶梯） |
| 2 keyword | `MEMORY.md` + `memory/*.md` | 关键词/路径命中 | 召回式（feedback_/project_/reference_） |
| operator | `spec/OPERATOR.md`（Phase 4） | 永不自动加载 | 人类维护者的升降级节奏，不占 agent 注意力 |

Codex discovery 链共享 `project_doc_max_bytes`（默认 32 KiB）且超限静默截断。core 由 drift gate 限制在 ≤16 KiB，至少保留默认预算的一半给项目级指令；展开流程放入 triggered extended。

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
  scripts/                   L2 管理脚本（Phase 3）
  <command skills>           L3 命令层，Codex skill 形态（Phase 4）
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
| **3** | L2 脚本（install/status/audit/doctor/toggle）+ **标记式 merge/remove 安装器**（§5，只增删 `/agentsmd/` 自有条目）+ 自有 manifest + kill-switch；首次 **re-AUTH** 触碰 live hooks.json/config.toml/AGENTS.md | 是（re-AUTH） | ✅ 已完成 |
| **4** | 遥测闭环 + `OPERATOR.md` + 命令层 skills | 是（re-AUTH） | ✅ 已完成 |
| **5** | 标准 Codex plugin + marketplace + GitHub Actions CI（Node 18/20/22/24 全套测试 + shellcheck）+ drift gates | 部署时 | ✅ 已完成 |

每个 hook 移植遵循 `spec/AGENTS.md §6` 证据规则：先对 temp fixture 灌样例 stdin 冒烟（§8.V3 destructive-smoke），再接 live。

---

## 9. 开放问题（阻断对应 Phase）

已解决（Phase 1 逆向 OMX 生产 hook + smoke 验证）：
- ✅ **#1 PreToolUse deny 字段**：`{decision:"block", reason, systemMessage, hookSpecificOutput:{hookEventName}}`——**不是** Claude 的 `permissionDecision:"deny"`。这是阻断类 hook 的唯一移植增量。
- ✅ **#2 stdin payload 形状**：snake_case，与 Claude Code **逐字段一致**（`tool_name`/`tool_input.command`/`session_id`/`transcript_path`/`cwd`/`hook_event_name`/`prompt`/`stop_hook_active`/`tool_response`）。读字段的 hook 零改动移植。
- ✅ **#3 注册事件**：manifest 区分 supported 5-event 集合与 agentsmd registered 4-event 集合；session-end 行为折进 Stop observer，不再宣称未经当前文档验证的“恰好”事件总数。

已解决（实现落地）：
- ✅ **[Phase 3/5]** 打包/安装机制 = **双路径**：plugin 携带的顶层 `hooks.json`（相对路径）由 Codex plugin 系统自动装配 + `scripts/install.js` 标记式 merge 手动并入 `~/.codex/hooks.json`；两份布线由 `drift.test.js` gate #4 保持一致。
- ✅ **[Phase 3]** 规范部署形态 = `~/.codex/AGENTS.md` 的 sentinel 托管块（`# >>> agentsmd >>> … # <<< agentsmd <<<`），块外内容（OMX/用户的）逐字保留；卸载只删块。
