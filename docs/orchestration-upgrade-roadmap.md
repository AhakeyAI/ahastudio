# AhaStudio 编排模块后续演进规划（v7 · `main @ 3dcf3fe`）

> **输入依据**：
> - 三方只读调研报告（Aha / Orca / T3 Code 编排架构横向深度调研）
> - `/swarm` 协作机制精华提炼（门铃经济学、零拷贝 `#seq`、语义停摆监测、零成本休眠复活、交付概览）
> - 仓库实地核验（`main @ 3dcf3fe`，2026-11-28；含 PR #15–#22 合入后复核）

---

## 1. 核心定位与 `3dcf3fe` 实地核验基线

AhaStudio 在**本地多 Agent 编码闭环产品语义**上已经领先同类项目（不可变快照、异构对抗评审、集成分支、`report_done` 结算红线、`unknown_acceptance` 不重发），当前升级主线为**双轨推进**：

1. **协作体验轨（源自 `/swarm` + T3 交接理念）**：降 Token、防卡死自愈、常驻休眠热复活、跨 CLI 限额原位接力、看板交付总览。
2. **架构地基轨（源自 Orca 可靠性 + T3 显式边界）**：先定持久化确认与事务边界再拆破万行 Service/Store、完善能力驱动与单写者所有权、架构守门棘轮、按需演进持久化，并为未来远程控制预留干净边界。

### 已合入 `main` 的里程碑

- **PR #13（`feat/multi-driver-orchestration`）**：`driver-capabilities.ts` 为 `codex / claude / antigravity / grok` 开启 `orchestration: true`；新增 `headless-workers.ts`（`HEADLESS_WORKER_DRIVERS` / `headlessWorkerSupports` / `ahaToolDecision` / `sessionGateDecision`）与 `secret-redaction.ts`。
- **PR #14（`feat/headless-worker-controls-3c`）**：新增 `worker-native-questions.ts` 统一托管 Codex / Claude / ACP / Grok 原生提问；前端 `ProposalWorkerControls` 与 `WorkerNativeQuestionCard`。
- **PR #15（`chore/orchestration-handoffs-sync`）**：`codex/orchestration-handoffs` 合入——持久化 worker handoff 与 Git publication evidence、`codeDeps`、`QueuedWorkerLaunch`（`waiting / claimed / needs_reconciliation`）、`IntegrationIntent`、`finalizedBatches`、看板逐接收方回执 `receipts`、`startObservation`、`RunAttention` UI；并附本规划文档（v5）。
- **PR #16（`feat/orchestration-swarm-protocol`）= Stage 1A 已完成**：Coordinator 提示词加入门铃原则 / 零拷贝 `#seq` / `[done]` 归属 / 所有权切分 / 短 Turn / 热休眠复用；Worker 派发 preamble 与 MCP 工具描述（`post_message` vs `message_worker`、`board_wait` vs `team_wait`、`report_done`）同步消歧。
- **PR #17（`codex/fix-agent-communication`）——直接影响后续 Stage 设计，务必先读**：
  1. **精确已读追踪**：新增持久化 `boardReadersByMessageId` 与 `recordBoardRead() / wasBoardPostRead(id, role)`；`read_board(seqs)`、回复、内联投递都会记录"谁读过哪条"。
  2. **游标语义变化**：发帖/回复**不再**推进 `lastReadSeq`；`mentionsOnly` 等待推进独立的 `lastMentionReadSeq`。
  3. **回答问题必须显式**：`message_worker` 需传 `questionId`；`post_message @role` **不再自动回答**待答问题；问题**无过期机制**。
  4. 新增 `post_message(replyTo=#seq|messageId)`；`peek` 统一走 `board-wait` 路径。
- **PR #18 / #19 / #20 = 前置修复已完成**：已修复「协调者已见过（精确已读或游标覆盖）但未答问题导致停摆永久静默」（`18a4dbc`），并同步更新文档至 v6（`eb3fd73`）。
- **PR #21 / #22 = Stage 2A / 2B 已完成**：Store 拆为 Facade + state-repository / lifecycle / mailbox / security 子 store（`runMutation` / `flushDurable` 契约落地）；Service 拆为薄 Facade + text-views / board / review / integration / delegation / worker-lifecycle 六个子模块（`3dcf3fe`）。

### `3dcf3fe` 关键文件体量基线

