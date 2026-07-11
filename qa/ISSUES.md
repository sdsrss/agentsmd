# QA issue ledger

### ISSUE-001 | P2 | OPEN | 中文 README 缺少项目初始化、约定分析与设计令牌功能说明
- 发现轮次: 0    修复 commit: —
- 复现: `rg -n '^## (Generate a project-level|Distill project conventions|Convention adoption|Capture design tokens)' README.md`; then run the equivalent query against `README.zh-CN.md` → English has four sections, Chinese has none.
- 期望: 中文用户能从本地中文 README 发现 `init`、`analyze --gather/--write/--adoption`、`design [--write]` 的用途、边界和关键参数 / 实际: 中文 README 从治理章节直接跳到开发章节，只能从 CLI help 或英文文档发现这些主功能。
- 根因与备注: 英文 README 新增项目级命令章节后，中文 README 未同步。属于用户功能可发现性缺陷，不改变产品语义，可用 README 结构一致性测试防回归。

### ISSUE-002 | P3 | OPEN | 中文 README 插件章节缺少图形界面安装路径
- 发现轮次: 0    修复 commit: —
- 复现: compare `sed -n '143,182p' README.md` with the plugin section in `README.zh-CN.md` → English documents Codex app/CLI plugin browser actions; Chinese only documents experimental CLI commands.
- 期望: 中文插件用户在没有 `codex plugin` 子命令时能找到 app/`/plugins` 安装路径 / 实际: 中文段落提到插件浏览器，但没有可执行步骤。
- 根因与备注: 插件浏览器说明只同步到英文文档。与 ISSUE-001 同属 README 中英功能漂移，可在同一处修复并用同一结构测试覆盖。

### ISSUE-003 | P3 | OPEN | 中文 README 治理示例遗漏 `--project` 作用域
- 发现轮次: 0    修复 commit: —
- 复现: `rg -n -- '--project=X|informational lens|信息' README.md README.zh-CN.md` → English governance section documents `audit --project=X` and `rules` scoping; Chinese governance section does not.
- 期望: 中文用户能发现按项目查看 telemetry/rules 的命令与“仅信息透镜、降级信号仍跨项目”的边界 / 实际: 只能看到未限定范围的 `--days=30` 示例。
- 根因与备注: governance 文档后续参数扩展未同步中文。与 ISSUE-001 同属 README 中英功能漂移，可合并修复提交，但提交信息必须列出全部 ID。

### ISSUE-004 | P2 | NEEDS_CONFIRMATION | 非法参数在不同子命令间返回 1 或 2
- 发现轮次: 1    修复 commit: —
- 复现: run `node bin/agentsmd.js init --check --dry-run; node bin/agentsmd.js audit --days=-1; node bin/agentsmd.js design --bogus; node bin/agentsmd.js status --bogus` and record statuses → `init`/`audit` return 1 while `design`/`status` return 2 for the same class of CLI usage error.
- 期望: 自动化调用者能用一致退出码区分“命令使用错误”和“有效命令得到不健康/有缺口结果” / 实际: 手写 parser 的 `init`、`analyze`、`audit`、`rules`、`sampling-audit`、`lesson-bypass-audit`、`sparkline` 及 `perf-baseline` 的部分值校验返回 1；基于 `ArgvError` 的入口通常返回 2。
- 根因与备注: 各脚本独立演进，参数错误的退出码约定未统一。方案 A: 全部非法 argv 统一为 2（推荐，符合现有 `ArgvError`、status/doctor/install/uninstall/restore 约定，风险是依赖旧 exit=1 的脚本需调整）；方案 B: 保留现状但在 help/README 逐命令记录退出码（零兼容风险，但自动化体验继续不一致）；方案 C: 全部归一为 1（实现简单，但会失去 usage/runtime/result 分类且改变更多既有入口）。这是外部调用者可见行为，未经产品确认不直接修改。
