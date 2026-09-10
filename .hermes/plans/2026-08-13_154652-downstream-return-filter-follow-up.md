# Metapi 下游返回值过滤器后续实施计划

> **For Hermes:** 后续实施时按本文顺序逐项执行；每项先写可失败的回归测试，再做最小修复，并进行变异验证。未经主人明确授权，不提交、不推送、不部署。

**基线提交：** `721cdec91fce628d80fe47a7ae8c93c0dc7597c4`

**目标：** 把当前 CPA/Hermes 专用终态错误映射 MVP 修正为不会产生假成功、不会把确定性请求错误误报为瞬时故障、能安全处理 SSE/WebSocket 终态，并逐步扩展为可配置的下游返回值过滤器。

**架构原则：** 内部“原始操作错误”和下游“公开错误表示”必须分离。Metapi 的路由、冷却、日志、告警始终消费原始错误；仅在本次请求的恢复边界明确后生成公开错误。禁止用 `2xx`、假 assistant 文本或假 tool call 掩盖失败。

**技术栈：** TypeScript、Fastify、WebSocket、SSE、React、Vitest、Drizzle ORM。

---

## 0. 使用规则与不可破坏约束

### 0.1 实施边界

- [ ] 修改前确认仓库为 `/Users/800g2/github/metapi`。
- [ ] 修改前确认当前分支及远端状态；禁止在未知远端推进时直接覆盖 `main`。
- [ ] 修改前创建包含当前 `main` 的 Git bundle 备份并执行 `git bundle verify`。
- [ ] 每一阶段只修改该阶段涉及的语义，不夹带重构、格式化或无关清理。
- [ ] 未经主人明确授权，不执行提交、推送和部署。
- [ ] 不向受限上游发送 Hello、健康检查、模型轮询或其他合成测活请求。
- [ ] 全链路验证只使用自然发生的真实任务或本地受控 fixture。

### 0.2 核心安全不变量

- [ ] 任何失败都不得改写为 HTTP `2xx`。
- [ ] 不得伪造 assistant 文本来结束任务。
- [ ] 不得伪造 tool call 来强迫任务继续。
- [ ] 已输出有效 SSE/WebSocket 字节后，不得跨通道重放当前请求。
- [ ] 同一请求最多发送一个协议终态。
- [ ] 下游公开错误不得改变 Metapi 内部真实错误记录。
- [ ] 确定性请求错误不得改写成可重试 5xx。
- [ ] `off`/`passthrough` 必须保留约定的原始状态和 payload；若做不到，要明确改名并记录限制。

### 0.3 每项修复的测试纪律

1. 写能精确复现缺陷的测试并先运行，确认 **FAIL**。
2. 做最小实现，运行同一测试确认 **PASS**。
3. 进行变异验证：临时撤销或破坏关键修复，确认测试重新 **FAIL**。
4. 恢复修复，再次运行确认 **PASS**。
5. 运行相邻回归测试、typecheck、build、drift-check。
6. 将真实输出记录在实施会话中；不得用推测结果代替。

---

# 第一阶段：先消除 P0 假成功与错误提交路径

> 本阶段完成前，不应把当前功能宣传为“避免下游任务中断”。

## 1. 修复 `response.failed → HTTP 200 + finish_reason: stop`

**问题：** Responses 上游失败事件转换到 Chat 下游时，可能成为 HTTP 200 SSE、`finish_reason: "stop"` 和 `[DONE]`，CPA/Hermes 会把失败当正常完成。

**证据：**

- `src/server/transformers/openai/chat/proxyStream.ts:303-331`
- `src/server/routes/proxy/chat.stream.test.ts:4711-4752`

**目标行为：**

- 无有效下游输出时：缓存失败，不提交 SSE，由 Surface 返回非 2xx 终态。
- 已有有效输出时：发送一个明确、协议合法的 in-band error terminal。
- 绝不把 `response.failed` 转换为 `finish_reason: "stop"`。

**文件：**

- Modify: `src/server/transformers/openai/chat/proxyStream.ts`
- Modify: `src/server/proxy-core/surfaces/chatSurface.ts`
- Test: `src/server/transformers/openai/chat/proxyStream.test.ts`
- Test: `src/server/routes/proxy/chat.stream.test.ts`

**步骤：**