| 文件 | 行数 | 当前状态 |
| --- | --- | --- |
| [`electron/orchestration/orchestration-service.ts`](../electron/orchestration/orchestration-service.ts) | **5,032** | Stage 2B 后保留鉴权、Run/Task、消息收发与 Coordinator 循环，其余经 `*Host` 接口委托给子服务（拆分前 10,796） |
| [`electron/orchestration/orchestration-store.ts`](../electron/orchestration/orchestration-store.ts) | **964** | Facade；单文件 `orchestration-state.json`（上限 200 消息/Run、50 Run，异步写盘），实现在 lifecycle（2,080）/ mailbox（1,140，含 `boardReadersByMessageId`）/ security 子 store（拆分前 4,060） |
| [`electron/orchestration/board-service.ts`](../electron/orchestration/board-service.ts) | **1,116** | 看板发帖/游标/精确已读/`board_wait`/停摆监测（Stage 1B 主战场） |
| [`electron/orchestration/worker-lifecycle-service.ts`](../electron/orchestration/worker-lifecycle-service.ts) | **2,580** | `workerStart` / `startFollowUp` / stop / release / abandon + Headless 桥接（Stage 3B 主战场） |
| [`electron/orchestration/worker-git-integration.ts`](../electron/orchestration/worker-git-integration.ts) | **2,251** | 已含 `IntegrationIntent` 钩子，后续与清理 Outbox 解耦 |
| [`src/components/OrchestrationBoardPanel.tsx`](../src/components/OrchestrationBoardPanel.tsx) | **2,425** | 已有 `board / members / graph`、原生提问与送达状态，缺 `Overview` 与视觉时间线 |
| [`electron/orchestration/headless-workers.ts`](../electron/orchestration/headless-workers.ts) | **114** | 多 driver headless 策略基座（Stage 3A/3B 直接复用与扩展） |
| [`electron/orchestration/worker-native-questions.ts`](../electron/orchestration/worker-native-questions.ts) | **321** | 原生提问生命周期管理器（已独立模块化） |

> **符号锚点（替代行号，Stage 2 后不失效）**：`isPostHiddenByReviewFirewall`、`headlessWorkerSupports` 调用处（`workerStart` 内）、`isNamedSeqLookup`（`boardRead` 内）、`inspectRunsForStallWatchdog`、`lastPostIsDone`、`handleBoardStallDetected`、`resolveActiveParentMailbox`、`settleWorkerReport`。

---

## 2. 不可回退红线（保护清单）

任何重构与新特性都必须保证以下 10 条不变量零退化，并持续遵守技术栈约束（`Electron 45 + React 18 + Vite 6 + TypeScript + 纯 CSS`，不引入 Effect-TS / Tailwind / React 19 / Base UI / TipTap）：

1. **结算隔离**：Turn 结束绝不 settle dispatch，仅显式 `report_done / worker_done` 可结算。
2. **投递防双写**：仅 `not_accepted` 允许 PTY fallback；`unknown_acceptance` 与中断的 `queuedLaunch(claimed)` 绝不自动重发或 fallback（进入 `needs_reconciliation` 核对）。
3. **身份与凭证脱敏**：`dispatchCapability` 与 MCP secret（`secret-redaction.ts`）强校验且在日志、看板、审批、原生提问、交接工件中强制脱敏。
4. **投递围栏**：`consumer_generation` / `consumer_fenced` 严格生效，防止旧进程/旧面板误消费。
5. **不可变快照与防篡改**：临时 `GIT_INDEX_FILE` 生成不可变 OID；拒绝 staged/unstaged 分叉；`strictReviewedTree: true` 阻断 Hook 篡改。
6. **异构对抗评审防火墙**：强制回避**所有参与编写的作者 CLI 集合**（不仅是当前 CLI，单 CLI 机器外）、独立 detached review worktree、隐藏作者自述与作者报告/交接帖（`isPostHiddenByReviewFirewall`）、跨 Run 鉴权隔离。
7. **脏主区保护与目标分支绑定**：脏 `main` 走 `aha/run/<runId>`；严禁 detached HEAD 建集成分支或合错分支（包括人工强制放行）。
8. **审批门禁不可绕过**：`chat-and-guard` / `always-ui` 同时约束 MCP 与 CLI/HTTP 评审入口，以及 `sessionGateDecision` 控制的非 Codex Coordinator 动作。
9. **单写者接管**：页面内人工接管与跨 CLI 接力移交前，必须通过显式所有权锁（claim/fence）与落盘确认，确保原控制者及其子进程均已停止写入。
10. **克制唤醒**：保留 `PeerPingPongTracker` 上限、保留 `nativeQuestions` / `approvals` / `gates` / `proposals` / 未读问答的 `hasPendingAttention` 静默保护，且**只要还有成员处于 `working` 状态，就绝不触发全局停摆告警**。

---

## 3. 演进依赖与推进图

Stage 0 / 1A / 前置修复 / 2A / 2B 均已完成（`main @ 3dcf3fe`）；下一步先补轻量质量守门，随后 1B / 3A / 4B+4C **互不依赖、可并行**：

```mermaid
flowchart LR
    S0["Stage 0 + 1A + 前置修复: 已完成"] --> S2A["Stage 2A: Store runMutation / flushDurable + 拆分（已完成 #21）"]
    S2A --> S2B["Stage 2B: Service 物理拆解（已完成 #22）"]
    S2B --> QG["质量守门: check-architecture + npm run check"]
    QG --> S1B["Stage 1B: board-service 语义停摆监测"]
    QG --> S3A["Stage 3A: 能力矩阵 + ProviderRefs"]
    QG --> S4BC["Stage 4B/4C: CleanupOutbox + 看板 Overview/休眠态"]
    S3A --> S3B1["Stage 3B-1: ResumeClaim + 进程回收 + 休眠自动复活"]
    S3B1 --> S3B2["Stage 3B-2: 跨 CLI 接力 + 常驻角色续波次 + 作者集合回避"]
    QG --> S3Ca["Stage 3C-a: 写入口 requestId 幂等"]
    S3B2 --> S3C["Stage 3C-b: 观测事实补齐"]
    S3C -. "按需双路径评估" .-> S4A["Stage 4A: JSONL（历史量） / node:sqlite（联合恢复）"]
```

