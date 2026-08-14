# 安装与验收：dsh-auto-fold-turn

本页是可执行的冒烟清单。区分：**DSH checkout**（`~/.dsh/source/current`，built
快照；其改动核验以 `git -C <dsh-checkout> status` 为准）
与**本插件目录**（`dsh-auto-fold-turn`，`dsh plugin` 装载的包）。

> 路径约定：`<dsh-checkout>` 与 `<dsh-reference>` 是占位符，分别表示你本机 DSH 的
> git 跟踪 checkout 目录与 DSH 只读参考仓库目录；`~/.dsh`（即
> `${DSH_HOME:-$HOME/.dsh}`）是 DSH 用户目录。除特殊说明外，所有命令在**本插件
> 目录根目录**内运行。

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

## 4. Arc 手工验收（对应设计文档 §实际运行验收）

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
| `dsh plugin add` 报 `ERR_PNPM_ADDING_TO_ROOT` | profile 目录带 `pnpm-workspace.yaml`（workspace root）时部分 pnpm 版本要求显式 workspace 安装：在 `~/.dsh/profiles/web` 下执行 `pnpm add -w <link:绝对路径>` 后，再按 §2 核对 package.json 的 `dependencies`/`dsh.profile.bundles` 是否补齐；或在 pnpm 配置中设置 `ignore-workspace-root-check=true` |
