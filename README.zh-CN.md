# agentsmd

**[English](./README.md) · 中文**

> 一套面向 **OpenAI Codex CLI** 的编程纪律规范：由 Codex 原生 hook 强制执行，并以命中率遥测闭环保持诚实。它把一份模型会逐渐漂移的规范，变成一个真正能守住的系统——且可独立安装，与 oh-my-codex 完全解耦。

![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![hooks](https://img.shields.io/badge/hooks-native%20Codex-blue) ![independent](https://img.shields.io/badge/independent%20of-oh--my--codex-orange)

> **前身为 `codexmd`。** 项目在 v2.0.0 更名为 `agentsmd` 以与仓库名一致。安装 agentsmd 会自动迁移旧的 codexmd 安装——[详见下文](#从-codexmd-升级)。

---

## agentsmd 是什么?

**agentsmd 是一套面向 Codex CLI 的全局编程纪律规范,由 Codex 自己的 hook 来强制执行。** 规范由 `spec/AGENTS.md`(always-on 核心)与 `spec/AGENTS-extended.md`(按需加载)组成,定义了 `CLASSIFY → AUTH → ROUTE → PLAN → EXECUTE → VALIDATE → REPORT` 工作流、按级别递增的严格度、Iron Laws(没有新鲜证据不算「完成」;没有根因不算修复)、§8 SAFETY 底线,以及诚实的四段式报告。原生 Codex hook 让其中的机械部分变成**不可跳过**的,并且每一次命中都会被记录——于是**由数据、而非口味,决定哪条规则值得留在 always-on 层。**

## 为什么要 hook + 遥测,而不只是一份 `AGENTS.md`?

一份规范文件的强度,取决于模型在会话中途是否愿意遵守。长规则列表的真实代价是**注意力稀释**:规则越多,在长任务中段每条的约束力越弱——而这个代价任何 token 计数都测不出来。

agentsmd 用「系统」而非「文档」的方式回应这一点:

- **Hook** 把机械规则(阻断 `rm -rf $VAR`、阻断没有量化的 commit 信息、阻断向红 CI 分支的 push)变成模型无法用话术绕过的确定性闸门。
- **遥测** 记录每一次命中,于是 `agentsmd-rules` 能显示:哪些 always-on 规则持续触发(它们证明了自己的价值),哪些从不触发(纯稀释——该降级)。

重点不是省 token。**一条无人强制、又从不命中的规则,是纯粹的注意力稀释源。** agentsmd 的存在,是为了让每条规则都可执行,并让每条 always-on 规则都由数据来背书。

## 它强制什么

横跨全部 5 个 Codex 事件的十个原生 hook。阻断类是硬闸门;Stop 时刻的那些会排队成一条 advisory,在你下一次输入时呈现。

| Hook | 事件 | 强制内容 |
|---|---|---|
| `pre-bash-safety-check` | PreToolUse:Bash | §8 SAFETY——阻断 `rm -rf $VAR`、`curl \| bash`;对未固定版本的 `npx` 告警 |
| `banned-vocab-check` | PreToolUse:Bash | §10——阻断 `git commit` 信息里没有量化的价值声明 |
| `ship-baseline-check` | PreToolUse:Bash | §E3——当共享分支的 CI 为红时,阻断 `git push` |
| `memory-read-check` | PreToolUse:Bash | §7——ship 时若未查阅项目 `MEMORY.md`,则阻断 |
| `session-start-check` | SessionStart | 注入 active-spec 横幅;重置 advisory 队列 |
| `surface-advisories` | UserPromptSubmit | 呈现上一轮 Stop hook 排队的 advisory |
| `memory-prompt-hint` | UserPromptSubmit | 呈现与本次 prompt 匹配的 `MEMORY.md` 条目 |
| `residue-audit` | Stop | §7/§9——标记 `~/.codex/tmp` 增长 |
| `sandbox-disposal-check` | Stop | §8.V4——标记未清理的临时目录 |
| `transcript-structure-scan` | Stop | §10——检查上一份报告的四段式顺序 + 违禁词 |

Stop hook 的 advisory 会排队,在下一次 `UserPromptSubmit` 通过已验证的 `additionalContext` 通道呈现,而非在 Stop 内联发出。每次命中都追加写入 `~/.codex/logs/agentsmd.jsonl`。

## 依赖

- **Codex CLI** 且启用原生 hook——`config.toml` → `[features] hooks = true`。安装器会设置它,并自动迁移 0.142 之前的旧名 `codex_hooks`。
- `PATH` 上要有 **`jq`** 和 **`node` ≥ 18**。

一切都尊重 `$CODEX_HOME`(默认 `~/.codex`)。

## 安装

### 独立安装器

如果你希望 agentsmd 直接管理 `$CODEX_HOME` 里的自身标记作用域条目,使用这条路径。
安装器会下载最新仓库快照,运行与本地开发相同的幂等 Node 安装器,并在退出时清理临时文件。

```bash
curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh
```

GitHub 不会从 `https://github.com/sdsrss/agentsmd/install.sh` 返回可执行的 raw 文件内容;
curl 管道安装请使用上面的 `raw.githubusercontent.com` URL。

常用选项:

```bash
# 固定到某个 branch、tag 或 commit
curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh -s -- --ref v2.1.0

# 显式更新:与安装是同一个幂等操作,可反复运行
curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh -s -- --update

# 安装后的检查
curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh -s -- --status
curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh -s -- --doctor
```

如果你的本地策略阻断 `curl | sh`,使用可检查的两步形式:

```bash
curl -fsSLo /tmp/agentsmd-install.sh https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh
sh /tmp/agentsmd-install.sh
```

### Codex plugin marketplace

如果你希望 Codex 把 agentsmd 当作插件安装,并由 Codex 的 plugin cache 管理 bundle,使用这条路径。
仓库自带 `.agents/plugins/marketplace.json`,marketplace 名称是 `agentsmd`。

```bash
codex plugin marketplace add sdsrss/agentsmd --json
codex plugin add agentsmd --marketplace agentsmd --json
```

Codex 也接受 `codex plugin add agentsmd@agentsmd`。`--marketplace` 形式在脚本里更清晰,
也与当前 CLI reference 一致。如果你本机的 `codex plugin` 子命令还不可用,先更新 Codex,
或使用上面的独立安装器。

### 本地开发 checkout

```bash
node scripts/install.js     # 并入 ~/.codex、设置 [features] hooks、注入规范块
node scripts/status.js      # 确认:agentsmd hook 已注册,其他租户被保留
node scripts/doctor.js      # 健康检查
```

安装是**幂等的**,并逐字节保留其他每个租户的条目。

## 更新

独立安装器的更新路径就是重跑:curl 安装器会抓取当前仓库快照,刷新 agentsmd 文件,
无重复地重新并入 hook,并拉取新的规范。

```bash
curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh -s -- --update

# 从 checkout 运行:
node scripts/install.js     # = 更新(幂等);或:npm run spec:update
```

插件更新先刷新已配置的 marketplace 快照,再从该 marketplace 重新安装插件。重装后开启一个新的
Codex 线程,让新的 skills/hooks 被加载。

```bash
codex plugin marketplace upgrade agentsmd --json
codex plugin add agentsmd --marketplace agentsmd --json
```

## 卸载

独立卸载会移除 agentsmd 自己的条目与状态,同时保留其他插件和用户配置:

```bash
curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh -s -- --uninstall

# 从 checkout 运行:
node scripts/uninstall.js
```

卸载只 strip agentsmd 自己的条目(hook、skills、`AGENTS.md` 块、install 与 state 目录),并且按 §5 **保留 `config.toml` 的 hooks flag**(删掉它可能会断掉 oh-my-codex 或你自己的 hook)。

插件卸载会移除 Codex 的插件安装/cache 条目。如果你不希望 Codex 继续跟踪本仓库作为 source,
也移除 marketplace:

```bash
codex plugin remove agentsmd --marketplace agentsmd --json
codex plugin marketplace remove agentsmd --json
```

如果你同时使用过独立安装和插件安装,两套清理都要运行;它们管理的是不同的 Codex surface。

### 从 codexmd 升级

如果你之前装过 **codexmd**(v1.4.0–v1.4.3),无需任何特殊操作:**运行 agentsmd 安装器会自动迁移你。** 它会 strip 掉旧 `CODEX_HOME/codexmd` 安装目录下的 hook、`# >>> codexmd >>>` 的 `AGENTS.md` 块、`codexmd-*` skills,以及 `~/.codex/{codexmd, .codexmd-state}`——按标记作用域(marker-scoped),因此 oh-my-codex 和其他每个租户都不受影响。若不存在 codexmd 安装,迁移是 no-op;`uninstall` 也会顺带清扫任何 codexmd 残留。

## 它如何独立于 oh-my-codex?

agentsmd 在共享的 `~/.codex/hooks.json`、`config.toml`、`AGENTS.md` 里**只管自己的条目**,靠当前 `CODEX_HOME/agentsmd` 安装目录标记和 `# >>> agentsmd >>>` sentinel 唯一识别 hook 命令。它绝不读取、修改、重排或依赖 oh-my-codex(OMX)或任何其他租户,且无论 OMX 是否存在都能干净安装。若共享的 `hooks.json` 不可解析,安装器会**宁可中止也不覆盖**——因为它可能藏着看不见的其他租户 hook。这一点由 `scripts/tests/install.test.js` 证明:在种入的 OMX 配置旁做到逐字节往返一致。

OMX(若在)是编排框架,agentsmd 是纪律/执行力层。二者互补——且 agentsmd **不依赖** OMX。

## 治理——让数据决定哪条规则留下

```bash
node scripts/audit.js --days=30    # 按规范章节聚合命中率遥测
node scripts/rules.js --days=30    # 对照 spec/hard-rules.json 给出升/降级信号
```

一条 hook 强制的规则在评审窗口内**零命中**,即 always-on 层的稀释源 → 降级候选;高频命中则证明它值得留在核心。运维节奏、体量预算与升降级门槛见 `spec/OPERATOR.md`。

## 开发

```bash
npm test    # 安装/独立性 + 闭环遥测 + drift + hook 冒烟 套件
```

`scripts/tests/drift.test.js` 是 CI 门禁,让 `spec/`、`hard-rules.json`、两处 hook 接线与版本号保持同步。架构与分阶段历史见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

## 布局

```
spec/        正典规范(core、extended、changelog、hard-rules.json、OPERATOR.md)
hooks/       L1 强制层——原生 hook + 共享 lib + 冒烟测试
scripts/     L2 管理层——install/uninstall/status/doctor/audit/rules(+ migrate + 测试)
skills/      L3 命令层——agentsmd-audit/rules/doctor/status
.agents/     repo marketplace,用于 `codex plugin add agentsmd --marketplace agentsmd`
.codex-plugin/plugin.json   Codex 插件清单
hooks.json   插件根的 hook 接线(相对路径)
install.sh   适合 curl 的独立安装/更新/卸载入口
```

## 常见问题

**agentsmd 和 codexmd 是同一个吗?**
是。`codexmd` 是旧名;项目在 v2.0.0 更名为 `agentsmd` 以与仓库一致。同一个系统、同一份 `CODEX-CODING-SPEC`,只是工具身份变了。已有的 codexmd 安装会被自动迁移。

**必须装 oh-my-codex 才能用 agentsmd 吗?**
不必。agentsmd 可独立安装运行。若恰好装了 OMX,两者共存且互不触碰对方的配置。

**它能用于原生的 OpenAI Codex CLI 吗?**
可以——它针对 Codex CLI 的原生 hook 系统(`[features] hooks = true`,Codex 0.142+),读取 snake_case 的 hook stdin,并发出 Codex 的 block/advisory/context JSON 形状。

**它会改动我现有的 `~/.codex` 配置吗?**
只改它自己的、按标记作用域的条目,并且拒绝触碰不可解析的 `hooks.json`。你的 model、profile 以及其他插件的条目都会被逐字节保留。

**如何更新或移除?**
独立安装:重跑 curl 安装器或 `node scripts/install.js`;用 `install.sh --uninstall`
或 `node scripts/uninstall.js` 移除。插件安装:先
`codex plugin marketplace upgrade agentsmd`,再
`codex plugin add agentsmd --marketplace agentsmd`;用
`codex plugin remove agentsmd --marketplace agentsmd` 移除。

## 许可

MIT