---

## 4. 分阶段可执行规划（按独立 PR 拆分）

### Stage 0：分支决策与旧 Worktree 清理 — **已完成**

- `codex/orchestration-handoffs` 经 PR #15 合入；全部旧 worktree、本地与远端已合并分支均已回收。

### Stage 1A：`/swarm` 协议与上下文经济学速赢 — **已完成（PR #16）**

- 门铃原则、零拷贝 `#seq`、`[done]` 专属协调者、所有权切分、短 Turn 纪律、热休眠复用、工具消歧均已落地于 `coordinator-prompt.ts` / `worker-dispatch-preamble.ts` / `aha-mcp-server.cjs`。
- PR #17 已同步修订：`message_worker` 改为显式 `questionId` 回答（不再"自动回答第一个待答问题"），Coordinator 提示词补充 questionId 用法。

### 前置修复：已读未答问题导致停摆永久静默 — **已完成（PR #19 / #20）**

- 已在 `inspectRunsForStallWatchdog` 中排除协调者已见过（`wasBoardPostRead` 精确已读或 `post.boardSeq <= coordinatorCursor.lastReadSeq` 游标覆盖）的未答 Run 级问题，并在停摆帖中点名 `#seq` + `questionId`；未读问题与子 Worker 提问维持原静默保护。

---

### Stage 2：先定持久化确认与事务接口，再物理拆解 Service 与 Store（拆为 2A / 2B 多个独立 PR）

> **核心原则**：Stage 2 **严格零行为变更**，禁止夹带新特性；验收以**职责边界清晰、无循环依赖、持久化确认契约明确**为准，不设死板行数指标。

#### 2A：为 Store 定义统一变更边界与持久化确认契约，再按职责拆分 — **已完成**
- 落地：`orchestration-store.ts` 为 Facade；`orchestration-state-repository.ts`（共享状态、hydrate/export、写盘、`runMutation` / `flushDurable`）+ `orchestration-store-slice.ts`（共享上下文）+ lifecycle / mailbox / security 三个子 store；service 中 5 处 `waitForPendingWrite()` 改为 `flushDurable()`；`persist()` 不再泄漏 unhandled rejection。
- **关键设计**：当前 `AtomicSnapshotWriter` 默认异步写盘（`cd1b3df` 已在关键边界使用 `store.waitForPendingWrite()`），单纯同步 `runTransaction()` 返回并不代表数据已落盘；且 JSONL 不提供 SQL `BEGIN` / `SAVEPOINT`。因此 2A 明确区分两层能力：
  ```ts
  interface OrchestrationUnitOfWork {
    /** 多实体变更合并为单次持久化调度（所有子 store 共享同一写入上下文） */
    runMutation<T>(fn: (tx: OrchestrationStoreTx) => T): T;
    /** 显式等待已提交变更落盘确认（用于移交 claim、结算、释放等崩溃敏感边界） */
    flushDurable(): Promise<void>;
  }
  ```
- **`runMutation` 语义边界（已决策，不做回滚）**：
  - `fn` **必须是同步函数、内部不得 `await`**；JS 单线程保证执行期间无穿插写入，多实体改动对外不可见半成品。
  - **不承诺中途异常回滚**：`fn` 抛错时已改动的内存状态不撤销。配套两条纪律：(a) 所有写路径遵循"先校验、后修改"（沿用 `settleWorkerReport` 中 `assert*Transition` 前置的现有惯例），校验失败必须发生在任何变更之前；(b) 若未来某操作确需回滚，仅对该操作单独引入 undo，不做全局机制。
  - `flushDurable()` **就地包装现有 `flushSync()` / `waitForPendingWrite()`** 并透传写盘错误（顺手修复 `persist()` 丢弃 `writer.write()` Promise 导致的 unhandled rejection）。
  - 普通高频状态更新走 `runMutation(...)`；**崩溃敏感边界（队列 claim、3B 启动新 CLI 前落盘移交记录、Git 发布意图与结算收尾）必须 `await store.flushDurable()` 确认落盘后**再执行外部副作用。
  - 若未来启用 SQLite，`runMutation` 内部直接对接 `BEGIN IMMEDIATE` / `SAVEPOINT` 且同步落盘（`flushDurable` 退化为 no-op），上层零改动。
- **子模块边界**（均接收共享 `tx` 上下文）：
  - `orchestration-state-repository.ts`（持久化与 `flushDurable` 抽象）
  - `orchestration-lifecycle-store.ts`（Run / Task DAG / Dispatch / Settlement / `QueuedWorkerLaunch` / Circuit Breaker）
  - `orchestration-mailbox-store.ts`（Message / Delivery / Receipts / **`boardReadersByMessageId` 精确已读** / Fencing / Question / Gate / Board Cursor——注意 `recordBoardRead` 是 PR #17 新增写入口，同样纳入 `runMutation` 边界）
  - `orchestration-security-store.ts`（Capability 校验、脱敏与容量裁剪）
  - `orchestration-store.ts` 保留为统一 Facade。