- [ ] 将现有“`response.failed` 产生 stop”测试改为期望非 2xx 或明确失败终态。
- [ ] 增加“无有效输出时不写任何 SSE 字节”的单元测试。
- [ ] 增加“已有部分文本时只发送一个 error terminal，且不出现 stop/tool_calls”的测试。
- [ ] 在 stream result 中保留 typed failure，交由 Surface 决定 precommit HTTP failure。
- [ ] 运行目标测试并做变异验证。

**目标命令：**

```bash
npx vitest run --root . \
  src/server/transformers/openai/chat/proxyStream.test.ts \
  src/server/routes/proxy/chat.stream.test.ts
```

**验收标准：**

- [ ] `response.failed` 不再产生 `finish_reason: "stop"`。
- [ ] 无输出失败不提交 HTTP 200 SSE。
- [ ] 已输出失败最多出现一个明确失败终态。
- [ ] CPA/Hermes 能收到非成功语义并进入正常恢复逻辑。

---

## 2. 修复无输出 reader failure 抢先提交 SSE

**问题：** `failReader()` 直接写原始错误和 `[DONE]`/Claude `event:error`，绕过已有 precommit buffer。

**证据：**

- `src/server/transformers/openai/chat/proxyStream.ts:92-106`
- `src/server/transformers/openai/responses/proxyStream.ts:139-153`

**目标行为：**

- reader 在任何有效输出前失败：返回 typed failure，不写下游字节。
- reader 在有效输出后失败：写一个协议内失败终态并结束。

**文件：**

- Modify: `src/server/transformers/openai/chat/proxyStream.ts`
- Review/possibly modify: `src/server/transformers/openai/responses/proxyStream.ts`
- Modify: `src/server/proxy-core/surfaces/chatSurface.ts`
- Modify: `src/server/proxy-core/surfaces/openAiResponsesSurface.ts`
- Test: `src/server/transformers/openai/chat/proxyStream.test.ts`
- Test: `src/server/transformers/openai/responses/proxyStream.test.ts`
- Test: `src/server/routes/proxy/chat.stream.test.ts`

**步骤：**

- [ ] 新增 reader 首次 `read()` 就抛错的 Chat、Claude、Responses 测试。
- [ ] 断言 precommit 情况下 sink 写入数组保持为空。
- [ ] 断言 Surface 返回过滤后的非 2xx JSON，而不是 HTTP 200 SSE。
- [ ] 对 postcommit 情况断言已发送部分内容保留，随后仅有一个错误终态。
- [ ] 运行目标测试并做变异验证。

**验收标准：**

- [ ] precommit reader failure 能进入 `resolveTerminalFailure()`。
- [ ] postcommit reader failure 不尝试新的 HTTP response 或通道重放。
- [ ] 错误文本是否净化由后续统一 public sanitizer 处理，不再由 transformer 私自决定。

---

## 3. 引入显式终止范围，区分单次失败、尝试预算耗尽与路由耗尽

**问题：** 当前策略只检查 `origin + phase + transport + key scope`，没有显式证明“所有通道耗尽”。深层 400 或单通道 404 也可能被改写成 503。

**证据：**

- `src/server/services/downstreamErrorPolicy.ts:227-238`
- `src/server/services/proxyRetryPolicy.ts:87-95`
- `src/server/proxy-core/surfaces/sharedSurface.ts:677-695`
- 默认最多尝试 3 次：`src/server/config.ts:127`
- 重试预算：`src/server/services/proxyChannelRetry.ts:3-13`

**设计：** 给 canonical failure 增加显式字段，建议：

```text
terminalScope:
  attempt
  attempt_budget_exhausted
  route_exhausted
```

必要时同时携带：

```text
attemptedChannelCount
maxChannelAttempts
eligibleChannelCount（仅在可可靠计算时）
```

**文件：**

- Modify: `src/server/services/downstreamErrorPolicy.ts`
- Modify: `src/server/proxy-core/surfaces/sharedSurface.ts`
- Modify: `src/server/proxy-core/surfaces/chatSurface.ts`
- Modify: `src/server/proxy-core/surfaces/openAiResponsesSurface.ts`
- Modify: `src/server/proxy-core/channelSelection.ts`（若需传递明确 exhaustion 状态）
- Test: `src/server/services/downstreamErrorPolicy.test.ts`
- Test: `src/server/proxy-core/surfaces/sharedSurface.test.ts`

