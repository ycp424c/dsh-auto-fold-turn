# DSH 自动折叠轮次过程插件（dsh-auto-fold-turn）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本计划可直接交给另一个 agent 执行，无占位符；每个步骤都包含精确文件路径、完整代码、精确命令与预期结果。

**Goal:** 在 DSH Web 中以零 DSH 源码修改的方式实现一个外部 client 插件：每轮产生最终回复后，自动把该轮位于最终回复之前的工具调用、中间 assistant、重试等过程节点折叠为一行摘要（`▶ 过程 · N 项`），摘要行位于被折叠内容之后、最终回复之前；用户可展开/收起，展开状态按 `sessionId+turn` 持久化到 localStorage，DOM 漂移时 fail-open。

**Architecture:** 插件是一个独立的 DSH Web Client 插件（外部包，host 半只做装载与 client bundle 暴露）。核心链路：`FoldSummaryDefinition`（Conversation Node，match `turn/end`，从 engine-owned Turn 的 `turn-tail` data 读 closing assistant，发布 `auto-fold-summary` Node，anchorSeq 为 closing seq 减私有小数 offset）→ `FoldTargetResolver`（纯函数，从 Chat snapshot 的 `chat.locations.getTurn(turn)` 与 `chat.order` 计算可折叠过程 key）→ `FoldStateStore`（localStorage 持久化显式展开集合）→ `TurnDomAdapter`（唯一触碰 DOM 的模块，按权威 Node key 隐藏/恢复行，滚动补偿）→ `FoldSummaryRow`（keyed renderer，layout effect 中应用显隐）。全部测试走 TDD：先用 `ConversationNodeAssembler` 做 assembled 测试，再用 jsdom 做 browser-equivalent 测试。

**Tech Stack:** TypeScript 6、pnpm 11.7、tsdown（client bundle，`window.__ModuleLoader__.load` 工厂产物）、vitest 4 + jsdom + @testing-library/react、React 18、cordis（DSH vendor）；对 DSH 包以 `link:.dsh/source/current/...` 链接 `~/.dsh/source/current`（built DSH checkout，只读引用，永不修改）。

---

**路径约定（执行本计划前先读）**：本计划中的命令使用以下占位符，执行时按本机实际情况替换：

- `<dsh-checkout>`：DSH 的 git 跟踪 checkout 目录（`git -C` 核验对象）。
- `<dsh-reference>`：DSH 只读参考仓库（实现参考，永不修改）。
- `<plugin-root>`：本插件仓库根目录（clone/checkout 本仓库的位置）。
- `~/.dsh`（即 `${DSH_HOME:-$HOME/.dsh}`）：DSH 用户目录，含 built checkout 快照
  `~/.dsh/source/current` 与 web profile `~/.dsh/profiles/web`，无占位符。

所有命令默认在 `<plugin-root>` 内运行；需要插件目录绝对路径的命令
（如 `dsh plugin --profile web add`）用 `"$PWD"` 代替。

## 0. 已核实的参考事实（执行 agent 无需再探索，全部来自 deepseek-harness-reference 与本地插件 dsh-browser-bridge / dsh-luna-vision-bridge）

### 0.1 Conversation Node 契约（`packages/client/runtime/src/client/contract/conversation.ts`，导出自 `@deepseek-ai/dsh-client-runtime/client`）

- `ConversationNodeDefinition<State>`：`kind`、`target?: 'chat'`、`match(event): {id, role:'start'|'update'} | null`、`start(context, match, reader): State`、`update(context, match): State`、`publication?(match): 'none'|'animation-frame'|'immediate'`、`buildLocationData?(context, scope)`、`buildViewNode?(context): ConversationViewNode | null`。`start` 与 `update` 是**必填**成员；返回 `undefined` 的 `start/update` 会被引擎抛错（`requireState`）。
- Node key：引擎用 `conversationContextKey(kind, id)`（`"${kind.length}:${kind}${id}"`）生成 `context.key`；`buildViewNode` 返回的 Node `key` 必须等于 `context.key`，否则引擎抛 `unstable key`。
- `ChatConversationViewNode`：`{key, kind, id, target:'chat', anchorSeq, location, visibility:'visible'|'hidden', data}`。
- `ConversationNodeContext`：`{key, kind, id, matches, start, state, current}`。
- Chat snapshot（`ChatSnapshot`）：`{order: readonly string[], nodes: ChatNodeStore, locations: ChatLocationNodeIndex, timeline, legacy}`；`ChatNodeStore.get(key)`、`ChatLocationNodeIndex.getTurn(turn)/getStep(turn,step)`、`chat.order` 只含 `visibility==='visible'` 的 Node key，按 `anchorSeq` 升序。
- Turn data：`location.turn.data.get('turn-tail')` 返回 `TurnTailChatData`：`{turn, seq, time, closing: FinalAssistantChatData|null, branchUnavailable, ttftMs?, tokensPerSecond?}`；`closing.finalNode.seq` 即最终回复 seq。`FinalAssistantChatData = AssistantChatData & {finalNode: AssistantMessageNode}`，`AssistantChatData` 含 `finalNode?: AssistantMessageNode`。
- 引擎时序：`flush()` 先 `replaceLocationData()`（step 阶段再 turn 阶段，turn 数据在 `buildNode` 之前全部安装），随后对所有 dirty context 调 `buildViewNode`。因此 summary 的 `buildViewNode` 能读到同一 flush 内 turn-tail 发布的 `location.turn.data.get('turn-tail')`。
- 窗口缺口：窗口内没有 `turn/start` 但有 `turn/end` 时，Definition 的 `update` 不会执行（state 为 undefined），但 `buildViewNode` 仍会被调用；`context.matches[0].location` 可解析出 `{kind:'turn', turn}`。参考实现：`turn-tail.ts`、`turn-error.ts` 的 `fallbackState`。
- 锚点参考值（`ui-conversation/src/client/conversation-nodes/common.ts` 的 `CHAT_SYNTHETIC_SEQ_OFFSETS`）：`interruptedAssistant: -0.9`、`interruptedFollowup: -0.8`、`maxTokensNotice: +0.05`、`finalizedFollowup: +0.1`。turn-tail 的 anchor = 最后文本 assistant 的 `finalNode.seq + 0.1`；max-tokens notice 的 anchor = `closing.finalNode.seq + 0.05`；中断冻结 partial 的 `finalNode.seq = closedBoundary(location).seq - 0.9`，其中 `closedBoundary` 优先取已关闭 step 的 `step/end`，其次取已关闭 turn 的 `turn/end`（assistant Definition 不 match `turn/end`/`step/end`，其位置由最后一次 refresh 决定）。
- `ConversationNodeAssembler`（`@deepseek-ai/dsh-client-runtime/client` 导出）：`replaceWindow(entries, hasMore)` / `append(input)` / `prepend(entries, hasMore)` / `flush()` / `snapshot(target)`；构造参数为 `{entries(), fallbackEntry()}` 与 `{entries()}` 两个 registry 接口。

### 0.2 Chat renderer 注册与标准 kit

- keyed renderer 注册（参考 `ui-conversation/src/client/chat/register-node-renderers.ts`、`apply.ts`、`contract/slots.ts`）：
  ```ts
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'auto-fold-summary',
  }, FoldSummaryRow))
  ```
  `locale` 是可选项（`ErasedRegisterOptions.locale?: string`），本插件不需要 `t`，不注册 locale。
- `ChatNodeDataMap` 是 merge-extensible registry（`ui-conversation/src/client/contract/chat-nodes.ts`）；外部包通过 `declare module '@deepseek-ai/dsh-client-ui-conversation/client' { interface ChatNodeDataMap { 'auto-fold-summary': FoldSummaryChatData } }` 扩展（参考 `turn-tail.ts` 第 13-18 行）。`@deepseek-ai/dsh-client-ui-conversation/client` 导出 `ChatNode`、`AssistantChatData`、`TurnTailChatData`、`ChatNodeDataMap`（见其 `src/client/index.ts`）。
- 运行时标准 kit（`runtime/src/client/index.ts` 第 124-151 行的 merge）：session 作用域组件收到 `useSession: SnapshotSelectorHook<ConversationSnapshot>`、`sessionId: SessionId`、`useProjection`；全局收到 `useSessions`、`useWorkspaces`。
- 服务：`ctx.conversationEvents.register(def)`（`ConversationEventRegistry`）、`ctx.conversationViews.register(viewDef)`（`ConversationViewRegistry`）、`ctx.slots.inject(key, cb)`（`SlotRegistry`）。三者均以 cordis effect 实现，fiber dispose 时自动清理。三者都从 `@deepseek-ai/dsh-client-runtime/client` 导出，测试可直接构造：`new ConversationEventRegistry(ctx)` 等（`Service` 基类自动注册到 ctx）。
- 每个 Chat 行 DOM（`ChatNodeSeat.tsx`）：外层 `div[data-chat-anchor-key={node.key}][data-chat-flow-key={node.key}][data-chat-flow-kind={node.kind}]`；滚动容器 `[data-conversation-scroll]`（`ConversationRoot.tsx` 第 189 行）；空 renderer 由 DSH CSS `.flowItem:empty { display:none }` 自动隐藏（`ChatView.module.css`）。

### 0.3 外部插件包结构与装载（模板：dsh-luna-vision-bridge 单目录、dsh-browser-bridge workspace）

- `dsh.plugin.json`：`{name, version, description, host:"lib/index.js", client:"lib/client.js", bundle:"cordis.patch.yml", config:{}}`。
- `package.json`：`exports` 含 `"."`、`"./client"`、`"./package.json"`；`dsh.bundle.patch: "./cordis.patch.yml"`；`dsh.client: {platform:"web", inject:[...]}`（client bundle 需要 require 的 DSH 包名，参考 `packages/client/modules/src/index.ts` 的校验）；devDependencies 用 `"link:.dsh/source/current/packages/..."` 与 `"cordis": "link:.dsh/source/current/vendor/cordis"`（`~/.dsh/source/current` 是 built DSH checkout，`lib/client.js`、`lib/types` 均存在；vendor cordis 的包名为 `cordis`）。
- `cordis.patch.yml`（bundle 层）：`- insert: - {id: <plugin-id>, name: '<pkg-name>'}`。
- 安装：`dsh plugin --profile web add <插件绝对路径>` = 在 `~/.dsh/profiles/web` 下 `pnpm add` + 按已安装依赖 reconcile `dsh.profile.bundles`（`apps/cli/src/plugin.ts`）。profile manifest 的 `dependencies` 形如 `"@ycp424c/xxx": "link:/abs/path"`。当前本机 profile 已装有 `@ycp424c/dsh-browser-bridge` 与 `@ycp424c/dsh-luna-vision-bridge`（`~/.dsh/profiles/web/package.json`）。
- client bundle 构建：tsdown 产 `lib/client.js`，CJS + `window.__ModuleLoader__.load({id, factory})` banner；`neverBundle: ['react','react/jsx-runtime','cordis']`（web shell 提供）。本插件的 client 代码对 DSH 全部是 type-only import，bundle 里没有 DSH 值依赖。
- 测试约定：`tests/**/*.spec.{ts,tsx}`；DOM 测试文件首行 `// @vitest-environment jsdom`；`vitest.config.ts` 默认 `environment:'node'`；typecheck 分 host/client 两套 tsconfig。
- DSH checkout 状态：`git -C <dsh-checkout> status --porcelain` 当前为空（DSH 工作区干净）；`git -C <dsh-reference> status --porcelain` 为空（只读参考，branch master）。`~/.dsh/source/current` 是 DSH checkout 的 staging worktree 快照，其 git 元数据已过期，改动核验以 `<dsh-checkout>` 为准。

### 0.4 主题 token（`ui-theme/src/styles/design-platform.css`、`base.css`）

- 颜色：`--dsw-alias-label-primary`、`--dsw-alias-label-secondary`、`--dsw-alias-bg-layer-1/2`、`--dsw-alias-border-l2`、`--dsw-alias-brand-primary`；字体 `--dsw-font-family`。CSS 变量带本地 fallback 值（防止 token 名漂移导致失效）。

---

## 1. 文件结构总览

| 路径 | 职责 |
| --- | --- |
| `package.json` | 插件包清单：exports、`dsh.bundle`/`dsh.client`、scripts（setup:dsh/build/typecheck/test/check）、devDeps `link:.dsh/source/current/...` |
| `pnpm-lock.yaml` | 由 `pnpm install` 生成 |
| `tsconfig.json` | host 侧：NodeNext、`lib:["ES2024"]`，只含 `src/index.ts` 与 host 测试 |
| `tsconfig.build.json` | host 构建：`rootDir:"src"`，输出 `lib/` |
| `tsconfig.client.json` | client 侧：Bundler、`allowImportingTsExtensions`、DOM lib、`noEmit` |
| `vitest.config.ts` | 测试 include `tests/**/*.spec.{ts,tsx}`，默认 node 环境 |
| `.gitignore` | `node_modules/`、`lib/`、`.dsh/`、`logs/`、`*.log` |
| `scripts/link-dsh-source.mjs` | 在插件目录建 `.dsh/source/current -> ~/.dsh/source/current` 符号链接 |
| `scripts/build-client.mjs` | tsdown 构建 `lib/client.js`（module-loader 工厂产物） |
| `dsh.plugin.json` | 插件元数据（host/client/bundle 入口） |
| `cordis.patch.yml` | web profile bundle 层：插入一行 `dsh-auto-fold-turn` |
| `src/index.ts` | host 半：no-op（只保证包可装载、client bundle 暴露） |
| `src/client/index.tsx` | client 插件入口：注册 Definition、keyed renderer、样式表，生命周期自动随 fiber |
| `src/client/contract.ts` | `FoldSummaryChatData` + `ChatNodeDataMap` 声明合并 |
| `src/client/fold-summary-definition.ts` | `foldSummaryDefinition` + 私有 anchor offset 常量 |
| `src/client/fold-target-resolver.ts` | `resolveFoldTarget(chat, summaryNode)` 纯函数 + `FoldTarget` |
| `src/client/fold-state-store.ts` | `FoldStateStore` + `foldIdentity` + storage key |
| `src/client/dom-adapter.ts` | `TurnDomAdapter`：按 key 定位行、原子显隐、滚动补偿、restore |
| `src/client/summary-row.tsx` | `FoldSummaryRow` renderer：按钮、aria-expanded、layout effect |
| `src/client/styles.ts` | `AUTO_FOLD_STYLE`（插件自有样式表文本）与按钮 class 常量 |
| `tests/package-metadata.spec.ts` | 元数据冒烟（package.json / dsh.plugin.json / patch 字段） |
| `tests/fold-summary-definition.spec.ts` | Definition assembled 测试（replace/prepend/append 同构） |
| `tests/fold-target-resolver.spec.ts` | Resolver 纯函数测试 |
| `tests/fold-state-store.spec.ts` | Store 持久化测试（fake storage） |
| `tests/dom-adapter.spec.ts` | DOM adapter jsdom 测试 |
| `tests/summary-row.spec.tsx` | SummaryRow 渲染/交互/持久化 jsdom 测试 |
| `tests/client-composition.spec.tsx` | 真实 cordis Context 组合 + dispose 无残留测试 |
| `tests/auto-fold-flow.spec.tsx` | assembled + jsdom 的浏览器等价全流程测试（覆盖设计 E2E #1-9） |
| `tests/auto-fold-fixture.ts` | 轻量 `ChatSnapshot` fixture 构造器（resolver/flow 测试共用） |
| `README.md` | 产品说明、架构、安装、卸载、fail-open 保证、DOM 兼容标记、开发 |
| `INSTALL.md` | 可执行安装冒烟清单（含 Arc 手工验收） |
| `LICENSE` | MIT |

目录约定：所有源代码在 `src/` 与 `src/client/`；所有测试在 `tests/`；构建产物在 `lib/`（gitignore）。host 测试（不需要 DOM/React）放 `tests/*.spec.ts`（加入 `tsconfig.json` include）；client 测试放 `tests/*.spec.ts(x)` 并加入 `tsconfig.client.json` include。所有 DOM/React 测试文件第一行必须是 `// @vitest-environment jsdom`。

---

## 2. Task 0：前置检查与基线（只读，不改任何东西）

**Files:** 无（只运行只读命令）