#### 2B：将 `orchestration-service.ts`（10,761 行）拆为薄 Facade + 内聚子服务 — **已完成**
- 落地：6 个子模块全部外提（service 约 10,800 → 5,000 行）；每个子服务只经显式 `*Host` 接口依赖 service（仅类型导入，无运行时循环），对外 API 由 service 委托保持不变。service 仍保留鉴权、Run/Task、消息收发（send/check/ask/reply）与 Coordinator 循环，后续按需再拆。
- **外提顺序按耦合低→高**（每外提 1–2 个子服务即运行 `npm run typecheck` + 定向单测；review / integration / worker-lifecycle 三步合并前必须加跑 `npm run test:e2e`）：
  1. `orchestration-text-views.ts`（`team_status`、看板摘要与快照文本视图——纯格式化、耦合最低，先做）
  2. `board-service.ts`（看板发帖、游标、`receipts`、精确已读、`board_wait`、中场注入、停摆监测——符号锚点 `boardPost` / `boardRead` / `boardWait` / `inspectRunsForStallWatchdog` / `handleBoardStallDetected`）
  3. `review-service.ts`（单 Worker 与 Run 级对抗评审、防火墙、批次汇总、并发启动锁）
  4. `integration-service.ts`（`workerIntegrate`、`runDiff`、`runFinalizeIntegration`、`recoverGitPublications`、集成锁与分支守卫）
  5. `delegation-service.ts`（提案确认链、语义 `delegateTask`、队列发射 `scheduleQueuedLaunches / launchQueuedTask`、角色路由）
  6. `worker-lifecycle-service.ts`（`workerStart` / `followUp` / `stop` / `release` / `abandon` / Headless 桥接，协同 `headless-workers.ts` 与 `worker-native-questions.ts`——耦合最重，最后做）

#### 质量守门（紧跟 2B 合入后的轻量独立 PR）
- 新增 `scripts/check-architecture.mjs` 与统一门禁脚本 `npm run check`（并接入 `.github/workflows/ci.yml`），在后续 PR 开工前锁死 2A/2B 拆好的边界：
  1. 禁止 `electron/orchestration/` 直接 `import 'electron'`（保证纯 Node 内核，服务未来远程 Daemon）；
  2. 禁止子服务与子 Store 出现运行时循环依赖或反向耦合；
  3. 禁止引入红线依赖（`effect`、`tailwindcss`、`@tiptap/*`、`@base-ui/*`）；
  4. 为已拆分核心模块设立文件体量棘轮，防止再次长出万行巨无霸。

---

### Stage 1B：在拆分后的 `board-service.ts` 升级语义停摆监测（独立 PR）

- **改动范围**：[`electron/orchestration/stall-watchdog.ts`](../electron/orchestration/stall-watchdog.ts)、拆分后的 `board-service.ts`、[`electron/orchestration/board-protocol.ts`](../electron/orchestration/board-protocol.ts)。
- **与红线 10 及 `[done]` 的精确边界**：
  - **严格遵守红线 10**：所有 4 类停摆诊断**仅在 Run 内所有活跃 Worker 均非 `working`、无 `hasPendingAttention`（审批、原生提问、未读问答、Gate、提案）且协调者 idle 且无活跃 waiter 时才触发**。
  - **收紧 `lastPostIsDone`**：仅当发帖者是 `coordinator` 且包含 `[done]` 时才视为 Run 已收尾，防止 Worker 误写 `[done]` 静默监测；**必须保留 `kind === 'stall'` 条件**——否则 watchdog 会被自己发出的停摆帖再次触发，形成循环。
- **"已读 / 已处理"判定（PR #17 后大幅简化，以精确已读为准）**：
  - **已读证据取两者的并集**：`wasBoardPostRead(postId, 'coordinator')`（精确已读）**或** `post.boardSeq <= coordinatorCursor.lastReadSeq`（宽泛读覆盖）。单独用任何一个都会漏：宽泛 `read_board` 只推进游标不记精确已读，而 `read_board(seqs)` 点读只记精确已读不推进游标。注意发帖/回复自 PR #17 起不再推进 `lastReadSeq`，`mentionsOnly` 等待推进的是 `lastMentionReadSeq`（其内联投递已记精确已读，无需再查该游标）。
  - **"读而未处理"仍需业务事实补判**：已读不等于已处理。报告帖满足以下任一即视为已处理：`post.receipts['coordinator'] === 'replied'`、协调者对其发过引用回复/认领帖、或对应任务/dispatch 已推进（开评审、已集成、已 follow-up、已重派或关闭）。
  - **"协调者未读停驻"诊断重写**：`mentionsOnly` 等待推进的是 `lastMentionReadSeq` 而非 `lastReadSeq`，**禁止**用 `headSeq > lastReadSeq` 判未读（会大量误报）；改为遍历发给协调者的帖子、用精确已读集合筛出未读项。
