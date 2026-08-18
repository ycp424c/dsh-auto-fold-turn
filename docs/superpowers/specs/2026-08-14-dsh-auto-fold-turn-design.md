# DSH 自动折叠轮次过程插件设计

## 状态

- 日期：2026-08-14
- 目标仓库：`ycp424c/dsh-auto-fold-turn`
- 状态：设计已确认，尚未进入实现
- 运行目标：当前 DSH Web profile

## 背景

DSH 会在一轮对话中依次展示中间 assistant 输出、工具调用、重试和最终回复。长轮次完成后，用户通常优先阅读最终回复，但完整过程会占据大量垂直空间。

本插件在不修改、不 patch DSH 源码的前提下，把已经产生最终回复的轮内过程默认折叠，只保留用户消息、过程摘要行和最终回复。用户可以随时展开原始过程，展开选择跨刷新保留。

## 目标

1. 所有新完成轮次和已加载的历史轮次使用相同折叠规则。
2. 一轮存在 closing assistant 时，默认折叠位于最终回复之前的工具调用、中间 assistant、重试和其他轮内过程节点。
3. 保留用户消息、closing assistant、插件摘要行、最终回复之后的终态提示和 DSH 原生 turn-tail 操作。
4. 摘要行位于该轮 agent 回答的顶部（用户 prompt 之后、过程节点之前）。
5. 用户手动展开某轮后，刷新页面仍保持展开，直到用户再次折叠。
6. 插件无法可靠识别轮次或 DOM 时保持完整内容可见。
7. 插件禁用或卸载后，原生聊天内容完整恢复。

## 非目标

- 不修改 DSH Agent、Session、模型请求、会话日志或 Host 业务行为。
- 不重写原生聊天 renderer。
- 不增加全局“全部展开／全部折叠”控制。
- 不增加逐会话开关、Host 配置或设置页面。
- 不统计工具内部子调用；摘要数量只表示被隐藏的顶层聊天节点数。
- v1 不提供显隐动画或过程分类统计。

## 方案选择

### 采用：Conversation Node + 精确 DOM 适配层

插件通过 DSH 正式的 Conversation Node 扩展接口创建 `auto-fold-summary` Chat Node，并将其排列在该轮 agent 回答的顶部（用户 prompt 之后、首个过程节点之前）。节点 renderer 负责摘要交互；独立的 DOM 适配层只根据权威 Node key 隐藏或恢复既有原生节点。

该方案保留原生 renderer，与现有 Chat 插件共存，并把非正式 DOM 依赖隔离在一个很薄的模块中。

### 未采用：仅使用 assistant-actions 或 turn-tail slot

这两个位置都在最终回复之后。折叠开关控制的是此前的过程，把它放在回复 footer 不符合内容归属和阅读顺序。

### 未采用：纯 DOM Observer

根据 DOM 顺序猜测轮次无法可靠覆盖分页、steering、多步骤轮次和历史重放。

### 未采用：Shadow 原生 renderer

虽然 slot priority 允许覆盖原生 Node renderer，但插件必须复制大量 DSH UI，升级和插件组合成本远高于薄 DOM 适配层。

## 总体架构

插件是独立的 Web Client 插件。Host 侧只承担包的装载和 client bundle 暴露，不读取或修改会话数据。

逻辑组件如下：

### Plugin Entry

注册客户端依赖、`FoldSummaryDefinition`、`auto-fold-summary` keyed renderer、样式和生命周期清理。入口只做组装，不承载折叠策略。

### FoldSummaryDefinition

一个可重放的 `ConversationNodeDefinition`：

- 匹配已有 `turn/end`，以 turn number 作为 Definition-local id。
- 使用 immediate publication。
- 从 engine-owned Turn location 的 `turn-tail` data 读取 closing assistant。
- 没有 closing assistant 时不发布 Chat Node。
- 有 closing assistant 时发布 `auto-fold-summary` Node，数据包含 turn、closing seq 和稳定持久身份所需字段。
- `anchorSeq` 使用插件私有的、明确命名的 before-first-agent-content offset，使摘要位于该轮 agent 回答的顶部（用户 prompt 之后、首个过程节点之前）。真实事件流中 `step/start` 可能先于 `user/message`（agent/inbox/spliced），因此锚点取该轮第一个 agent 内容事件（`assistant/chunk` 等，均带 `turn` 字段且恒排在用户消息之后）的 seq。该排序假设由专门兼容测试覆盖，不散落在其他模块。

历史 replace、历史 prepend 和实时 append 必须产生相同的最终 Node。

### FoldTargetResolver

一个纯函数，从会话 Chat snapshot 和 summary Node 计算 `FoldTarget`：