**步骤：**

- [ ] 写单通道 deterministic 400 测试，当前应错误改写为 503，确认 FAIL。
- [ ] 写单通道 generic 404 且仍有其他合资格通道的测试。
- [ ] 写达到 `maxChannelAttempts` 后的 attempt-budget 测试。
- [ ] 写 `selectChannel()` 明确返回无路由/无候选的 route-exhausted 测试。
- [ ] 仅允许 `attempt_budget_exhausted`/`route_exhausted` 进入深层状态映射。
- [ ] `attempt` 级请求错误保持精确状态和协议 payload。
- [ ] 修改 UI/公开文案：默认三次应称“通道尝试预算耗尽”，不能称“所有配置通道耗尽”。
- [ ] 运行测试并做变异验证。

**验收标准：**

- [ ] 单次或首通道 failure 不会被伪装成全池耗尽。
- [ ] 达到尝试上限与真正无候选通道可被区分。
- [ ] 日志保留 attempted/max/eligible（若有）证据。

---

## 4. 保留确定性请求错误，不得改成瞬时 5xx

**问题：** `inferCanonicalFailureCause()` 没有普通 400/413/422 的精确分支；400 可落到 `internal_error`，然后被映射为 503。

**证据：**

- `src/server/services/downstreamErrorPolicy.ts:108-138`
- `src/server/services/downstreamErrorPolicy.ts:320-330`

**目标映射：**

- 下游请求格式/参数错误：保留 `400` 和准确 `type/code/message`。
- payload 过大：保留 `413`。
- 语义校验失败：保留 `422`。
- Responses 明确 previous-response miss：保留 request-scoped `404`。
- 深层模型/账号/配额错误只有在恢复边界耗尽后才转换成层级相对的公开 5xx。

**文件：**

- Modify: `src/server/services/downstreamErrorPolicy.ts`
- Modify: `src/server/transformers/shared/streamFailure.ts`（若需提取更精确类型）
- Test: `src/server/services/downstreamErrorPolicy.test.ts`

**步骤：**

- [ ] 增加 400/413/422、显式 previous-response 404、generic request-id 404 的矩阵测试。
- [ ] 从结构化 `error.type/error.code` 优先判定请求错误，文本只能作为窄范围辅助。
- [ ] 保留请求错误原始 payload 或协议等价 payload。
- [ ] 确认这些错误不会触发 `metapi_upstream_pool_exhausted`。
- [ ] 做变异验证。

---

## 5. 修复 WebSocket HTTP bridge 双终态

**问题：** 内层 SSE event 名称为 `response.failed`，但 JSON payload 可能是 `type: "error"`；外层只看 JSON type，随后又追加 408。

**证据：**

- 内层发送：`src/server/proxy-core/surfaces/openAiResponsesSurface.ts:996-1003,1119-1126,1227-1234`
- 外层解析：`src/server/routes/proxy/responsesWebsocket.ts:470-482`
- 追加 408：`src/server/routes/proxy/responsesWebsocket.ts:487-489`

**文件：**

- Modify: `src/server/routes/proxy/responsesWebsocket.ts`
- Possibly modify: `src/server/proxy-core/surfaces/openAiResponsesSurface.ts`
- Test: `src/server/routes/proxy/responses.websocket.test.ts`

**步骤：**

- [ ] 构造 `event: response.failed` + `data.type = error` 的 HTTP bridge 测试。
- [ ] 当前应观察到原错误加 408，确认测试红色。
- [ ] bridge 同时识别 SSE event 名称和 JSON type。
- [ ] 引入 request-local `terminalDelivered` 守卫，保证至多一个终态。
- [ ] 断言不再出现额外 `stream closed before response.completed`。
- [ ] 做变异验证。

---

## 6. 处理事件转换和下游写入异常，保证一个协议终态

**问题：** lifecycle 主要处理 reader 异常；事件 handler、transformer 或下游 write 抛错后，Surface 可能只断开连接。

**证据：**

- `src/server/transformers/shared/protocolLifecycle.ts:55-94`
- Chat catch：`src/server/proxy-core/surfaces/chatSurface.ts:1027-1032`
- Responses catch：`src/server/proxy-core/surfaces/openAiResponsesSurface.ts:1469-1474`