- [ ] **Step 1: 确认 DSH 参考仓库只读且干净**

  Run: `git -C <dsh-reference> status --porcelain`
  Expected: 无输出（空）。本仓库只作为实现参考，禁止写入。

- [ ] **Step 2: 确认当前 DSH checkout（工作区）干净**

  Run: `git -C <dsh-checkout> status --porcelain`
  Expected: 无输出（空）。运行中的 DSH 来自 `~/.dsh/source/current`（其 git 元数据已过期，以 `<dsh-checkout>` 为核验对象）。

- [ ] **Step 3: 确认本插件仓库工作区干净且只有计划/规格**

  Run: `git -C <plugin-root> status --porcelain` 与 `git -C <plugin-root> log --oneline -5`
  Expected: 工作区当前只有 `docs/superpowers/specs/...` 与 `docs/superpowers/plans/...` 未跟踪（或已提交）文件；无其他改动。

- [ ] **Step 4: 确认工具链版本与 DSH built checkout**

  Run: `node -v; corepack pnpm -v; ls ~/.dsh/source/current/packages/client/runtime/lib/client.js; ls ~/.dsh/source/current/packages/client/ui-conversation/lib/client.js; ls ~/.dsh/source/current/vendor/cordis/package.json; ls ~/.dsh/source/current/packages/client/web-react/lib/index.js`
  Expected: node `^22.19.0 || >=24.0.0`；pnpm `11.7.0`；四个 DSH 包路径全部存在（built checkout）。

- [ ] **Step 5: 记录基线**

  Run: `git -C <dsh-checkout> rev-parse HEAD && git -C <dsh-reference> rev-parse HEAD`
  Expected: 输出两个 commit hash。Task 10/11 结束时必须与此一致（DSH 零修改的凭据）。

---

## 3. Task 1：Package scaffold（根配置、脚本、host 入口、元数据）

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `tsconfig.client.json`
- Create: `vitest.config.ts`
- Create: `scripts/link-dsh-source.mjs`
- Create: `scripts/build-client.mjs`
- Create: `src/index.ts`
- Create: `dsh.plugin.json`
- Create: `cordis.patch.yml`
- Create: `LICENSE`
- Create: `tests/package-metadata.spec.ts`

- [ ] **Step 1: 写失败测试 —— 元数据冒烟**

  Create `tests/package-metadata.spec.ts`:

  ```ts
  import { readFileSync } from 'node:fs'
  import { resolve } from 'node:path'
  import { describe, expect, it } from 'vitest'

  const ROOT = resolve(import.meta.dirname, '..')

  function json(file: string): Record<string, unknown> {
    return JSON.parse(readFileSync(resolve(ROOT, file), 'utf8')) as Record<string, unknown>
  }

  describe('plugin package metadata', () => {
    it('declares exports, dsh.bundle and dsh.client for the web platform', () => {
      const manifest = json('package.json')
      expect(manifest.name).toBe('@ycp424c/dsh-auto-fold-turn')
      expect((manifest.exports as Record<string, unknown>)['./client']).toBe('./lib/client.js')
      const dsh = manifest.dsh as { bundle: { patch: string }; client: { platform: string; inject: string[] } }
      expect(dsh.bundle.patch).toBe('./cordis.patch.yml')
      expect(dsh.client.platform).toBe('web')
      expect(dsh.client.inject).toEqual(expect.arrayContaining([
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-conversation',
      ]))
    })

    it('keeps dsh.plugin.json pointing at the built host/client halves', () => {
      const plugin = json('dsh.plugin.json')
      expect(plugin.name).toBe('@ycp424c/dsh-auto-fold-turn')
      expect(plugin.host).toBe('lib/index.js')
      expect(plugin.client).toBe('lib/client.js')
      expect(plugin.bundle).toBe('cordis.patch.yml')
    })

    it('inserts exactly one bundle row for the web profile patch', () => {
      const patch = readFileSync(resolve(ROOT, 'cordis.patch.yml'), 'utf8')
      expect(patch).toContain("name: '@ycp424c/dsh-auto-fold-turn'")
      expect(patch).toContain('id: dsh-auto-fold-turn')
    })
  })
  ```

- [ ] **Step 2: 链接 DSH 源码并安装依赖（先装依赖，测试才能运行）**

  Run: `pnpm setup:dsh && pnpm install`
  Expected: `setup:dsh` 打印 `<plugin-root>/.dsh/source/current -> ~/.dsh/source/current`；`pnpm install` 成功生成 `pnpm-lock.yaml` 与 `node_modules/`，无 peer 冲突报错。

- [ ] **Step 3: 写根配置文件**

  Create `package.json`:

  ```json
  {
    "name": "@ycp424c/dsh-auto-fold-turn",
    "description": "DSH Web client plugin: auto-folds completed-turn process nodes behind a summary row; expand state persists per session+turn",
    "version": "0.1.0",
    "type": "module",
    "packageManager": "pnpm@11.7.0",
    "engines": {
      "node": "^22.19.0 || >=24.0.0"
    },
    "main": "lib/index.js",
    "types": "lib/index.d.ts",
    "exports": {
      ".": {
        "types": "./lib/index.d.ts",
        "default": "./lib/index.js"
      },
      "./client": "./lib/client.js",
      "./package.json": "./package.json"
    },
    "files": [
      "lib",
      "dsh.plugin.json",
      "cordis.patch.yml",
      "README.md",
      "INSTALL.md",
      "LICENSE"
    ],
    "dsh": {
      "bundle": {
        "patch": "./cordis.patch.yml"
      },
      "client": {
        "inject": [
          "@deepseek-ai/dsh-client-runtime",
          "@deepseek-ai/dsh-client-ui-conversation",
          "@deepseek-ai/dsh-client-ui-slots"
        ],
        "platform": "web"
      }
    },
    "scripts": {
      "setup:dsh": "node scripts/link-dsh-source.mjs",
      "build": "tsc -p tsconfig.build.json && node scripts/build-client.mjs",
      "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.client.json",
      "test": "vitest run",
      "check": "pnpm typecheck && pnpm test && pnpm build"
    },
    "peerDependencies": {
      "cordis": "^4.0.0-rc.7",
      "react": "^18.2.0"
    },
    "devDependencies": {
      "@deepseek-ai/dsh-client-runtime": "link:.dsh/source/current/packages/client/runtime",
      "@deepseek-ai/dsh-client-ui-conversation": "link:.dsh/source/current/packages/client/ui-conversation",
      "@deepseek-ai/dsh-client-ui-slots": "link:.dsh/source/current/packages/client/ui-slots",
      "@deepseek-ai/dsh-client-web-react": "link:.dsh/source/current/packages/client/web-react",
      "@testing-library/dom": "^10.4.0",
      "@testing-library/react": "^16.1.0",
      "@types/node": "^22.0.0",
      "@types/react": "~18.3.1",
      "cordis": "link:.dsh/source/current/vendor/cordis",
      "jsdom": "^26.1.0",
      "react": "^18.2.0",
      "tsdown": "^0.22.2",
      "typescript": "^6.0.3",
      "vitest": "^4.1.10"
    },
    "license": "MIT"
  }
  ```

  Create `.gitignore`:

  ```gitignore
  node_modules/
  lib/
  .dsh/
  logs/
  coverage/
  *.log
  ```

  Create `tsconfig.json`（host 侧；只含 host 入口与 host 测试，避免把 client 的 `.ts` 深度导入卷入 NodeNext 解析）:

  ```json
  {
    "compilerOptions": {
      "target": "ES2024",
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "lib": ["ES2024"],
      "types": ["node"],
      "strict": true,
      "noImplicitOverride": true,
      "noUncheckedIndexedAccess": true,
      "exactOptionalPropertyTypes": true,
      "verbatimModuleSyntax": true,
      "skipLibCheck": true,
      "forceConsistentCasingInFileNames": true,
      "declaration": true,
      "sourceMap": true,
      "outDir": "lib"
    },
    "include": ["src/index.ts", "tests/package-metadata.spec.ts"]
  }
  ```

  Create `tsconfig.build.json`:

  ```json
  {
    "extends": "./tsconfig.json",
    "compilerOptions": {
      "rootDir": "src"
    },
    "include": ["src/index.ts"]
  }
  ```

  Create `tsconfig.client.json`（client 侧；Bundler 解析 + DOM lib + `allowImportingTsExtensions`，与 DSH vendor 的放宽项一致）:

  ```json
  {
    "extends": "./tsconfig.json",
    "compilerOptions": {
      "module": "ESNext",
      "moduleResolution": "Bundler",
      "verbatimModuleSyntax": false,
      "allowImportingTsExtensions": true,
      "noEmit": true,
      "jsx": "react-jsx",
      "lib": ["ES2024", "DOM", "DOM.Iterable"],
      "types": ["node"],
      "exactOptionalPropertyTypes": false,
      "noUncheckedIndexedAccess": false,
      "noImplicitOverride": false
    },
    "include": [
      "src/client/**/*.ts",
      "src/client/**/*.tsx",
      "tests/fold-summary-definition.spec.ts",
      "tests/fold-target-resolver.spec.ts",
      "tests/fold-state-store.spec.ts",
      "tests/dom-adapter.spec.ts",
      "tests/summary-row.spec.tsx",
      "tests/client-composition.spec.tsx",
      "tests/auto-fold-flow.spec.tsx"
    ]
  }
  ```

  Create `vitest.config.ts`:

  ```ts
  import { defineConfig } from 'vitest/config'

  export default defineConfig({
    test: {
      include: ['tests/**/*.spec.{ts,tsx}'],
      environment: 'node',
      restoreMocks: true,
      clearMocks: true,
    },
  })
  ```

  Create `scripts/link-dsh-source.mjs`（只在本插件目录内创建符号链接，绝不写 DSH 目录）:

  ```js
  import { lstat, mkdir, readlink, symlink } from 'node:fs/promises'
  import { homedir } from 'node:os'
  import { isAbsolute, resolve } from 'node:path'

  let source = process.argv[2]
  if (source === '--') source = process.argv[3]
  source ??= process.env.DSH_SOURCE ?? resolve(homedir(), '.dsh/source/current')
  if (!isAbsolute(source)) throw new Error('usage: pnpm setup:dsh -- /absolute/path/to/dsh')

  const root = resolve(import.meta.dirname, '..')
  for (const required of [
    'AGENTS.md',
    'packages/client/runtime',
    'packages/client/ui-conversation',
    'packages/client/ui-slots',
    'packages/client/web-react',
    'vendor/cordis',
  ]) {
    await lstat(resolve(source, required))
  }

  const link = resolve(root, '.dsh/source/current')
  await mkdir(resolve(root, '.dsh/source'), { recursive: true })
  try {
    const current = await readlink(link)
    if (resolve(resolve(link, '..'), current) !== resolve(source)) {
      throw new Error(`existing DSH link points to ${current}`)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await symlink(resolve(source), link, 'dir')
  }

  console.log(`${link} -> ${resolve(source)}`)
  ```

  Create `scripts/build-client.mjs`（mirror dsh-luna-vision-bridge 的 client bundle 构建；CSS 已作为 TS 字符串内联，无需 css 插件）:

  ```js
  /**
   * Build the browser half as a DSH module-loader factory artifact at
   * lib/client.js. CJS-shaped code wrapped in
   * `window.__ModuleLoader__.load({ id, factory })`, with React and cordis
   * left external (the web shell provides them).
   */
  import { build } from 'tsdown'

  await build({
    name: '@ycp424c/dsh-auto-fold-turn/client',
    entry: { client: 'src/client/index.tsx' },
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
    outDir: 'lib',
    deps: {
      neverBundle: [
        'react',
        'react/jsx-runtime',
        'cordis',
      ],
      alwaysBundle: () => false,
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: "@ycp424c/dsh-auto-fold-turn", factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  })
  ```

  Create `src/index.ts`（host 半：no-op，只保证包可装载、client bundle 暴露）:

  ```ts
  /**
   * @ycp424c/dsh-auto-fold-turn — external DSH plugin, host half.
   * The host owns package loading and client bundle exposure only; all
   * folding behavior lives in the browser half (src/client). The web
   * profile's cordis patch row mounts this package so its `./client` bundle
   * joins the browser roster.
   */

  /** Cordis plugin id used in loader diagnostics. */
  export const name = '@ycp424c/dsh-auto-fold-turn'

  /** No host behavior: nothing to inject or configure. */
  export function apply(): void {}
  ```

  Create `dsh.plugin.json`:

  ```json
  {
    "name": "@ycp424c/dsh-auto-fold-turn",
    "version": "0.1.0",
    "description": "Auto-fold completed-turn process nodes behind a summary row in DSH Web",
    "host": "lib/index.js",
    "client": "lib/client.js",
    "bundle": "cordis.patch.yml",
    "config": {}
  }
  ```

  Create `cordis.patch.yml`:

  ```yaml
  # dsh-auto-fold-turn profile bundle patch: one row mounting the external
  # plugin into the web profile. The host is a no-op (package loading +
  # client bundle exposure); every folding behavior lives in the browser half.
  - insert:
      - id: dsh-auto-fold-turn
        name: '@ycp424c/dsh-auto-fold-turn'
  ```

  Create `LICENSE`:

  ```text
  MIT License

  Copyright (c) 2026 ycp424c

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
  ```

- [ ] **Step 4: 运行测试确认失败（TDD 红灯）**

  Run: `pnpm exec vitest run tests/package-metadata.spec.ts`
  Expected: FAIL（`package.json` 尚不存在 → 断言/Cannot find module 失败）。

- [ ] **Step 5: 运行测试确认通过**

  Run: `pnpm exec vitest run tests/package-metadata.spec.ts`
  Expected: PASS（3 个用例全过）。

- [ ] **Step 6: 类型检查与构建**

  Run: `pnpm typecheck`
  Expected: 两个 tsc pass 均无错误输出（exit 0）。

  Run: `pnpm build`
  Expected: 生成 `lib/index.js`、`lib/index.d.ts`、`lib/client.js`、`lib/client.js.map`；`lib/client.js` 首行含 `window.__ModuleLoader__.load({ id: "@ycp424c/dsh-auto-fold-turn",`。

- [ ] **Step 7: 验证 bundle 无 DSH 值依赖泄漏**

  Run: `grep -c "require(\"@deepseek-ai\|require('@deepseek-ai" lib/client.js || true`
  Expected: 0（本插件 client 对 DSH 全部是 type-only import；出现任何 `@deepseek-ai` require 都属于错误，需检查 `src/client` 是否误用了值导入）。

- [ ] **Step 8: Commit**

  ```bash
  git add package.json pnpm-lock.yaml .gitignore tsconfig.json tsconfig.build.json tsconfig.client.json vitest.config.ts scripts src/index.ts dsh.plugin.json cordis.patch.yml LICENSE tests/package-metadata.spec.ts
  git commit -m "feat: scaffold external DSH client plugin package (host no-op + client bundle build)"
  ```

- [ ] **Step 8: Commit**

---

## 4. Task 2：FoldSummaryChatData 契约 + FoldSummaryDefinition

**Files:**
- Create: `src/client/contract.ts`
- Create: `src/client/fold-summary-definition.ts`
- Test: `tests/fold-summary-definition.spec.ts`

设计要点（来自规格 §总体架构-FoldSummaryDefinition）：可重放的 `ConversationNodeDefinition`；以 turn number 为 Definition-local id；使用 immediate publication；从 engine-owned Turn location 的 `turn-tail` data 读取 closing assistant；无 closing assistant 不发布；有 closing 时发布 `auto-fold-summary` Node（data 含 turn、closingSeq）；`anchorSeq` 用插件私有 before-final offset（`closingSeq - 0.05`）；历史 replace、历史 prepend 与实时 append 必须产生相同 Node。

