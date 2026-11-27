# AhaStudio 编排模块后续演进规划（v5 · `main @ cd1b3df`）

> **输入依据**：
> - 三方只读调研报告（Aha / Orca / T3 Code 编排架构横向深度调研）
> - `/swarm` 协作机制精华提炼（门铃经济学、零拷贝 `#seq`、语义停摆监测、零成本休眠、交付概览）
> - 仓库实地核验与 Stage 0 收口后基线（`main @ cd1b3df`，2026-11-28）

---

## 1. 核心定位与 `cd1b3df` 实地核验基线

AhaStudio 在**本地多 Agent 编码闭环产品语义**上已经领先同类项目（不可变快照、异构对抗评审、集成分支、`report_done` 结算红线、`unknown_acceptance` 不重发），当前升级主线为**双轨推进**：

1. **协作体验轨（源自 `/swarm` + T3 交接理念）**：降 Token、防卡死自愈、跨 CLI 限额原位接力、看板交付总览。
2. **架构地基轨（源自 Orca 可靠性 + T3 显式边界）**：先定持久化确认与事务边界再拆破万行 Service/Store、完善能力驱动与单写者所有权、按需演进持久化。

### 已合入 `main @ cd1b3df` 的前期里程碑（Stage 0 已完成）

- **PR #13（`10155f2`，`feat/multi-driver-orchestration`）**：
  - [`electron/agent-drivers/driver-capabilities.ts`](../electron/agent-drivers/driver-capabilities.ts) 已为 `codex / claude / antigravity / grok` 开启 `orchestration: true`（`opencode / pi` 保持 terminal-only）；
  - 新增 [`electron/orchestration/headless-workers.ts`](../electron/orchestration/headless-workers.ts)（114 行）：集中定义 `HEADLESS_WORKER_DRIVERS`、`headlessWorkerSupports`、`headlessWorkerControlsError`、`ahaToolDecision`、`sessionGateDecision`、`parseAhaMcpToolName`；
  - 新增 [`electron/agent-drivers/secret-redaction.ts`](../electron/agent-drivers/secret-redaction.ts)；[`coordinator-prompt.ts`](../electron/orchestration/coordinator-prompt.ts) 已同步多 driver headless 说明与 ACP 退场指令 `ORCHESTRATION_ENDED_INSTRUCTIONS`。
- **PR #14（`ca0a500`，`feat/headless-worker-controls-3c`）**：
  - 新增 [`electron/orchestration/worker-native-questions.ts`](../electron/orchestration/worker-native-questions.ts)（321 行）：统一托管 Codex `requestUserInput`、Claude `AskUserQuestion`、ACP 表单与 Grok `ask_user_question`，并已接入 `inspectRunsForStallWatchdog` 的 `hasPendingAttention`；
  - 新增 [`src/components/ProposalWorkerControls.tsx`](../src/components/ProposalWorkerControls.tsx) 与 [`src/components/WorkerNativeQuestionCard.tsx`](../src/components/WorkerNativeQuestionCard.tsx)，同步完善 headless worker 启停/退出事件与 `openNativeQuestions` 快照合流。
- **Stage 0 收口（`cd1b3df`，`codex/orchestration-handoffs` 快进合入 + 全量旧 Worktree 清理）**：
  - 已合入 `codeDeps`、`QueuedWorkerLaunch`（`waiting / claimed / needs_reconciliation`，已补齐 PR #14 的 `policy / network / allowSubWorkers / userInitiated` 透传）、`IntegrationIntent`、`finalizedBatches`、看板逐接收方回执 `receipts: Record<string, 'notified' | 'delivered' | 'replied'>`、保留 worktree 历史保护，以及 [`src/components/RunAttention.tsx`](../src/components/RunAttention.tsx) 与 [`tests/orchestration-handoffs.test.mjs`](../tests/orchestration-handoffs.test.mjs)；
  - 已回收全部 11 个旧 worktree（含 9 个已合并 worktree、被 PR #14 替代的旧 `feat/headless-worker-controls` 及已合入的 `orchestration-handoffs`）；
  - 合入验证：`npm run typecheck`、`npx vite build`、`npm run test:fast`（552 通过 / 0 失败 / 2 macOS 跳过）、`npm run test:e2e`（27/27 全通过）。

