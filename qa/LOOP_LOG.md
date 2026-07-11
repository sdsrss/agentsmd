# Iterative self-test log

## Configuration

- Commands discovered: `npm test`; `npm run lint:shell`; combined `npm run check`.
  No build, typecheck, start, server, or dependency-install step exists. Package
  construction is exercised by the distribution test (`npm pack` in a temporary
  prefix).
- MAX_ROUNDS: 10
- Required consecutive clean full-regression rounds: 2
- Git: branch `qa/self-test`; local tag `qa-baseline`; one local commit per fix;
  push and force operations prohibited.
- Prohibited product changes: none beyond the global safety and sandbox rules.
- Sandbox: repository and local temporary services/fixtures only. All lifecycle
  commands use an isolated temporary `CODEX_HOME`; no production, real accounts,
  real user data, publishing, or shared remote operations.

## Round 0（2026-07-11）
- 覆盖: 首次运行检测；README/CLI/CI/脚本/测试/19 类用户功能盘点；Node、npm、jq、ShellCheck 环境确认；完整现有测试与 shell lint 基线（用例数: 902 个测试断言 + 1 个 shell lint 命令，对比上轮: N/A）
- 新发现: P0:0 P1:0 P2:1 P3:2（ISSUE-001, ISSUE-002, ISSUE-003）
- 修复并复验: 无（第 0 轮仅准备、立案与建立基线）
- 遗留 / 待确认: ISSUE-001 至 ISSUE-003 待第 1 轮按 RED→修复→原步骤复验；真实 Codex plugin UI/runtime、多版本 Node/macOS、远程 registry/CI 为沙箱盲区。
- 退出判定: 未满足（准备轮不计入连续干净轮；存在 OPEN P2；尚未完成真实用户全功能走查）
- 下轮计划: 两个画像交替执行全部 CLI/生命周期/诊断/治理入口；先为 README 中英功能漂移加入失败断言，再最小修复并独立提交；继续抽样特殊字符、非法参数、管道/重定向、乱序和重复操作。

## Baseline evidence

- Branch/tag: `qa/self-test`; `qa-baseline` → `aa8c519c03077eec73a0996d8200e16c24636372`.
- Environment: Node `v22.21.0`; npm `11.6.2`; jq `1.7`;
  ShellCheck `0.9.0`.
- `npm test`: exit 0; 902 passed, 0 failed across the 20 Node suites and hook
  smoke suite.
- `npm run lint:shell`: exit 0; no diagnostics.
- Baseline worktree before QA files: clean.