- **状态优先 + 零浪费 4 类诊断**：
  1. **报告未处理**：已读或未读但无"已处理"业务依据且未 `@coordinator` 的报告帖 → 点名 `#seq` 提醒 `@coordinator`。
  2. **协调者未读停驻**：按精确已读集合存在未读的 `@coordinator` 消息 → 列出 `#seq` 提醒。
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
  3. 协调者点读报告并已回复/启动评审/集成后，不再误报该报告未处理；
  4. 限额/报错直接升 Coordinator，不浪费 Headless re-ping turn；
  5. 系统提醒唤醒协调者但任务无进展时，计数不重置，达到 3 次后稳定静默；
  6. **watchdog 自己发出的 `stall` 帖不会再次触发提醒**（`kind === 'stall'` 抑制保留）。

---

### Stage 3：能力驱动、常驻休眠热复活、跨 CLI 接力与幂等恢复（拆为 3A / 3B-1 / 3B-2 / 3C 四个独立 PR）

#### PR 3A：就地扩展能力矩阵、`headless-workers.ts` 与 `ProviderRefs` — **已完成**
- 落地：`AgentDriverCapabilities` 新增 `nativeThreadIds / resumeAcrossCwd / acceptsDeveloperContext / supportsSteer / hookApprovalDialect`（Claude `resumeAcrossCwd: false`、Codex `true`，其余保守 `false`）；`permission-approvals.ts` 按 `hookApprovalDialect` 出 hook stdout（逐字节回归测试）；驱动运行时 `steer` 取自能力矩阵；`headless-workers.ts` 新增结构化 `headlessWorkerSupportError` / `headlessResumeError`（`cwd_bound_session` 等）与 `ProviderRefs` / `providerRefs()`，供 3B 直接使用。未建 `orchestration-policy.ts`：现有策略判断已集中在 `headless-workers.ts`。
- **基础**：直接建立在已有 [`driver-capabilities.ts`](../electron/agent-drivers/driver-capabilities.ts) 和 [`headless-workers.ts`](../electron/orchestration/headless-workers.ts) 之上，不重复实现已有的 `headlessWorkerSupports / headlessWorkerControlsError / ahaToolDecision / sessionGateDecision`。
- **增量内容**：
  1. 在 `AgentDriverCapabilities` 补充尚未声明的编排维度：`nativeThreadIds: 'strong' | 'weak' | 'none'`、**`resumeAcrossCwd: boolean`**（显式声明是否支持切换 worktree 目录后原生 resume，例如 Claude 会话按 `cwd` 分桶默认 `false`）、`acceptsDeveloperContext`、`supportsSteer`、`hookApprovalDialect`，收口 [`permission-approvals.ts`](../electron/orchestration/permission-approvals.ts) 和 service 内残余的 `cliId` 硬编码分支。
  2. 引入结构化 `ProviderRefs`（App ID 为主身份，Provider session/thread/turn/request ID 仅作引用证据）。
  3. 将散落的策略判断收敛进 `headless-workers.ts` / `orchestration-policy.ts`，能力不足时返回显式结构化原因。

#### PR 3B：常驻休眠 Worker 热复活 + 跨 CLI 原位接力 + `ResumeClaim` 单写者锁（拆 3B-1 / 3B-2 两个 PR）
- **核心定位（从“一次性 Dispatch”升级为“常驻休眠角色 + 一次性评审者”）**：
  - **对抗评审者（`reviewOfDispatchId / reviewOfRunId`）永远保持一次性**：审完 detached snapshot 即销毁，严禁休眠复用，杜绝跨轮次锚定偏见。
  - **领域开发者 / 调研者（`@backend / @frontend / @researcher`）升级为可常驻休眠角色**：空闲时可主动关闭子进程释放内存（真零内存、零 Token 休眠），被 `@role` 唤醒或重启后凭 `providerSessionId` 自动复活，合入第一波代码后也能继续承接下一波任务，直到整个 Run 收尾或人工点「退休」才彻底销毁。