**文件：**

- Modify: `src/server/transformers/shared/protocolLifecycle.ts`
- Modify: Chat/Responses proxy stream session as needed
- Modify: Chat/Responses surfaces as needed
- Test: transformer tests and route-level stream tests

**步骤：**

- [ ] 注入 handler 抛错、transformer 抛错和 sink write 抛错测试。
- [ ] precommit：不提交流，返回 typed HTTP failure。
- [ ] postcommit 且 socket 可写：发送一个净化后的协议终态。
- [ ] postcommit 且 socket 已损坏：只能结束连接并记录内部错误，不再伪造第二终态。
- [ ] 断言日志/通道健康仍记录原始异常。
- [ ] 做变异验证。

---

# 第二阶段：建立统一的公开错误净化层

## 7. 将“状态改写”和“消息净化”拆成两种独立动作

**问题：** postcommit 无法改 HTTP status，但仍需要净化错误。当前 `isPolicyInScope()` 同时排除 postcommit/WebSocket，导致原始 provider 文本可能泄漏。

**设计：** 分成两个决策：

```text
statusRewriteAllowed: precommit HTTP/SSE-before-output
publicSanitizationAllowed: scoped key 的所有公开 transport/phase
```

**文件：**

- Modify: `src/server/services/downstreamErrorPolicy.ts`
- Possibly create: `src/server/services/downstreamPublicError.ts`
- Modify: `src/server/transformers/openai/chat/proxyStream.ts`
- Modify: `src/server/transformers/openai/responses/proxyStream.ts`
- Modify: `src/server/routes/proxy/responsesWebsocket.ts`
- Test: new/updated policy, transformer, route tests

**步骤：**

- [ ] 定义公开错误对象，保留 protocol/transport/phase，但不保留敏感原文。
- [ ] precommit 可以同时改 status、code、message。
- [ ] postcommit/WebSocket 只能净化协议内错误，不改已提交状态、不重放。
- [ ] 对敏感样例断言下游 bytes 不包含 token、内部 URL、账号、provider 原文。
- [ ] 对内部日志断言仍保留原始错误。
- [ ] 做变异验证。

**验收标准：**

- [ ] 原始操作错误和公开错误对象是两个独立对象。
- [ ] 不会把净化后的文本写回 tokenRouter/logging 输入。
- [ ] Chat、Claude、Responses、WebSocket 都有协议合法的净化失败形状。

---

## 8. 统一 postcommit Chat、Claude、Responses 的终态

**协议要求：**

- Chat SSE：明确 error envelope；不得同时输出成功 stop。
- Claude Messages SSE：`event: error` + Anthropic error shape；不得追加 `message_stop` 假完成。
- Responses SSE：`response.failed` + `[DONE]`，最多一次。
- 任何部分 tool call 被截断时，不得生成 `finish_reason: tool_calls` 或 `stop`。

**文件：**

- Modify/test Chat and Responses proxy stream transformer files
- Test: `src/server/transformers/openai/chat/proxyStream.test.ts`
- Test: `src/server/transformers/openai/responses/proxyStream.test.ts`
- Test: `src/server/routes/proxy/chat.stream.test.ts`

**测试矩阵：**

- [ ] 部分文本后失败。
- [ ] 部分 reasoning 后失败。
- [ ] 部分 tool name 后失败。
- [ ] 部分 tool arguments 后失败。
- [ ] 已完整 terminal 后 reader 再抛错。
- [ ] 原生 Claude `event:error`。
- [ ] 原生 Responses `response.failed`。

---

## 9. 为 Native Responses WebSocket 增加净化而非同 turn 重试

**现状：** WebSocket 会记录失败并在下一 turn 重新选通道，但当前 turn 原始错误直接转发。

**证据：**

- `src/server/routes/proxy/responsesWebsocket.ts:772-825`
- policy 显式排除 WebSocket：`src/server/services/downstreamErrorPolicy.ts:227-238`

**文件：**

- Modify: `src/server/routes/proxy/responsesWebsocket.ts`
- Modify: public sanitizer/policy service
- Test: `src/server/routes/proxy/responses.websocket.test.ts`

**步骤：**