- 从 `chat.locations.getTurn(turn)` 读取该轮有序 Node key。
- 与当前可见的 `chat.order` 求交集，不处理 DSH 已经隐藏的 Node。
- 找到 `finalNode.seq` 等于 closing seq 的 assistant Node，作为最终回复。
- 排除 closing assistant、`auto-fold-summary`、`turn-tail`。
- 防御性排除 `user` 和 `steering`，即使未来 DSH 把它们归入 Turn 也不会被隐藏。
- 只把 `anchorSeq` 严格早于最终回复的其余 Node 纳入过程集合（最终回复自身 anchor 是折叠边界）；原生排在最终回复之后的 error、max-token 等终态提示属于结果状态，保持可见。
- 返回过程数量、目标 key 和最终回复 key；无法唯一解析时返回不可折叠结果。

该模块只扫描当前 Turn，不扫描整个会话或完整事件窗口。

### FoldStateStore

维护用户主动展开的轮次集合：

- 身份为 `sessionId + turn`，不依赖可能缺失的 `messageId`。
- 默认状态是折叠，因此持久层只记录显式展开项。
- 展开时写入记录；再次折叠时删除记录。
- 使用版本化 localStorage key `dsh.auto-fold.expanded.v1`。
- localStorage 内容损坏时重置为空。
- 写入失败时保留当前页面内存状态，并记录一次诊断；不阻塞交互。

v1 不自动过期用户的显式展开选择，以兑现“直到再次折叠”的行为。

### TurnDomAdapter

唯一直接接触 DSH DOM 的模块：

- 通过 `[data-chat-anchor-key]` 和经过 `CSS.escape` 的精确 Node key 定位聊天行。
- 通过插件自有属性和样式统一隐藏过程行，不覆盖 DSH 自有 class 或内联样式。
- 在应用折叠前先解析完整目标集合；必要目标缺失时不做任何隐藏。
- 只移除插件自己添加的属性。
- 展开、组件卸载、会话切换或插件卸载时恢复现场。
- 使用 `[data-conversation-scroll]` 作为滚动容器，显隐前后补偿摘要行的 viewport top 差值，使摘要行保持在用户当前视口位置。

该适配层不安装全局 MutationObserver。Chat view 重新挂载或历史页加入时，相应的 summary renderer 会重新执行 layout effect；只有真实回归证明该机制不足时才增加更窄的观察器。

### FoldSummaryRow

`auto-fold-summary` Node 的 renderer：

- 通过标准 session props 读取 Chat snapshot。
- 调用 `FoldTargetResolver` 和 `FoldStateStore`。
- 在 layout effect 中调用 `TurnDomAdapter`，避免历史加载时先闪出完整过程。
- 没有过程节点时不显示摘要内容，并隐藏自己产生的空 flow row。
- 折叠时显示 `▶ 过程 · N 项`。
- 展开时显示 `▼ 收起过程 · N 项`。
- 整行是原生 button，提供 `aria-expanded`，支持 Enter 和 Space。

## 位置与排序

目标顺序固定为：

```text
用户消息
  [过程 · N 项 / 收起过程 · N 项]
  轮内过程节点……
最终回复
原生最终回复操作栏
```

折叠时过程节点不可见，摘要行位于用户消息之后、首个过程节点之前，是该轮 agent 回答的顶部。展开时过程恢复到摘要行下方，摘要仍位于其控制内容的开头。

摘要 Node 的排序通过该轮第一个 agent 内容事件（`assistant/chunk` / `assistant/message` / `tool/call` / `llm/retry`）的 seq 减去一个插件私有小数 offset 实现。offset 是兼容边界，不作为公共 API；测试必须证明它位于用户消息之后、所有过程节点之前。真实事件流中 `step/start` 可能先于 `user/message`（agent/inbox/spliced），因此 step 锚点不可靠——这些 agent 内容事件都带 `turn` 字段且恒排在用户消息之后（用户先提问、agent 才响应）。折叠边界以最终回复自身的 anchor 为准：任何原生排在最终回复之后的 Node 都不会被折叠，因此终态提示即使位于最终回复之后，也不会被误折叠。若未来 DSH 改变排序约定，兼容测试应失败，而运行时 DOM 适配仍保持 fail-open。

## 交互和视觉

- 摘要行使用 DSH 现有字体、颜色、圆角、hover 和 focus token，不硬编码主题颜色。
- 默认视觉弱于最终回复，不抢正文注意力。
- hover 和键盘 focus 时增强背景及文字对比度。
- v1 即时显隐，不做高度动画。
- 显隐操作保持摘要行相对 viewport 位置，避免内容在其上方出现或消失导致跳动。
- 没有过程节点时不显示摘要行。

## 数据流

```text
turn/end
  → FoldSummaryDefinition 找到 closing assistant 与 turn/start 位置
  → 发布排在 agent 回答顶部的 auto-fold-summary Node
  → FoldSummaryRow 读取 session snapshot
  → FoldTargetResolver 计算当前 Turn 的精确过程 Node key
  → FoldStateStore 读取默认折叠或显式展开状态
  → TurnDomAdapter 原子隐藏或恢复过程行
  → 用户点击时更新 store 并重新应用显隐
```

历史会话打开时，每个已加载且存在 closing assistant 的 Turn 都走同一流程，因此新完成轮次与历史轮次没有两套规则。

