# Metapi 变更日志

> 这是当前项目的持续变更记录。后续每次新增功能、修复缺陷、调整接口或修改文档，都要在本文件追加一条记录，不能只修改代码而不记录。

## 记录规则

- 每条记录使用日期、变更类型、需求来源、Issue 链接、实现范围、验证结果和交付物几个字段。
- 有 GitHub Issue 时必须附上完整链接；没有 Issue 时标记为“本会话需求”，不要虚构编号。
- 代码完成后再补充实际文件路径和测试结果，未验证的内容必须明确标记为“未验证”。
- 采用追加方式维护历史记录，不覆盖已完成记录；如果后续修复同一问题，新增一条记录并链接到原记录。
- PDF、截图、需求说明等交付物也要记录，但不能把交付物当成代码实现本身。

## 2026-08-03

### 1. 每个站点独立最大并发

- **类型**：功能实现
- **需求来源**：本会话需求，未提供 GitHub Issue 链接
- **目标**：允许每个站点单独设置最大并发；`0` 表示不限制；不同站点的请求不能共享同一个并发计数器。
- **实现范围**：
  - 数据库 `sites.max_concurrency` 字段，默认值为 `0`，同步更新 schema contract 和各数据库启动产物。
  - 站点创建、更新 API 支持 `maxConcurrency`，接受 `0-100000` 的整数，并拒绝越界或非整数值。
  - 站点管理页面增加最大并发输入框和表格列，保存后可以看到每个站点自己的限制值。
  - 代理请求通过站点级 lease/队列控制并发；达到上限时只等待当前站点，不阻塞其他站点。
- **主要文件**：
  - `src/server/db/schema.ts`
  - `src/server/routes/api/sites.ts`
  - `src/server/services/proxyChannelCoordinator.ts`
  - `src/server/services/siteApiEndpointService.ts`
  - `src/server/proxy-core/surfaces/sharedSurface.ts`
  - `src/server/proxy-core/surfaces/geminiSurface.ts`
  - `src/web/pages/Sites.tsx`
  - `src/web/pages/helpers/sitesEditor.ts`
- **验证**：
  - `src/server/routes/api/sites.api-endpoints.test.ts` 覆盖创建、更新和越界校验。
  - `src/server/services/proxyChannelCoordinator.test.ts` 覆盖同站点排队、不同站点隔离和 `0` 不限流。
  - 本地页面实际显示 `concurrency-site` 的最大并发为 `1`，其他站点显示“不限制”。
- **状态**：已完成并在当前本地服务中运行。

### 2. Rerank 代理接口