- [ ] scoped key 下，保留内部原始 `response.failed` 记录。
- [ ] 下游只收到净化后的 `response.failed` 或 `error`。
- [ ] 当前 turn 不跨通道重放。
- [ ] 下一 turn 清除失败 channel pin 并重新选择。
- [ ] 断言一个 turn 一个终态、下一 turn 可继续使用同一 socket。

---

# 第三阶段：修复 passthrough 与持久化一致性

## 10. 让 `passthrough` 真正保留原始 payload，或移除伪选项

**问题：** `handleDetectedFailure()` 只保存 status/reason，不保存原始 payload，`passthrough` 可能得到重建后的通用 envelope。

**证据：**

- `src/server/proxy-core/surfaces/sharedSurface.ts:698-721`
- Chat 调用：`src/server/proxy-core/surfaces/chatSurface.ts:951-973`
- Responses 调用：`src/server/proxy-core/surfaces/openAiResponsesSurface.ts:1382-1404`

**文件：**

- Modify: `src/server/proxy-core/surfaces/sharedSurface.ts`
- Modify detector/callers to carry raw payload
- Test: `src/server/proxy-core/surfaces/sharedSurface.test.ts`
- Test: route-level Chat/Responses tests

**步骤：**

- [ ] 给 detector-based failure 增加原始 payload fixture。
- [ ] `off`/`passthrough` 断言 status、type、code、扩展字段、request ID 原样保留。
- [ ] 若某类传输无法严格 passthrough，明确将选项改为“兼容格式返回”并记录限制。
- [ ] `off` 与 `passthrough` 的产品语义必须明确；若完全相同，删除其中一个，避免假配置。

---

## 11. 修复 accounts-only 导入后的内存策略旧 ID

**问题：** 账号导入重建下游 Key 并把策略持久化为新 ID，但 remapped policy 未必进入 `appliedSettings`，运行时 `config.downstreamErrorPolicy` 可能仍引用旧 ID，直到重启。

**证据：**

- `src/server/services/backupService.ts:1615-1629,1883-1924`
- 仅应用 `appliedSettings`：`src/server/routes/api/settings.ts:1967-1971`
- 现有测试只验证数据库：`src/server/services/backupService.test.ts:1014-1029`

**文件：**

- Modify: `src/server/services/backupService.ts` and/or settings import orchestration
- Modify: `src/server/routes/api/settings.ts`
- Test: `src/server/services/backupService.test.ts`
- Test: relevant settings backup route tests

**步骤：**

- [ ] 写 accounts-only 导入后内存 config 仍是旧 ID 的回归测试。
- [ ] 导入结果显式返回 remapped policy，或导入完成后从数据库重新 hydration。
- [ ] 断言数据库和内存策略立即一致，无需重启。
- [ ] 同时覆盖 WebDAV import 路径。
- [ ] 做变异验证。

---

## 12. 启动 hydration 校验策略引用的 Key 是否存在

**问题：** 启动时只校验配置结构，不校验 ID 是否仍存在。

**证据：**

- `src/server/runtimeSettingsHydration.ts:87-93`

**文件：**

- Modify: hydration orchestration（避免把 DB 查询塞进纯解析函数）
- Test: `src/server/runtimeSettingsHydration.test.ts`
- Test: startup/runtime integration test as appropriate

**目标行为：**

- stale ID 不得静默绑定到以后复用的自增 ID。
- 若策略所有 Key 都失效，安全降级为 `off` 并记录 warning/event。
- 若仅部分失效，保留有效 Key 并持久化清理后的策略。

---

## 13. 用稳定非秘密标识替代数据库自增 ID/明文 Key 身份

**现状：** 备份通过 API Key 值映射身份，功能可用但使用秘密作为稳定身份。

**证据：**

- `src/server/services/backupService.ts:1446-1466`

**设计建议：** 为 downstream API key 增加非秘密 `stableId`/UUID：

- DB 内唯一；
- 创建时生成；
- 备份导出 stableId；
- 导入按 stableId remap；
- 实际 key 仍作为凭据，不作为引用身份。

**注意：** 该任务涉及 schema、迁移、SQLite/Postgres/MySQL parity，必须单独实施，不与前述 P0 修复混合。

**文件候选：**

- DB schema/contract/migration files
- `src/server/services/downstreamApiKeyService.ts`
- `src/server/services/backupService.ts`
- API contracts and tests