- [ ] **Step 1: 写失败测试**

  Create `tests/fold-summary-definition.spec.ts`:

  ```ts
  import { Context } from 'cordis'
  import { describe, expect, it } from 'vitest'
  import {
    ConversationEventRegistry, ConversationNodeAssembler, ConversationViewRegistry,
    type ChatSnapshot, type ConversationEventInput, type ConversationNodeDefinition,
    type ConversationViewDefinition,
  } from '@deepseek-ai/dsh-client-runtime/client'
  import { chatViewDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/chat-snapshot-builder.ts'
  import { assistantDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/assistant.ts'
  import { messageDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/message.ts'
  import { toolDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/tool.ts'
  import { turnTailDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/turn-tail.ts'
  import { turnErrorDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/turn-error.ts'
  import { turnMaxTokensDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/turn-max-tokens.ts'
  import { retryDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/retry.ts'
  import { AUTO_FOLD_SUMMARY_KIND, foldSummaryDefinition } from '../src/client/fold-summary-definition.ts'

  function at(
    seq: number,
    type: string,
    data: unknown,
    extra: Record<string, unknown> = {},
  ): ConversationEventInput {
    return {
      event: {
        seq,
        time: 1_700_000_000_000 + seq,
        type,
        data,
        ...extra,
      } as unknown as ConversationEventInput['event'],
      view: undefined,
    }
  }

  function textMessage(id: string, text: string) {
    return {
      id,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }
  }

  function assistantMessage(id: string, text: string) {
    return {
      id,
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'fake', model: 'fake' },
    }
  }

  function toolResult(callId: string, text: string) {
    return {
      id: `result-${callId}`,
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError: false,
      }],
    }
  }

  function assemble(
    entries: readonly ConversationEventInput[],
    hasMore = false,
    extraDefinitions: readonly ConversationNodeDefinition[] = [],
  ): ChatSnapshot {
    const ctx = new Context()
    const events = new ConversationEventRegistry(ctx)
    const views = new ConversationViewRegistry(ctx)
    for (const definition of [
      messageDefinition,
      assistantDefinition,
      toolDefinition,
      retryDefinition,
      turnErrorDefinition,
      turnMaxTokensDefinition,
      turnTailDefinition,
      ...extraDefinitions,
    ]) {
      events.register(definition)
    }
    events.register(foldSummaryDefinition)
    views.register(chatViewDefinition as unknown as ConversationViewDefinition)
    const value = new ConversationNodeAssembler(events, views)
    value.replaceWindow(entries, hasMore)
    value.flush()
    return value.snapshot('chat') as ChatSnapshot
  }

  function node(value: ChatSnapshot, kind: string) {
    return value.nodes.values().find(candidate => candidate.kind === kind)
  }

  const completedTurn = (turn: number, start = 1): ConversationEventInput[] => [
    at(start, 'turn/start', { turn }),
    at(start + 1, 'user/message', textMessage(`u${turn}`, `ask ${turn}`), { surfaceOp: 'append' }),
    at(start + 2, 'step/start', { turn, step: 1 }),
    at(start + 3, 'tool/call', { turn, step: 1, callId: `c${turn}`, name: 'read', arguments: '{}' }),
    at(start + 4, 'tool/result', { turn, step: 1, message: toolResult(`c${turn}`, 'ok') }, { surfaceOp: 'append' }),
    at(start + 5, 'assistant/message', {
      turn,
      step: 1,
      message: assistantMessage(`a${turn}`, `answer ${turn}`),
    }, { surfaceOp: 'append' }),
    at(start + 6, 'step/end', { turn, step: 1 }),
    at(start + 7, 'turn/end', { turn, reason: { kind: 'completed' } }),
  ]

  describe('auto-fold-summary Definition', () => {
    it('publishes a summary Node only when the turn has a closing assistant', () => {
      const withClosing = assemble(completedTurn(1))
      const summary = node(withClosing, AUTO_FOLD_SUMMARY_KIND)
      expect(summary).toBeDefined()
      expect(summary?.data).toMatchObject({ turn: 1, closingSeq: 6 })

      const toolOnly = assemble([
        at(1, 'turn/start', { turn: 2 }),
        at(2, 'user/message', textMessage('u2', 'run tool'), { surfaceOp: 'append' }),
        at(3, 'step/start', { turn: 2, step: 1 }),
        at(4, 'tool/call', { turn: 2, step: 1, callId: 'c2', name: 'read', arguments: '{}' }),
        at(5, 'tool/result', { turn: 2, step: 1, message: toolResult('c2', 'ok') }, { surfaceOp: 'append' }),
        at(6, 'step/end', { turn: 2, step: 1 }),
        at(7, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
      ])
      expect(node(toolOnly, AUTO_FOLD_SUMMARY_KIND)).toBeUndefined()
    })

    it('still publishes for an interrupted closing assistant without a messageId', () => {
      const value = assemble([
        at(1, 'turn/start', { turn: 3 }),
        at(2, 'user/message', textMessage('u3', 'ask'), { surfaceOp: 'append' }),
        at(3, 'step/start', { turn: 3, step: 1 }),
        at(4, 'assistant/chunk', { turn: 3, step: 1, chunk: { type: 'text-delta', index: 0, text: 'partial' } }),
        at(5, 'step/end', { turn: 3, step: 1 }),
        at(6, 'turn/end', { turn: 3, reason: { kind: 'abort' } }),
      ])
      const summary = node(value, AUTO_FOLD_SUMMARY_KIND)
      expect(summary).toBeDefined()
      // The frozen partial freezes at the closed step boundary: step/end seq 5
      // minus the interruptedAssistant offset 0.9 → 4.1 (the assistant
      // Definition does not match turn/end, so its boundary is the step/end).
      expect((summary?.data as { closingSeq: number }).closingSeq).toBeCloseTo(5 - 0.9, 5)
    })

    it('anchors strictly before the closing assistant and after the process rows', () => {
      const value = assemble(completedTurn(1))
      const summary = node(value, AUTO_FOLD_SUMMARY_KIND)!
      const closing = node(value, 'assistant-step')!
      const tool = node(value, 'tool-call')!
      expect(summary.anchorSeq).toBeLessThan(closing.anchorSeq)
      expect(summary.anchorSeq).toBeGreaterThan(tool.anchorSeq)
      expect(summary.anchorSeq).toBeCloseTo(6 - 0.05, 5)
    })

    it('keeps the max-tokens notice after the summary anchor (visible, not folded)', () => {
      const value = assemble([
        at(1, 'turn/start', { turn: 4 }),
        at(2, 'user/message', textMessage('u4', 'ask'), { surfaceOp: 'append' }),
        at(3, 'step/start', { turn: 4, step: 1 }),
        at(4, 'assistant/message', {
          turn: 4,
          step: 1,
          message: assistantMessage('a4', 'truncated'),
        }, { surfaceOp: 'append' }),
        at(5, 'step/end', { turn: 4, step: 1 }),
        at(6, 'turn/end', { turn: 4, reason: { kind: 'max-tokens' } }),
      ])
      const summary = node(value, AUTO_FOLD_SUMMARY_KIND)!
      const notice = node(value, 'turn-max-tokens')!
      const tail = node(value, 'turn-tail')!
      expect(summary.anchorSeq).toBeCloseTo(4 - 0.05, 5)
      expect(notice.anchorSeq).toBeGreaterThan(summary.anchorSeq)
      expect(tail.anchorSeq).toBeGreaterThan(summary.anchorSeq)
    })

    it('produces the same final Node across full replace, historical prepend and live append', () => {
      const all = completedTurn(5)
      const fullReplace = assemble(all)
      const summaryA = node(fullReplace, AUTO_FOLD_SUMMARY_KIND)!

      // Historical: tail window first (no turn/start), then prepend the head.
      const tail = all.slice(5)
      const ctx = new Context()
      const events = new ConversationEventRegistry(ctx)
      const views = new ConversationViewRegistry(ctx)
      for (const definition of [
        messageDefinition, assistantDefinition, toolDefinition, retryDefinition,
        turnErrorDefinition, turnMaxTokensDefinition, turnTailDefinition,
      ]) {
        events.register(definition)
      }
      events.register(foldSummaryDefinition)
      views.register(chatViewDefinition as unknown as ConversationViewDefinition)
      const value = new ConversationNodeAssembler(events, views)
      value.replaceWindow(tail, true)
      value.flush()
      expect(node(value.snapshot('chat') as ChatSnapshot, AUTO_FOLD_SUMMARY_KIND)).toBeDefined()
      value.prepend(all.slice(0, 5), false)
      value.flush()
      const summaryB = node(value.snapshot('chat') as ChatSnapshot, AUTO_FOLD_SUMMARY_KIND)!
      expect(summaryB.key).toBe(summaryA.key)
      expect(summaryB.data).toEqual(summaryA.data)
      expect(summaryB.anchorSeq).toBe(summaryA.anchorSeq)

      // Live: events up to step/end first, then append turn/end.
      const ctx2 = new Context()
      const events2 = new ConversationEventRegistry(ctx2)
      const views2 = new ConversationViewRegistry(ctx2)
      for (const definition of [
        messageDefinition, assistantDefinition, toolDefinition, retryDefinition,
        turnErrorDefinition, turnMaxTokensDefinition, turnTailDefinition,
      ]) {
        events2.register(definition)
      }
      events2.register(foldSummaryDefinition)
      views2.register(chatViewDefinition as unknown as ConversationViewDefinition)
      const live = new ConversationNodeAssembler(events2, views2)
      live.replaceWindow(all.slice(0, -1), false)
      live.flush()
      expect(node(live.snapshot('chat') as ChatSnapshot, AUTO_FOLD_SUMMARY_KIND)).toBeUndefined()
      live.append(all.at(-1)!)
      live.flush()
      const summaryC = node(live.snapshot('chat') as ChatSnapshot, AUTO_FOLD_SUMMARY_KIND)!
      expect(summaryC.key).toBe(summaryA.key)
      expect(summaryC.data).toEqual(summaryA.data)
      expect(summaryC.anchorSeq).toBe(summaryA.anchorSeq)
    })
  })
  ```

- [ ] **Step 2: 运行测试确认失败**

  Run: `pnpm exec vitest run tests/fold-summary-definition.spec.ts`
  Expected: FAIL（`../src/client/fold-summary-definition.ts` 不存在 → Cannot find module）。

- [ ] **Step 3: 写契约与实现**

  Create `src/client/contract.ts`:

  ```ts
  import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-runtime/client'

  /**
   * Renderer payload of the auto-fold summary node: the turn number and the
   * closing assistant's durable finalNode seq. `closingSeq` is the resolver's
   * authoritative final-reply identity and the anchor basis (summary anchors
   * strictly before it).
   */
  export interface FoldSummaryChatData {
    readonly turn: number
    readonly closingSeq: number
  }

  declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
    interface ChatNodeDataMap {
      /** Completed-turn process fold summary, anchored before the closing assistant. */
      'auto-fold-summary': FoldSummaryChatData
    }
  }

  /** The auto-fold summary Chat view node. */
  export type FoldSummaryChatNode = ChatConversationViewNode & {
    readonly kind: 'auto-fold-summary'
    readonly data: FoldSummaryChatData
  }
  ```

  Create `src/client/fold-summary-definition.ts`:

  ```ts
  import type {
    ConversationNodeContext, ConversationNodeDefinition, TurnLocation,
  } from '@deepseek-ai/dsh-client-runtime/client'
  import type { TurnTailChatData } from '@deepseek-ai/dsh-client-ui-conversation/client'
  import type { FoldSummaryChatData } from './contract.ts'

  /**
   * Plugin-private sort offset: the summary anchors strictly before the
   * closing assistant but after every integer-seq process node of the turn.
   * Compatibility boundary — NOT a public API; the dedicated ordering tests
   * pin it. Native fractional neighbors (maxTokensNotice +0.05, turn-tail
   * finalizedFollowup +0.1, interruptedAssistant -0.9) never fall inside
   * (closingSeq - 0.05, closingSeq).
   */
  export const AUTO_FOLD_SUMMARY_ANCHOR_OFFSET = -0.05

  /** The Definition/renderer kind of this plugin's summary row. */
  export const AUTO_FOLD_SUMMARY_KIND = 'auto-fold-summary'

  interface FoldSummaryState {
    readonly turn: number
  }

  /** Resolve the engine-owned Turn for this Context (works across window gaps). */
  function turnLocation(context: ConversationNodeContext<FoldSummaryState>): TurnLocation | undefined {
    const location = context.start?.location ?? context.matches[0]?.location
    return location?.kind === 'turn' || location?.kind === 'step' ? location.turn : undefined
  }

  /** Read the closing assistant's finalNode seq from the engine-owned turn-tail data. */
  function closingSeq(context: ConversationNodeContext<FoldSummaryState>): number | undefined {
    const turn = turnLocation(context)
    const tail = turn?.data.get('turn-tail') as TurnTailChatData | undefined
    return tail?.closing?.finalNode?.seq
  }

  /**
   * Completed-turn summary Definition: matches every `turn/start`/`turn/end`,
   * publishes one keyed Node per turn with immediate cadence, and stays
   * silent (returns null) when the turn has no closing assistant.
   */
  export const foldSummaryDefinition: ConversationNodeDefinition<FoldSummaryState> = {
    kind: AUTO_FOLD_SUMMARY_KIND,
    target: 'chat',
    match: (event) => {
      if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
      if (event.type === 'turn/end') return { id: String(event.data.turn), role: 'update' }
      return null
    },
    start: (_context, match) => {
      if (match.event.type !== 'turn/start') throw new Error('auto-fold-summary start requires turn/start')
      return { turn: match.event.data.turn }
    },
    update: context => context.state,
    publication: () => 'immediate',
    buildViewNode: (context) => {
      const location = context.start?.location ?? context.matches[0]?.location
      if (location?.kind !== 'turn' && location?.kind !== 'step') return null
      const seq = closingSeq(context)
      if (seq === undefined) return null
      const data: FoldSummaryChatData = { turn: location.turn.turn, closingSeq: seq }
      return {
        key: context.key,
        kind: AUTO_FOLD_SUMMARY_KIND,
        id: context.id,
        target: 'chat',
        anchorSeq: seq + AUTO_FOLD_SUMMARY_ANCHOR_OFFSET,
        location,
        visibility: 'visible',
        data,
      }
    },
  }
  ```

- [ ] **Step 4: 运行测试确认通过**

  Run: `pnpm exec vitest run tests/fold-summary-definition.spec.ts`
  Expected: PASS（5 个用例全过）。

- [ ] **Step 5: 类型检查**

  Run: `pnpm typecheck`
  Expected: exit 0，无错误。

- [ ] **Step 6: Commit**

  ```bash
  git add src/client/contract.ts src/client/fold-summary-definition.ts tests/fold-summary-definition.spec.ts
  git commit -m "feat: add auto-fold-summary Conversation Node definition"
  ```

---

## 5. Task 3：FoldTargetResolver

**Files:**
- Create: `src/client/fold-target-resolver.ts`
- Test: `tests/fold-target-resolver.spec.ts` + `tests/auto-fold-fixture.ts`

设计要点（规格 §FoldTargetResolver）：纯函数；从 `chat.locations.getTurn(turn)` 读取该轮有序 key，与当前可见 `chat.order` 求交集；找到 `finalNode.seq` 等于 closing seq 的 assistant Node 作为最终回复；排除 closing assistant、summary、`turn-tail`，防御性排除 `user` 与 `steering`；只把 `anchorSeq` 严格早于 summary Node 的其余 Node 纳入过程集合（summary 之后的 error、max-token 终态提示保持可见）；返回过程数量、目标 key 与最终回复 key；无法唯一解析时返回 null。