- **基础**：直接复用已合入的 `needs_reconciliation`、`reconciliationDiff` 与 `QueuedWorkerLaunch` 落盘认领模式，在其之上扩展可审计、经过 `secret-redaction.ts` 与 capability 脱敏的 `ContextTransfer / ContextHandoff` 工件，绝不起第二套平行结构。
- **PR 3B-1（所有权、进程回收与同 worktree 休眠自动复活，先行）— 已完成**：
  - 落地：持久化 `ResumeClaim`（Worker 身份 + 目录单写者锁，记录 pid，预留 `hostId / actor`），复活前 `flushDurable()`；上次进程遗留的 claim 重启后为 `stale`，仅在记录的进程确认已退出后才放行（绝不按 pid 盲杀）。Windows 已由 job 对象覆盖全部 headless driver（`spawnAgentProcess` 早已统一走 job），本 PR 补 POSIX：agent 以独立进程组启动，关闭时 `kill(-pgid)`。`startFollowUp` 对无进程的已结算 headless Worker 按 `providerSessionId` 在原目录（新增 `providerCwd`）原位复活；对抗评审者、已释放、目录不存在或 `headlessResumeError` 拒绝时仍报 `dispatch_inactive` 并说明原因。空闲休眠：结算后空闲 `headlessWorkerDormancyMs`（桌面端 5 分钟）且无待处理事项时关闭进程，快照 `headlessLive.dormant` 标记可热唤醒。页面内人工接管目前尚无独立实现，claim 的 `actor: 'person'` 留给其接入。
  1. 引入显式 `ResumeClaim / WorktreeOwnershipFence`，**claim 中记录 pid / job 句柄**（并预留 `hostId?: string` 与 `actor` 来源字段）；页面内人工接管同步切到同一套 claim。
  2. **推广现有 [`windows-codex-job.ts`](../electron/orchestration/windows-codex-job.ts)（当前仅服务 Codex）到全部 headless driver**；macOS / Linux 用进程组回收（`kill(-pgid)`）。
  3. **同 worktree 零成本休眠与按 `providerSessionId` 自动复活**：
     - 改造 `startFollowUp`：当 Headless Worker 进程已退出或应用重启后，若 `settledDispatch.providerSessionId` 存在、worktree 仍在且 `driverCapabilities(cliId).resume === true`，不再直接抛 `dispatch_inactive`，而是获取 `ResumeClaim` 后通过 `open({ cwd, resumeSessionId })` 原位复活会话。
     - 增加**空闲自动休眠**（可配阈值，如空闲 5 分钟且无活跃 turn / 无待答原生提问 / 无待批权限）：先归档 timeline，再安全 `close()` 释放子进程内存，将成员态置为 `dormant（休眠待命）`，下次被 `@role` 呼叫自动 `resume` 秒醒。
- **PR 3B-2 拆分（已决策）**：3B-2a 跨 CLI 原位接力（约束 1 / 3 / 4 / 5）— **已完成**；3B-2b 合入后常驻角色续接下一波任务（约束 2）— **已完成**。
  - 3B-2b 落地：`integrate_worker(keepResident=true)` 对拥有独立 worktree/分支的 headless Worker 只合入、不释放，记录 `residentAfterIntegration`（目标分支、合入时分支 OID 与快照 OID）。下一次 follow-up 即新一波：worktree 快照仍等于已合入快照时（Worker 默认不提交，worktree 里就是已合入内容）才清空并在**同一路径**从最新目标分支切出新 `aha/worker/*` 分支，旧分支按 CAS 删除，cwd 不变故原生 resume 照常；合入后又有新改动则拒绝并保留（`resident_worktree_changed`）。worktree 已不存在时在新 worktree 起新会话并以 `ContextHandoff` 续接（跨目录原生 resume 暂不尝试，统一走便携上下文）。新一波 `authorCliIds` 从当前 CLI 重新累计。`run-finalize` 释放所有常驻 Worker。
  - 3B-2a 落地：`manage_worker action="handoff" agent=<cli>`（HTTP `role-manage`）把已停止/已结算的 headless Worker 任务交给另一 CLI，同一 worktree、保留未提交改动。目标按 `headlessWorkerSupportError` + 运行时可用性筛选（pi/opencode、grok/antigravity 只读一律拒绝）。写入静止：旧会话关闭且其最后进程树已不存活，再两次快照（间隔 `handoffQuiescenceMs`，默认 2s）OID 一致，否则保留 worktree 并拒绝（`writer_still_running` / `worktree_still_changing`）。两阶段：`pending` 移交记录 + 新 Worker 的 `ResumeClaim` 先 `flushDurable()`，拿到会话后写 `active` 再落盘，follow-up 派发后 `completed`；重启时 `pending/active` 一律转 `needs_attention` 并向协调者发一次告警，绝不自动续跑（不按 pid 盲杀，遗留 claim 保持 `stale` 直到进程确认退出）。新 Agent 从脱敏的 `ContextHandoff`（接力说明、前任报告、末轮输出，12KB 上限）+ 原任务启动；dispatch 记录 `authorCliIds`（单波内累计），单 Worker 与 Run 级评审都回避整个作者集合。