## 失败与兼容策略

运行时统一 fail-open：

- 没有 closing assistant：不生成摘要，不隐藏内容。
- 无法唯一识别最终 assistant：不隐藏内容。
- snapshot 目标和 DOM 行无法完整对应：不隐藏任何目标。
- localStorage 不可用：交互在当前页面继续工作，跨刷新持久化降级。
- 插件 renderer 或 DOM 适配失败：不得影响最终回复和 DSH 原生操作。
- 插件卸载：清除所有插件自有显隐属性和样式。

DOM 兼容依赖集中为：

- `[data-chat-anchor-key]`
- `[data-chat-flow-kind]`
- `[data-conversation-scroll]`

这些标记当前同时被 DSH 自身滚动逻辑和 E2E 测试使用，但不视为稳定公共 API。插件升级 DSH 时必须运行兼容 smoke；不匹配时保持完整内容可见。

## 测试设计

### Definition 单元测试

- 有 closing assistant 的 `turn/end` 生成 summary Node。
- 无 closing assistant 时不生成。
- 没有 `messageId` 的中断 closing assistant 仍可生成。
- summary anchor 严格位于 agent 回答顶部（用户 prompt 之后、首个过程节点之前）。
- 完整 replace、尾页后 prepend 和实时 append 产生相同 Node。

### Resolver 单元测试

- 只读取当前 Turn。
- 保留 closing assistant、summary、turn-tail、user 和 steering。
- 折叠最终回复之前的工具、中间 assistant 和 retry 等过程节点。
- 保留最终回复之后的 error、max-token 等终态提示。
- 多轮数据不相互污染。
- 解析歧义时返回不可折叠。

### Store 单元测试

- 默认折叠。
- 展开后可由新实例恢复。
- 再次折叠删除持久记录。
- 损坏 JSON 重置为空。
- localStorage 写入异常不破坏当前内存状态。

### DOM Adapter 单元测试

- 找齐全部目标后统一隐藏。
- 缺少任一必要目标时不产生部分隐藏。
- 展开和 dispose 恢复原 DOM。
- 不移除其他插件或 DSH 自有属性。
- 显隐前后摘要行 viewport top 保持在允许误差内。

### Client 组合测试

- 真实 Client 组合能注册 Definition 和 keyed renderer。
- HMR／dispose 后 registry 无残留，DOM 全部恢复。
- 与 produced-files、message-feedback 等现有插件同时组合时互不覆盖。

### 浏览器 E2E

1. 多步骤轮次结束后只显示用户消息、summary 和最终回复。
2. 展开恢复原顺序的全部过程；再次点击重新折叠。
3. 展开后刷新仍展开；折叠后刷新仍折叠。
4. 打开已有多轮历史时，各 Turn 独立折叠。
5. 有最终回复的 error、abort、max-token Turn 也折叠其前置过程，同时保留原生终态提示。
6. 没有最终回复的异常 Turn 保持完整显示。
7. 加载更早历史、切换 Chat／Trajectory、切换 Session 后状态正确。
8. 禁用插件后恢复完整原生聊天内容。
9. DOM 兼容标记缺失时保持完整内容可见。

### 实际运行验收

- 在当前 `web` profile 安装 link 插件并核对 profile package、patch、lockfile 和 node_modules。
- 启动 DSH，确认 Client package 进入 boot graph 且 activation 无 pending／failed。
- 在 Arc 完成一轮多步骤对话，验证折叠、展开、刷新、再次折叠和会话切换。
- 核对 DSH 源码参考仓库和当前 DSH checkout 均无改动。

## 性能边界

- Definition 对每个事件只执行常量时间 match。
- Resolver 每次只遍历所属 Turn 的 Node key。
- 不扫描完整 Session event window。
- 不安装全局 DOM Observer。
- 历史首次渲染的总工作量与已加载可见 Node 数量线性相关。

## 验收标准

1. 所有已加载、存在最终回复的 Turn 默认折叠，包括历史 Turn。
2. 折叠后保留用户消息、summary、最终回复、终态提示和原生 turn-tail 操作。
3. summary 位于用户消息之后、首个过程节点之前（agent 回答顶部）。
4. 每个 Turn 可独立展开和折叠。
5. 显式展开状态跨刷新保留，直到用户再次折叠。
6. 没有最终回复或无法可靠解析的 Turn 保持完整显示。
7. 一个 Turn 的操作不影响其他 Turn。
8. 插件禁用、卸载或兼容失败时不会隐藏原生内容。
9. produced-files、message-feedback、Trajectory、历史分页和 Session 切换无回归。
10. DSH 源码和运行 checkout 保持零修改。

## 后续演进

若 DSH 未来提供正式的整轮 visibility／wrapper slot，只替换 `TurnDomAdapter`，保留 Definition、Resolver、StateStore 和 SummaryRow。全局批量控制、逐会话设置、过程分类统计和动画只有在真实使用反馈证明需要时再设计。