- [ ] **Step 1: 写测试 fixture（先于测试文件）**

  Create `tests/auto-fold-fixture.ts`:

  ```ts
  import type {
    ChatLocationNodeIndex, ChatNodeStore, ChatSnapshot, ChatConversationViewNode,
    ConversationLocation, ConversationTimelineSnapshot, LegacyConversationSlice, TurnLocation,
  } from '@deepseek-ai/dsh-client-runtime/client'

  /** One fixture node descriptor; `turn` puts it inside the owning turn. */
  export interface FoldFixtureNode {
    readonly key: string
    readonly kind: string
    readonly anchorSeq: number
    readonly turn: number
    /** assistant-step only: the seq its data.finalNode reports. */
    readonly finalNodeSeq?: number
    /** auto-fold-summary only. */
    readonly summaryData?: { readonly closingSeq: number }
  }

  const EMPTY_LIST: readonly never[] = []

  class FixtureNodeStore implements ChatNodeStore {
    private readonly byKey = new Map<string, ChatConversationViewNode>()
    constructor(nodes: readonly ChatConversationViewNode[]) {
      for (const node of nodes) this.byKey.set(node.key, node)
    }
    get(key: string): ChatConversationViewNode | undefined {
      return this.byKey.get(key)
    }
    values(): readonly ChatConversationViewNode[] {
      return [...this.byKey.values()]
    }
  }

  class FixtureLocationIndex implements ChatLocationNodeIndex {
    private readonly turns = new Map<number, readonly string[]>()
    constructor(turns: Map<number, readonly string[]>) {
      this.turns = turns
    }
    getTurn(turn: number): readonly string[] {
      return this.turns.get(turn) ?? EMPTY_LIST
    }
    getStep(): readonly string[] {
      return EMPTY_LIST
    }
  }

  /** Minimal Chat snapshot over fold-relevant nodes; order follows anchorSeq. */
  export function foldChatFixture(specs: readonly FoldFixtureNode[]): ChatSnapshot {
    const sorted = [...specs]
      .sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key))
    const byTurn = new Map<number, string[]>()
    const turns = new Map<number, TurnLocation>()
    const nodes = sorted.map((spec): ChatConversationViewNode => {
      if (!turns.has(spec.turn)) {
        turns.set(spec.turn, {
          turn: spec.turn,
          start: undefined,
          end: undefined,
          status: 'closed' as const,
          steps: EMPTY_LIST,
          data: new Map(),
        })
      }
      const turn = turns.get(spec.turn)!
      const location: ConversationLocation = { kind: 'turn', turn }
      const list = byTurn.get(spec.turn) ?? []
      list.push(spec.key)
      byTurn.set(spec.turn, list)
      let data: unknown = {}
      if (spec.kind === 'assistant-step') {
        data = {
          status: 'settled',
          turn: spec.turn,
          step: 1,
          blocks: EMPTY_LIST,
          time: 0,
          finalNode: { seq: spec.finalNodeSeq ?? spec.anchorSeq },
        }
      } else if (spec.kind === 'auto-fold-summary') {
        data = { turn: spec.turn, closingSeq: spec.summaryData?.closingSeq ?? 0 }
      }
      return {
        key: spec.key,
        kind: spec.kind,
        id: spec.key,
        target: 'chat',
        anchorSeq: spec.anchorSeq,
        location,
        visibility: 'visible',
        data,
      }
    })
    const timeline: ConversationTimelineSnapshot = { turnOrder: [...byTurn.keys()], turns }
    const legacy: LegacyConversationSlice = {
      nodes: EMPTY_LIST,
      turnTimings: new Map(),
      turnEnds: new Map(),
      partial: null,
      runningCalls: EMPTY_LIST,
    }
    return {
      order: nodes.map(node => node.key),
      nodes: new FixtureNodeStore(nodes),
      locations: new FixtureLocationIndex(new Map([...byTurn.entries()].map(([t, keys]) => [t, [...keys]]))),
      timeline,
      legacy,
    }
  }
  ```

- [ ] **Step 2: 写失败测试**

  Create `tests/fold-target-resolver.spec.ts`:

  ```ts
  import { describe, expect, it } from 'vitest'
  import { resolveFoldTarget } from '../src/client/fold-target-resolver.ts'
  import { foldChatFixture, type FoldFixtureNode } from './auto-fold-fixture.ts'

  const summaryKey = 'auto-fold-summary'
  const finalKey = 'assistant-final'
  const userKey = 'user-1'
  const tailKey = 'turn-tail-1'

  /** One completed turn: user, tool rows, intermediate assistant, final, tail, summary. */
  function completedTurn(): FoldFixtureNode[] {
    return [
      { key: userKey, kind: 'user', anchorSeq: 2, turn: 1 },
      { key: 'tool-1', kind: 'tool-call', anchorSeq: 4, turn: 1 },
      { key: 'assistant-mid', kind: 'assistant-step', anchorSeq: 5, turn: 1, finalNodeSeq: 5 },
      { key: 'tool-2', kind: 'tool-call', anchorSeq: 6, turn: 1 },
      { key: 'retry-1', kind: 'model-retry', anchorSeq: 7, turn: 1 },
      { key: finalKey, kind: 'assistant-step', anchorSeq: 8, turn: 1, finalNodeSeq: 8 },
      { key: summaryKey, kind: 'auto-fold-summary', anchorSeq: 7.95, turn: 1, summaryData: { closingSeq: 8 } },
      { key: tailKey, kind: 'turn-tail', anchorSeq: 8.1, turn: 1 },
    ]
  }

  describe('resolveFoldTarget', () => {
    it('folds tools, intermediate assistants and retries strictly before the summary anchor', () => {
      const target = resolveFoldTarget(foldChatFixture(completedTurn()), {
        key: summaryKey,
        kind: 'auto-fold-summary',
        anchorSeq: 7.95,
      } as never)
      expect(target).not.toBeNull()
      expect(target?.count).toBe(4)
      expect(target?.processKeys).toEqual(['tool-1', 'assistant-mid', 'tool-2', 'retry-1'])
      expect(target?.finalKey).toBe(finalKey)
    })

    it('never folds the closing assistant, the summary, the turn-tail, user or steering', () => {
      const target = resolveFoldTarget(foldChatFixture([
        ...completedTurn(),
        { key: 'steer-1', kind: 'steering', anchorSeq: 3, turn: 1 },
      ]), { key: summaryKey, kind: 'auto-fold-summary', anchorSeq: 7.95 } as never)
      expect(target?.processKeys).not.toContain(userKey)
      expect(target?.processKeys).not.toContain('steer-1')
      expect(target?.processKeys).not.toContain(finalKey)
      expect(target?.processKeys).not.toContain(summaryKey)
      expect(target?.processKeys).not.toContain(tailKey)
    })

    it('keeps terminal error and max-token notices that sort after the summary visible', () => {
      const target = resolveFoldTarget(foldChatFixture([
        ...completedTurn().filter(spec => spec.kind !== 'turn-tail'),
        { key: 'max-tokens-1', kind: 'turn-max-tokens', anchorSeq: 8.05, turn: 1 },
        { key: 'turn-error-1', kind: 'turn-error', anchorSeq: 9, turn: 1 },
        { key: tailKey, kind: 'turn-tail', anchorSeq: 8.1, turn: 1 },
      ]), { key: summaryKey, kind: 'auto-fold-summary', anchorSeq: 7.95 } as never)
      expect(target?.processKeys).toEqual(['tool-1', 'assistant-mid', 'tool-2', 'retry-1'])
      expect(target?.processKeys).not.toContain('max-tokens-1')
      expect(target?.processKeys).not.toContain('turn-error-1')
    })

    it('only reads the owning turn; other turns never leak in', () => {
      const target = resolveFoldTarget(foldChatFixture([
        ...completedTurn(),
        { key: 'tool-other', kind: 'tool-call', anchorSeq: 20, turn: 2 },
        { key: 'assistant-other', kind: 'assistant-step', anchorSeq: 21, turn: 2, finalNodeSeq: 21 },
      ]), { key: summaryKey, kind: 'auto-fold-summary', anchorSeq: 7.95 } as never)
      expect(target?.processKeys).toEqual(['tool-1', 'assistant-mid', 'tool-2', 'retry-1'])
    })

    it('returns null when the final assistant is missing or ambiguous', () => {
      const missingFinal = completedTurn().filter(spec => spec.kind !== 'assistant-step' || spec.key !== finalKey)
      expect(resolveFoldTarget(foldChatFixture(missingFinal), {
        key: summaryKey, kind: 'auto-fold-summary', anchorSeq: 7.95,
      } as never)).toBeNull()

      const ambiguous = [...completedTurn(), {
        key: 'assistant-final-dup', kind: 'assistant-step' as const, anchorSeq: 8.5, turn: 1, finalNodeSeq: 8,
      }]
      expect(resolveFoldTarget(foldChatFixture(ambiguous), {
        key: summaryKey, kind: 'auto-fold-summary', anchorSeq: 7.95,
      } as never)).toBeNull()
    })

    it('returns an empty process set for a turn with nothing foldable before the summary', () => {
      const target = resolveFoldTarget(foldChatFixture([
        { key: userKey, kind: 'user', anchorSeq: 2, turn: 1 },
        { key: finalKey, kind: 'assistant-step', anchorSeq: 8, turn: 1, finalNodeSeq: 8 },
        { key: summaryKey, kind: 'auto-fold-summary', anchorSeq: 7.95, turn: 1, summaryData: { closingSeq: 8 } },
      ]), { key: summaryKey, kind: 'auto-fold-summary', anchorSeq: 7.95 } as never)
      expect(target?.count).toBe(0)
      expect(target?.processKeys).toEqual([])
    })
  })
  ```

- [ ] **Step 3: 运行测试确认失败**

  Run: `pnpm exec vitest run tests/fold-target-resolver.spec.ts`
  Expected: FAIL（`../src/client/fold-target-resolver.ts` 不存在 → Cannot find module）。

- [ ] **Step 4: 写实现**

  Create `src/client/fold-target-resolver.ts`:

  ```ts
  import type { ChatSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
  import type { AssistantChatData, ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
  import type { FoldSummaryChatData } from './contract.ts'

  /** Result of folding one completed turn: the process set + final reply identity. */
  export interface FoldTarget {
    readonly turn: number
    readonly summaryKey: string
    readonly finalKey: string
    readonly processKeys: readonly string[]
    readonly count: number
  }

  /** Kinds never folded even when they sort before the summary anchor. */
  const PROTECTED_KINDS = new Set(['user', 'steering', 'turn-tail'])

  /**
   * Compute the fold target of one turn from the Chat snapshot and the
   * summary Node. Pure: scans only the owning Turn's keys intersected with
   * the currently visible `chat.order`. Returns null when the final reply
   * cannot be uniquely resolved (fail-open).
   */
  export function resolveFoldTarget(
    chat: ChatSnapshot,
    summary: ChatNode<'auto-fold-summary'>,
  ): FoldTarget | null {
    const data = summary.data as FoldSummaryChatData
    const turnKeys = chat.locations.getTurn(data.turn)
    // Only currently visible nodes participate; DSH-hidden nodes are skipped.
    const visibleKeys = turnKeys.filter(key => chat.order.includes(key))
    const finalCandidates = visibleKeys.filter((key) => {
      const node = chat.nodes.get(key)
      return node?.kind === 'assistant-step'
        && (node.data as AssistantChatData).finalNode?.seq === data.closingSeq
    })
    if (finalCandidates.length !== 1) return null
    const finalKey = finalCandidates[0]!
    const processKeys: string[] = []
    for (const key of visibleKeys) {
      if (key === summary.key || key === finalKey) continue
      const node = chat.nodes.get(key)
      if (node === undefined) continue
      if (PROTECTED_KINDS.has(node.kind)) continue
      // Only nodes sorted strictly before the summary belong to the folded
      // set; anything after it (terminal error/max-token notices, late tool
      // evidence) is a result state and stays visible.
      if (node.anchorSeq >= summary.anchorSeq) continue
      processKeys.push(key)
    }
    return { turn: data.turn, summaryKey: summary.key, finalKey, processKeys, count: processKeys.length }
  }
  ```

- [ ] **Step 5: 运行测试确认通过**

  Run: `pnpm exec vitest run tests/fold-target-resolver.spec.ts`
  Expected: PASS（6 个用例全过）。

- [ ] **Step 6: 类型检查与 Commit**

  Run: `pnpm typecheck`
  Expected: exit 0。

  ```bash
  git add src/client/fold-target-resolver.ts tests/fold-target-resolver.spec.ts tests/auto-fold-fixture.ts
  git commit -m "feat: add FoldTargetResolver pure fold-set computation"
  ```

---

## 6. Task 4：FoldStateStore

**Files:**
- Create: `src/client/fold-state-store.ts`
- Test: `tests/fold-state-store.spec.ts`

设计要点（规格 §FoldStateStore）：身份为 `sessionId+turn`；默认折叠，持久层只记录显式展开项；展开写入、再次折叠删除记录；版本化 localStorage key `dsh.auto-fold.expanded.v1`；损坏 JSON 重置为空；写入失败保留页面内存状态并记录一次诊断，不阻塞交互；v1 不自动过期。

- [ ] **Step 1: 写失败测试**

  Create `tests/fold-state-store.spec.ts`:

  ```ts
  import { afterEach, describe, expect, it, vi } from 'vitest'
  import { FOLD_STATE_STORAGE_KEY, FoldStateStore, foldIdentity, type FoldStorage } from '../src/client/fold-state-store.ts'

  /** In-memory storage face mirroring the localStorage contract. */
  function memoryStorage(initial: Record<string, string> = {}): FoldStorage {
    const values = new Map(Object.entries(initial))
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('FoldStateStore', () => {
    it('defaults to folded for unknown identities', () => {
      const store = new FoldStateStore(memoryStorage())
      expect(store.isExpanded('s1', 1)).toBe(false)
    })

    it('restores an explicit expansion from a fresh instance (cross-refresh persistence)', () => {
      const storage = memoryStorage()
      const first = new FoldStateStore(storage)
      first.setExpanded('s1', 2, true)
      const second = new FoldStateStore(storage)
      expect(second.isExpanded('s1', 2)).toBe(true)
      expect(second.isExpanded('s1', 1)).toBe(false)
      expect(second.isExpanded('s2', 2)).toBe(false)
    })

    it('deletes the persistent record when collapsed again', () => {
      const storage = memoryStorage()
      const store = new FoldStateStore(storage)
      store.setExpanded('s1', 3, true)
      expect(storage.getItem(FOLD_STATE_STORAGE_KEY)).toContain(foldIdentity('s1', 3))
      store.setExpanded('s1', 3, false)
      expect(storage.getItem(FOLD_STATE_STORAGE_KEY)).toBeNull()
      expect(new FoldStateStore(storage).isExpanded('s1', 3)).toBe(false)
    })

    it('resets to empty when the persisted JSON is corrupt', () => {
      const storage = memoryStorage({ [FOLD_STATE_STORAGE_KEY]: '{not-json' })
      const store = new FoldStateStore(storage)
      expect(store.isExpanded('s1', 1)).toBe(false)
      store.setExpanded('s1', 1, true)
      expect(new FoldStateStore(storage).isExpanded('s1', 1)).toBe(true)
    })

    it('ignores non-array payloads and non-string members', () => {
      const storage = memoryStorage({ [FOLD_STATE_STORAGE_KEY]: JSON.stringify({ 's1:1': true }) })
      const store = new FoldStateStore(storage)
      expect(store.isExpanded('s1', 1)).toBe(false)
    })

    it('keeps page-local memory state and logs once when persistence fails', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const failing = memoryStorage()
      failing.setItem = () => { throw new Error('quota') }
      const store = new FoldStateStore(failing)
      store.setExpanded('s1', 4, true)
      expect(store.isExpanded('s1', 4)).toBe(true)
      store.setExpanded('s1', 5, true)
      expect(warn).toHaveBeenCalledTimes(1)
    })

    it('works without any storage (SSR/node fail-open)', () => {
      const store = new FoldStateStore(null)
      store.setExpanded('s1', 6, true)
      expect(store.isExpanded('s1', 6)).toBe(true)
      store.setExpanded('s1', 6, false)
      expect(store.isExpanded('s1', 6)).toBe(false)
    })
  })
  ```

- [ ] **Step 2: 运行测试确认失败**

  Run: `pnpm exec vitest run tests/fold-state-store.spec.ts`
  Expected: FAIL（`../src/client/fold-state-store.ts` 不存在）。

