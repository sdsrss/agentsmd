# agentsmd — Architecture & Build Plan

Codex 版编程全局规范**系统**（不只是一份规范文本）的架构设计与分阶段实施计划。参照 `/mnt/data_ssd/dev/projects/claudemd` 的成熟三层形态，适配 Codex CLI 的真实能力面。本文件是设计正典；实施已完成（Phase 0-5 全绿，见 §8 阶段表）。

---

## 1. 为什么需要「系统」而不只是「一份 AGENTS.md」

`spec/AGENTS.md` 的 core 规范文本本身已经完备：六大功能轴（§3 链式思维 / §4 skills+工具路由 / §7 记忆与进度 / §9 文件卫生 / §11 自动化）齐备，Iron Laws、§8 SAFETY、Codex 机制映射都准确。它缺的**不是文字**。

真实成本是**注意力稀释**（`docs/agentsmd.txt`）：规则条数越多，长会话中间段每条的遵从强度越低，且这个成本 token 数字测不出来。claudemd 最终演化出**三层加载 + hook 强制 + 命中率升降级**，其目的**不是省 token，是保持每条规则的执行力**。一条无人强制、又从不命中的 always-on 规则，是纯稀释源。

因此本系统的每个部件都服务同一个目标：**让「规则被写下」变成「规则被执行」，并让数据决定哪条规则值得留在 always-on 层。**

---

## 2. 三层架构（claudemd 形态 → Codex 适配）

```
L3  命令层    Codex skills（dir + SKILL.md）：agentsmd-audit / doctor / rules / status
              —— stub，告诉 agent 去跑哪个 L2 脚本
L2  管理脚本  scripts/*.js（Node）：install / uninstall / status / audit / doctor / toggle
              —— 处理安装、append-only 并入 ~/.codex/hooks.json、遥测聚合、命中率升降级
L1  强制层    hooks/*.sh（bash，fail-open，<3s）：由 Codex harness 在 5 个事件直接调用
              —— 确定性强制：阻断危险 Bash、扫 banned-vocab、注入 MEMORY 提示、会话引导
```

**层间隔离不变式**（沿用 claudemd）：L1 永不 import L2；坏掉的安装留下 hooks 仍可用（或 fail-open）；坏掉的 hooks 留下命令仍可用。**append-only 不变式**：安装器并入 `~/.codex/hooks.json` 时绝不删改/重排 OMX 或其他插件的条目。

**命令层为何是 skills 而非 prompts**：`spec/AGENTS.md §4` 明确「custom prompts 上游已弃用——author a skill」。Codex skill = `dir + SKILL.md(name+description frontmatter)`，是 agent 可被描述触发调用的正典形态，正好对应 claudemd「slash command 作为 L2 脚本的 stub」模式。

---

## 3. Codex hook 契约（本机 v0.130.0 实测 / 逆向）

这是整个强制层的地基。结论：**Codex 原生 hook 与 Claude Code hook 近乎同构，claudemd 的 16 个 hook 主要改路径/harness细节即可移植，无需重写协议。**