- **类型**：功能实现
- **需求来源**：[GitHub Issue #591](https://github.com/cita-777/metapi/issues/591)
- **目标**：新增 `POST /v1/rerank`，复用现有的鉴权、模型路由、站点 API 地址池、重试、用量解析、计费和代理日志链路。
- **实现范围**：
  - 增加 Rerank 路由，校验 `model`，将请求转发到选中的上游 `/v1/rerank`。
  - 支持站点 API 地址池、首字节超时、通道重试和失败切换。
  - 成功路径解析用量并记录计费；失败路径只记录通道失败和代理失败日志，不虚构用量或费用。
  - 路由已在 proxy router 中注册。
- **主要文件**：
  - `src/server/routes/proxy/rerank.ts`
  - `src/server/routes/proxy/rerank.test.ts`
  - `src/server/routes/proxy/router.ts`
- **验证**：
  - 缺少 `model` 返回 HTTP 400。
  - 未携带下游鉴权调用实际本地接口返回 HTTP 401，鉴权边界生效。
  - Rerank 路由单元测试覆盖上游 URL、请求体转发和成功日志。
- **状态**：已完成。要得到真实排序结果，还需要在本地配置支持 Rerank 的上游站点和下游 API Key。

### 3. 路由优先级与 P0/P1/P2

- **类型**：缺陷修复
- **需求来源**：[GitHub Issue #590](https://github.com/cita-777/metapi/issues/590)
- **目标**：新建通道进入当前路由的下一优先级；拖拽或批量更新后优先级保持连续并和页面展示一致。
- **实现范围**：
  - 创建通道时按当前路由已有最大优先级计算默认值，不再把所有新通道固定为 `P0`。
  - 批量保存时按路由压缩为连续的 `P0`、`P1`、`P2` 等层级。
  - 返回通道列表时按 `priority`、`id` 排序，确保 API 和页面顺序一致。
  - 保留优先级拖拽后的保存和路由决策刷新行为。
- **主要文件**：
  - `src/server/routes/api/tokens.ts`
  - `src/web/pages/TokenRoutes.tsx`
  - `src/web/pages/token-routes/priorityRail.ts`
  - `src/web/pages/token-routes/RouteCard.tsx`
- **验证**：
  - 前端优先级 helper 和拖拽相关测试通过。
  - 本地路由页面实际展开 `deepseek-v4-pro`，通道显示在 `P0` 优先级桶中。
  - API 返回顺序使用 `priority`、`id` 排序。
- **状态**：已完成并在当前本地服务中运行。

### 4. Coding Plan v3 URL 拼接

- **类型**：缺陷修复
- **需求来源**：[GitHub Issue #586](https://github.com/cita-777/metapi/issues/586)
- **目标**：当上游 Base URL 已经以 `/v3` 等版本段结尾时，不要把下游请求的 `/v1` 重复拼接到 URL 中。
- **实现范围**：
  - URL 拼接逻辑识别末尾 `/vN` 版本段。
  - `.../api/coding/v3` 加 `/v1/chat/completions` 后得到 `.../api/coding/v3/chat/completions`。
  - 保持已有 `/v1`、无版本后缀和其他平台路径行为不回归。
- **主要文件**：
  - `src/server/proxy-core/orchestration/upstreamRequest.ts`
- **验证**：
  - Coding Plan v3 URL 拼接单元测试覆盖 v3、v1、无版本后缀和现有特殊路径。
  - Rerank 测试中的 Coding Plan v3 上游地址实际拼接为 `https://ark.cn-beijing.volces.com/api/coding/v3/rerank`。
- **状态**：已完成。

### 5. 渠道失败隔离

- **类型**：缺陷修复
- **需求来源**：[GitHub Issue #585](https://github.com/cita-777/metapi/issues/585)
- **目标**：一个渠道失败时，只更新实际失败渠道的冷却和失败状态，不影响同凭据的其他渠道，也不误触发站点级运行时熔断。
- **实现范围**：
  - 429 用量限流只冷却本次实际失败的 channel。
  - 不再按同一凭据扩散 `cooldownUntil` 或失败状态。
  - 429 不再写入站点级运行时熔断；其他健康渠道仍可参与选择。
  - 成功恢复时只清理当前通道自身的失败状态。
- **主要文件**：
  - `src/server/services/tokenRouter.ts`
  - 相关 token router、proxy retry 和路由健康状态测试文件
- **验证**：
  - 单线程 Vitest 覆盖限流失败、普通失败、成功恢复和站点熔断边界。
  - 验证结论：失败通道进入冷却，同凭据其他通道不扩散，429 不写入站点级熔断。
- **状态**：已完成。

### 6. 需求文档和演示交付物

- **类型**：文档与交付物
- **需求来源**：本会话中提供的四个 GitHub Issue
- **实现范围**：
  - 需求说明：[docs/plans/github-issues-591-590-586-585.md](plans/github-issues-591-590-586-585.md)
  - 网页演示 PDF：`output/pdf/metapi-issues-demo-2026-08-03.pdf`
  - PDF 包含当前 run 页面截图、站点独立并发、路由 P0、Rerank 请求示例、Coding Plan v3 和渠道失败隔离说明。
- **验证**：
  - 前端 `http://127.0.0.1:5174/` 返回 HTTP 200。
  - 后端 `http://127.0.0.1:4000/health` 返回 HTTP 200。
  - PDF 已渲染检查，共 6 页，中文正文和接口示例可读。
- **状态**：已完成。

### 7. 汇总验证

- `npm run typecheck:server`：通过
- `npm run typecheck:web`：通过
- `npm run typecheck:web:test`：通过
- `npm run test:schema:unit`：通过
- `npm run repo:drift-check`：通过
- 相关 Rerank、endpoint flow、路由优先级、tokenRouter、站点并发测试：使用单线程 Vitest 通过
- 说明：本机并行 Vitest worker 曾出现 OOM/UNKNOWN，后续复测优先使用：

```powershell
npx vitest run --pool=threads --poolOptions.threads.singleThread=true <test-file>
```

### 8. 建立持续变更日志

- **类型**：文档维护
- **需求来源**：本会话需求
- **目标**：把功能、修复、测试和交付物集中记录，作为后续改动的唯一开发日志。
- **实现范围**：新增本文件 `docs/change-log.md`，并提供 Issue 链接、文件路径、验证结果和后续追加模板。
- **状态**：已完成；后续每次代码或文档变更都追加到本文件。

## 2026-08-21

### 9. 提交到上游仓库的独立分支

- **类型**：版本交付
- **需求来源**：本会话需求：[Metapi 仓库](https://github.com/cita-777/metapi)
- **目标**：将本地已完成的站点独立并发、Rerank 和四个 Issue 修复提交到上游仓库的独立分支，不直接修改 `main`。
- **实现范围**：以远程 `main` 为基线创建 `codex/metapi-issues-591-590-586-585`，迁移代码、测试、数据库迁移产物、需求文档、持续日志和演示 PDF。
- **主要文件**：
  - `src/server/routes/proxy/rerank.ts`
  - `src/server/services/proxyChannelCoordinator.ts`
  - `src/server/services/tokenRouter.ts`
  - `src/server/db/schema.ts`
  - `docs/change-log.md`
- **验证**：`npm run typecheck:server`、`npm run typecheck:web`、`npm run typecheck:web:test`、`npm run test:schema:unit`、`npm run repo:drift-check` 均通过；相关聚焦测试通过，`tokenRouter.selection.test.ts` 单独运行 26/26 通过。
- **提交**：本地提交 `02e2308`（`feat: add proxy fixes and per-site concurrency`）。
- **推送结果**：未推送；GitHub 返回 `403 Permission to cita-777/metapi.git denied to lengxiaouser`，当前凭据对该仓库没有写权限；远程分支尚未创建。
- **状态**：代码已验证并在本地分支就绪，等待具备该仓库写权限的凭据后重试。

### 10. 创建 Fork 并准备 Pull Request

- **类型**：版本交付
- **需求来源**：本会话需求
- **目标**：通过个人 Fork 提交变更，避免直接写入上游仓库。
- **实现范围**：已创建 [lengxiaouser/metapi](https://github.com/lengxiaouser/metapi) Fork，目标分支为 `codex/metapi-issues-591-590-586-585`，PR 基线为上游 `main`。
- **验证**：Fork 的 `main` 已通过 Git 远程读取确认，功能分支已成功推送。
- **状态**：已完成。

### 11. 创建上游 Pull Request

- **类型**：版本交付
- **需求来源**：本会话需求
- **目标**：请求上游仓库审核本次站点并发控制、Rerank 及四个 Issue 修复。
- **实现范围**：创建 [PR #609](https://github.com/cita-777/metapi/pull/609)，源分支为 `lengxiaouser:codex/metapi-issues-591-590-586-585`，目标为 `cita-777:main`。
- **验证**：GitHub API 返回 PR 编号 `609`，状态为 `open`；PR 描述已包含 Issue 链接、验证命令和变更范围。
- **状态**：已提交，等待上游审核。

## 2026-08-22

### 12. 修复 CodeRabbit PR 审查问题

- **类型**：缺陷修复与架构重构
- **需求来源**：CodeRabbit 对 [PR #609](https://github.com/cita-777/metapi/pull/609) 的审查；对应 Issue：[#591](https://github.com/cita-777/metapi/issues/591)、[#590](https://github.com/cita-777/metapi/issues/590)、[#586](https://github.com/cita-777/metapi/issues/586)、[#585](https://github.com/cita-777/metapi/issues/585)
- **目标**：修复站点并发租约释放、并发超时误判、路由通道优先级竞态、Rerank 路由职责过重和变更日志字段不完整等问题。
- **实现范围**：
  - 流式响应交接后暂停后台续租，按真实读取进度续租；读取失败先取消 reader，再释放站点租约。
  - 为本地站点排队超时增加显式 `siteConcurrencyTimeout` 标记，统一由 `sharedSurface.ts` 分类，避免把真实上游 503 当成站点排队超时。
  - 新增 `routeChannelService.ts`，用进程内串行锁和数据库事务统一处理自动通道、批量通道、单通道和批量优先级写入，并统一清理路由决策缓存。
  - 新增 `rerankSurface.ts`，通过 `executeEndpointFlow()` 承担 Rerank 的站点地址池、首字节超时、上游请求、用量计费、日志和失败重试；路由文件只保留校验与委托。
  - 修正 Rerank 记录：只有成功响应解析用量并计费，失败只写失败状态日志，费用和用量为零/未知不代表已发生计费。
- **主要文件**：
  - `src/server/services/proxyChannelCoordinator.ts`
  - `src/server/services/siteApiEndpointService.ts`
  - `src/server/proxy-core/surfaces/sharedSurface.ts`
  - `src/server/proxy-core/surfaces/chatSurface.ts`
  - `src/server/proxy-core/surfaces/openAiResponsesSurface.ts`
  - `src/server/proxy-core/surfaces/geminiSurface.ts`
  - `src/server/proxy-core/surfaces/rerankSurface.ts`
  - `src/server/routes/proxy/rerank.ts`
  - `src/server/services/routeChannelService.ts`
  - `src/server/routes/api/tokens.ts`
  - `docs/change-log.md`
- **验证**：
  - `npm run typecheck:server`：通过。
  - `npx vitest run --pool=threads --poolOptions.threads.singleThread=true src/server/routes/proxy/rerank.test.ts src/server/services/siteApiEndpointService.test.ts src/server/services/proxyChannelCoordinator.test.ts`：通过，24 个测试通过。
  - 路由优先级与共享 surface 回归测试：通过，`tokens.batch.test.ts`、`tokens.route-update-rebuild.test.ts` 共 21 个测试，`sharedSurface.test.ts` 与 `sharedSurface.usage-source.test.ts` 共 24 个测试。
  - Rerank 测试实际验证上游 URL 为 `https://ark.cn-beijing.volces.com/api/coding/v3/rerank`、请求体转发和成功日志；测试环境的 quota best-effort 查询因未创建 `accounts` 表输出告警，但不影响请求结果。
  - `npm run typecheck:web`：通过。
  - `npm run typecheck:web:test`：通过。
  - `npm run test:schema:unit`：通过，15 个测试通过。
  - `npm run repo:drift-check`：通过，新增违规 0 个；报告中的 5 项为既有 tracked debt。
- **交付物**：本地 checkout 中的修复代码和本变更日志；无新增 PDF 或截图。
- **状态**：已完成，等待提交并更新 PR。

### 13. 修复 CodeRabbit follow-up 审查问题

- **类型**：缺陷修复与文档修正
- **需求来源**：CodeRabbit 对 [PR #609](https://github.com/cita-777/metapi/pull/609) 的 follow-up 审查
- **目标**：修复 Issue 链接的 Markdown 空格，并确保手工通道传入的明确优先级不会被自动分配逻辑覆盖。
- **实现范围**：
  - 将 `[ #591]` 修正为 `[#591]`，并确认 PR/Issue 链接均为合法 Markdown。
  - `routeChannelService` 区分明确优先级和自动候选：手工通道传入 `priority: 0`、`priority: 3` 等值时原样归一化保留；自动候选才分配下一个优先级。
  - 自动补齐候选不再把 `priority: 0` 当成显式优先级，避免所有自动通道固定在 P0。
- **主要文件**：
  - `src/server/services/routeChannelService.ts`
  - `src/server/routes/api/tokens.ts`
  - `docs/change-log.md`
- **验证**：
  - `npm run typecheck:server`：通过。
  - `npx vitest run --pool=threads --poolOptions.threads.singleThread=true --hookTimeout=30000 src/server/routes/api/tokens.batch.test.ts`：6 个测试通过。
  - `npx vitest run --pool=threads --poolOptions.threads.singleThread=true --hookTimeout=30000 src/server/routes/api/tokens.route-update-rebuild.test.ts`：15 个测试通过。
- **交付物**：代码与持续变更日志；无新增 PDF 或截图。
- **状态**：已完成，已推送到 PR 分支；本次日志修正随当前文档提交同步。

## 2026-10-25

### 1. 通道模型指纹检测（集成 lm-detector）

- **类型**：功能实现
- **需求来源**：本会话需求，未提供 GitHub Issue 链接
- **目标**：像糖果题一样在「路由」页手动触发、展示结果，用 [lm-detector](https://github.com/Ikaleio/lm-detector) 的数字指纹估计通道背后实际是哪个模型，并与糖果题结果组合解读。
- **实现范围**：
  - 依赖 `lmfpd-sdk@0.1.0`（MIT，精确锁版本），只用出题、请求体、数字解析、评分与参考库加载；不用 SDK 自带的 HTTP 路径，上游请求走 metapi 自己的站点 API 请求池与端点回退，密钥不出本机。
  - 每次检测串行发送 3 道挑战，使用中性 SDK 身份（与参考库采样环境一致）；参考库加载失败时不发上游请求。
  - 判定分为身份一致、疑似换皮、无法确认、非模型输出、未完成；疑似换皮需要校准置信度不低于 0.6（未校准的初值）且声称家族在参考库内。
  - 结果存 `settings`（`model_identity_probe_results_v1`），配置指纹包含参考库版本，新鲜期 24 小时；不进路由、健康与冷却。
  - 使用日志新增客户端族 `model_identity_probe`，与糖果题一起从聚合统计中排除；备份导出排除、导入账号与出厂重置时清空。
  - 前端新增「🔍 测身份」按钮、结果徽章、明细弹窗，以及糖果题 × 模型指纹的组合解读（两个弹窗共用同一个函数）。
- **主要文件**：
  - `src/server/services/modelIdentityProbeService.ts`
  - `src/server/services/modelIdentityProbe/detector.ts`、`familyMap.ts`、`verdict.ts`、`resultStore.ts`
  - `src/server/routes/api/modelIdentityProbe.ts`
  - `src/server/services/proxyLogQueries.ts`
  - `src/server/services/channelProbeContext.ts`
  - `src/shared/modelIdentityProbe.js`、`src/shared/modelIdentityProbe.d.ts`
  - `src/web/pages/token-routes/identityProbe/`、`src/web/pages/token-routes/probeSummary.ts`
  - `docs/configuration.md`
- **验证**：
  - `typecheck:web`、`typecheck:web:test`、`typecheck:server`、`typecheck:desktop`：通过。
  - 新增与受影响测试（指纹服务、适配层、判定、存储、路由、架构、日志聚合、糖果题回归、路由页前端）：全部通过。
  - `repo:drift-check`：新增违规 0 个；5 项为既有 tracked debt。
  - 全量 `vitest run`：9 个测试文件因 Windows 临时目录 `EPERM` 无法启动，在 `main` 上同样失败，与本改动无关；其余全部通过。
  - 未验证：真实上游通道上的端到端检测，以及 `mismatch` 阈值的校准。
- **交付物**：代码与本变更日志；无 PDF 或截图。
- **状态**：已完成，仅在本地分支 `feat/model-fingerprint-probe`，未推送。

## 2026-10-26

### 1. 模型指纹判定分级与路由一键测身份

- **类型**：功能实现
- **需求来源**：本会话需求（199 测试机 hub 站四个模型结果都显示「身份一致」，实际情况各不相同），未提供 GitHub Issue 链接
- **目标**：把只比较家族的「身份一致」拆成分级判定，让同家族换版本可见；路由级增加一键检测所有通道。
- **实现范围**：
  - 判定分级：型号一致、疑似换版本、家族一致、倾向一致；疑似换皮、无法确认、非模型输出、未完成保持原规则。只有「型号一致」显示为绿色。
  - 按「型号线」比较：日期快照（`-1017`、`-0731` 这类月日后缀）视为同一型号，声称型号的概率为其所有快照之和；规则在 `src/shared/modelIdentityProbe.js`，服务端判定与前端明细高亮共用。
  - 结果新增 `claimedProbability`；存量结果中的旧 `match` 读取为「家族一致」，不会被抬高成「型号一致」。
  - 判定文案集中在共享模块，使用日志备注、徽章、提示、明细与批量汇总读同一张表；组合解读按新等级更新。
  - 路由头部新增「🔍 一键测身份」：逐个通道串行检测、开始前确认请求数与预计耗时、显示进度、结束后按判定汇总；非对话模型跳过。
- **主要文件**：
  - `src/server/services/modelIdentityProbe/verdict.ts`、`familyMap.ts`、`resultStore.ts`
  - `src/shared/modelIdentityProbe.js`、`src/shared/modelIdentityProbe.d.ts`
  - `src/web/pages/token-routes/identityProbe/presentation.ts`、`useIdentityProbe.ts`、`IdentityProbeDetailModal.tsx`
  - `src/web/pages/token-routes/probeSummary.ts`、`RouteCard.tsx`
- **验证**：
  - 四个 typecheck 通过；`repo:drift-check` 新增违规 0。
  - 判定测试用 199 上四条 hub 实测排名作为用例：#26 型号一致、#24 型号一致（快照归一）、#27 疑似换版本、#25 倾向一致。
  - 指纹相关服务端、糖果题回归、路由页前端测试共 391 个通过。
  - 未验证：阈值 0.6 对「疑似换版本」的误报率。
- **交付物**：代码与本变更日志；无 PDF 或截图。
- **状态**：已完成，仅在本地分支，未推送。

## 2026-10-29

### 1. 糖果题、模型指纹检测、模型操练场共用从真实流量学到的客户端身份

- **类型**：功能实现
- **需求来源**：本会话需求（debian 部署调试抓取 #458–464 显示，内置的 Claude Code / Codex 模板与本机真实流量不一致），未提供 GitHub Issue 链接
- **目标**：三处合成请求都使用本机真实 CLI 流量的客户端身份，身份头走真实请求同样的透传规则，从而按客户端分流的中转站会把它们分到与真实流量相同的后端。
- **实现范围**：
  - 新增身份快照 `observedClientIdentity`：只在 `sharedSurface` 的成功路径上，从真实 `claude_code` / `codex` 请求学习。身份头值走白名单，会话头只记头名，请求体只记形状特征。操练场和探测请求不参与学习。快照持久化在 `settings`，不进入备份，出厂重置时清除。
  - 糖果题：身份头改为以 `downstreamHeaders` 发送（此前 Claude 的 Stainless 头会落到 Windows/x64 默认值），请求体按观察到的形状构建。内置模板修正：Codex 去掉 `Version`、`Conversation_id`，`Session_id` 改为 `session-id`；Claude 增加 `x-claude-code-session-id`。内置模板的 UA 改为模板自己的常量 `claude-cli/2.1.280 (external, cli)` 和 `codex_cli_rs/0.165.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464`（两者都是已发布版本；2.1.280 是 CLIProxyAPI 实测过的基线），不再沿用代理运行时的默认 UA。代理运行时的默认 UA 和 OAuth 配额探测不变。结果新增 `identitySource`、`identityUserAgent`。
  - 模型指纹检测：只替换请求头，请求体保持 SDK 原样（参考库在该请求体下采样）。三个挑战共用一个会话 id；Codex 身份合成跟随站点设置。接口新增 `clientIdentity: 'sdk'` 对照模式。旧结果读作 `sdk`。详情页展示身份来源。
  - 模型操练场：新增「客户端身份」选择（跟随真实客户端 / 指定 UA 变体 / 裸协议），只换请求头，不改请求体。每个对话一个会话种子。回环请求不再带 undici 默认的 `user-agent: undici`、`accept-language: *`。实际使用的身份通过响应头 `x-metapi-tester-identity` 回传并在页面展示。
  - 新增只读接口 `GET /api/client-identity/observed`；新增架构测试，固定单一写入点和指纹检测请求体不变两条规则。
- **主要文件**：
  - `src/server/services/observedClientIdentity.ts`、`src/server/routes/api/clientIdentity.ts`
  - `src/server/proxy-core/surfaces/sharedSurface.ts`、`chatSurface.ts`、`openAiResponsesSurface.ts`
  - `src/server/services/candyProbeService.ts`、`candyProbe/fingerprints.ts`、`candyProbe/resultStore.ts`
  - `src/server/services/modelIdentityProbeService.ts`、`modelIdentityProbe/resultStore.ts`、`src/shared/modelIdentityProbe.d.ts`
  - `src/server/routes/api/test.ts`、`src/web/pages/ModelTester.tsx`、`src/web/pages/helpers/modelTesterSession.ts`
  - `src/web/pages/token-routes/identityProbe/IdentityProbeDetailModal.tsx`、`presentation.ts`
- **验证**：
  - 四个 typecheck 通过；`repo:drift-check` 新增违规 0；`build:server` 通过。
  - 全量 vitest：3495 个测试通过。另有 9 个测试文件在清理临时目录时报 `EPERM`（Windows 本机环境问题，在未改动的 HEAD 上同样出现），其中的测试用例本身都通过。
  - 未验证：部署后用真实上游对比三处请求的上游头与真实流量 trace；`observed` 与 `sdk` 两种身份下指纹检测判定是否一致。
- **交付物**：代码与本变更日志；无 PDF 或截图。
- **状态**：已完成，仅在本地工作区，未提交、未推送。

### 2. 修复：客户端身份学习被普通 OpenAI SDK 客户端污染

- **类型**：缺陷修复
- **需求来源**：本会话代码评审（合并 `feat/model-fingerprint-probe` 前的 review），未提供 GitHub Issue 链接
- **问题**：身份学习只按 `clientKind` 过滤。代理的 Codex 识别是路由用的启发式规则，`/v1/chat/completions`、`/v1/responses` 上带任意 `x-stainless-*` 或 `openai-beta` 头的请求都会判为 `codex`，而 OpenAI 官方 SDK 默认就带这些头。于是 Cherry Studio、LobeChat 等第三方应用的成功请求会被学成「观察到的真实 Codex 客户端」，并成为糖果题、指纹检测和操练场的默认身份。
- **修复**：
  - 只学 UA 本身是官方客户端的请求：Claude Code 要求 `claude-cli/x.y.z`，Codex 要求 UA 命中 `codexClientFamily` 里的官方客户端规则（`codex_cli_rs/`、`codex_vscode/` 等）。单独的 `originator` 头不算数。代理的路由识别不变。
  - 启动加载持久化快照时套用同一规则，旧版本已经学进去的第三方 SDK 身份会被丢弃。
  - `claudeCodeProfile.ts` 导出 `isClaudeCodeUserAgent`，与 Claude Code 识别共用同一个 UA 规则。
- **主要文件**：`src/server/services/observedClientIdentity.ts`、`src/server/proxy-core/cliProfiles/claudeCodeProfile.ts`、`src/server/services/observedClientIdentity.test.ts`
- **验证**：
  - 四个 typecheck 通过；`repo:drift-check` 违规 0；`proxy-core` 全部及身份、糖果题、指纹检测、操练场相关的 37 个测试文件 412 个用例通过。
  - 新增的 3 个用例在未修复的代码上失败，修复后通过：OpenAI SDK 头被代理判为 `codex` 但不被学习；Claude 接口上的非 Claude Code UA 不被学习；旧快照中的第三方 SDK 行在加载时被丢弃。
- **交付物**：代码与本变更日志；无 PDF 或截图。
- **状态**：已完成，仅在本地工作区，未提交、未推送。

## 后续记录模板

复制下面模板追加到对应日期下，先记录需求来源，再补充实际实现和验证结果：

```md
### YYYY-MM-DD - 简短标题

- **类型**：功能实现 / 缺陷修复 / 重构 / 文档
- **需求来源**：[Issue #N](https://github.com/cita-777/metapi/issues/N) 或本会话需求
- **目标**：
- **实现范围**：
- **主要文件**：
  - `path/to/file`
- **验证**：
- **交付物**：代码、文档、PDF、截图等；没有交付物时填写“无”。
- **状态**：进行中 / 已完成 / 阻塞
```