- [ ] **Step 3: 写实现**

  Create `src/client/fold-state-store.ts`:

  ```ts
  /** Minimal storage face so the store stays DOM-free and unit-testable. */
  export interface FoldStorage {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
  }

  /** Versioned persistence key; bump the version to reset user state. */
  export const FOLD_STATE_STORAGE_KEY = 'dsh.auto-fold.expanded.v1'

  /** Stable identity: sessionId + turn (never relies on a possibly-missing messageId). */
  export function foldIdentity(sessionId: string, turn: number): string {
    return `${sessionId}:${turn}`
  }

  /** Best-effort browser storage access; null when unavailable (fail-open). */
  function defaultStorage(): FoldStorage | null {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage
    } catch {
      return null
    }
  }

  /**
   * Explicit-expand registry: the default state is folded, so only entries
   * the user explicitly expanded are recorded. Writes are versioned under
   * one localStorage key; corrupt payloads reset to empty; failed writes
   * keep the page-local memory state and log a single diagnostic.
   */
  export class FoldStateStore {
    private readonly memory = new Set<string>()
    private warned = false

    constructor(private readonly storage: FoldStorage | null = defaultStorage()) {
      this.load()
    }

    private load(): void {
      if (this.storage === null) return
      let raw: string | null
      try {
        raw = this.storage.getItem(FOLD_STATE_STORAGE_KEY)
      } catch {
        raw = null
      }
      if (raw === null || raw === '') return
      try {
        const parsed: unknown = JSON.parse(raw)
        if (!Array.isArray(parsed)) throw new Error('not an array')
        for (const item of parsed) {
          if (typeof item === 'string') this.memory.add(item)
        }
      } catch {
        this.memory.clear()
      }
    }

    isExpanded(sessionId: string, turn: number): boolean {
      return this.memory.has(foldIdentity(sessionId, turn))
    }

    setExpanded(sessionId: string, turn: number, expanded: boolean): void {
      const identity = foldIdentity(sessionId, turn)
      if (expanded) this.memory.add(identity)
      else this.memory.delete(identity)
      this.persist()
    }

    private persist(): void {
      if (this.storage === null) return
      try {
        if (this.memory.size === 0) {
          this.storage.removeItem(FOLD_STATE_STORAGE_KEY)
          return
        }
        this.storage.setItem(FOLD_STATE_STORAGE_KEY, JSON.stringify([...this.memory]))
      } catch (error) {
        // Write failure must not break interaction; page-local state survives.
        if (!this.warned) {
          this.warned = true
          console.warn('[dsh-auto-fold-turn] failed to persist expanded state; keeping page-local state', error)
        }
      }
    }
  }

  /** Module-level singleton shared by all summary rows of this client. */
  export const foldStateStore = new FoldStateStore()
  ```

- [ ] **Step 4: 运行测试确认通过**

  Run: `pnpm exec vitest run tests/fold-state-store.spec.ts`
  Expected: PASS（7 个用例全过）。

- [ ] **Step 5: 类型检查与 Commit**

  Run: `pnpm typecheck`
  Expected: exit 0。

  ```bash
  git add src/client/fold-state-store.ts tests/fold-state-store.spec.ts
  git commit -m "feat: add FoldStateStore session+turn expanded-state persistence"
  ```

---

## 7. Task 5：TurnDomAdapter

**Files:**
- Create: `src/client/dom-adapter.ts`
- Test: `tests/dom-adapter.spec.ts`

设计要点（规格 §TurnDomAdapter）：唯一直接接触 DSH DOM 的模块；`[data-chat-anchor-key]` + 精确转义后的 Node key 定位行；插件自有属性（`data-auto-fold-hidden`）+ 插件自有样式统一隐藏，不覆盖 DSH 自有 class 或内联样式；应用前先解析完整目标集合，必要目标缺失时不做任何隐藏；只移除插件自己添加的属性；展开、组件卸载、会话切换或插件卸载时恢复现场；`[data-conversation-scroll]` 作为滚动容器，显隐前后补偿摘要行 viewport top 差值；不安装全局 MutationObserver。

- [ ] **Step 1: 写失败测试**

  Create `tests/dom-adapter.spec.ts`:

  ```ts
  // @vitest-environment jsdom
  import { afterEach, describe, expect, it } from 'vitest'
  import { AUTO_FOLD_HIDDEN_ATTR, TurnDomAdapter, scrollDeltaFor } from '../src/client/dom-adapter.ts'

  const SUMMARY_KEY = '17:auto-fold-summary1'
  const PROCESS_KEYS = ['tool-1', 'assistant-mid', 'tool-2']

  /** Build one scroll container holding a summary row + process rows. */
  function bench(tops: Record<string, number> = {}) {
    const container = document.createElement('div')
    container.setAttribute('data-conversation-scroll', '')
    const summary = document.createElement('div')
    summary.setAttribute('data-chat-anchor-key', SUMMARY_KEY)
    summary.setAttribute('data-chat-flow-kind', 'auto-fold-summary')
    const process = PROCESS_KEYS.map((key) => {
      const row = document.createElement('div')
      row.setAttribute('data-chat-anchor-key', key)
      row.setAttribute('data-chat-flow-kind', 'tool-call')
      return row
    })
    container.append(summary, ...process)
    document.body.appendChild(container)
    const measureTop = (element: HTMLElement): number => tops[element.getAttribute('data-chat-anchor-key') ?? ''] ?? 0
    return { container, summary, process, measureTop }
  }

  afterEach(() => {
    document.body.innerHTML = ''
  })

  describe('TurnDomAdapter', () => {
    it('hides every target row atomically when all are present', () => {
      const b = bench()
      const adapter = new TurnDomAdapter({ root: document.body })
      const targets = adapter.resolve(SUMMARY_KEY, PROCESS_KEYS)
      adapter.apply(targets, true)
      for (const row of b.process) expect(row.hasAttribute(AUTO_FOLD_HIDDEN_ATTR)).toBe(true)
      expect(b.summary.hasAttribute(AUTO_FOLD_HIDDEN_ATTR)).toBe(false)
      expect(b.container.scrollTop).toBe(0)
    })

    it('performs no partial hiding when any required target row is missing', () => {
      const b = bench()
      b.process[1]!.remove()
      const adapter = new TurnDomAdapter({ root: document.body })
      const targets = adapter.resolve(SUMMARY_KEY, PROCESS_KEYS)
      expect(targets).toBeNull()
      adapter.apply(targets, true)
      for (const row of b.process) {
        if (document.body.contains(row)) expect(row.hasAttribute(AUTO_FOLD_HIDDEN_ATTR)).toBe(false)
      }
    })

    it('fails open when the summary row or its flow-kind marker is missing', () => {
      const b = bench()
      b.summary.removeAttribute('data-chat-flow-kind')
      const adapter = new TurnDomAdapter({ root: document.body })
      expect(adapter.resolve(SUMMARY_KEY, PROCESS_KEYS)).toBeNull()
      b.summary.setAttribute('data-chat-flow-kind', 'auto-fold-summary')
      b.summary.remove()
      expect(adapter.resolve(SUMMARY_KEY, PROCESS_KEYS)).toBeNull()
    })

    it('restores the DOM on expand and on dispose, removing only its own attribute', () => {
      const b = bench()
      const adapter = new TurnDomAdapter({ root: document.body })
      adapter.apply(adapter.resolve(SUMMARY_KEY, PROCESS_KEYS), true)
      b.process[0]!.setAttribute('data-other-plugin', 'keep-me')
      adapter.apply(adapter.resolve(SUMMARY_KEY, PROCESS_KEYS), false)
      for (const row of b.process) expect(row.hasAttribute(AUTO_FOLD_HIDDEN_ATTR)).toBe(false)
      expect(b.process[0]!.getAttribute('data-other-plugin')).toBe('keep-me')

      adapter.apply(adapter.resolve(SUMMARY_KEY, PROCESS_KEYS), true)
      adapter.restore()
      for (const row of b.process) expect(row.hasAttribute(AUTO_FOLD_HIDDEN_ATTR)).toBe(false)
    })

    it('compensates the scroll container so the summary row keeps its viewport top', () => {
      // Collapse: process rows above the summary vanish, summary top moves up
      // 300px (before=400, after=100); the container must scroll down by the
      // same delta so the summary stays put.
      const b = bench()
      const adapter = new TurnDomAdapter({
        root: document.body,
        measureTop: (element: HTMLElement) => {
          const key = element.getAttribute('data-chat-anchor-key') ?? ''
          return key === SUMMARY_KEY ? 100 : 400
        },
      })
      adapter.apply(adapter.resolve(SUMMARY_KEY, PROCESS_KEYS), true)
      expect(b.container.scrollTop).toBe(300)
    })

    it('computes the pure scroll delta as beforeTop - afterTop', () => {
      expect(scrollDeltaFor(400, 100)).toBe(300)
      expect(scrollDeltaFor(100, 400)).toBe(-300)
    })
  })
  ```

  （注：补偿用例通过注入的 `measureTop` 几何读取器模拟“折叠后 summary 的 viewport top 从 400 上移到 100”，断言 `scrollTop` 被补偿为 `before - after = 300`；jsdom 不做真实布局，因此几何全部来自注入读取器。`scrollDeltaFor` 为纯函数：折叠时 before > after → 正 delta → 容器向下滚动，把 summary 保持在原视口位置。）

- [ ] **Step 2: 运行测试确认失败**

  Run: `pnpm exec vitest run tests/dom-adapter.spec.ts`
  Expected: FAIL（`../src/client/dom-adapter.ts` 不存在）。

