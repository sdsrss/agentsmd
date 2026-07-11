# QA final report

## 执行摘要

- 结果: 达到本任务定义的可发布质量退出条件。
- 轮次: Round 0 准备 + 6 个循环轮；用户确认 CLI contract 后，Round 5、Round 6 为连续两轮无新增问题的全功能回归。
- 问题: 共 5 个，P0:0、P1:0、P2:3、P3:2。
- 处理: 5 个均已修复并按原步骤复验为 VERIFIED；无 OPEN、FIXED 未复验、NEEDS_CONFIRMATION、WONTFIX 或 CANNOT_REPRODUCE。
- 最终新鲜证据: `qa/user-journey.sh` 87 passed / 0 failed；其内 `npm run check` 完成 908 passed / 0 failed 的 Node+hook 自动化断言及 ShellCheck 0 diagnostics；`npm pack --dry-run` 发布包入口检查通过。
- Git: `qa/self-test`，基线 tag `qa-baseline`；所有修复为独立本地 commit；未 push、未 force、未合并。

## 修复清单

- ISSUE-001 ↔ `71aa10e` — 补齐中文 README 的 init/analyze/adoption/design 用户路径，并加入 drift 防回归。
- ISSUE-002 ↔ `71aa10e` — 补齐 Codex app 与 `/plugins` 插件浏览器步骤。
- ISSUE-003 ↔ `71aa10e` — 补齐治理 `--project` 示例与仅信息透镜/跨项目降级边界。
- ISSUE-004 ↔ `827d4f1` — 顶层 dispatcher、所有子命令与 standalone installer 的 argv/usage 错误统一为 exit 2；有效负面/运行时结果保持 exit 1。
- ISSUE-005 ↔ `8413d06` — standalone installer 拒绝冲突或重复 lifecycle action；结合 ISSUE-004 后返回 exit 2，安装状态保持 true。

## ⚠️ 需要逐条确认的事项

- 无。ISSUE-004 已按用户确认的方案 A 修复并 VERIFIED。

## 遗留 P3

- 无。发现的两个 P3（ISSUE-002、ISSUE-003）均已 VERIFIED。

## 测试盲区

- 未连接真实 Codex plugin browser/cache，未覆盖所有 Codex runtime/version 的真实激活；仅验证 manifest、wiring、package 与隔离安装路径。
- 当前主机为 Linux + Node 22；CI 声明的 Node 18/20/24 与 macOS 行为由 fixture/既有测试代表，本轮未在对应操作系统上新鲜执行。
- 按沙箱边界未触碰真实 GitHub/npm registry、共享分支 CI、生产配置、第三方账号或真实用户数据；相关逻辑只用本地 fixture/mock。
- 没有 start/build/typecheck 服务或脚本；项目为 Node CLI + shell hooks，发布包形态由 distribution E2E 与 `npm pack` 检查。

## 技术债建议

- 保留 dispatcher contract 矩阵和 `agentsmd-lint-argv` gate，防止新增手写 parser 再次产生退出码或静默回退漂移。
- 在发布流水线保留 Node 18/20/22/24 + macOS hook matrix，并增加可用 Codex 版本上的 plugin 安装冒烟。
- 保留 `qa/user-journey.sh` 作为候选发布门禁；它使用隔离 `CODEX_HOME`、多语言/emoji fixture、误用与管道场景，并在退出时清理任务创建的临时目录。
