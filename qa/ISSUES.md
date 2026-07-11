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