### `cd1b3df` 关键文件体量与区段基线

| 文件 | 行数 | 当前状态 |
| --- | --- | --- |
| [`electron/orchestration/orchestration-service.ts`](../electron/orchestration/orchestration-service.ts) | **10,736** | 已含 handoffs/multi-driver 全量逻辑，Stage 2 拆解锚点稳定 |
| [`electron/orchestration/orchestration-store.ts`](../electron/orchestration/orchestration-store.ts) | **4,025** | 单文件 `orchestration-state.json`（上限 200 消息/Run、50 Run，异步写盘） |
| [`electron/orchestration/worker-git-integration.ts`](../electron/orchestration/worker-git-integration.ts) | **2,251** | 已含 `IntegrationIntent` 钩子，后续与清理 Outbox 解耦 |
| [`src/components/OrchestrationBoardPanel.tsx`](../src/components/OrchestrationBoardPanel.tsx) | **2,425** | 已有 `board / members / graph`、原生提问与送达状态，缺 `Overview` 与视觉时间线 |
| [`electron/orchestration/headless-workers.ts`](../electron/orchestration/headless-workers.ts) | **114** | 多 driver headless 策略基座（Stage 3A/3B 直接复用与扩展） |
| [`electron/orchestration/worker-native-questions.ts`](../electron/orchestration/worker-native-questions.ts) | **321** | 原生提问生命周期管理器（已独立模块化） |

---

## 2. 不可回退红线（保护清单）

任何重构与新特性都必须保证以下 10 条不变量零退化，并持续遵守技术栈约束（`Electron 45 + React 18 + Vite 6 + TypeScript + 纯 CSS`，不引入 Effect-TS / Tailwind / React 19 / Base UI / TipTap）：

1. **结算隔离**：Turn 结束绝不 settle dispatch，仅显式 `report_done / worker_done` 可结算。
2. **投递防双写**：仅 `not_accepted` 允许 PTY fallback；`unknown_acceptance` 与中断的 `queuedLaunch(claimed)` 绝不自动重发或 fallback（进入 `needs_reconciliation` 核对）。
3. **身份与凭证脱敏**：`dispatchCapability` 与 MCP secret（[`secret-redaction.ts`](../electron/agent-drivers/secret-redaction.ts)）强校验且在日志、看板、审批、原生提问、交接工件中强制脱敏。
4. **投递围栏**：`consumer_generation` / `consumer_fenced` 严格生效，防止旧进程/旧面板误消费。
5. **不可变快照与防篡改**：临时 `GIT_INDEX_FILE` 生成不可变 OID；拒绝 staged/unstaged 分叉；`strictReviewedTree: true` 阻断 Hook 篡改。
6. **异构对抗评审防火墙**：强制回避**所有参与编写的作者 CLI 集合**（不仅是当前 CLI，单 CLI 机器外）、独立 detached review worktree、隐藏作者自述与作者报告/交接帖（`isPostHiddenByReviewFirewall`）、跨 Run 鉴权隔离。
7. **脏主区保护与目标分支绑定**：脏 `main` 走 `aha/run/<runId>`；严禁 detached HEAD 建集成分支或合错分支（包括人工强制放行）。
8. **审批门禁不可绕过**：`chat-and-guard` / `always-ui` 同时约束 MCP 与 CLI/HTTP 评审入口，以及 `sessionGateDecision` 控制的非 Codex Coordinator 动作。
9. **单写者接管**：页面内人工接管与跨 CLI 接力移交前，必须通过显式所有权锁（claim/fence）与落盘确认，确保原控制者及其子进程均已停止写入。
10. **克制唤醒**：保留 `PeerPingPongTracker` 上限、保留 `nativeQuestions` / `approvals` / `gates` / `proposals` 的 `hasPendingAttention` 静默保护，且**只要还有成员处于 `working` 状态，就绝不触发全局停摆告警**。