- **PR 3B-2（跨 CLI 原位接力 + 合入后常驻角色续接下一波任务）五条硬约束**：
  1. **目标 CLI 筛选严格复用现有启动判断**（`workerStart` 内 `headlessWorkerSupports` 调用处）：
     - 必须通过 `headlessWorkerSupports(targetCli, workerPolicy)` 且校验运行时可用性（`headlessWorkers.available?.(targetCli) !== false` / `codexPilot.enabled()`）；
     - 沙箱 root 锁定同一 worktree，策略**宁严勿宽**：`antigravity` / `grok` 无 `read-only` 档，禁止接力只读 headless 任务；**`pi` 和 `opencode` 当前完全没有 headless Worker 支持，即使人工同意切换权限也不可作为 headless 接力目标**（仅显式降级为终端 Worker 流程）。
  2. **解耦“合入后释放旧分支”与“退休角色”（续波次且兼容 `cwd` 绑定）**：
     - `integrate_worker` 合入第一波改动后，允许保留该非评审 `@role` 的常驻会话身份（仅清理旧任务分支，不再把整个人打死为不可唤醒）；
     - 续接下一波任务时，优先在校验工作区干净 + `ResumeClaim` 单写者锁后，**在同一 worktree 路径原地切出基于最新 `main / aha/run/<runId>` 的新分支**（保持 `cwd` 不变，100% 兼容 Claude 等按 `cwd` 分桶的原生 `resumeSessionId`）；若必须新建不同路径 worktree 且目标 driver `resumeAcrossCwd === false`（或原生 resume 失败），则**自动降级为 `ContextHandoff` 便携上下文续接**，绝不报错卡死。
     - 只有 Run `finalize` 或人工显式「退休/销毁」才彻底清理角色与 worktree。
  3. **红线 6（异构评审作者集合回避）**：**复用 [`agent-roster.ts`](../electron/orchestration/agent-roster.ts) 已实现的 `authorCliIds / excludeCliIds` 机制**（Run 级评审已传 `integratedAuthorClis`），本 PR 做两件增量：(a) **单波任务内**的跨 CLI 接力将累计作者集合持久化到该波 Worker 记录（新一波独立任务从空集合重新累计，避免已合并旧波次污染无关任务）；(b) 单 Worker 评审把该集合传入 roster。仅当所有可用 CLI 均已参与编写时才显式降级并标明原因。
  4. **红线 9（单写者 + 写入静止核验）**：移交或原地切分支前先中断原 CLI、回收其子进程组；"写入静止"的判定必须可操作化——**进程树为空，且相隔 N 秒的两次 worktree 快照 OID 一致**；若检测到残留后台进程仍在写入，**保留 worktree 现状并暂停移交**，绝不放行双写。
  5. **两阶段落盘 + 崩溃恢复（防双实例）**：
     - **第一段**：启动新 CLI **之前**，先把 `pending` 态移交记录与 `ResumeClaim`（含拟用 targetCli、worktree、来源 dispatch）写入 Store 并 `await store.flushDurable()`；
     - **第二段**：拉起新 CLI 拿到 provider thread id 后，再写 `active` 态并二次 `flushDurable()`；
     - **重启恢复规则（写死）**：发现 `pending/active` 移交记录时，先按 claim 中记录的 pid / job 回收可能存活的孤儿进程（Windows 上 Electron 崩溃不保证子进程退出），随后将该移交标记为 **`needs_attention` 交人工处理**，**绝不自动续跑、绝不重复拉起第二份 Worker**。
- **附带能力**（可独立后续 PR）：`delegate_task(forkFrom: "@role")` 热上下文派生（评审模式依然经过对抗防火墙，隐藏作者自述）。
- **必须覆盖的验收用例（含休眠复活与 2 条关键失败验收）**：
  1. **休眠复活闭环（3B-1）**：Headless Worker 空闲休眠（进程已关闭）或应用重启后，收到 `@role` 返工指令可凭 `providerSessionId` 自动复活并保留上下文；对抗评审者完结后拒绝休眠复用；
  2. **跨 CLI 接力 & 续波次闭环（3B-2）**：保留同一 worktree 未提交改动完成跨 CLI 接力，作者集合 `{A, B}` 触发异构评审回避，脱敏无凭证泄露，最终通过评审合入；合入后同一 `@role` 可基于最新基线原地切新分支续接第二波任务（以及 `resumeAcrossCwd === false` 跨路径时自动降级 `ContextHandoff`）；
  3. **能力与策略拒绝**：`antigravity/grok` 拒绝接力 `read-only` headless 任务；`pi / opencode` 即使请求切权也因无 headless 支持而被 `headlessWorkerSupports()` 拒绝；
  4. **失败验收 1（残留子进程仍在写文件）**：旧 CLI 已确认中断，但模拟其衍生的后台进程仍在改写 worktree 文件 → 系统必须**保留 worktree 不清理、暂停移交并返回明确错误**，不得启动新 CLI 造成双写；
  5. **失败验收 2（拉起新 CLI 后、落盘成功前崩溃）**：移交记录落盘后拉起新 CLI，模拟在写入 `active` 之前应用崩溃 → 重启后恢复流程回收孤儿进程、标记 `needs_attention`，**绝不再启动第二份重复 Worker**。