**验证：**

- [ ] 三种数据库 schema contract/parity 测试。
- [ ] 有 ID gap、导入顺序变化、key 轮换时策略仍绑定正确 stableId。
- [ ] API 不泄露完整 key。

---

# 第四阶段：补齐公共 Surface 覆盖

> 先完成第一至第三阶段的共享契约，再扩展路由，避免复制错误逻辑。

## 14. 接入 Gemini / Gemini CLI HTTP 与 SSE

**证据：**

- `src/server/proxy-core/surfaces/geminiSurface.ts:1343-1380,1438-1472,1491-1497`
- `CanonicalFailureProtocol` 已预留 `gemini`，但没有生产调用方。

**文件：**

- Modify: `src/server/proxy-core/surfaces/geminiSurface.ts`
- Modify: policy serializer for Gemini-native error shape
- Test: `src/server/routes/proxy/gemini.test.ts`
- Add/update Gemini surface tests as needed

**测试矩阵：** precommit HTTP、SSE-before-output、SSE-after-output、scoped/unscoped key、400/401/429/503。

---

## 15. 修复 Web Search simulation 绕过

**证据：**

- Chat 提前返回：`src/server/proxy-core/surfaces/chatSurface.ts:125-134`
- Responses 提前返回：`src/server/proxy-core/surfaces/openAiResponsesSurface.ts:269-277`
- simulation 原样转发 `/v1/search` 错误：`src/server/proxy-core/webSearchSimulation.ts:195-204,254-263`

**目标：** simulation 内部失败必须回到统一 canonical/public failure 边界，不能绕过 scoped key policy。

**文件：**

- Modify: `src/server/proxy-core/webSearchSimulation.ts`
- Modify: Chat/Responses surface orchestration
- Test: web-search simulation tests and route integration tests

---

## 16. 接入 legacy Completions

**证据：**

- `src/server/routes/proxy/completions.ts:68-76,120-170,270-272,323-373`

**要求：**

- 非流式终态接入共享 canonical failure。
- SSE 首字节前失败必须缓冲。
- 已输出后仅发送一个 legacy-compatible error terminal。

**测试：**

- `src/server/routes/proxy/completions.siteApiEndpoint.test.ts`
- `src/server/routes/proxy/completions.usage-source.test.ts`
- 新增 scoped policy 测试。

---

## 17. 接入 Embeddings 与 Search

**证据：**

- `src/server/routes/proxy/embeddings.ts:66-72,166-219`
- `src/server/routes/proxy/search.ts:91-99,171-218`

**要求：** 共用非流式 failure helper，不复制 Chat/Responses 的整套 Surface。

**测试：**

- `src/server/routes/proxy/embeddings.siteApiEndpoint.test.ts`
- `src/server/routes/proxy/search.test.ts`

---

## 18. 接入 Images 与 Videos

**证据：**

- Images：`src/server/routes/proxy/images.ts:63-71,116-148,185-233,274-282,342-374,411-459`
- Videos：`src/server/routes/proxy/videos.ts:75-83,168-197,202-260`

**注意：** Videos 的 task GET/DELETE 具有资源级 404/状态语义，不能用模型调用规则粗暴改写。Images/Videos 必须分别定义 request-scoped/resource-scoped 错误。

**测试：**

- `src/server/routes/proxy/images.edits.test.ts`
- `src/server/routes/proxy/videos.test.ts`
- 新增 generation/task lifecycle 的 scoped/unscoped 错误测试。

---

# 第五阶段：从固定模式演进为可配置规则引擎

> 只有前四阶段稳定后再做，避免用“灵活规则”掩盖底层语义缺陷。

## 19. 定义版本化规则模型

**建议结构：**

```yaml
version: 1
mode: rules
rules:
  - id: upstream-auth-exhausted
    enabled: true
    priority: 100
    scope:
      downstreamApiKeyIds: [12]
    match:
      protocols: [chat, responses, messages]
      transports: [http, sse, websocket]
      phases: [precommit, postcommit]
      origins: [upstream, routing]
      causes: [upstream_auth]
      terminalScopes: [attempt_budget_exhausted, route_exhausted]
    action:
      kind: remap_error
      status: 503
      type: server_error
      code: metapi_upstream_auth_exhausted
      message: All configured upstream attempts are currently unavailable.
```

