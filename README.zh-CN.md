# agentsmd

**[English](./README.md) · 中文**

> 一套面向 **OpenAI Codex CLI** 的编程纪律规范：原生 hook 覆盖可机械检测的规则子集，rule-specific opportunity telemetry 为人工治理提供证据。它可独立安装，不依赖 oh-my-codex。

![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![hooks](https://img.shields.io/badge/hooks-native%20Codex-blue) ![independent](https://img.shields.io/badge/independent%20of-oh--my--codex-orange)

> **前身为 `codexmd`。** 项目在 v2.0.0 更名为 `agentsmd` 以与仓库名一致。安装器只迁移 provenance 可验证的 codexmd artifact——[详见下文](#从-codexmd-升级)。

---

## agentsmd 是什么?

**agentsmd 是一套面向 Codex CLI 的全局编程纪律规范,并用原生 hook 观察其中可机械检测的子集。** `spec/AGENTS.md` 是 always-on 核心,`spec/AGENTS-extended.md` 保存按需加载的展开流程。hook 对能识别的命令模式执行阻断或提示;需要语义判断的规则仍由 agent 与 operator 执行。

## 为什么要 hook + 遥测,而不只是一份 `AGENTS.md`?

一份规范文件的强度,取决于模型在会话中途是否愿意遵守。长规则列表的真实代价是**注意力稀释**:规则越多,在长任务中段每条的约束力越弱——而这个代价任何 token 计数都测不出来。

agentsmd 用「系统」而非「文档」的方式回应这一点:

- **Hook** 阻断可识别的危险命令、secret commit 与已知红色 CI 分支 push;缺少前置工具或无法解析时 fail-open,并尽量记录原因。
- **遥测** 分开记录 eligible/evaluated 机会与 enforcement 命中,避免把「没有触发机会」误判成规则无价值。

治理不以原始 token 或命中数单独下结论。core 体量、detector coverage、opportunity 与 outcome 是不同信号,operator 复审后才调整 always-on 规则。

## 它强制什么

横跨 4 个 Codex 事件(SessionStart、PreToolUse、UserPromptSubmit、Stop——无 PostToolUse)的十五个原生 hook。阻断类是硬闸门;Stop 时刻的那些会排队成一条 advisory,在你下一次输入时呈现。

用户明确要求“提交并发版/发布”时,该请求直接授权当前仓库的标准 ship
流程,不再重复确认。完成条件包括合入默认分支、验证 tag/artifact,以及删除
本地和远端已合并的任务/发布分支。未点名的生产环境、live 配置或其他
仓库/package/registry 不在该授权范围内。

| Hook | 事件 | 强制内容 |
|---|---|---|
| `pre-bash-safety-check` | PreToolUse:Bash | §8 SAFETY——阻断不安全变量删除及同一/跨 tool 的远程下载执行,含相对路径和嵌套 shell 来源;对未固定版本的 `npx` 告警 |
| `banned-vocab-check` | PreToolUse:Bash | §10——阻断 `git commit` 信息里没有量化的价值声明 |
| `ship-baseline-check` | PreToolUse:Bash | §E3——当共享分支的 CI 为红时,阻断 `git push` |
| `memory-read-check` | PreToolUse:Bash | §7——ship 前若没有成功 `read_file` 或明确读取项目 memory index 及一个链接 memory 的命令证据,则阻断 |
| `session-start-check` | SessionStart | 注入 active-spec 横幅;重置 advisory 队列 |
| `surface-advisories` | UserPromptSubmit | 呈现上一轮 Stop hook 排队的 advisory |
| `memory-prompt-hint` | UserPromptSubmit | 呈现与本次 prompt 匹配的 `MEMORY.md` 条目 |
| `residue-audit` | Stop | §7/§9——标记 `~/.codex/tmp` 增长 |
| `sandbox-disposal-check` | Stop | §8.V4——标记疑似任务临时目录,排除 Codex runtime 路径,删除前要求验证所有权 |
| `transcript-structure-scan` | Stop | §10/§6——检查报告标签完整性/顺序、违禁词、证据锚点与对冲措辞 |
| `secrets-scan` | PreToolUse:Bash | §8——阻断新增密钥内容或高置信 `.env`/私钥文件名的 `git commit` |
| `convention-cite-scan` | Stop | 追踪 `@conv-*` 项目约定引用,供 `analyze --adoption` |
| `session-exit-checkpoint` | Stop | §7——跟踪 patch/formatter 写入,标记没有 test/lint/typecheck/build 证据的字节 |
| `mem-audit` | Stop | §7——标记 `MEMORY.md` 索引/文件漂移 + 缺失 verified 头 |
| `session-summary` | Stop | 记录本会话的强制计数(下次 SessionStart 呈现) |

Stop hook 的 advisory 会排队,在下一次 `UserPromptSubmit` 通过已验证的 `additionalContext` 通道呈现,而非在 Stop 内联发出。每次命中都追加写入 `~/.codex/logs/agentsmd.jsonl`。

## 依赖

- **Codex CLI** 且启用原生 hook——`config.toml` → `[features] hooks = true`。安装器会设置它,并自动迁移 0.142 之前的旧名 `codex_hooks`。如果用户还没有配置 `[tui] status_line`,安装器也会恢复一组有用的 Codex 内置 footer 字段。
- `PATH` 上要有 **`jq`** 和 **`node` ≥ 18**。

已安装 artifact、运行时状态、日志与 standalone 生命周期命令尊重 `$CODEX_HOME`
(默认 `~/.codex`)。`init`、`analyze`、`design` 等项目命令作用于当前工作目录;
Codex 自行管理 plugin cache。

## 安装

选择一条安装路径:

- **独立 curl 安装器:** 多数本地 Codex CLI 用户的最短路径。
- **npm 包:** 版本固定的全局 `agentsmd` CLI(`npm install -g @sdsrs/agentsmd`),或用 `npx --package` 一次性运行。
- **Codex 插件市场:** 用 Codex 的插件浏览器;较新的 CLI 也提供自动化命令。
- **本地 checkout:** 用于开发或安装前审阅改动。

### 独立安装器

如果你希望 agentsmd 直接管理 `$CODEX_HOME` 里的 manifest-owned artifact 与 marker-scoped 共享条目,使用这条路径。
安装器会下载最新仓库快照,运行与本地开发相同的幂等 Node 安装器,并在退出时清理临时文件。

```bash
curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh
```

GitHub 不会从 `https://github.com/sdsrss/agentsmd/install.sh` 返回可执行的 raw 文件内容;
curl 管道安装请使用上面的 `raw.githubusercontent.com` URL。

常用选项:

```bash
# 固定到某个 branch、tag 或 commit
curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh -s -- --ref v2.2.1

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

### npm 包

包内自带 `agentsmd` CLI,所以 npm 用户不再需要 `npm explore`。它以
`@sdsrs/agentsmd` 作用域发布(npm 拒绝了无作用域的 `agentsmd` 名,认为它与已有
包过于相似);安装进 Codex 的运行时足迹名仍是 `agentsmd`。

全局安装 CLI 后直接调用:

```bash
npm install -g @sdsrs/agentsmd
agentsmd install     # 之后:update、uninstall、status、doctor、audit、rules
```

想要一次性、不留全局安装?用 `npx` 时必须**显式写出命令名**——作用域包需要把命令
拼出来,即 `npx --package … agentsmd …`,而不是裸的 `npx @sdsrs/agentsmd …`(部分
npm/npx 版本无法解析后者):

```bash
npx --package @sdsrs/agentsmd agentsmd install
```

`agentsmd --help` 是项目、生命周期、诊断和治理子命令的权威清单。裸调用
`agentsmd` 只打印这份帮助,不安装任何东西。`install` 和 `update` 默认输出简洁结果;
自动化需要完整安装 manifest 时传入 `--json`。

### Codex plugin marketplace

如果你希望 Codex 把 agentsmd 当作插件安装,并由 Codex 的 plugin cache 管理 bundle,使用这条路径。
仓库自带 `.agents/plugins/marketplace.json`,marketplace 名称是 `agentsmd`;其中条目固定指向
已发布的 `@sdsrs/agentsmd` npm artifact,不会把整个仓库 checkout 当成 plugin payload。

> **plugin bundle 声明什么、仓库验证什么。** bundle 声明 agentsmd 的 hooks 与
> skills;仓库 drift test 证明其 wiring 与 standalone template 一致,但没有对每个
> Codex plugin runtime/version 做端到端激活测试。完整安装的其余部分——把核心规范注入 `~/.codex/AGENTS.md`、设置
> `config.toml` 的 `[features] hooks = true`、以及迁移旧的 codexmd 安装——由脚本
> 安装器完成。需要仓库测试覆盖的完整 surface 时,加插件后再跑一次安装器:
>
> ```bash
> npm install -g @sdsrs/agentsmd && agentsmd install
> ```

通用安装路径是 Codex 的插件浏览器:

- 在 Codex app 中打开 **插件**,浏览 marketplace,选择 **添加到 Codex**。
- 在 Codex CLI 中运行 `codex`,输入 `/plugins`,打开 marketplace 条目并选择安装。

需要自动化时,较新的 Codex CLI 还提供实验性的 `codex plugin` 命令:

```bash
codex plugin marketplace add sdsrss/agentsmd --json
codex plugin add agentsmd --marketplace agentsmd --json
```

Codex 也接受 `codex plugin add agentsmd@agentsmd`。`--marketplace` 形式在脚本里更清晰,
也与当前 CLI reference 一致。如果你本机的 `codex plugin` 子命令还不可用,先更新 Codex,
或使用上面的独立/npm 安装器。

### 本地开发 checkout

```bash
node scripts/install.js     # 并入 ~/.codex、设置 hooks + status_line、注入规范块
node scripts/status.js      # 确认:agentsmd hook 已注册,其他租户被保留
node scripts/doctor.js      # 健康检查
```

安装是**幂等的**,保留其他租户的 hook object;install/uninstall round trip 会逐字节恢复测试中的共享 fixture。

## 更新

独立安装器的更新路径就是重跑:curl 安装器会抓取当前仓库快照,刷新 agentsmd 文件,
无重复地重新并入 hook,并拉取新的规范。

```bash
curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh -s -- --update

# 从 checkout 运行:
node scripts/install.js     # = 更新(幂等);或:npm run spec:update
```

对于 npm 安装,先刷新包,再重跑 install(幂等):

```bash
npm install -g @sdsrs/agentsmd@latest
agentsmd install
# …或一次性、不留全局安装:
npx --package @sdsrs/agentsmd@latest agentsmd install
```

插件更新先刷新已配置的 marketplace 快照,再从该 marketplace 重新安装插件。重装后开启一个新的
Codex 线程,让新的 skills/hooks 被加载。

```bash
codex plugin marketplace upgrade agentsmd --json
codex plugin add agentsmd --marketplace agentsmd --json
```

## 卸载

独立卸载会移除 agentsmd owned runtime 条目,同时保留其他插件和用户配置:

```bash
curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh -s -- --uninstall

# 从 checkout 运行:
node scripts/uninstall.js
```

卸载先验证 ownership,再以 transaction 移除已注册 hook、skills、`AGENTS.md` 块、install manifest、known session runtime state 与 extended spec。快照检查与 rollback 会拒绝覆盖在最终文件系统操作前已观察到的外部修改;POSIX 没有可移植的 compare-and-replace 原语,因此不承诺排除 check 与 rename/unlink 之间的非协作写入。`.agentsmd-state/backups/` recovery snapshot 与 unknown/foreign state entry 会保留,因此 state dir 通常仍存在。按 §5 **保留 `config.toml` 的 hook/status-line 设置**。卸载还会在 `$CODEX_HOME/agentsmd/hooks/` 留下未注册的 no-op shim,避免当前会话缓存的旧命令报 exit 127;之后 install 会覆盖这些 shim。

对于 npm 安装,先卸载 agentsmd 的 Codex 足迹,再移除全局包:

```bash
agentsmd uninstall
npm uninstall -g @sdsrs/agentsmd
```

插件卸载会移除 Codex 的插件安装/cache 条目。如果你不希望 Codex 继续跟踪本仓库作为 source,
也移除 marketplace:

```bash
codex plugin remove agentsmd --marketplace agentsmd --json
codex plugin marketplace remove agentsmd --json
```

如果你同时使用过独立安装和插件安装,两套清理都要运行;它们管理的是不同的 Codex surface。

### 从 codexmd 升级

如果你之前装过 **codexmd**(v1.4.0–v1.4.3),运行 agentsmd 安装器会检测旧 hook 与 manifest。它只迁移 provenance 可验证的 legacy artifact;同名目录来源不明或内容已修改时会保留并报告,不会按前缀删除。

## 它如何独立于 oh-my-codex?

agentsmd 用当前 `CODEX_HOME/agentsmd` 命令路径识别自己的 `hooks.json` 条目,用 sentinel 识别 `AGENTS.md` 块;deploy、extended spec 与 skills 要求 manifest exact path + content hash。install/update 与 uninstall 都先 preflight;快照检查覆盖最终文件系统操作前已观察到的并发修改,但不把可移植 POSIX 无法消除的 check-to-rename/unlink 间隔描述为原子 CAS。旧 manifest 在 hash baseline 前持久备份到 owner-only `.agentsmd-legacy-backup-*`。`config.toml` 只补缺失值且卸载不删;共享文件不可解析或 owned artifact hash 不匹配时操作中止。fixture 覆盖 OMX 共存、ownership collision、故障注入、mode preservation 与并发写入。

OMX(若在)是编排框架,agentsmd 是纪律/执行力层。二者互补——且 agentsmd **不依赖** OMX。

## 治理——基于机会分母的人工复审

```bash
node scripts/audit.js --days=30    # 按规范章节聚合命中率遥测
node scripts/audit.js --project=X  # 只查看路径中包含 X 的项目(也可用于 rules)
node scripts/rules.js --days=30    # 对照 spec/hard-rules.json 给出升/降级信号
```

只有在积累足够 rule-specific evaluated opportunities 后仍为零 enforcement hit,规则才进入人工降级评审。`--project` 对 rules 仅作信息透镜,逐规则显示本地命中,降级信号仍跨项目。`no-opportunity`、低评估量和全局 session 数都不是降级证据;高命中只证明活跃度。门槛见 `spec/OPERATOR.md`。

## 生成项目级 AGENTS.md

agentsmd 安装到 `~/.codex/AGENTS.md` 的是全局纪律规范(通用的“怎么做”)。要为当前
项目生成包含技术栈、目录与命令事实的项目级 `AGENTS.md`(项目的“是什么”),在项目根目录运行:

```bash
agentsmd init
# 或从已部署目录直接运行:
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/init.js"
```

它检测 Node/Rust/Python/Go,写入 sentinel 管理块;重跑会原位更新并保留块外手写内容。
`--check` 检查漂移,`--dry-run` 只预览。`--check`、`--dry-run` 与 `--local` 是互斥执行模式。

`agentsmd init --local` 会创建仅供个人使用、加入 `.gitignore` 的 `AGENTS.local.md`。
该文件只创建一次,不会覆盖已有内容;命令会提示如何在 Codex 的
`project_doc_fallback_filenames` 中启用它。

对于前端项目,`agentsmd init` 会识别 React/Vue/Svelte/Angular/Solid/Preact 及
Next/Nuxt/Remix/Astro/SvelteKit 等框架,并加入确定性的 `## Frontend` 技术栈事实。
不需要这部分时传 `--no-frontend`;非前端项目不受影响。

## 提炼项目约定

`init` 只生成技术栈事实。要从源码提炼命名、import、错误处理和注释等隐含约定,
可在 Codex 会话中使用 `agentsmd-analyze` skill,或先直接运行确定性的收集阶段:

```bash
agentsmd analyze --gather
```

收集结果是带上限、遵循 ignore 规则的源码图。阅读并提炼内容是唯一的 AI 步骤;
完成后用 `agentsmd analyze --write --from <file>` 写入 `AGENTS.md` 的
`agentsmd:conventions` 管理块。约定块超过 6 KiB 或整个文件接近默认 32 KiB 上限时,
命令会拒绝写入而不是静默截断。

## 查看约定采用情况

`analyze --write` 会为已识别的约定标题加入稳定的 `@conv-*` anchor。Stop hook 只记录
当前项目 `AGENTS.md` 中真实存在且被输出引用的 anchor;伪造的 anchor 不计数。查看采用情况:

```bash
agentsmd analyze --adoption
agentsmd analyze --adoption --days=7 --project=X
```

零引用只表示需要人工复审,不是自动删除依据;当前 citation 层尚未记录每个 anchor 的
evaluated opportunity。`@conv-*` 引用统计与全局 `§*` enforcement ledger 分开保存。

## 提取设计令牌

对于前端项目,`agentsmd design` 会从 CSS `:root` custom properties 与 Tailwind v4
`@theme` 提取事实,生成 `DESIGN.md` 管理块并在 `AGENTS.md` 中加入一行指针:

```bash
agentsmd design          # 默认预览,不写文件
agentsmd design --write  # 写入 DESIGN.md 与 AGENTS.md 指针
```

输出按颜色、间距、字体、圆角、阴影等类别分组,并受预算保护;超限时拒绝而不截断。
非前端项目是 no-op。Tailwind v3 的主题位于 `tailwind.config.js` 时,命令会如实说明
尚未解析配置对象,不会假装已提取令牌。

## 开发

```bash
npm test    # 安装/独立性 + 闭环遥测 + drift + distribution + hook 冒烟 套件
```

`scripts/tests/drift.test.js` 是 CI 门禁,让 `spec/`、`hard-rules.json`、两处 hook 接线与版本号保持同步。架构与分阶段历史见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

## 布局

```
bin/         npm CLI 入口——`agentsmd` CLI 对 scripts/ 的 dispatcher
spec/        正典规范(core、extended、changelog、hard-rules.json、OPERATOR.md)
hooks/       L1 强制层——原生 hook + 共享 lib + 冒烟测试
scripts/     L2 管理层——install/uninstall/status/doctor/audit/rules(+ migrate + 测试)
skills/      L3 命令层——每个面向用户的脚本对应一个 agentsmd-* skill stub(见 skills/)
.agents/     repo marketplace metadata,固定指向 npm artifact
.codex-plugin/plugin.json   Codex 插件清单
hooks.json   插件根的 hook 接线(相对路径)
install.sh   适合 curl 的独立安装/更新/卸载入口
```

## 常见问题

**agentsmd 和 codexmd 是同一个吗?**
是。`codexmd` 是旧名;项目在 v2.0.0 更名为 `agentsmd` 以与仓库一致。同一个系统、同一份 `CODEX-CODING-SPEC`,只是工具身份变了。旧 artifact 只有在 provenance 可验证时才迁移。

**必须装 oh-my-codex 才能用 agentsmd 吗?**
不必。agentsmd 可独立安装运行。若恰好装了 OMX,两者共存且互不触碰对方的配置。

**它能用于原生的 OpenAI Codex CLI 吗?**
standalone installer 面向原生 hook 配置,`doctor` 检查部署 wiring、可执行位、依赖、flag、manifest 与 spec inventory。仓库 smoke suite 覆盖 snake_case fixture 和 block/advisory/context JSON;fixture 之外的 runtime compatibility 取决于具体 Codex 版本。

**它会改动我现有的 `~/.codex` 配置吗?**
只改已识别的共享条目与 manifest-owned standalone artifact,并拒绝触碰不可解析的共享文件或 hash 不匹配的 artifact。model、profile 与其他插件配置不在 mutation set 内。

**如何更新或移除?**
独立安装:重跑 curl 安装器或 `node scripts/install.js`;用 `install.sh --uninstall`
或 `node scripts/uninstall.js` 移除。npm:重跑
`npm install -g @sdsrs/agentsmd@latest` 后 `agentsmd install`(或一次性
`npx --package @sdsrs/agentsmd@latest agentsmd install`);用 `agentsmd uninstall` 后
`npm uninstall -g @sdsrs/agentsmd` 移除。插件安装:先
`codex plugin marketplace upgrade agentsmd`,再
`codex plugin add agentsmd --marketplace agentsmd`;用
`codex plugin remove agentsmd --marketplace agentsmd` 移除。

## 许可

MIT
