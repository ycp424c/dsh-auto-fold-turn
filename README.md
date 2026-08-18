# @ycp424c/dsh-auto-fold-turn

DSH Web 外部 client 插件：一轮对话产生最终回复后，自动把该轮位于最终回复之前的
工具调用、中间 assistant、重试等过程节点折叠为一行摘要（`▶ 过程 · N 项`），摘要行
位于该轮 agent 回答的顶部（用户 prompt 之后、过程节点之前）。用户可随时展开/收起，
显式展开状态按 `sessionId + turn` 持久化到 localStorage，跨刷新保留直到再次折叠。

该插件**不修改、不 patch DSH 源码**：所有行为通过 DSH 正式的 Conversation Node
扩展接口与一个薄 DOM 适配层实现；禁用或卸载插件后，原生聊天内容完整恢复。

## 行为

- 所有已加载、存在最终回复的 Turn 默认折叠，包括历史 Turn（历史 replace / prepend
  与实时 append 走同一规则）。
- 折叠后保留：用户消息、摘要行、最终回复、最终回复之后的终态提示（error /
  max-token 等）与 DSH 原生 turn-tail 操作。
- 每个 Turn 独立折叠/展开；一个 Turn 的操作不影响其他 Turn。
- 显式展开状态跨刷新保留，直到用户再次折叠。
- 没有最终回复或无法可靠解析的 Turn 保持完整显示。

## 失败与兼容策略（统一 fail-open）

- 没有 closing assistant：不生成摘要，不隐藏内容。
- 无法唯一识别最终 assistant：不隐藏内容。
- snapshot 目标与 DOM 行无法完整对应：不隐藏任何目标。
- localStorage 不可用/损坏/写入失败：交互在当前页面继续，持久化降级或重置。
- 插件卸载：清除所有插件自有显隐属性与样式。

## 架构

| 模块 | 职责 |
| --- | --- |
| `src/client/index.tsx` | 插件入口：注册 Definition、keyed renderer、样式表；生命周期随 fiber |
| `src/client/fold-summary-definition.ts` | `auto-fold-summary` Conversation Node Definition（match `turn/end` 与轮内 agent 内容事件，读 `turn-tail` data 的 closing，anchor 为该轮第一个 agent 内容事件 seq - 0.05） |
| `src/client/fold-target-resolver.ts` | 纯函数：从 Chat snapshot 计算本轮可折叠过程 key 与最终回复 key |
| `src/client/fold-state-store.ts` | `sessionId+turn` 显式展开集合，localStorage key `dsh.auto-fold.expanded.v1` |
| `src/client/dom-adapter.ts` | 唯一接触 DSH DOM 的模块：按 `[data-chat-anchor-key]` 精确 key 定位、原子显隐、`[data-conversation-scroll]` 滚动补偿 |
| `src/client/summary-row.tsx` | 摘要行 renderer：layout effect 应用显隐，原生 button + `aria-expanded` |

排序：摘要 Node 的 `anchorSeq` 为该轮第一个 agent 内容事件（`assistant/chunk` /
`assistant/message` / `tool/call` / `llm/retry`）的 seq 减插件私有小数 offset（兼容边界，
非公共 API），使按钮位于 agent 回答的顶部——用户 prompt 之后、所有过程节点之前。
这些事件都带 `turn` 字段且恒排在用户消息之后（真实事件流中 `step/start` 可能先于
`user/message`，即 agent/inbox/spliced，因此 step 锚点不可靠）。折叠边界以最终回复
自身的 anchor 为准：任何原生排在最终回复之后的 Node（终态提示、晚期工具证据）都不会被折叠。

## DOM 兼容标记

插件升级 DSH 后需运行兼容 smoke（INSTALL.md）。依赖的三个标记当前同时被 DSH
自身滚动逻辑与 E2E 测试使用，但不视为稳定公共 API：

- `[data-chat-anchor-key]`（行定位）
- `[data-chat-flow-kind]`（summary 行漂移校验）
- `[data-conversation-scroll]`（滚动容器）

## 折叠语义与参考源

- 折叠对象：该轮内、排序严格位于最终回复之前、且不在保护集合
  （`user` / `steering` / `turn-tail` / 最终回复）中的一切 Chat 节点——包括
  `tool-call`、中间 `assistant-step`、`model-retry`，以及 `context`、
  `command`、`compaction` 等轮内节点（均可展开恢复）。
- 最终回复之后的一切节点（终态 error / max-token 提示、晚期工具证据）永不折叠。
- DOM 标记语义：`[data-chat-anchor-key]` 缺失或流程 kind 漂移时**不隐藏任何行**
  （fail-open）；`[data-conversation-scroll]` 缺失时仍执行隐藏，仅跳过滚动
  补偿（行可随时展开恢复，不会丢失内容）。
- 测试与类型检查把 DSH 包解析到本机只读参考 checkout
  `<dsh-checkout>`（`.dsh/source/reference` 符号链接指向它）。DSH 升级后请同步
  reference 链接并重跑 `pnpm check`；`~/.dsh/source/current`（staging 快照）
  与 checkout 存在版本漂移时（例如 staging 早于 turn-max-tokens），以 reference
  为准。

## 开发

```bash
pnpm setup:dsh          # 链接 ~/.dsh/source/current（built DSH checkout，只读）
pnpm install
pnpm check              # typecheck + test + build
```

测试与类型检查会把 DSH 包解析到本机只读参考 checkout（`<dsh-checkout>` 源码 /
built types），运行真实 Conversation Node 引擎；详见 `vitest.config.ts` 与
`tsconfig.client.json` 的注释（`vitest.config.ts` 中 `.dsh/source/reference`
符号链接指向 `<dsh-checkout>`，需与 `scripts/link-dsh-source.mjs` 建立的
`.dsh/source/current` 区分）。

安装到本机 web profile 见 [INSTALL.md](./INSTALL.md)。

## License

MIT