**硬约束：**

- action 不允许产生 `< 400` status。
- postcommit/WebSocket action 不允许改 HTTP status，只能 sanitize protocol event。
- 规则不能更改内部 operational failure。
- message regex 必须有长度/数量限制并避免灾难性回溯；优先结构化 status/type/code/cause。
- 规则优先级和首个匹配/合并语义必须固定并测试。

**文件候选：**

- Modify: `src/server/services/downstreamErrorPolicy.ts`
- Possibly create: `src/server/services/downstreamErrorRules.ts`
- Modify: settings contracts/API/UI/backup/hydration
- Add comprehensive rule parser/evaluator tests

---

## 20. 设置页增加低风险可视化编辑与预览

**功能：**

- 规则启停、排序、复制、删除。
- 按 API Key、协议、transport、phase、status/type/code/cause 匹配。
- action 仅提供 preserve/sanitize/remap_error。
- 实时校验禁止 2xx、禁止 postcommit 改 status。
- 提供本地“输入失败 → 预览公开结果”的纯函数模拟，不发网络请求。
- 清晰显示覆盖范围和“不能保证任务不中断”的说明。

**文件：**

- Modify: `src/web/pages/Settings.tsx`
- Consider extracting feature component/helper，避免继续膨胀 Settings god-file
- Test: `src/web/pages/settings.downstream-error-policy.test.tsx`

**验收标准：**

- [ ] 无 Key 时不能启用 scoped rewrite。
- [ ] 删除最后一个 scoped Key 后策略安全关闭。
- [ ] 前端预览与后端 evaluator 使用同一契约测试向量。
- [ ] 保存失败不污染本地已生效状态。

---

## 21. 更新备份、导入、文档和兼容迁移

**要求：**

- 旧 `{mode, downstreamApiKeyIds}` 自动迁移到等价 version 1 preset。
- preferences-only 备份明确提示不包含依赖 downstream keys 的规则。
- all backup 使用 stableId remap。
- 文档说明映射矩阵、协议覆盖、pre/postcommit 边界、CPA/Hermes 恢复条件。

**文件候选：**

- `src/server/services/backupService.ts`
- `src/server/runtimeSettingsHydration.ts`
- `src/server/routes/api/settings.ts`
- `docs/configuration.md`
- `docs/client-integration.md`
- `docs/operations.md`

---

# 第六阶段：验证、上线与观测闭环

## 22. 运行分层测试

### 22.1 核心 policy 与 shared surface

```bash
npx vitest run --root . \
  src/server/services/downstreamErrorPolicy.test.ts \
  src/server/proxy-core/surfaces/sharedSurface.test.ts
```

### 22.2 流式转换与主路由

```bash
npx vitest run --root . \
  src/server/transformers/openai/chat/proxyStream.test.ts \
  src/server/transformers/openai/responses/proxyStream.test.ts \
  src/server/routes/proxy/chat.stream.test.ts \
  src/server/routes/proxy/responses.compact.test.ts \
  src/server/routes/proxy/responses.websocket.test.ts
```

### 22.3 设置、Key 生命周期与备份

```bash
npx vitest run --root . \
  src/server/routes/api/settings.events.test.ts \
  src/server/routes/api/downstreamApiKeys.test.ts \
  src/server/services/backupService.test.ts \
  src/server/runtimeSettingsHydration.test.ts \
  src/web/pages/settings.downstream-error-policy.test.tsx
```

### 22.4 扩展 Surface

按实施范围运行 Gemini、Completions、Embeddings、Search、Images、Videos 测试文件。

### 22.5 全局校验

```bash
npm run typecheck
npm run build
npm run repo:drift-check
npm test
```

**要求：**

- [ ] 全量测试必须取得一次新的全绿结果；若有 flaky，记录首次和重试输出，不能仅用定向测试替代。
- [ ] `git diff --check` 通过。
- [ ] 工作区仅包含本计划批准的文件。

---

## 23. 进行不联网的多跳契约测试

建立本地 fixture 模拟：

```text
Hermes-like client → CPA-like consumer fixture → Metapi → fake upstream
```

至少覆盖：