#### PR 3C：CLI / 远程 `requestId` 幂等与观测事实补齐（未来远程控制前置护栏；拆 3C-a / 3C-b）
- **拆分（已决策）**：3C-a（写入口 `requestId` 幂等）不依赖 3B，与 3A / 3B-1 并行先做；3C-b（`AttemptObservationFact` 事实补齐，含 dormant/resume、handoff）依赖 3B 的事件，排在 3B-2 之后。
- **3C-a — 已完成**：`request-idempotency.ts` 的 `RequestReceipts` 按 `(action, callerPaneId, requestId)` 记账，`worker-start / worker-integrate / run-finalize / worker-release / approve / deny` 带 `requestId` 时只执行一次：重试（含并发重复）返回首个成功结果并带 `replayed: true`，同 ID 异载荷返回 409 `request_mismatch`，失败结果不入账（重试会重新执行）。收据仅在内存保留（24h / 500 条），应用重启后不重放。CLI 对上述动作自动生成 `requestId`，断线时提示 `--retry-request <id>`。
- **定位说明**：单机模式下主要服务 CLI/HTTP 断线重试与防连点，但**面向未来的远程控制（手机/弱网重连、重复点击审批/派发/合入）属于必经防双写护栏**，在 3B-2 之后独立收口。
- **内容**：
  1. 在已有 `startObservation` 与 `IntegrationIntent / finalizedBatches` 基础上，补齐只增不改的 `AttemptObservationFact` 关键事件覆盖（turn、approval、native question、snapshot、dormant/resume、handoff、integration）。
  2. 为 HTTP/CLI/远程写入口（`worker-start / worker-integrate / run-finalize / worker-release` 及审批决策）增加 `(callerFingerprint, requestId)` 幂等收据与 `--retry-request <id>` 恢复指引，同 ID 异载荷返回 `request_mismatch`。

---

### Stage 4：收尾 Outbox、看板总览与按需演进持久化（4B / 4C 独立推进，4A 按需双路径）

#### PR 4B：克制版 `CleanupOutbox`（不依赖 SQLite，可独立先做）
- **明确边界**：仅纳入**幂等、可安全重试的资源收尾副作用**：
  - `worker.release`（worktree 删除 + 分支 CAS 清理）
  - `review_worktree.cleanup`（detached review worktree 清理重试）
  - `run_branch.cleanup`（收尾后 `aha/run/<runId>` 清理）
- **明确禁区**：**严禁把 `codex.start_turn` 或 `pty.deliver_prompt` 纳入自动重发 Outbox**，保证 `unknown_acceptance` 不重发红线永不被破坏。进程重启后自动扫描未完成清理队列并幂等补清。

#### PR 4C：看板「交付总览（Overview）」+ 视觉时间线 + 游标分流（不依赖 SQLite）
- **基础**：直接兼容 `openNativeQuestions`、`ProposalWorkerControls`、`WorkerNativeQuestionCard`、`RunAttention` 及最新 snapshot 合流机制。
- **改动范围**：[`OrchestrationBoardPanel.tsx`](../src/components/OrchestrationBoardPanel.tsx)、[`orchestration-board-model.ts`](../src/lib/orchestration-board-model.ts)、[`orchestration-client.ts`](../src/lib/orchestration-client.ts)。
- **内容**：
  1. **派生式 Overview 页签（借鉴 `swarm_pane`）**：协调者只维护极简目标与按**交付成果**分组的 `threads`，进度/评审门禁/阻塞问答状态全部从看板和 Store 实时派生；成员状态明确区分 **`工作中` / `休眠待命（可热唤醒）` / `已退休`** 三态，并提供一键「退休/回收」操作。
  2. **视觉变更时间线**：解析看板贴中的 `Screenshot: <path> | <简短说明>` 行（校验仅允许工作区或合法 artifact 目录路径），统一经服务端资产 ID 接口渲染前后对比缩略图（不直接拼 `file://` 本地路径，确保未来远程浏览器/手机端也能查看）。
  3. **游标分流订阅（Transport 无关）**：将前端大快照合并逐步拆为 `runOverview` + `boardCursorStream(since)` + `workerTimelineStream(dispatchId)`，底层传输接口与桌面 IPC 解耦（未来可平滑替换为 WebSocket/SSE 远程接入），结合引用缓存投影降低大 Run 渲染开销。

#### Stage 4A（按需双路径，不预设强制迁移）
基于 Stage 2A 已落地的 `store.runMutation()` / `store.flushDurable()` 契约，后续仅在真实痛点出现时分别评估以下两条独立路径：

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

## 6. 统一交付门禁与未来远程控制前瞻约束

### 交付与验证闭环
每个 PR 均遵循统一闭环：
1. 在 `../ahastation-local-cli.aha-worktrees/<branch>` 独立工作树开发；
2. 补齐对应单元/集成回归测试；
3. 运行 `npm run check`（当前为 `npm run typecheck` + `npm run test:fast`；触及 review / integration / worktree / 核心生命周期 / Store 持久化边界时必须加跑 `npm run test:e2e`）；
4. 逐项核对第 2 节 10 条红线无回退后再合入 `main`。

### 为未来远程控制预留的低成本设计原则（随 Stage 2–4 顺手守住）
1. **纯 Node 编排内核**：`electron/orchestration/` 严禁直接 `import 'electron'`，所有命令与查询均为纯 JSON DTO，确保未来可无改动跑在独立无界面 Daemon 或远端主机。
2. **Transport 与资产路径解耦**：前端客户端走可替换订阅接口与 `cursor` 增量流，图片/差异产物走资产路由而非裸 `file://` 路径。
3. **多端身份与防双写**：新增的 `ResumeClaim`、`ContextHandoff`、`CleanupOutbox` 预留可选 `hostId`（默认 `'local'`）与操作者 `actor`，文件引用优先使用仓库相对 POSIX 路径；远程写入依赖 Stage 3C 的 `requestId` 幂等与独立远程权限策略。