---

## 3. 演进依赖与推进图

Stage 0 已在 `main @ cd1b3df` 完成，后续所有阶段按 **独立 PR 粒度** 在独立 worktree 中推进：

```mermaid
flowchart LR
    S0["Stage 0: 已完成（main @ cd1b3df）"] --> S1A["Stage 1A: Prompt 与 MCP 协议速赢"]
    S1A --> S2["Stage 2: 定持久化确认/事务接口 & 拆 Service/Store"]
    S2 --> S1B["Stage 1B: 在 board-service 升级 Watchdog"]
    S1B --> S3A["Stage 3A: 扩展能力矩阵/headless-workers 与 ProviderRefs"]
    S3A --> S3B["Stage 3B: 跨 CLI 接力 + ResumeClaim + 作者集合回避"]
    S3B --> S3C["Stage 3C: CLI 断线 requestId 幂等与事实完善"]
    S2 --> S4BC["Stage 4B/4C: CleanupOutbox + 看板 Overview/时间线"]
    S3C -. "按需双路径评估" .-> S4A["Stage 4A: JSONL（历史量） / node:sqlite（联合恢复）"]
```

---

## 4. 分阶段可执行规划（按独立 PR 拆分）

### Stage 0：分支决策与旧 Worktree 清理 — **已完成（`main @ cd1b3df`）**

- `codex/orchestration-handoffs` 已同步 `main`、对齐 PR #13/#14 字段并通过全量测试（`test:fast` 552/554 + `test:e2e` 27/27），已快进合入本地 `main @ cd1b3df`。
- 9 个已合并 worktree、旧 `feat/headless-worker-controls` 及 `orchestration-handoffs` worktree 与本地旧分支均已回收完毕。

---

### Stage 1A：`/swarm` 协议与上下文经济学速赢（独立 PR，当前下一站）

- **改动范围**（只动 Prompt 与 MCP 工具描述，不改 `orchestration-service.ts` 核心结构）：
  - [`electron/orchestration/coordinator-prompt.ts`](../electron/orchestration/coordinator-prompt.ts)
  - [`electron/orchestration/worker-dispatch-preamble.ts`](../electron/orchestration/worker-dispatch-preamble.ts)
  - [`electron/orchestration/aha-mcp-server.cjs`](../electron/orchestration/aha-mcp-server.cjs)