- [ ] deep upstream 401/403/429 经 Metapi 变成层级相对 503。
- [ ] deep deterministic 400 保持 400，不触发重复请求。
- [ ] 503 被 Hermes classifier 识别为 retryable overload。
- [ ] 失败不能变成普通 assistant stop。
- [ ] 部分 tool call 后失败不能变成成功 tool_calls/stop。
- [ ] retry/fallback 全耗尽时明确失败，而不是假成功。

不依赖真实受限站点，不读取或输出真实凭据。

---

## 24. 部署前检查与备份

- [ ] 主人确认部署目标、方式和版本。
- [ ] 确认目标实例当前 commit/image digest。
- [ ] 备份数据库、配置和当前镜像。
- [ ] 确认 probe/自动测活开关保持符合站点规则。
- [ ] 先部署到可回滚环境或保留旧容器/image。
- [ ] 记录回滚命令与验证点。

---

## 25. 使用真实自然任务做全链路验证

**禁止：** Hello、OK、健康检查、模型列表轮询、专门制造错误的探测请求。

**方法：** 等自然发生的真实 Hermes 任务触发已有失败，关联检查：

1. Metapi 内部原始错误、通道和尝试计数；
2. Metapi 对 CPA 返回的 status/type/code/message；
3. CPA 是否冷却/切换凭据，还是立即透传；
4. Hermes 是否 retry/fallback；
5. 当前任务是否继续产生真实 tool call/最终答案；
6. 是否出现假 `stop`、双终态、重复 tool call 或敏感信息泄漏。

**成功标准：**

- [ ] 原始内部错误保持可诊断。
- [ ] 下游公开错误符合规则且不泄密。
- [ ] 没有假成功。
- [ ] 有可用恢复资源时任务能继续。
- [ ] 无可用恢复资源时任务明确失败。
- [ ] 无双终态、无重复副作用、无任务状态污染。

---

# 建议的独立提交顺序（仅获授权后执行）

1. `fix(proxy): preserve failure semantics before stream commit`
   - 修复假成功、reader precommit 绕过。
2. `fix(proxy): distinguish attempt budget from route exhaustion`
   - 显式 exhaustion 和请求错误保留。
3. `fix(proxy): normalize websocket terminal delivery`
   - bridge 双终态和 WebSocket 净化。
4. `fix(proxy): sanitize post-commit stream failures`
   - Chat/Claude/Responses public sanitizer。
5. `fix(settings): keep downstream policy identity consistent`
   - 导入、hydration、stable identity。
6. `feat(proxy): extend downstream error policy surfaces`
   - Gemini/Web Search/其他 routes，必要时再按 surface 拆分。
7. `feat(settings): add configurable downstream error rules`
   - 版本化规则模型、UI、备份迁移、文档。

每个提交必须可独立回滚。推送前再次确认：**直推 `origin/main` 还是使用分支/PR**，不得根据历史偏好自行推送。

---

# 完成定义

只有同时满足以下条件，才可称为“下游返回值过滤器完成”：

- [ ] 不存在已知 `failure → 2xx/stop` 假成功路径。
- [ ] precommit failure 不会被 transformer 抢先提交。
- [ ] 单次失败、尝试预算耗尽、无候选路由语义明确。
- [ ] 400/413/422/request-scoped 404 保留请求语义。
- [ ] Chat、Claude、Responses、Gemini、WebSocket 公开失败形状经过测试。
- [ ] postcommit 只净化，不改 status、不重放。
- [ ] 一个请求最多一个终态。
- [ ] passthrough 行为名实相符。
- [ ] API Key 删除、批量删除、导入、重启、ID gap 后策略仍绑定正确身份。
- [ ] 所有宣称支持的 public routes 均接入，或设置页/文档明确列出不支持范围。
- [ ] typecheck、build、drift-check、全量测试通过。
- [ ] 真实自然任务完成一次 Hermes→CPA→Metapi 验证闭环。
- [ ] 部署有备份、版本证据和可执行回滚路径。

## 产品承诺边界

最终文案应使用：

> 将深层上游错误转换成下游可恢复信号，并净化公开错误，增加 CPA/Hermes 重试与 fallback 成功机会。

不得使用：

> 保证下游任务永不中断。

当 Metapi、CPA、Hermes 的所有恢复资源和预算耗尽时，系统必须明确失败，而不是制造一个看似成功的返回值。