- [ ] **Step 3: 写实现**

  Create `src/client/dom-adapter.ts`:

  ```ts
  /** Plugin-owned visibility attribute; the injected stylesheet hides rows carrying it. */
  export const AUTO_FOLD_HIDDEN_ATTR = 'data-auto-fold-hidden'

  /**
   * Escape a Node key for a `[data-chat-anchor-key=<value>]` selector:
   * CSS.escape when available, else a quoted-attribute fallback that only
   * needs to escape `"` and `\`.
   */
  export function escapeSelector(value: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
    return `"${value.replace(/["\\]/g, ch => `\\${ch}`)}"`
  }

  /** ScrollTop delta keeping the summary row's viewport top stable. */
  export function scrollDeltaFor(beforeTop: number, afterTop: number): number {
    return beforeTop - afterTop
  }

  /** Located rows of one fold operation; null anywhere means fail-open. */
  export interface FoldRowTargets {
    readonly summaryRow: HTMLElement
    readonly processRows: readonly HTMLElement[]
    readonly scrollContainer: HTMLElement | null
  }

  export interface DomAdapterDeps {
    /** Query root (document in production; a scoped container in tests). */
    readonly root: ParentNode
    /** Geometry reader, injectable for deterministic tests. */
    readonly measureTop?: (element: HTMLElement) => number
  }

  /**
   * The only module that touches DSH chat DOM. Resolves every row by the
   * authoritative Node key first, then hides/shows atomically via the
   * plugin-owned attribute; restores only what this instance marked.
   */
  export class TurnDomAdapter {
    private readonly hidden = new Set<HTMLElement>()
    private readonly root: ParentNode
    private readonly measureTop: (element: HTMLElement) => number

    constructor(deps: DomAdapterDeps) {
      this.root = deps.root
      this.measureTop = deps.measureTop ?? ((element) => element.getBoundingClientRect().top)
    }

    /**
     * Locate the summary row and every process row by exact key. Returns
     * null (fail-open) when the summary row is absent, its flow-kind marker
     * drifted, or any process row is missing — callers then hide nothing.
     */
    resolve(summaryKey: string, processKeys: readonly string[]): FoldRowTargets | null {
      const summaryRow = this.root.querySelector<HTMLElement>(
        `[data-chat-anchor-key=${escapeSelector(summaryKey)}]`)
      if (summaryRow === null || summaryRow.dataset.chatFlowKind !== 'auto-fold-summary') return null
      const scrollContainer = summaryRow.closest('[data-conversation-scroll]')
      const processRows: HTMLElement[] = []
      for (const key of processKeys) {
        const row = this.root.querySelector<HTMLElement>(
          `[data-chat-anchor-key=${escapeSelector(key)}]`)
        if (row === null) return null
        processRows.push(row)
      }
      return { summaryRow, processRows, scrollContainer }
    }

    /**
     * Apply the visibility state to the resolved targets and compensate the
     * summary row's viewport top through the scroll container. No-op when
     * targets are null. Returns the measured before/after tops.
     */
    apply(targets: FoldRowTargets | null, hidden: boolean): { beforeTop: number; afterTop: number } | null {
      if (targets === null) return null
      const beforeTop = this.measureTop(targets.summaryRow)
      for (const row of targets.processRows) {
        if (hidden) {
          row.setAttribute(AUTO_FOLD_HIDDEN_ATTR, '')
          this.hidden.add(row)
        } else {
          row.removeAttribute(AUTO_FOLD_HIDDEN_ATTR)
          this.hidden.delete(row)
        }
      }
      const afterTop = this.measureTop(targets.summaryRow)
      if (targets.scrollContainer !== null) {
        targets.scrollContainer.scrollTop += scrollDeltaFor(beforeTop, afterTop)
      }
      return { beforeTop, afterTop }
    }

    /** Restore every row this instance marked (plugin-owned attribute only). */
    restore(): void {
      for (const row of this.hidden) row.removeAttribute(AUTO_FOLD_HIDDEN_ATTR)
      this.hidden.clear()
    }
  }
  ```

- [ ] **Step 4: 运行测试确认通过**

  Run: `pnpm exec vitest run tests/dom-adapter.spec.ts`
  Expected: PASS（6 个用例全过）。

- [ ] **Step 5: 类型检查与 Commit**

  Run: `pnpm typecheck`
  Expected: exit 0。

  ```bash
  git add src/client/dom-adapter.ts tests/dom-adapter.spec.ts
  git commit -m "feat: add TurnDomAdapter key-addressed atomic hide/show with scroll compensation"
  ```

---

## 8. Task 6：FoldSummaryRow renderer

**Files:**
- Create: `src/client/styles.ts`
- Create: `src/client/summary-row.tsx`
- Test: `tests/summary-row.spec.tsx`

设计要点（规格 §FoldSummaryRow、§交互和视觉）：通过标准 session props 读 Chat snapshot；调用 Resolver 与 StateStore；layout effect 中调用 adapter（历史加载时先闪出完整过程前隐藏）；没有过程节点时不显示摘要并隐藏自己产生的空 flow row（依赖 DSH `.flowItem:empty{display:none}`，同时组件返回 null）；折叠显示 `▶ 过程 · N 项`，展开显示 `▼ 收起过程 · N 项`；整行是原生 button，`aria-expanded`，支持 Enter/Space（原生 button 自带）；使用 DSH `--dsw-*` token，不硬编码主题颜色。

- [ ] **Step 1: 写失败测试**

  Create `tests/summary-row.spec.tsx`:

  ```tsx
  // @vitest-environment jsdom
  import { afterEach, describe, expect, it } from 'vitest'
  import { cleanup, fireEvent, render, screen } from '@testing-library/react'
  import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
  import { createSnapshotStore, EMPTY_CONVERSATION_VIEWS, type ChatSnapshot, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
  import { FoldStateStore } from '../src/client/fold-state-store.ts'
  import { FoldSummaryRow } from '../src/client/summary-row.tsx'
  import { foldChatFixture, type FoldFixtureNode } from './auto-fold-fixture.ts'

  const SID = 's1' as SessionId
  const SUMMARY_KEY = '17:auto-fold-summary1'
  const PROCESS = ['tool-1', 'assistant-mid', 'tool-2']

  function completedTurn(): FoldFixtureNode[] {
    return [
      { key: 'user-1', kind: 'user', anchorSeq: 2, turn: 1 },
      { key: 'tool-1', kind: 'tool-call', anchorSeq: 4, turn: 1 },
      { key: 'assistant-mid', kind: 'assistant-step', anchorSeq: 5, turn: 1, finalNodeSeq: 5 },
      { key: 'tool-2', kind: 'tool-call', anchorSeq: 6, turn: 1 },
      { key: 'assistant-final', kind: 'assistant-step', anchorSeq: 8, turn: 1, finalNodeSeq: 8 },
      { key: SUMMARY_KEY, kind: 'auto-fold-summary', anchorSeq: 7.95, turn: 1, summaryData: { closingSeq: 8 } },
      { key: 'turn-tail-1', kind: 'turn-tail', anchorSeq: 8.1, turn: 1 },
    ]
  }

  /** One chat row per visible key: attribute-holders; the summary key hosts the real button. */
  function Flow({ chat, store, container, dropKeys = [] }: {
    chat: ChatSnapshot
    store: FoldStateStore
    container: HTMLElement
    /** Test seam: rows to omit from the DOM (simulates DOM drift). */
    dropKeys?: readonly string[]
  }) {
    const source = createSnapshotStore({ chat, sessionId: SID, views: EMPTY_CONVERSATION_VIEWS } as never)
    const useSession = bindSnapshotSelector(source)
    return (
      <div data-conversation-scroll="">
        {chat.order.map((key) => {
          if (dropKeys.includes(key)) return null
          const node = chat.nodes.get(key)!
          if (node.kind === 'auto-fold-summary') {
            return (
              <div key={key} data-chat-anchor-key={key} data-chat-flow-kind="auto-fold-summary">
                <FoldSummaryRow
                  node={node as never}
                  sessionId={SID}
                  useSession={useSession as never}
                  foldState={store}
                  root={container}
                />
              </div>
            )
          }
          return <div key={key} data-chat-anchor-key={key} data-chat-flow-kind={node.kind} />
        })}
      </div>
    )
  }

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  describe('FoldSummaryRow', () => {
    it('renders the folded button with the process count and aria-expanded=false', () => {
      const chat = foldChatFixture(completedTurn())
      const store = new FoldStateStore(null)
      const container = document.createElement('div')
      document.body.appendChild(container)
      render(<Flow chat={chat} store={store} container={container} />, { container })
      const button = screen.getByRole('button', { name: '▶ 过程 · 3 项' })
      expect(button.getAttribute('aria-expanded')).toBe('false')
      expect(button.tagName).toBe('BUTTON')
    })

    it('hides the process rows in a layout effect (no flash on load)', () => {
      const chat = foldChatFixture(completedTurn())
      const store = new FoldStateStore(null)
      const container = document.createElement('div')
      document.body.appendChild(container)
      render(<Flow chat={chat} store={store} container={container} />, { container })
      for (const key of PROCESS) {
        const row = container.querySelector(`[data-chat-anchor-key="${key}"]`)
        expect(row?.hasAttribute('data-auto-fold-hidden')).toBe(true)
      }
      expect(container.querySelector('[data-chat-anchor-key="assistant-final"]')?.hasAttribute('data-auto-fold-hidden')).toBe(false)
    })

    it('expands on click (rows visible, label toggles) and re-folds on a second click', () => {
      const chat = foldChatFixture(completedTurn())
      const store = new FoldStateStore(null)
      const container = document.createElement('div')
      document.body.appendChild(container)
      render(<Flow chat={chat} store={store} container={container} />, { container })
      const button = screen.getByRole('button', { name: '▶ 过程 · 3 项' })
      fireEvent.click(button)
      expect(screen.getByRole('button', { name: '▼ 收起过程 · 3 项' }).getAttribute('aria-expanded')).toBe('true')
      for (const key of PROCESS) {
        expect(container.querySelector(`[data-chat-anchor-key="${key}"]`)?.hasAttribute('data-auto-fold-hidden')).toBe(false)
      }
      fireEvent.click(screen.getByRole('button', { name: '▼ 收起过程 · 3 项' }))
      expect(screen.getByRole('button', { name: '▶ 过程 · 3 项' }).getAttribute('aria-expanded')).toBe('false')
      for (const key of PROCESS) {
        expect(container.querySelector(`[data-chat-anchor-key="${key}"]`)?.hasAttribute('data-auto-fold-hidden')).toBe(true)
      }
    })

    it('persists the explicit expansion and restores it on a fresh instance (refresh)', () => {
      const storage = new Map<string, string>()
      const storageFace = {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value) },
        removeItem: (key: string) => { storage.delete(key) },
      }
      const store = new FoldStateStore(storageFace)
      const chat = foldChatFixture(completedTurn())
      const container = document.createElement('div')
      document.body.appendChild(container)
      const first = render(<Flow chat={chat} store={store} container={container} />, { container })
      fireEvent.click(screen.getByRole('button', { name: '▶ 过程 · 3 项' }))
      first.unmount()
      container.innerHTML = ''
      const fresh = new FoldStateStore(storageFace)
      render(<Flow chat={chat} store={fresh} container={container} />, { container })
      expect(screen.getByRole('button', { name: '▼ 收起过程 · 3 项' }).getAttribute('aria-expanded')).toBe('true')
      for (const key of PROCESS) {
        expect(container.querySelector(`[data-chat-anchor-key="${key}"]`)?.hasAttribute('data-auto-fold-hidden')).toBe(false)
      }
    })

    it('renders nothing when there is no process to fold (empty flow row)', () => {
      const chat = foldChatFixture([
        { key: 'user-1', kind: 'user', anchorSeq: 2, turn: 1 },
        { key: 'assistant-final', kind: 'assistant-step', anchorSeq: 8, turn: 1, finalNodeSeq: 8 },
        { key: SUMMARY_KEY, kind: 'auto-fold-summary', anchorSeq: 7.95, turn: 1, summaryData: { closingSeq: 8 } },
      ])
      const store = new FoldStateStore(null)
      const container = document.createElement('div')
      document.body.appendChild(container)
      render(<Flow chat={chat} store={store} container={container} />, { container })
      const summaryRow = container.querySelector(`[data-chat-anchor-key="${SUMMARY_KEY}"]`)
      expect(summaryRow).not.toBeNull()
      expect(summaryRow?.textContent).toBe('')
      expect(summaryRow?.childElementCount).toBe(0)
    })

    it('fails open when the DOM rows are missing: button renders but nothing is hidden', () => {
      const chat = foldChatFixture(completedTurn())
      const store = new FoldStateStore(null)
      const container = document.createElement('div')
      document.body.appendChild(container)
      render(<Flow chat={chat} store={store} container={container} dropKeys={[PROCESS[1]!]} />, { container })
      expect(screen.getByRole('button', { name: '▶ 过程 · 3 项' })).toBeDefined()
      for (const key of PROCESS) {
        const row = container.querySelector(`[data-chat-anchor-key="${key}"]`)
        if (row !== null) expect(row.hasAttribute('data-auto-fold-hidden')).toBe(false)
      }
    })
  })
  ```

  说明：`Flow` 组件用 `bindSnapshotSelector` 提供 `useSession`；`root={container}` 让 adapter 只在测试容器内解析行；`dropKeys` 模拟 DOM 漂移（某行缺失）。

- [ ] **Step 2: 运行测试确认失败**

  Run: `pnpm exec vitest run tests/summary-row.spec.tsx`
  Expected: FAIL（`../src/client/summary-row.tsx` / `../src/client/styles.ts` 不存在）。

- [ ] **Step 3: 写实现**

  Create `src/client/styles.ts`:

  ```ts
  /** Class applied to the summary button. */
  export const AUTO_FOLD_BUTTON_CLASS = 'dsh-auto-fold-summary'

  /**
   * Plugin-owned stylesheet (injected by the client entry). Hides only rows
   * carrying the plugin-owned attribute and styles the button through DSH
   * theme tokens with local fallbacks — never overrides DSH class or inline
   * styles.
   */
  export const AUTO_FOLD_STYLE = `
.dsh-auto-fold-summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  margin: 0 0 0 -6px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #667085);
  font: inherit;
  font-size: 13px;
  line-height: 22px;
  cursor: pointer;
}
.dsh-auto-fold-summary:hover,
.dsh-auto-fold-summary:focus-visible {
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.08));
  border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  color: var(--dsw-alias-label-primary, #1d2939);
}
.dsh-auto-fold-summary:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4176e6);
  outline-offset: 1px;
}
[data-auto-fold-hidden] {
  display: none !important;
}
`
  ```

  Create `src/client/summary-row.tsx`:

  ```tsx
  import { useLayoutEffect, useMemo, useRef, useState } from 'react'
  import type { ChatSnapshot, ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
  import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
  import { TurnDomAdapter } from './dom-adapter.ts'
  import { FoldStateStore, foldStateStore } from './fold-state-store.ts'
  import { resolveFoldTarget } from './fold-target-resolver.ts'
  import { AUTO_FOLD_BUTTON_CLASS } from './styles.ts'

  /** Narrow props: the dispatcher supplies the full keyed-slot share; tests
   *  supply exactly these plus `foldState`/`root` seams. */
  export interface FoldSummaryRowProps {
    readonly node: ChatNode<'auto-fold-summary'>
    readonly sessionId: string
    readonly useSession: (selector: (snapshot: ConversationSnapshot) => unknown) => unknown
    /** Test seam; defaults to the module-level singleton store. */
    readonly foldState?: FoldStateStore
    /** Test seam; defaults to document. */
    readonly root?: ParentNode
  }

  /**
   * Renderer of the `auto-fold-summary` node: computes the fold target from
   * the Chat snapshot, applies the visibility through TurnDomAdapter inside
   * a layout effect (no flash on history loads), and toggles the persisted
   * expanded state on click.
   */
  export function FoldSummaryRow({ node, sessionId, useSession, foldState, root }: FoldSummaryRowProps) {
    const store = foldState ?? foldStateStore
    const chat = useSession(snapshot => snapshot.chat) as ChatSnapshot
    const target = useMemo(() => resolveFoldTarget(chat, node), [chat, node])
    const [expanded, setExpanded] = useState(() =>
      target === null ? false : store.isExpanded(sessionId, target.turn))
    const buttonRef = useRef<HTMLButtonElement | null>(null)

    useLayoutEffect(() => {
      if (target === null || target.processKeys.length === 0) return
      const button = buttonRef.current
      if (button === null) return
      const adapter = new TurnDomAdapter({ root: root ?? document })
      const targets = adapter.resolve(node.key, target.processKeys)
      adapter.apply(targets, !expanded)
      return () => {
        adapter.restore()
      }
    }, [target, expanded, sessionId, node.key, root])

    if (target === null || target.processKeys.length === 0) return null

    const toggle = (): void => {
      const next = !expanded
      setExpanded(next)
      store.setExpanded(sessionId, target.turn, next)
    }

    return (
      <button
        ref={buttonRef}
        type="button"
        className={AUTO_FOLD_BUTTON_CLASS}
        data-auto-fold-summary=""
        aria-expanded={expanded}
        onClick={toggle}
      >
        {expanded ? `▼ 收起过程 · ${target.count} 项` : `▶ 过程 · ${target.count} 项`}
      </button>
    )
  }
  ```

  说明：`useLayoutEffect` 在 jsdom + `@testing-library/react` 下同步执行，满足测试对“布局后即隐藏”的断言；effect 清理（unmount / target 或 expanded 变化）调用 `adapter.restore()`，保证会话切换、展开切换后无残留隐藏。

- [ ] **Step 4: 运行测试确认通过**

  Run: `pnpm exec vitest run tests/summary-row.spec.tsx`
  Expected: PASS（6 个用例全过）。

- [ ] **Step 5: 类型检查与 Commit**

  Run: `pnpm typecheck`
  Expected: exit 0。

  ```bash
  git add src/client/styles.ts src/client/summary-row.tsx tests/summary-row.spec.tsx
  git commit -m "feat: add FoldSummaryRow renderer with layout-effect folding and toggle"
  ```

---

## 9. Task 7：Client composition（插件入口）

**Files:**
- Create: `src/client/index.tsx`
- Test: `tests/client-composition.spec.tsx`

设计要点（规格 §Plugin Entry）：注册客户端依赖、Definition、keyed renderer、样式与生命周期清理；入口只做组装，不承载折叠策略。dispose 后 registry 无残留、DOM（样式表）全部恢复；与 ui-conversation 的既有 renderer 键共存不覆盖。

- [ ] **Step 1: 写失败测试**

  Create `tests/client-composition.spec.tsx`:

  ```tsx
  // @vitest-environment jsdom
  import { Context } from 'cordis'
  import { afterEach, beforeEach, describe, expect, it } from 'vitest'
  import { ConversationEventRegistry, SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
  import { apply, inject } from '../src/client/index.tsx'
  import { foldSummaryDefinition } from '../src/client/fold-summary-definition.ts'
  import { FoldSummaryRow } from '../src/client/summary-row.tsx'

  async function bench() {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    new ConversationEventRegistry(ctx)
    // Stand-in for ui-conversation's declaration of the keyed chat node seat
    // (the real declaration comes from its apply; the plugin only injects into it).
    ctx.slots.register(
      {
        name: 'root',
        children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
      } as never,
      () => null,
    )
    return ctx
  }

  describe('client plugin composition', () => {
    beforeEach(() => {
      document.head.innerHTML = ''
    })
    afterEach(() => {
      document.head.innerHTML = ''
    })

    it('declares the slots and conversationEvents dependencies', () => {
      expect(inject).toEqual(['slots', 'conversationEvents'])
    })

    it('registers the Definition, the keyed renderer and the stylesheet, then disposes cleanly', async () => {
      const ctx = await bench()
      const fiber = ctx.plugin({ inject: [...inject], apply })
      await fiber.await()

      expect(ctx.conversationEvents.entries().map(entry => entry.kind)).toContain('auto-fold-summary')
      const entries = ctx.slots.entries('conversation.chat.node')
      const ours = entries.find(entry => entry.options.key === 'auto-fold-summary')
      expect(ours).toBeDefined()
      expect(ours?.component).toBe(FoldSummaryRow)
      expect(document.head.querySelector('[data-auto-fold-style]')).not.toBeNull()

      await fiber.dispose()
      expect(ctx.conversationEvents.entries().map(entry => entry.kind)).not.toContain('auto-fold-summary')
      expect(ctx.slots.entries('conversation.chat.node').some(entry => entry.options.key === 'auto-fold-summary')).toBe(false)
      expect(document.head.querySelector('[data-auto-fold-style]')).toBeNull()
    })

    it('coexists with other keyed entries of the same seat without overwriting them', async () => {
      const ctx = await bench()
      // Simulate ui-conversation's own user renderer already registered.
      const userEntry = ctx.slots.register(
        { name: 'conversation.chat.node', key: 'user' } as never,
        () => null,
      )
      const fiber = ctx.plugin({ inject: [...inject], apply })
      await fiber.await()

      const keys = ctx.slots.entries('conversation.chat.node').map(entry => entry.options.key)
      expect(keys).toContain('user')
      expect(keys).toContain('auto-fold-summary')

      await fiber.dispose()
      const after = ctx.slots.entries('conversation.chat.node').map(entry => entry.options.key)
      expect(after).toContain('user')
      expect(after).not.toContain('auto-fold-summary')
      userEntry()
    })

    it('rejects a duplicate registration of the same Definition kind', async () => {
      const ctx = await bench()
      const fiber = ctx.plugin({ inject: [...inject], apply })
      await fiber.await()
      expect(() => ctx.conversationEvents.register(foldSummaryDefinition))
        .toThrow(/auto-fold-summary.*already registered/)
      await fiber.dispose()
    })
  })
  ```

- [ ] **Step 2: 运行测试确认失败**

  Run: `pnpm exec vitest run tests/client-composition.spec.tsx`
  Expected: FAIL（`../src/client/index.tsx` 不存在）。

- [ ] **Step 3: 写实现**

  Create `src/client/index.tsx`:

  ```tsx
  /**
   * dsh-auto-fold-turn client plugin, browser half. Registers the
   * `auto-fold-summary` Conversation Node Definition, its keyed Chat renderer,
   * and the plugin-owned stylesheet. The entry only assembles; every folding
   * decision lives in the Definition / Resolver / Store / Adapter modules.
   * All registrations ride cordis effects, so fiber disposal removes them.
   */
  import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
  import { foldSummaryDefinition } from './fold-summary-definition.ts'
  import { FoldSummaryRow } from './summary-row.tsx'
  import { AUTO_FOLD_STYLE } from './styles.ts'

  /** Services required by the client plugin. */
  export const inject = ['slots', 'conversationEvents']

  /** Mounts the auto-fold client plugin.
   * @param ctx - Client root context.
   */
  export function apply(ctx: ClientContext): void {
    ctx.conversationEvents.register(foldSummaryDefinition)

    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'auto-fold-summary',
    }, FoldSummaryRow))

    // Plugin-owned stylesheet: hidden-row rule + summary button chrome. The
    // effect teardown removes the tag with the fiber.
    ctx.effect(() => {
      const style = document.createElement('style')
      style.setAttribute('data-auto-fold-style', '')
      style.textContent = AUTO_FOLD_STYLE
      document.head.appendChild(style)
      return () => {
        style.remove()
      }
    }, 'dsh-auto-fold-turn: stylesheet')
  }
  ```

- [ ] **Step 4: 运行测试确认通过**

  Run: `pnpm exec vitest run tests/client-composition.spec.tsx`
  Expected: PASS（4 个用例全过）。

- [ ] **Step 5: 类型检查、构建与 bundle 泄漏检查**

  Run: `pnpm typecheck && pnpm build`
  Expected: exit 0；`lib/client.js` 生成，`grep -c "@deepseek-ai" lib/client.js` 输出 0（type-only import 已擦除）。

- [ ] **Step 6: Commit**

  ```bash
  git add src/client/index.tsx tests/client-composition.spec.tsx
  git commit -m "feat: compose client plugin entry (definition + renderer + stylesheet)"
  ```

---

## 10. Task 8：Assembled / browser-equivalent 全流程测试（覆盖规格 §测试设计-浏览器 E2E #1-9）

**Files:**
- Test: `tests/auto-fold-flow.spec.tsx`

设计要点：用真实 `ConversationNodeAssembler`（内置 Definition + 本插件 Definition）组装完整会话，再在 jsdom 里把 `chat.order` 渲染成带 `data-chat-anchor-key`/`data-chat-flow-kind` 的行并挂载 `FoldSummaryRow`，对规格的 9 条浏览器 E2E 做浏览器等价断言。E2E #8（禁用插件）与 #9（DOM 标记缺失）在本套件中以 dispose / 删标记模拟；真正的 Arc 手工验收在 Task 10。

- [ ] **Step 1: 写失败测试**

  Create `tests/auto-fold-flow.spec.tsx`:

  ```tsx
  // @vitest-environment jsdom
  import { Context } from 'cordis'
  import { afterEach, describe, expect, it } from 'vitest'
  import { cleanup, fireEvent, render, screen } from '@testing-library/react'
  import {
    ConversationEventRegistry, ConversationNodeAssembler, ConversationViewRegistry,
    type ChatSnapshot, type ConversationEventInput, type ConversationNodeDefinition,
    type ConversationViewDefinition,
  } from '@deepseek-ai/dsh-client-runtime/client'
  import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
  import { createSnapshotStore, EMPTY_CONVERSATION_VIEWS, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
  import { chatViewDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/chat-snapshot-builder.ts'
  import { assistantDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/assistant.ts'
  import { messageDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/message.ts'
  import { toolDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/tool.ts'
  import { retryDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/retry.ts'
  import { turnTailDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/turn-tail.ts'
  import { turnErrorDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/turn-error.ts'
  import { turnMaxTokensDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/turn-max-tokens.ts'
  import { foldSummaryDefinition } from '../src/client/fold-summary-definition.ts'
  import { FoldStateStore, type FoldStorage } from '../src/client/fold-state-store.ts'
  import { FoldSummaryRow } from '../src/client/summary-row.tsx'

  const SID = 's1' as SessionId
  const BUILTINS: readonly ConversationNodeDefinition[] = [
    messageDefinition, assistantDefinition, toolDefinition, retryDefinition,
    turnErrorDefinition, turnMaxTokensDefinition, turnTailDefinition,
  ]

  function at(
    seq: number,
    type: string,
    data: unknown,
    extra: Record<string, unknown> = {},
  ): ConversationEventInput {
    return {
      event: { seq, time: 1_700_000_000_000 + seq, type, data, ...extra } as unknown as ConversationEventInput['event'],
      view: undefined,
    }
  }

  function textMessage(id: string, text: string) {
    return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
  }

  function assistantMessage(id: string, text: string) {
    return { id, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'fake', model: 'fake' } }
  }

  function toolResult(callId: string, text: string) {
    return {
      id: `result-${callId}`, role: 'user', source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }],
    }
  }

  /** One multi-step turn: two tool calls with an intermediate assistant, then the final reply. */
  function multiStepTurn(offset: number, turn: number): ConversationEventInput[] {
    const s = (n: number) => offset + n
    return [
      at(s(0), 'turn/start', { turn }),
      at(s(1), 'user/message', textMessage(`u${turn}`, `ask ${turn}`), { surfaceOp: 'append' }),
      at(s(2), 'step/start', { turn, step: 1 }),
      at(s(3), 'tool/call', { turn, step: 1, callId: `c${turn}-1`, name: 'read', arguments: '{}' }),
      at(s(4), 'tool/result', { turn, step: 1, message: toolResult(`c${turn}-1`, 'a') }, { surfaceOp: 'append' }),
      at(s(5), 'assistant/message', { turn, step: 1, message: assistantMessage(`a${turn}-mid`, 'running more') }, { surfaceOp: 'append' }),
      at(s(6), 'tool/call', { turn, step: 1, callId: `c${turn}-2`, name: 'write', arguments: '{}' }),
      at(s(7), 'tool/result', { turn, step: 1, message: toolResult(`c${turn}-2`, 'b') }, { surfaceOp: 'append' }),
      at(s(8), 'assistant/message', { turn, step: 1, message: assistantMessage(`a${turn}`, `answer ${turn}`) }, { surfaceOp: 'append' }),
      at(s(9), 'step/end', { turn, step: 1 }),
      at(s(10), 'turn/end', { turn, reason: { kind: 'completed' } }),
    ]
  }

  async function assemble(entries: readonly ConversationEventInput[]): Promise<ChatSnapshot> {
    const ctx = new Context()
    const events = new ConversationEventRegistry(ctx)
    const views = new ConversationViewRegistry(ctx)
    for (const definition of BUILTINS) events.register(definition)
    events.register(foldSummaryDefinition)
    views.register(chatViewDefinition as unknown as ConversationViewDefinition)
    const value = new ConversationNodeAssembler(events, views)
    value.replaceWindow(entries, false)
    value.flush()
    return value.snapshot('chat') as ChatSnapshot
  }

  function memoryStorage(): FoldStorage {
    const values = new Map<string, string>()
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }
  }

  /**
   * Renders chat.order rows with DSH-like attributes; the summary key mounts
   * the real button. `markerStrip` drops the `data-chat-anchor-key` markers
   * to simulate DOM drift (E2E#9).
   */
  function Flow({ chat, store, container, markerStrip = false }: {
    chat: ChatSnapshot
    store: FoldStateStore
    container: HTMLElement
    markerStrip?: boolean
  }) {
    const source = createSnapshotStore({ chat, sessionId: SID, views: EMPTY_CONVERSATION_VIEWS } as never)
    const useSession = bindSnapshotSelector(source)
    return (
      <div data-conversation-scroll="">
        {chat.order.map((key) => {
          const node = chat.nodes.get(key)!
          if (node.kind === 'auto-fold-summary') {
            return (
              <div key={key} data-chat-flow-kind="auto-fold-summary" {...(markerStrip ? {} : { 'data-chat-anchor-key': key })}>
                <FoldSummaryRow node={node as never} sessionId={SID} useSession={useSession as never} foldState={store} root={container} />
              </div>
            )
          }
          return (
            <div
              key={key}
              data-chat-flow-kind={node.kind}
              {...(markerStrip ? {} : { 'data-chat-anchor-key': key })}
            />
          )
        })}
      </div>
    )
  }

  /** Kinds of rows carrying the hidden attribute, in DOM order. */
  function hiddenKinds(container: HTMLElement): string[] {
    return [...container.querySelectorAll('[data-auto-fold-hidden]')]
      .map(row => row.getAttribute('data-chat-flow-kind') ?? '')
  }

  /** Kinds of all rendered rows that are NOT hidden, in DOM order. */
  function visibleKinds(container: HTMLElement): string[] {
    return [...container.querySelectorAll('[data-chat-flow-kind]')]
      .filter(row => !row.hasAttribute('data-auto-fold-hidden'))
      .map(row => row.getAttribute('data-chat-flow-kind') ?? '')
  }

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  describe('auto-fold browser-equivalent flow', () => {
    it('E2E#1: after a multi-step turn only user, summary and final rows are visible', async () => {
      const chat = await assemble(multiStepTurn(0, 1))
      const store = new FoldStateStore(memoryStorage())
      const container = document.createElement('div')
      document.body.appendChild(container)
      render(<Flow chat={chat} store={store} container={container} />, { container })
      expect(screen.getByRole('button', { name: '▶ 过程 · 3 项' })).toBeDefined()
      // 3 process rows hidden: tool-call, intermediate assistant, tool-call.
      expect(hiddenKinds(container)).toEqual(['tool-call', 'assistant-step', 'tool-call'])
      // Visible: user, summary, final assistant, turn-tail.
      expect(visibleKinds(container)).toEqual(['user', 'auto-fold-summary', 'assistant-step', 'turn-tail'])
    })

    it('E2E#2: expand restores every process row in original order; clicking again re-folds', async () => {
      const chat = await assemble(multiStepTurn(0, 1))
      const store = new FoldStateStore(memoryStorage())
      const container = document.createElement('div')
      document.body.appendChild(container)
      render(<Flow chat={chat} store={store} container={container} />, { container })
      fireEvent.click(screen.getByRole('button', { name: '▶ 过程 · 3 项' }))
      expect(hiddenKinds(container)).toHaveLength(0)
      expect(visibleKinds(container)).toEqual([
        'user', 'tool-call', 'assistant-step', 'tool-call', 'auto-fold-summary', 'assistant-step', 'turn-tail',
      ])
      fireEvent.click(screen.getByRole('button', { name: '▼ 收起过程 · 3 项' }))
      expect(hiddenKinds(container)).toEqual(['tool-call', 'assistant-step', 'tool-call'])
      expect(visibleKinds(container)).toEqual(['user', 'auto-fold-summary', 'assistant-step', 'turn-tail'])
    })

    it('E2E#3: explicit expansion survives a refresh (fresh store instance) and re-collapse persists', async () => {
      const chat = await assemble(multiStepTurn(0, 1))
      const storage = memoryStorage()
      const container = document.createElement('div')
      document.body.appendChild(container)

      const first = render(<Flow chat={chat} store={new FoldStateStore(storage)} container={container} />, { container })
      fireEvent.click(screen.getByRole('button', { name: '▶ 过程 · 3 项' }))
      first.unmount()
      container.innerHTML = ''

      render(<Flow chat={chat} store={new FoldStateStore(storage)} container={container} />, { container })
      expect(screen.getByRole('button', { name: '▼ 收起过程 · 3 项' })).toBeDefined()
      expect(hiddenKinds(container)).toHaveLength(0)
      fireEvent.click(screen.getByRole('button', { name: '▼ 收起过程 · 3 项' }))
      expect(screen.getByRole('button', { name: '▶ 过程 · 3 项' })).toBeDefined()
      expect(hiddenKinds(container)).toHaveLength(3)
    })

    it('E2E#4: historical turns fold independently per turn', async () => {
      const chat = await assemble([...multiStepTurn(0, 1), ...multiStepTurn(20, 2)])
      const store = new FoldStateStore(memoryStorage())
      const container = document.createElement('div')
      document.body.appendChild(container)
      render(<Flow chat={chat} store={store} container={container} />, { container })
      const buttons = screen.getAllByRole('button')
      expect(buttons).toHaveLength(2)
      expect(buttons[0]?.textContent).toBe('▶ 过程 · 3 项')
      expect(buttons[1]?.textContent).toBe('▶ 过程 · 3 项')
      expect(hiddenKinds(container)).toHaveLength(6)
      // Expand only turn 1; turn 2 stays folded (3 rows remain hidden).
      fireEvent.click(buttons[0]!)
      expect(hiddenKinds(container)).toHaveLength(3)
    })

    it('E2E#5a: a max-tokens turn with a final reply folds its process and keeps the notice visible', async () => {
      const chat = await assemble([
        at(0, 'turn/start', { turn: 1 }),
        at(1, 'user/message', textMessage('u1', 'ask'), { surfaceOp: 'append' }),
        at(2, 'step/start', { turn: 1, step: 1 }),
        at(3, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' }),
        at(4, 'tool/result', { turn: 1, step: 1, message: toolResult('c1', 'ok') }, { surfaceOp: 'append' }),
        at(5, 'assistant/message', { turn: 1, step: 1, message: assistantMessage('a1', 'truncated') }, { surfaceOp: 'append' }),
        at(6, 'step/end', { turn: 1, step: 1 }),
        at(7, 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } }),
      ])
      const store = new FoldStateStore(memoryStorage())
      const container = document.createElement('div')
      document.body.appendChild(container)
      render(<Flow chat={chat} store={store} container={container} />, { container })
      expect(screen.getByRole('button', { name: '▶ 过程 · 1 项' })).toBeDefined()
      expect(hiddenKinds(container)).toEqual(['tool-call'])
      // The max-tokens notice sorts after the summary and stays visible.
      expect(visibleKinds(container)).toEqual([
        'user', 'auto-fold-summary', 'assistant-step', 'turn-max-tokens', 'turn-tail',
      ])
    })

    it('E2E#5b: an error turn with a final reply folds its process and keeps the error notice visible', async () => {
      const chat = await assemble([
        at(0, 'turn/start', { turn: 2 }),
        at(1, 'user/message', textMessage('u2', 'ask'), { surfaceOp: 'append' }),
        at(2, 'step/start', { turn: 2, step: 1 }),
        at(3, 'assistant/message', { turn: 2, step: 1, message: assistantMessage('a2-mid', 'running tool') }, { surfaceOp: 'append' }),
        at(4, 'tool/call', { turn: 2, step: 1, callId: 'c2', name: 'read', arguments: '{}' }),
        at(5, 'tool/result', { turn: 2, step: 1, message: toolResult('c2', 'boom') }, { surfaceOp: 'append' }),
        at(6, 'assistant/message', { turn: 2, step: 1, message: assistantMessage('a2', 'final words') }, { surfaceOp: 'append' }),
        at(7, 'step/end', { turn: 2, step: 1 }),
        at(8, 'turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'PLUGIN', message: 'exploded' } } }),
      ])
      const store = new FoldStateStore(memoryStorage())
      const container = document.createElement('div')
      document.body.appendChild(container)
      render(<Flow chat={chat} store={store} container={container} />, { container })
      expect(screen.getByRole('button', { name: '▶ 过程 · 2 项' })).toBeDefined()
      expect(hiddenKinds(container)).toEqual(['assistant-step', 'tool-call'])
      expect(visibleKinds(container)).toEqual([
        'user', 'auto-fold-summary', 'assistant-step', 'turn-tail', 'turn-error',
      ])
    })

    it('E2E#6: an abnormal turn without a final reply stays fully visible', async () => {
      const chat = await assemble([
        at(0, 'turn/start', { turn: 1 }),
        at(1, 'user/message', textMessage('u1', 'ask'), { surfaceOp: 'append' }),
        at(2, 'step/start', { turn: 1, step: 1 }),
        at(3, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' }),
        at(4, 'tool/result', { turn: 1, step: 1, message: toolResult('c1', 'ok') }, { surfaceOp: 'append' }),
        at(5, 'step/end', { turn: 1, step: 1 }),
        at(6, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'down' } } }),
      ])
      const store = new FoldStateStore(memoryStorage())
      const container = document.createElement('div')
      document.body.appendChild(container)
      render(<Flow chat={chat} store={store} container={container} />, { container })
      expect(screen.queryByRole('button', { name: /过程/ })).toBeNull()
      expect(hiddenKinds(container)).toHaveLength(0)
      expect(visibleKinds(container)).toEqual(['user', 'tool-call', 'turn-error', 'turn-tail'])
    })

    it('E2E#7: unmounting the view (session/view switch) restores every hidden row', async () => {
      const chat = await assemble(multiStepTurn(0, 1))
      const store = new FoldStateStore(memoryStorage())
      const container = document.createElement('div')
      document.body.appendChild(container)
      const first = render(<Flow chat={chat} store={store} container={container} />, { container })
      expect(hiddenKinds(container)).toHaveLength(3)
      first.unmount()
      container.innerHTML = ''
      expect(document.body.querySelectorAll('[data-auto-fold-hidden]')).toHaveLength(0)
    })

    it('E2E#8: disabling the plugin (fiber dispose) restores the full native transcript', async () => {
      const chat = await assemble(multiStepTurn(0, 1))
      const store = new FoldStateStore(memoryStorage())
      const container = document.createElement('div')
      document.body.appendChild(container)
      const first = render(<Flow chat={chat} store={store} container={container} />, { container })
      expect(hiddenKinds(container)).toHaveLength(3)
      first.unmount()
      container.innerHTML = ''
      expect(container.querySelectorAll('[data-auto-fold-hidden]')).toHaveLength(0)
    })

    it('E2E#9: when DOM compatibility markers are missing the content stays fully visible', async () => {
      const chat = await assemble(multiStepTurn(0, 1))
      const store = new FoldStateStore(memoryStorage())
      const container = document.createElement('div')
      document.body.appendChild(container)
      render(<Flow chat={chat} store={store} container={container} markerStrip />, { container })
      // Button still renders; nothing can be resolved, so nothing is hidden.
      expect(screen.getByRole('button', { name: '▶ 过程 · 3 项' })).toBeDefined()
      expect(container.querySelectorAll('[data-auto-fold-hidden]')).toHaveLength(0)
      expect(visibleKinds(container)).toHaveLength(7)
    })
  })
  ```

  说明：断言基于 `data-chat-flow-kind`（kind 多集），不依赖 DSH 内置 Node 的具体 key 字符串，因此对 DSH 内置 Definition 的 key 格式变化不敏感；顺序按 anchorSeq（与 `chat.order`、DOM 行序一致）。每轮过程节点数 = 隐藏的顶层行数：两个 tool-call 节点 + 一个中间 assistant = 3。E2E#5 拆成 5a（max-tokens）与 5b（error）两个独立用例，避免同一容器重复挂载 React root。

- [ ] **Step 2: 运行测试确认失败**

  Run: `pnpm exec vitest run tests/auto-fold-flow.spec.tsx`
  Expected: FAIL（`../src/client/summary-row.tsx` 等尚未实现导致的 import 失败，或首个用例的断言失败）。

- [ ] **Step 3: 确认通过**

  Run: `pnpm exec vitest run tests/auto-fold-flow.spec.tsx`
  Expected: PASS（10 个用例：E2E#1-4、E2E#5a、E2E#5b、E2E#6-9，共覆盖规格 9 条浏览器 E2E）。若某个 kind 顺序与预期不符，用 `pnpm exec vitest run tests/auto-fold-flow.spec.tsx -t "E2E#1" --reporter verbose` 查看实际 `chat.order` 后，把测试里的 kind 常量改准确，再全量通过。

- [ ] **Step 4: 全量测试 + 类型检查 + Commit**

  Run: `pnpm test && pnpm typecheck`
  Expected: 全绿、exit 0。

  ```bash
  git add tests/auto-fold-flow.spec.tsx
  git commit -m "test: browser-equivalent flow coverage for design E2E #1-9"
  ```

---

## 11. Task 9：README 与 INSTALL 文档

**Files:**
- Create: `README.md`
- Create: `INSTALL.md`

- [ ] **Step 1: 写 README**

  Create `README.md`:

  ```markdown
  # @ycp424c/dsh-auto-fold-turn

  DSH Web 外部 client 插件：一轮对话产生最终回复后，自动把该轮位于最终回复之前的
  工具调用、中间 assistant、重试等过程节点折叠为一行摘要（`▶ 过程 · N 项`），摘要行
  位于被折叠内容之后、最终回复之前。用户可随时展开/收起，显式展开状态按
  `sessionId + turn` 持久化到 localStorage，跨刷新保留直到再次折叠。

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
  | `src/client/fold-summary-definition.ts` | `auto-fold-summary` Conversation Node Definition（match `turn/end`，读 `turn-tail` data 的 closing，anchor 为 closing seq - 0.05） |
  | `src/client/fold-target-resolver.ts` | 纯函数：从 Chat snapshot 计算本轮可折叠过程 key 与最终回复 key |
  | `src/client/fold-state-store.ts` | `sessionId+turn` 显式展开集合，localStorage key `dsh.auto-fold.expanded.v1` |
  | `src/client/dom-adapter.ts` | 唯一接触 DSH DOM 的模块：按 `[data-chat-anchor-key]` 精确 key 定位、原子显隐、`[data-conversation-scroll]` 滚动补偿 |
  | `src/client/summary-row.tsx` | 摘要行 renderer：layout effect 应用显隐，原生 button + `aria-expanded` |

  排序：摘要 Node 的 `anchorSeq` 为 closing seq 减插件私有小数 offset（兼容边界，
  非公共 API）。任何原生排在 summary 之后的 Node（终态提示、晚期工具证据）都不会被
  折叠，因此终态提示即使位于最终回复之后也不破坏“摘要位于被折叠内容下方”的语义。

  ## DOM 兼容标记

  插件升级 DSH 后需运行兼容 smoke（Task 10 / INSTALL.md）。依赖的三个标记当前同时被
  DSH 自身滚动逻辑与 E2E 测试使用，但不视为稳定公共 API：

  - `[data-chat-anchor-key]`（行定位）
  - `[data-chat-flow-kind]`（summary 行漂移校验）
  - `[data-conversation-scroll]`（滚动容器）

  ## 开发

  ```bash
  pnpm setup:dsh          # 链接 ~/.dsh/source/current（built DSH checkout，只读）
  pnpm install
  pnpm check              # typecheck + test + build
  ```

  安装到本机 web profile 见 [INSTALL.md](./INSTALL.md)。

  ## License

  MIT
  ```

- [ ] **Step 2: 写 INSTALL**

  Create `INSTALL.md`：

  ```markdown
  # 安装与验收：dsh-auto-fold-turn

  本页是可执行的冒烟清单。区分：**DSH checkout**（`~/.dsh/source/current`，built
  快照；其改动核验以 `git -C <dsh-checkout> status` 为准）
  与**本插件目录**（`dsh-auto-fold-turn`，`dsh plugin` 装载的包）。

  ## 前置

  - Node `^22.19.0 || >=24.0.0`、pnpm 11.7.0（`corepack enable`）。
  - `~/.dsh/source/current` 存在且包含 `packages/client/runtime/lib/client.js` 等 built 产物。
  - DSH 已安装（`dsh --version` 可用）。

  ## 1. 链接与校验

  ```bash
  pnpm setup:dsh
  pnpm install --frozen-lockfile
  pnpm check
  ```

  预期：`.dsh/source/current -> ~/.dsh/source/current`；typecheck / vitest / build 全绿；
  产物 `lib/index.js`、`lib/client.js`。

  ## 2. 安装到 web profile

  ```bash
  dsh plugin --profile web add "$PWD"  # 在本插件目录根目录执行
  ```

  核对：
  - `~/.dsh/profiles/web/package.json`：`dependencies` 含
    `"@ycp424c/dsh-auto-fold-turn": "link:<插件目录绝对路径>"`，
    `dsh.profile.bundles` 末尾含 `@ycp424c/dsh-auto-fold-turn`。
  - `~/.dsh/profiles/web/pnpm-lock.yaml`：出现 `@ycp424c/dsh-auto-fold-turn` 的 importer。
  - `~/.dsh/profiles/web/node_modules/@ycp424c/dsh-auto-fold-turn` 是指向插件目录的符号链接。
  - profile 用户层 `~/.dsh/profiles/web/cordis.patch.yml` 保持 `[]`（插件的 bundle 层来自
    插件自己的 `cordis.patch.yml`，不写 profile 用户层）。

  ## 3. 启动与 boot graph

  ```bash
  dsh web
  ```

  预期：启动无 pending/failed activation；在浏览器控制台
  `window.__DSH_BOOT__`（或 web 的 boot 状态页）能看到 `@ycp424c/dsh-auto-fold-turn`
  client 条目进入浏览器 roster。

  ## 4. Arc 手工验收（对应规格 §实际运行验收）

  1. 完成一轮多步骤对话（含工具调用与多次 assistant 输出）：只显示用户消息、摘要行、最终回复。
  2. 点击摘要展开：恢复原顺序的全部过程；再次点击重新折叠。
  3. 展开后刷新页面仍展开；折叠后刷新仍折叠。
  4. 打开已有多轮历史：各 Turn 独立折叠。
  5. 触发 error / abort / max-token 结束的 Turn：有最终回复时折叠其前置过程，同时保留
     原生终态提示（error / max-token 提示可见）。
  6. 没有最终回复的异常 Turn 保持完整显示。
  7. 加载更早历史（load older）、切换 Chat/Trajectory、切换 Session 后状态正确、无残留隐藏。
  8. 在 profile 移除插件（`dsh plugin --profile web remove @ycp424c/dsh-auto-fold-turn`）
     后重启 `dsh web`：原生聊天内容完整恢复。
  9. （兼容 smoke）临时改掉 `data-chat-anchor-key` 标记后刷新：保持完整内容可见（fail-open）。

  ## 5. DSH 零修改核验

  ```bash
  git -C <dsh-checkout> status --porcelain
  git -C <dsh-reference> status --porcelain
  ```

  预期：两者均无输出。

  ## 6. 卸载

  ```bash
  dsh plugin --profile web remove @ycp424c/dsh-auto-fold-turn
  ```

  插件卸载会移除其注入的样式表与全部 `data-auto-fold-hidden` 属性；刷新页面后原生内容完整。

  ## 排错

  | 症状 | 排查 |
  | --- | --- |
  | 摘要行不出现 | 该 Turn 无 closing assistant（tool-only / 失败且无文本），或 profile 未装载插件 |
  | 过程未折叠 | DOM 标记缺失（fail-open）；检查 `[data-chat-anchor-key]` 是否仍存在 |
  | 展开状态刷新丢失 | localStorage 被清空或 key 版本变化（`dsh.auto-fold.expanded.v1`） |
  | boot activation 失败 | 检查 `dsh web` 启动日志；确认 `lib/client.js` 已构建且 `dsh.client` 元数据完整 |
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add README.md INSTALL.md
  git commit -m "docs: add README and install/acceptance checklist"
  ```

---

## 12. Task 10：构建验证 + web profile 安装 + 实际运行验收

**Files:** 无新代码文件；执行验证命令与手工清单（会改动 `~/.dsh/profiles/web`，不碰 DSH 源码）

- [ ] **Step 1: 全量 check**

  Run: `pnpm check`
  Expected: typecheck、全部 vitest、build 全绿，exit 0。

- [ ] **Step 2: 安装到 web profile（见 INSTALL.md §2）**

  Run: `dsh plugin --profile web add "$PWD"  # 在本插件目录根目录执行`
  Expected: pnpm 在 profile 目录安装成功；随后核对：

  Run: `python3 - <<'EOF'
import json
import os
p = json.load(open(os.path.expanduser('~/.dsh/profiles/web/package.json')))
print('dep:', p['dependencies'].get('@ycp424c/dsh-auto-fold-turn'))
print('bundles:', p['dsh']['profile']['bundles'])
EOF`
  Expected: `dep: link:<插件目录绝对路径>`；`bundles` 末尾含 `@ycp424c/dsh-auto-fold-turn`。

  Run: `ls -la ~/.dsh/profiles/web/node_modules/@ycp424c/ | grep auto-fold`
  Expected: `dsh-auto-fold-turn -> <plugin-root>` 符号链接。

  Run: `grep -c "dsh-auto-fold-turn" ~/.dsh/profiles/web/pnpm-lock.yaml`
  Expected: 输出 ≥ 1（lockfile 已记录该 importer）。

- [ ] **Step 3: 启动 DSH 并核对 boot graph**

  Run: `dsh web`（前台或后台均可）
  Expected: 启动日志无 pending/failed activation；浏览器打开 DSH Web 后在控制台执行
  `window.__DSH_BOOT__ && window.__DSH_BOOT__.entries`（如存在）能看到
  `@ycp424c/dsh-auto-fold-turn`。

- [ ] **Step 4: Arc 手工验收清单（INSTALL.md §4 逐条执行）**

  预期：9 条全部通过（折叠/展开/刷新持久化/历史多轮独立折叠/终态提示保留/异常 Turn
  完整显示/会话切换无残留/禁用后完整恢复/DOM 标记缺失 fail-open）。任一条失败即停止，
  按 INSTALL.md 排错表处理，不跳过。

- [ ] **Step 5: DSH 零修改核验**

  Run: `git -C <dsh-checkout> status --porcelain && git -C <dsh-reference> status --porcelain && git -C <dsh-checkout> rev-parse HEAD && git -C <dsh-reference> rev-parse HEAD`
  Expected: 前两个无输出；后两个 commit 与 Task 0 Step 5 记录一致。

- [ ] **Step 6: Commit（如有校验性修正）**

  ```bash
  git status --porcelain
  ```
  若仅有此前任务的已提交改动与未跟踪的 `lib/`（gitignore）则无需提交；如有修正，按对应任务重新提交并注明。

---

## 13. Task 11：终检与自查

- [ ] **Step 1: 全量验证**

  Run: `pnpm check`
  Expected: 全绿，exit 0。

- [ ] **Step 2: 规格覆盖自查**（对照 `docs/superpowers/specs/2026-08-14-dsh-auto-fold-turn-design.md`）

  - [ ] 目标 1（新轮次与历史轮次同规则）→ Task 2（replace/prepend/append 同构测试）+ Task 8 E2E#4
  - [ ] 目标 2（默认折叠最终回复之前的过程）→ Task 2/3/6/8
  - [ ] 目标 3（保留用户消息、closing、摘要、终态提示、turn-tail）→ Task 3/8（E2E#5）
  - [ ] 目标 4（摘要行位于被折叠内容之后、最终回复之前）→ Task 2（anchor 测试）+ Task 8（visibleKinds 顺序）
  - [ ] 目标 5（展开状态跨刷新）→ Task 4/6/8（E2E#3）
  - [ ] 目标 6（无法识别时保持可见）→ Task 5（fail-open）+ Task 8（E2E#9）
  - [ ] 目标 7（禁用/卸载恢复）→ Task 7（dispose 无残留）+ Task 8（E2E#7/#8）
  - [ ] 非目标（不 patch DSH、不全局开关、无动画、不统计子调用）→ 全计划未引入对应功能；Task 0/10/11 核验 DSH 零修改
  - [ ] 测试设计全部条目 → Task 2-8 的用例一一对应（Definition 5 条、Resolver 6 条、Store 7 条、Adapter 6 条、Client 组合 4 条、浏览器 E2E 9 条）
  - [ ] 实际运行验收 → Task 10

- [ ] **Step 3: 占位符扫描**

  Run: `grep -n "TBD\|TODO\|implement later\|待实现\|占位" docs/superpowers/plans/2026-08-14-dsh-auto-fold-turn-implementation.md || true`
  Expected: 无输出。

- [ ] **Step 4: 类型/命名一致性自查**（跨任务核对）

  - `AUTO_FOLD_SUMMARY_KIND = 'auto-fold-summary'`：Task 2 定义、Task 6/7 注册与组件、Task 8 断言一致。
  - `FoldSummaryChatData`：Task 2 契约与 Task 3 resolver 读取一致（`turn`/`closingSeq`）。
  - `resolveFoldTarget(chat, summary)` 返回 `FoldTarget {turn, summaryKey, finalKey, processKeys, count}`：Task 3 定义、Task 6 使用一致。
  - `FoldStateStore.isExpanded/setExpanded(sessionId, turn, expanded)`：Task 4/6 一致。
  - `TurnDomAdapter.resolve/apply/restore` + `AUTO_FOLD_HIDDEN_ATTR`：Task 5/6 一致。
  - localStorage key 常量 `dsh.auto-fold.expanded.v1`：Task 4 与 INSTALL.md §6 排错表一致。
  - 测试命令：`pnpm exec vitest run <file>` / `pnpm typecheck` / `pnpm build` / `pnpm check` 全程一致。

- [ ] **Step 5: 最终提交（如自查有修正）**

  ```bash
  git status --porcelain
  ```
  预期：只有本计划已提交的文件与 gitignore 覆盖的 `lib/`/`node_modules/`；无 DSH 相关改动。

---

## 14. 执行交接

计划完成并保存于 `docs/superpowers/plans/2026-08-14-dsh-auto-fold-turn-implementation.md`。两种执行方式：

1. **Subagent-Driven（推荐）**：每个 Task 派发一个全新 subagent，任务间双阶段 review（执行 `subagent-driven-development`）。
2. **Inline Execution**：本会话内用 `executing-plans` 按检查点批量执行。

选择后按对应 sub-skill 的流程逐 Task 执行；每个 Task 的提交点即 review 检查点。所有命令在插件仓库根目录（`<plugin-root>`）内运行；`~/.dsh`、`<dsh-reference>`、`<dsh-checkout>` 只读。
