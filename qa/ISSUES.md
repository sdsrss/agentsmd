# QA issue ledger

### ISSUE-001 | P2 | VERIFIED | 中文 README 缺少项目初始化、约定分析与设计令牌功能说明
- 发现轮次: 0    修复 commit: 71aa10e
- 复现: `rg -n '^## (Generate a project-level|Distill project conventions|Convention adoption|Capture design tokens)' README.md`; then run the equivalent query against `README.zh-CN.md` → English has four sections, Chinese has none.
- 期望: 中文用户能从本地中文 README 发现 `init`、`analyze --gather/--write/--adoption`、`design [--write]` 的用途、边界和关键参数 / 实际: 中文 README 从治理章节直接跳到开发章节，只能从 CLI help 或英文文档发现这些主功能。
- 根因与备注: 英文 README 新增项目级命令章节后，中文 README 未同步。新增三条 README drift 断言；修复前 `node scripts/tests/drift.test.js` 为 17 passed / 3 failed，修复后为 20 passed / 0 failed。原复现命令已在 Round 1 重放，中文四个章节均可定位。

### ISSUE-002 | P3 | VERIFIED | 中文 README 插件章节缺少图形界面安装路径
- 发现轮次: 0    修复 commit: 71aa10e
- 复现: compare `sed -n '143,182p' README.md` with the plugin section in `README.zh-CN.md` → English documents Codex app/CLI plugin browser actions; Chinese only documents experimental CLI commands.
- 期望: 中文插件用户在没有 `codex plugin` 子命令时能找到 app/`/plugins` 安装路径 / 实际: 中文段落提到插件浏览器，但没有可执行步骤。
- 根因与备注: 插件浏览器说明只同步到英文文档。与 ISSUE-001 同根因合并修复；Round 1 原复现步骤重放后，中文 README 可定位 app **插件** 与 CLI `/plugins` 两条动作。

### ISSUE-003 | P3 | VERIFIED | 中文 README 治理示例遗漏 `--project` 作用域
- 发现轮次: 0    修复 commit: 71aa10e
- 复现: `rg -n -- '--project=X|informational lens|信息' README.md README.zh-CN.md` → English governance section documents `audit --project=X` and `rules` scoping; Chinese governance section does not.
- 期望: 中文用户能发现按项目查看 telemetry/rules 的命令与“仅信息透镜、降级信号仍跨项目”的边界 / 实际: 只能看到未限定范围的 `--days=30` 示例。
- 根因与备注: governance 文档后续参数扩展未同步中文。与 ISSUE-001 同根因合并修复；Round 1 原复现步骤重放后，`audit.js --project=X`、仅作信息透镜、降级信号仍跨项目三项均可定位。

### ISSUE-004 | P2 | NEEDS_CONFIRMATION | 非法参数在不同子命令间返回 1 或 2
- 发现轮次: 1    修复 commit: —
- 复现: run `node bin/agentsmd.js init --check --dry-run; node bin/agentsmd.js audit --days=-1; node bin/agentsmd.js design --bogus; node bin/agentsmd.js status --bogus` and record statuses → `init`/`audit` return 1 while `design`/`status` return 2 for the same class of CLI usage error.
- 期望: 自动化调用者能用一致退出码区分“命令使用错误”和“有效命令得到不健康/有缺口结果” / 实际: 手写 parser 的 `init`、`analyze`、`audit`、`rules`、`sampling-audit`、`lesson-bypass-audit`、`sparkline` 及 `perf-baseline` 的部分值校验返回 1；基于 `ArgvError` 的入口通常返回 2。
- 根因与备注: 各脚本独立演进，参数错误的退出码约定未统一。方案 A: 全部非法 argv 统一为 2（推荐，符合现有 `ArgvError`、status/doctor/install/uninstall/restore 约定，风险是依赖旧 exit=1 的脚本需调整）；方案 B: 保留现状但在 help/README 逐命令记录退出码（零兼容风险，但自动化体验继续不一致）；方案 C: 全部归一为 1（实现简单，但会失去 usage/runtime/result 分类且改变更多既有入口）。这是外部调用者可见行为，未经产品确认不直接修改。

### ISSUE-005 | P2 | VERIFIED | Standalone installer 静默接受冲突 action 并执行最后一个
- 发现轮次: 2    修复 commit: 8413d06
- 复现: in an isolated installed `CODEX_HOME`, run `sh install.sh --source "$PWD" --status --uninstall`; then `node bin/agentsmd.js status | jq -r .installed` → command exits 0, executes uninstall, and changes `installed` from true to false.
- 期望: 同一次调用出现多个 lifecycle action 时，在读取或修改 CODEX_HOME 前拒绝并明确报错 / 实际: parser repeatedly overwrites `ACTION`, so the final flag wins silently and `--status --uninstall` performs an unexpected destructive lifecycle action.
- 根因与备注: `install.sh` 没有记录 action flag 是否已经出现。新增 distribution regression；修复前 32 passed / 1 failed，修复后 33 passed / 0 failed。Round 2 原命令重放结果为 `before=true exit=1 after=true`，stderr 明确列出 `--status` 与 `--uninstall`，因此冲突调用未改变安装状态。
