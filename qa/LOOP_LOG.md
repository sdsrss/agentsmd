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

## Round 1（2026-07-11）
- 覆盖: 两个画像交替重放 18 个 CLI 入口、隔离 CODEX_HOME 的 install→status→doctor→update→restore-list→uninstall、中文/空格/emoji 项目的 init/analyze/design、治理/诊断非法参数、管道/重定向、npm package dry-run、完整测试与 shell lint（用例数: 80 个用户旅程场景 + 905 个自动化断言 + 1 个 shell lint 命令，对比上轮: 902 个断言 + 1 lint）
- 新发现: P0:0 P1:0 P2:1 P3:0（ISSUE-004）
- 修复并复验: ISSUE-001, ISSUE-002, ISSUE-003（71aa10e）；三项均按原复现步骤重放并标记 VERIFIED
- 遗留 / 待确认: ISSUE-004 为 NEEDS_CONFIRMATION；真实 Codex plugin UI/runtime、多版本 Node/macOS、远程 registry/CI 仍是沙箱盲区。
- 退出判定: 未满足（本轮出现新 P2，连续干净轮归零；ISSUE-004 虽不阻塞 P0/P1/P2 总账条件，但需产品确认退出码兼容策略）
- 下轮计划: 候选退出轮执行同等规模全功能回归；加深 standalone installer、恢复 dry-run/confirm fixture、重复/乱序参数与 hook 变体；若无 P0-P2 新发现，记为连续干净轮 1/2。

## Round 2（2026-07-11）
- 覆盖: 重读三份 QA 状态文件；完整双画像用户旅程；新增 standalone local-source install→冲突 action→状态不变→uninstall 场景；隔离 restore list/非法参数；全部 CLI、项目命令、治理诊断、hook、package 与 shell lint 回归（用例数: 85 个用户旅程场景 + 906 个自动化断言 + 1 个 shell lint 命令，对比上轮: 80 + 905 + 1）
- 新发现: P0:0 P1:0 P2:1 P3:0（ISSUE-005）
- 修复并复验: ISSUE-005（8413d06）；原复现命令重放为 `before=true exit=1 after=true`，已标记 VERIFIED
- 遗留 / 待确认: ISSUE-004 为 NEEDS_CONFIRMATION；外部 runtime 与跨平台盲区不变。
- 退出判定: 未满足（本轮发现新 P2，即使已修复也使连续干净轮归零）
- 下轮计划: 执行不低于本轮规模的全功能回归，重点复验 ISSUE-005 与 restore confirm/rollback、action 重复/顺序变体；若无 P0-P2 新发现，记为连续干净轮 1/2。

## Round 3（2026-07-11）
- 覆盖: 候选退出全功能回归；87 个双画像用户旅程覆盖全部 18 个 CLI、isolated lifecycle、standalone installer 冲突/逆序/重复 action、项目生成/分析/设计、治理诊断、pipe/redirect、package；完整 906 条自动化断言覆盖 restore confirm/rollback、15 hooks 与并发/故障 fixture；shell lint（用例数: 87 + 906 + 1，对比上轮: 85 + 906 + 1）
- 新发现: P0:0 P1:0 P2:0 P3:0（无）
- 修复并复验: 无新增修复；ISSUE-005 的原顺序、逆序、重复 action 均复验通过
- 遗留 / 待确认: ISSUE-004 为 NEEDS_CONFIRMATION；外部 runtime 与跨平台盲区不变。
- 退出判定: 未满足（连续干净轮 1/2；其余退出条件满足）
- 下轮计划: 再执行一次不低于 87 + 906 + 1 的候选退出全功能回归；若仍无 P0-P2 新发现，生成 FINAL_REPORT 并停止。