- **具体措施（已核对 `cd1b3df` 源码行为，零冲突）**：
  1. **门铃原则（仅限非对抗协作）**：明确 `@role` 是唤醒门铃而非抄送（CC）；在**非对抗的同级流水线交接（例如「调研 Worker → 实现 Worker」或「实现 Worker → 测试 Worker」）**中只 `@` 下一棒，绝不顺手抄送 `@coordinator`。**严禁拿 `author → reviewer` 当 `#seq` 交接示例**：对抗评审受 `isPostHiddenByReviewFirewall` 隔离（[`orchestration-service.ts:1406`](../electron/orchestration/orchestration-service.ts#L1406)），作者的 `report / worker_done / handoff / update` 帖子对评审者不可见，评审者只读 detached snapshot worktree 与 diff。
  2. **零拷贝 `#seq` 引用**：禁止协调者把调研 Worker 的报告复制粘贴转述给实现 Worker，改用 `检查 #4 和 #6` + `read_board(seqs=[4, 6])`（对抗评审场景除外）。
  3. **`[done]` 专属于协调者收尾（严禁 Worker 写 `[done]`）**：当前 Watchdog 看到看板最新一帖带 `[done]` 即会抑制停摆提醒（[`orchestration-service.ts:10062`](../electron/orchestration/orchestration-service.ts#L10062)）。因此 **Worker 完工继续统一走 `report_done`（不在正文写 `[done]`）**，`[done]` **严格留给 Coordinator 在整个 Run 确认收尾时发出**，避免单个 Worker 交卷提前关闭整条 Run 的停摆监测。
  4. **所有权前置切分与短 Turn 纪律**：派活前明确文件所有权，从设计上杜绝两 Worker 改同一文件；补充 Coordinator「短 Turn 纪律」（调研/构建/测试均外派）。
  5. **热休眠复用心智与工具消歧**：引导将已完成的 Headless Worker（Codex/Claude/Antigravity/Grok）视为零成本休眠成员，返工优先通过 `@role` 热唤醒复用；厘清 `post_message` vs `message_worker`、`board_wait` vs `team_wait` 的首选边界。
- **验收**：`npm run typecheck` + [`tests/coordinator-prompt.test.mjs`](../tests/coordinator-prompt.test.mjs) + Watchdog/MCP 相关测试全绿。

---

### Stage 2：先定持久化确认与事务接口，再物理拆解 Service 与 Store（拆为 2A / 2B 多个独立 PR）

> **核心原则**：Stage 2 **严格零行为变更**，禁止夹带新特性；验收以**职责边界清晰、无循环依赖、持久化确认契约明确**为准，不设死板行数指标。

#### 2A：为 Store 定义统一变更边界与持久化确认契约，再按职责拆分
- **关键设计**：当前 `AtomicSnapshotWriter` 默认异步写盘（`cd1b3df` 已在关键边界使用 `store.waitForPendingWrite()`），单纯同步 `runTransaction()` 返回并不代表数据已落盘；且 JSONL 不提供 SQL `BEGIN` / `SAVEPOINT`。因此 2A 明确区分两层能力：
  ```ts
  interface OrchestrationUnitOfWork {
    /** 内存级原子多实体变更（所有子 store 共享同一写入上下文，结束后调度单次持久化） */
    runMutation<T>(fn: (tx: OrchestrationStoreTx) => T): T;
    /** 显式等待已提交变更落盘确认（用于移交 claim、结算、释放等崩溃敏感边界） */
    flushDurable(): Promise<void>;
  }
  ```
  - 普通高频状态更新走 `runMutation(...)`；**崩溃敏感边界（如队列 claim、3B 启动新 CLI 前落盘移交记录、Git 发布意图与结算收尾）必须 `await store.flushDurable()` 确认落盘成功后**再执行外部副作用。
  - 若未来启用 SQLite，`runMutation` 内部直接对接 `BEGIN IMMEDIATE` / `SAVEPOINT` 且同步落盘（`flushDurable` 退化为 no-op），上层零改动。
- **子模块边界**（均接收共享 `tx` 上下文）：
  - `orchestration-state-repository.ts`（持久化与 `flushDurable` 抽象）
  - `orchestration-lifecycle-store.ts`（Run / Task DAG / Dispatch / Settlement / `QueuedWorkerLaunch` / Circuit Breaker）
  - `orchestration-mailbox-store.ts`（Message / Delivery / Receipts / Fencing / Question / Gate / Board Cursor）
  - `orchestration-security-store.ts`（Capability 校验、脱敏与容量裁剪）
  - `orchestration-store.ts` 保留为统一 Facade。

#### 2B：将 `orchestration-service.ts`（10,736 行）拆为薄 Facade + 内聚子服务
- 基于 `cd1b3df` 实测区段锚点逐个外提（每外提 1–2 个子服务即运行 `npm run typecheck` + 定向单测，最终合并前跑全量 `npm run test:fast` + `npm run test:e2e`）：
  - `board-service.ts`（看板发帖、游标、`receipts`、`board_wait`、中场注入、停摆监测，参考原 `L9050–L10104`）
  - `review-service.ts`（单 Worker 与 Run 级对抗评审、防火墙、批次汇总、并发启动锁）
  - `integration-service.ts`（`workerIntegrate`、`runDiff`、`runFinalizeIntegration`、`recoverGitPublications`、集成锁与分支守卫）
  - `delegation-service.ts`（提案确认链、语义 `delegateTask`、队列发射 `scheduleQueuedLaunches / launchQueuedTask`、角色路由，参考原 `L7169–L9049`）
  - `worker-lifecycle-service.ts`（`workerStart` / `followUp` / `stop` / `release` / `abandon` / Headless 桥接，协同 `headless-workers.ts` 与 `worker-native-questions.ts`，参考原 `L4765–L7168`）
  - `orchestration-text-views.ts`（`team_status`、看板摘要与快照文本视图，参考原 `L10105–L10736`）

---

### Stage 1B：在拆分后的 `board-service.ts` 升级语义停摆监测（独立 PR）

- **改动范围**：[`electron/orchestration/stall-watchdog.ts`](../electron/orchestration/stall-watchdog.ts)、拆分后的 `board-service.ts`、[`electron/orchestration/board-protocol.ts`](../electron/orchestration/board-protocol.ts)。
- **与红线 10 及 `[done]` 的精确边界**：
  - **严格遵守红线 10**：所有 4 类停摆诊断**仅在 Run 内所有活跃 Worker 均非 `working`、无 `hasPendingAttention`（含审批、原生提问 `nativeQuestions`、普通问答、Gate、提案）且协调者 idle 且无活跃 waiter 时才触发**。
  - **收紧 `lastPostIsDone`**：仅当发帖者是 `coordinator` 且包含 `[done]` 时才视为 Run 已收尾，防止 Worker 误写 `[done]` 静默监测。
- **报告“已处理”判定（直接复用 `cd1b3df` 已合入的看板 `receipts` + 业务状态）**：
  - [`orchestration-service.ts:9797`](../electron/orchestration/orchestration-service.ts#L9797) 中 `read_board(seqs:[...])` 故意不推进 `lastReadSeq`。因此不能仅凭 `post.boardSeq > coordinatorLastReadSeq` 判定报告无人处理，必须结合具体业务事实综合判断：
    - 复用 `cd1b3df` 已落地的消息回执 `post.receipts['coordinator'] === 'replied'` 或协调者针对该 `#seq` 的引用回复/认领帖；
    - 该报告对应的任务或 dispatch 是否已进入后续状态（已开启评审、已集成、已 follow-up、已重新派发或已关闭）。
- **状态优先 + 零浪费 4 类诊断**：
  1. **报告未处理**：存在未满足上述“已处理”依据且未 `@coordinator` 的报告帖 → 点名 `#seq` 提醒 `@coordinator`。
  2. **协调者未读停驻**：存在晚于 `coordinatorLastReadSeq` 的未处理消息 → 列出未处理 `#seq` 提醒 `@coordinator`。
  3. **`@mention` 未获回复（先查状态再决定动作）**：某等待态 Worker 的 `lastMentionedSeq > lastPostSeq` 时：
     - **先检查 driver / session 诊断状态**（错误码、进程退出或 `usageLimits` 限额信号）：若已确认报错或限额，**绝不浪费 Token 发 re-ping turn**，直接一步升级 `@coordinator` 建议换 CLI 接力或人工处理；
     - 仅当 Worker 存活、无报错、无限额信号时，才定向 re-ping 该 `@role` **至多 1 次**；若下个周期仍无新发帖，立刻升级 `@coordinator`。
  4. **兜底全局静默**：未发协调者 `[done]` → 带各成员最后 `#seq` 提醒 `@coordinator`。
- **统一计数与防空转重置**：
  - 将停摆提醒退避计数与现有 `PeerPingPongTracker` 收口到同一 Run 级唤醒预算管理器，同一停摆上限 3 次即静默。
  - **关键约束**：只有**实质进展**（新任务/评审派发、任务/集成状态推进、人工输入、或非系统触发的有效业务回复）才重置 3 次上限；**系统停摆提醒唤醒协调者后，若协调者结束 turn 但任务没有任何进展，绝不能重置 3 次上限**。
- **验收用例清单**：
  1. 覆盖 4 类诊断；
  2. 有 `working` 成员或 `nativeQuestions` 未答时不误报；
  3. 协调者通过 `read_board(seqs:[...])` 点读报告并已回复/启动评审/集成后，不再误报该报告未处理；
  4. 限额/报错直接升 Coordinator，不浪费 Headless re-ping turn；
  5. **系统提醒唤醒协调者但任务无进展时，计数不重置，达到 3 次后稳定静默**。

---

### Stage 3：能力驱动、跨 CLI 原位接力与幂等恢复（拆为 3A / 3B / 3C 三个独立 PR）

#### PR 3A：就地扩展能力矩阵、`headless-workers.ts` 与 `ProviderRefs`
- **基础**：直接建立在 `cd1b3df` 已有的 [`driver-capabilities.ts`](../electron/agent-drivers/driver-capabilities.ts) 和 [`headless-workers.ts`](../electron/orchestration/headless-workers.ts) 之上，不重复实现已有的 `headlessWorkerSupports / headlessWorkerControlsError / ahaToolDecision / sessionGateDecision`。
- **增量内容**：
  1. 在 `AgentDriverCapabilities` 补充尚未声明的编排维度：`nativeThreadIds: 'strong' | 'weak' | 'none'`、`acceptsDeveloperContext`、`supportsSteer`、`hookApprovalDialect`，收口 [`permission-approvals.ts`](../electron/orchestration/permission-approvals.ts) 和 service 内残余的 `cliId` 硬编码分支。
  2. 引入结构化 `ProviderRefs`（App ID 为主身份，Provider session/thread/turn/request ID 仅作引用证据）。
  3. 将散落的策略判断收敛进 `headless-workers.ts` / `orchestration-policy.ts`，能力不足时返回显式结构化原因。

#### PR 3B：跨 CLI 原位接力 + `ResumeClaim` 单写者锁 + 作者集合回避
- **基础**：直接复用 `cd1b3df` 已合入的 `needs_reconciliation`、`reconciliationDiff` 与 `QueuedWorkerLaunch` 落盘认领模式，在其之上扩展可审计、经过 [`secret-redaction.ts`](../electron/agent-drivers/secret-redaction.ts) 与 capability 脱敏的 `ContextTransfer / ContextHandoff` 工件，绝不起第二套平行结构。
- **四条硬约束（必须随 3B 同步落地）**：
  1. **目标 CLI 筛选严格复用现有启动判断**（[`orchestration-service.ts:5564`](../electron/orchestration/orchestration-service.ts#L5564)）：
     - 必须通过 `headlessWorkerSupports(targetCli, workerPolicy)` 且校验运行时可用性（`headlessWorkers.available?.(targetCli) !== false` / `codexPilot.enabled()`）；
     - 沙箱 root 锁定同一 worktree，策略**宁严勿宽**：`antigravity` / `grok` 无 `read-only` 档，禁止接力只读 headless 任务；**`pi` 和 `opencode` 当前完全没有 headless Worker 支持，即使人工同意切换权限也不可作为 headless 接力目标**（仅显式降级为终端 Worker 流程）。
  2. **红线 6（异构评审作者集合回避）**：将 Worker 的作者标识升级为累计集合 `authorCliIds: string[]`。例如 Codex 写一半后由 Claude 接力，作者集合为 `['codex', 'claude']`；单 Worker 评审必须回避整个集合（Run 级评审回避所有已集成 Worker 的作者集合并集），仅当所有可用 CLI 均已参与编写时才显式降级并标明原因。
  3. **红线 9（单写者 `ResumeClaim` + 进程树静默核验）**：引入显式 `ResumeClaim / WorktreeOwnershipFence`，移交前先中断原 CLI、回收其子进程组（如 Windows Job Object），并在启动新 CLI 前做 worktree 快照稳定性校验；若检测到仍有残留后台进程写入，**保留 worktree 现状并暂停移交**，绝不放行双写。
  4. **先落盘再拉起（防崩溃双实例）**：在启动新 CLI 进程**之前**，必须先把 `pending` 态移交记录与 `ResumeClaim` 写入 Store 并 `await store.flushDurable()` 确认落盘；重启恢复时先核对已记录/存活实例，绝不重复拉起第二份 Worker。
- **附带能力**：支持 `delegate_task(forkFrom: "@role")` 热上下文派生（评审模式依然经过对抗防火墙，隐藏作者自述）。
- **必须覆盖的验收用例（含 2 条关键失败验收）**：
  1. **正常闭环**：保留同一 worktree 未提交改动完成跨 CLI 接力，作者集合 `{A, B}` 触发异构评审回避，脱敏无凭证泄露，最终通过评审合入；
  2. **能力与策略拒绝**：`antigravity/grok` 拒绝接力 `read-only` headless 任务；`pi / opencode` 即使请求切权也因无 headless 支持而被 `headlessWorkerSupports()` 拒绝；
  3. **失败验收 1（残留子进程仍在写文件）**：旧 CLI 已确认中断，但模拟其衍生的后台进程仍在改写 worktree 文件 → 系统必须**保留 worktree 不清理、暂停移交并返回明确错误**，不得启动新 CLI 造成双写；
  4. **失败验收 2（拉起新 CLI 后、落盘成功前崩溃）**：移交记录落盘后拉起新 CLI，模拟在写入 `completed` 之前应用崩溃 → 重启后恢复流程核对已落盘的 `pending` 移交/claim 记录与已有实例，**绝不再启动第二份重复 Worker**。

#### PR 3C：CLI 断线 `requestId` 幂等与观测事实补齐（优先级低于 3A / 3B）
- **定位说明**：LLM Agent 调用 MCP 时通常不会跨次携带同一 `requestId` 重试，此项主要服务于 **CLI/HTTP 断线自动重试与前端防重复点击**，排在 3A/3B 之后按轻量范围实现。
- **内容**：
  1. 在已有 `startObservation` 与 `IntegrationIntent / finalizedBatches` 基础上，补齐只增不改的 `AttemptObservationFact` 关键事件覆盖（turn、approval、native question、snapshot、handoff、integration）。
  2. 为 HTTP/CLI 写入口（`worker-start / worker-integrate / run-finalize / worker-release`）增加 `(callerFingerprint, requestId)` 幂等收据与 `--retry-request <id>` 恢复指引，同 ID 异载荷返回 `request_mismatch`。

---

### Stage 4：收尾 Outbox、看板总览与按需演进持久化（4B / 4C 独立推进，4A 按需双路径）

#### PR 4B：克制版 `CleanupOutbox`（不依赖 SQLite，可独立先做）
- **明确边界**：仅纳入**幂等、可安全重试的资源收尾副作用**：
  - `worker.release`（worktree 删除 + 分支 CAS 清理）
  - `review_worktree.cleanup`（detached review worktree 清理重试）
  - `run_branch.cleanup`（收尾后 `aha/run/<runId>` 清理）
- **明确禁区**：**严禁把 `codex.start_turn` 或 `pty.deliver_prompt` 纳入自动重发 Outbox**，保证 `unknown_acceptance` 不重发红线永不被破坏。进程重启后自动扫描未完成清理队列并幂等补清。

#### PR 4C：看板「交付总览（Overview）」+ 视觉时间线 + 游标分流（不依赖 SQLite）
- **基础**：直接兼容 `cd1b3df` 中的 `openNativeQuestions`、`ProposalWorkerControls`、`WorkerNativeQuestionCard`、`RunAttention` 及最新 snapshot 合流机制。
- **改动范围**：[`OrchestrationBoardPanel.tsx`](../src/components/OrchestrationBoardPanel.tsx)、[`orchestration-board-model.ts`](../src/lib/orchestration-board-model.ts)、[`orchestration-client.ts`](../src/lib/orchestration-client.ts)。
- **内容**：
  1. **派生式 Overview 页签（借鉴 `swarm_pane`）**：协调者只维护极简目标与按**交付成果**分组的 `threads`，进度/评审门禁/阻塞问答状态全部从看板和 Store 实时派生。
  2. **视觉变更时间线**：解析看板贴中的 `Screenshot: <path> | <简短说明>` 行（校验仅允许工作区或合法 artifact 目录路径），渲染前后对比缩略图时间线。
  3. **游标分流订阅**：将前端大快照合并逐步拆为 `runOverview` + `boardCursorStream(since)` + `workerTimelineStream(dispatchId)`，结合引用缓存投影降低大 Run 渲染开销。

#### Stage 4A（按需双路径，不预设强制迁移）
基于 Stage 2A 的 `OrchestrationUnitOfWork` / `flushDurable()` 抽象，后续仅在真实痛点出现时分别评估以下两条独立路径：

1. **路径 A（历史量与截断成为痛点时）→ 评估 Append-only JSONL**：
   - 将只增不改的消息流与观测事实拆出为按 Run 切分的 append-only JSONL 文件，核心热状态仍由原子快照维护，以低改造成本解除 200 消息 / 50 Run 截断与全量覆盖写瓶颈（不强求 JSONL 提供 SQL 事务语义）。
2. **路径 B（多项状态需要联合原子恢复/复杂查询成为痛点时）→ 评估 `node:sqlite`**：
   - 借助 Electron 45（Node `24.22.2`）内置 `node:sqlite` + `BEGIN IMMEDIATE` / `SAVEPOINT` 与 `schema_migrations` 实现跨实体事务恢复与独立资源表；
   - **发布门槛（Release Gate）**：由于 Node 24 中 `node:sqlite` 仍为实验 API（含 `ExperimentalWarning`），任何基于 `node:sqlite` 的实现合入发布前，必须通过 **Windows NSIS / macOS arm64 DMG / Linux AppImage 打包态（asar）三平台实测**。

---

## 5. 明确暂缓项（P3 / 触发条件未到不做）

| 暂缓项 | 暂缓原因 | 何时再启动 |
| --- | --- | --- |
| **T3 全量 Event Sourcing + ExecutionNode Graph** | 复杂度远超当前本地桌面编排收益；状态表 + `AttemptObservationFact` 已满足审计需求 | 当需要多层嵌套子代理可视化执行树与任意时间点全状态重放时 |
| **多频道（`channels` + `@#channel`）与分片批派（`tasks`）** | 2–6 人规模下多频道增加路由心智负担 | 当单 Run 常态化出现 8+ 并行 Worker 或多模块独立子团队时 |
| **Checkpoint + Provider 对话联合回滚** | 跨 CLI 对话回滚支持度差异大，工程风险极高 | 当 Stage 3 能力矩阵与持久化稳定后作为独立特性评估 |
| **多机远程/联邦编排** | 当前核心场景为本地工作台 | 产品正式规划远程 Host/云端 Worker 时 |

---

## 6. 统一交付与验证门禁

每个 PR 均遵循统一闭环：
1. 在 `../ahastation-local-cli.aha-worktrees/<branch>` 独立工作树开发；
2. 补齐对应单元/集成回归测试；
3. 运行 `npm run typecheck` + `npm run test:fast`（触及 review / integration / worktree / 核心生命周期 / Store 持久化边界时必须加跑 `npm run test:e2e`）；
4. 逐项核对第 2 节 10 条红线无回退后再合入 `main`。