| 维度 | Claude Code | Codex v0.130 | 移植增量 |
|---|---|---|---|
| 启用 | 插件装即生效 | `config.toml [features]` 需 `hooks = true`（Codex 0.142+；旧名 `codex_hooks` 装时自动迁移） | doctor 检查该 flag |
| 注册 | 每插件 `hooks.json`，marketplace 合并 | 单一全局 `~/.codex/hooks.json`（**当前 OMX 独占**） | 安装器 **append-only 合并** |
| 事件 | SessionStart/PreToolUse/PostToolUse/UserPromptSubmit/Stop/**SessionEnd** | ✅ 确认恰好 5 个，**无 SessionEnd** | session-end 逻辑折进 Stop |
| 条目形状 | `{"type":"command","command":"...","timeout":N}` | **同构** | 逐条对应 |
| matcher | `"Bash"` / `"*"` / `"startup\|resume"` | **同构**（OMX 用 `Bash`、`startup\|resume`） | 直接沿用 |
| stdin | JSON（tool_name/tool_input/session_id…） | ✅ **实测 snake_case，与 Claude 逐字段一致** | 读字段零改动 |
| 阻断输出 | `hookSpecificOutput.permissionDecision:"deny"` | ✅ **实测 `decision:"block"`+reason+systemMessage** | `hook_deny`→`hook_block` 改写 |
| 注入 context | `hookSpecificOutput.additionalContext` | OMX 用 `additionalContext/systemMessage` | 直接沿用 |

证据锚点：`~/.codex/hooks.json`(5 事件挂载) · `~/.codex/config.toml:48`(`codex_hooks=true`) · OMX `codex-native-hook.js` 出现 `hookEventName/decision/"block"/systemMessage/additionalContext/hookSpecificOutput/stdin`（与 claudemd `hook_deny` 同族）。

**路径自派生**（沿用 claudemd 不变式）：脚本用 `${BASH_SOURCE[0]}`/`__dirname` 自推基址，不依赖 `${CLAUDE_PLUGIN_ROOT}` 类变量——跨版本安全，也回避 Codex plugin-root 变量的不确定性。

---

## 4. 闭环数据面（spec → hook → 遥测 → 升降级）

这是「让数据决定 always-on 层」的落地机制，也是 claudemd 与一份静态文档的本质区别：

```
spec/AGENTS*.md 的 (HARD) 规则
  └─ spec/hard-rules.json           机器可读镜像（每条规则的 section_anchor + enforcement + codex_hook_event）
      └─ hooks/*.sh 强制             命中/阻断/fail-open 时 hook_record
          └─ ~/.codex/logs/agentsmd.jsonl   append-only 遥测（ts/hook/event/project/session_id/spec_section/extra）
              └─ scripts/audit.js    bySection 聚合
                  └─ 升降级信号       0 命中的 always-on 规则 → 降级到 extended；高频命中 → 证明值回 core
```

- 遥测写入器移植 claudemd `hooks/lib/rule-hits.sh`：改日志路径 `~/.claude/logs/claudemd.jsonl` → `~/.codex/logs/agentsmd.jsonl`，project 字段编码沿用 `tr -c 'a-zA-Z0-9-' '-'`，保留 size-capped rotation。
- **离线兜底**（Codex 特有优势）：`codex exec` 可无交互跑，为「离线扫历史会话产出命中率」提供一条 CI/定时路径——即 `agentsmd.txt` 设想的「试运行拿稀释度信号」，无需实时 hook 也能取数。
- `hard-rules.json` 的 `last_demote_review` 现为 `null`（部署前无字段数据）；首批遥测落地后由 OPERATOR 按节奏回填。

---

## 5. 插件独立性与生命周期隔离（HARD 不变式）

**agentsmd 是一个独立的 Codex 插件，与 oh-my-codex(OMX) 完全解耦。** 用户可能**根本没装 OMX**，agentsmd 必须能独立安装运行；装了 OMX 时，两者的**安装/更新/卸载互不冲突、互不影响**。这是 HARD 不变式，不是「尽量」。

**agentsmd 绝不**：假设 OMX 存在 · 读取/依赖/修改 OMX（或任何其他租户）的任何条目 · 在共享文件里重排或触碰非自己的内容。**agentsmd 只管自己的条目**，靠当前 `CODEX_HOME/agentsmd` 安装目录标记唯一识别 hook 命令（绝不会撞上 OMX 的 `codex-native-hook.js`、其他插件，或恰好名为 `agentsmd` 的项目目录）。

**装卸语义**（照搬 OMX `codex-hooks.js` 生产验证的 merge/remove 模式，用 agentsmd 自己的标记）：
- **安装/更新 = merge**：逐事件 → strip 掉自己的旧条目 + **其余条目逐字保留** + 追加自己的新条目。**幂等**，重装不重复。
- **卸载 = remove**：只 strip 当前 `CODEX_HOME/agentsmd` 安装目录下的条目 + 其余逐字保留；事件数组空→删事件键，hooks 空→删 hooks，root 空→删文件。
- 天然处理两种边界：目标文件**不存在**（从 `{}` 起，创建自己的）· **有没有 OMX**（OMX 条目只是「其他条目」，原样保留）。
- 安装器把「装了什么」（自己的 hook 条目、是否由自己设了 hook flag、是否补了 status line、AGENTS.md 注入块）记入 agentsmd **自有** manifest `~/.codex/.agentsmd-state/manifest.json`，使卸载精确可逆。

**每个共享面的隔离策略**：

| 共享面 | agentsmd 隔离方式 | 无 OMX 时 |
|---|---|---|
| `~/.codex/hooks.json` | 标记式 merge/remove（上）；只增删自己 | 不存在则创建，只含自己的条目 |
| `config.toml [features] hooks` | 缺失则 append `true`（0.142+；旧 `codex_hooks` 迁移为新名；保留其余配置）；**卸载不删**（留着无害；删了可能断 OMX/用户的 hook） | 自己设 `true`，卸载留存 |
| `config.toml [tui] status_line` | 若缺失则补 Codex built-in footer preset；已有用户值逐字保留；**卸载不删**（这是用户可见 TUI 偏好） | 自己设 preset，卸载留存 |
| `~/.codex/AGENTS.md`（规范部署） | sentinel 托管块 `# >>> agentsmd >>> … # <<< agentsmd <<<`，块外内容（OMX/用户的）逐字保留；卸载只删块 | 不存在则创建，只含自己的块 |
| MCP servers | 强制层不加 MCP（遥测是本地 jsonl）；未来若加，用 `agentsmd_*` 键 | 无影响 |
| skills（命令层） | agentsmd 自有目录 + `agentsmd-` 前缀技能名 | 无影响 |
| state / log | 自有路径 `~/.codex/.agentsmd-state/`、`~/.codex/logs/agentsmd.jsonl` | 无碰撞 |

**打包形态**：标准 `.codex-plugin/plugin.json`（`name:"agentsmd"` + `skills:"./skills/"` + 携带 `hooks.json`）。若 Codex 对插件携带的 `hooks.json` 自动装配（figma 插件已携带 hooks.json，倾向支持）→ 装卸隔离由插件系统免费提供；若不自动 → agentsmd 附带 postinstall 跑上面的标记式 merge。**两条路都满足独立性**。

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

Codex 侧约束（已在 spec 头部记录）：discovery 链合并有 `project_doc_max_bytes`(默认 32KiB) 上限，**超限静默截断**；core 现 24.1KB 占约 74%。这正是「让数据砍 core」的物理动机——Tier 0 越精简，被截断风险越低、每条规则遵从强度越高。

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
| **5** | 打包成标准 codex plugin（`.codex-plugin/plugin.json`：skills + 携带 hooks.json）+ marketplace 清单 + CI drift 测试（hard-rules ↔ spec 一致性）；独立于 OMX 可单独安装 | 部署时 | ✅ 已完成 |

每个 hook 移植遵循 `spec/AGENTS.md §6` 证据规则：先对 temp fixture 灌样例 stdin 冒烟（§8.V3 destructive-smoke），再接 live。

---

## 9. 开放问题（阻断对应 Phase）

已解决（Phase 1 逆向 OMX 生产 hook + smoke 验证）：
- ✅ **#1 PreToolUse deny 字段**：`{decision:"block", reason, systemMessage, hookSpecificOutput:{hookEventName}}`——**不是** Claude 的 `permissionDecision:"deny"`。这是阻断类 hook 的唯一移植增量。
- ✅ **#2 stdin payload 形状**：snake_case，与 Claude Code **逐字段一致**（`tool_name`/`tool_input.command`/`session_id`/`transcript_path`/`cwd`/`hook_event_name`/`prompt`/`stop_hook_active`/`tool_response`）。读字段的 hook 零改动移植。
- ✅ **#3 SessionEnd**：Codex 恰好 5 事件，**无 SessionEnd**（`MANAGED_HOOK_EVENTS` 类型确认）。session-end 逻辑折进 Stop。

已解决（实现落地）：
- ✅ **[Phase 3/5]** 打包/安装机制 = **双路径**：plugin 携带的顶层 `hooks.json`（相对路径）由 Codex plugin 系统自动装配 + `scripts/install.js` 标记式 merge 手动并入 `~/.codex/hooks.json`；两份布线由 `drift.test.js` gate #4 保持一致。
- ✅ **[Phase 3]** 规范部署形态 = `~/.codex/AGENTS.md` 的 sentinel 托管块（`# >>> agentsmd >>> … # <<< agentsmd <<<`），块外内容（OMX/用户的）逐字保留；卸载只删块。