## Round 4（2026-07-11）
- 覆盖: 候选退出全功能回归原样重放；全新临时目录上的 87 个双画像用户旅程、全部 18 个 CLI、两套隔离安装路径、项目/治理/诊断/pipe/redirect/package，以及内嵌完整 906 条自动化断言与 shell lint（用例数: 87 + 906 + 1，对比上轮: 87 + 906 + 1）
- 新发现: P0:0 P1:0 P2:0 P3:0（无）
- 修复并复验: 无新增修复；历史 VERIFIED 问题均由完整回归覆盖
- 遗留 / 待确认: ISSUE-004 为 NEEDS_CONFIRMATION；外部 runtime 与跨平台盲区不变。
- 退出判定: 满足（连续干净轮 2/2；无 OPEN 或 FIXED 未复验的 P0/P1/P2；完整测试、发布包 E2E 与 shell lint 通过）
- 下轮计划: 无；生成 FINAL_REPORT 后停止，等待用户决定 ISSUE-004，不合并、不 push。

## Round 5（2026-07-11，用户确认后的续测）
- 覆盖: 用户确认 ISSUE-004 方案 A 后，重放 10 个 argv/usage 入口与 3 个有效负面/运行时路径；dispatcher、standalone installer、中英 contract 文档、argv static gate；完整 87 个用户旅程与 908 条自动化断言、shell lint（另独立重复执行一次完整 `npm run check`）
- 新发现: P0:0 P1:0 P2:0 P3:0（无）
- 修复并复验: ISSUE-004（827d4f1）；原复现矩阵全部 exit 2，有效负面/运行时路径保持 exit 1，标记 VERIFIED
- 遗留 / 待确认: 无；外部 runtime 与跨平台盲区不变。
- 退出判定: 未满足（公开 CLI contract 刚变更，续测干净轮 1/2）
- 下轮计划: 重读 QA 状态后再执行一次 87 + 908 + 1 的全功能回归；无新增问题则恢复连续干净轮 2/2 并更新 FINAL_REPORT。

## Round 6（2026-07-11）
- 覆盖: 重读三份 QA 状态文件；全新 fixture 原样重放 87 个双画像用户旅程，包括统一后的顶层/子命令/standalone argv exit=2 contract；内嵌完整 908 条自动化断言、npm package dry-run 与 shell lint（用例数: 87 + 908 + 1，对比上轮: 87 + 908 + 1，另有 Round 5 独立重复 check）
- 新发现: P0:0 P1:0 P2:0 P3:0（无）
- 修复并复验: 无新增修复；ISSUE-004 及全部历史 VERIFIED 问题由完整回归覆盖
- 遗留 / 待确认: 无；外部 runtime 与跨平台盲区不变。
- 退出判定: 满足（用户确认后的连续干净轮 2/2；5 个问题全部 VERIFIED；完整测试、发布包 E2E 与 shell lint 通过）
- 下轮计划: 无；更新 FINAL_REPORT 后停止，不合并、不 push。

## Round 7（2026-07-11，v4.0.0 release review）
- 覆盖: v4.0.0 结构化版本/两个 changelog、version cascade、drift、distribution、package 86-file dry-run、publish dry-run、safety coverage、argv lint、secret scan、独立 release review；复验用户旅程版本动态读取与 standalone value-option misuse
- 新发现: P0:0 P1:1 P2:1 P3:1（ISSUE-006, ISSUE-007, ISSUE-008）
- 修复并复验: ISSUE-006（cfd5bb9）、ISSUE-007（0bb7d0f）、ISSUE-008（427f850）；均按原步骤重放并标记 VERIFIED
- 遗留 / 待确认: 无；reviewer live 安装事故由用户确认保留，发布后正式 latest 覆盖。
- 退出判定: 未满足（本轮出现新 P1/P2，连续干净轮归零）
- 下轮计划: 执行两轮 87 + 909 + 1 全功能候选回归；连续无新增问题后方可 push/publish。

## Round 8（2026-07-11）
- 覆盖: v4.0.0 release commit 后的候选退出全功能回归；全新 fixture 上 87 个双画像用户旅程、909 条自动化断言、npm package dry-run 与 shell lint（用例数: 87 + 909 + 1）
- 新发现: P0:0 P1:0 P2:0 P3:0（无）
- 修复并复验: 无新增修复；ISSUE-006/007/008 与全部历史问题由完整回归覆盖
- 遗留 / 待确认: 无。
- 退出判定: 未满足（release review 后连续干净轮 1/2）
- 下轮计划: 再执行同等规模全功能回归；无新增问题则进入 push/publish。
