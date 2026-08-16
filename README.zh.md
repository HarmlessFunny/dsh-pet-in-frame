# dsh-pet-in-frame

[English](README.md) | 中文

单包形态的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：一只悬浮在 Web 界面角落的小宠物，会跟着 Agent 的动静换姿态——思考、查资料、翻代码、跑命令、改文件、出错、待机。

一个包 = 一个 bundle = 一行 loader 条目：host 半监听 Agent 生命周期（`agent/status`、`tools/execute`、`tools/result`、`agent/error`），盯着 `assets/` 目录里的图片和 `manifest.json` 变化，提供四个 HTTP 路由（`/dsh-pet-in-frame/state`、`/texts`、`/frames/<动作>`、`/assets/<文件>`）；浏览器半把宠物注册进 `shell.overlay`，轮询 `state`，切换静态姿态或轮播帧动画。

差异化卖点：**素材目录即配置**。往 `assets/` 丢一张 `bash.png`，跑命令时宠物自动换成它；加一组帧 + 一行 manifest，就是动画。不用构建、不用改代码，改完几秒内热更新。

## 截图

**主界面（探索页）** — 宠物常驻右下角，待机姿态：

![主界面待机](https://raw.githubusercontent.com/HarmlessFunny/dsh-pet-in-frame/main/screenshots/01-hero-idle.jpg)

**对话中** — 宠物跟随 Agent 状态换姿态，点击显示状态气泡：

![对话中](https://raw.githubusercontent.com/HarmlessFunny/dsh-pet-in-frame/main/screenshots/02-chat-bubble.jpg)

## 特性

- 姿态随 Agent 状态与工具调用自动切换：

  | 动作 | 触发 | 取图 |
  |---|---|---|
  | `think` | running 且无活跃工具 | `think.png` / `{imgs:[...],delay}` |
  | `search` | `web_search`、`web_fetch` | `search.png` |
  | `read` | `read`、`glob`、`grep` | `read.png` → `search.png` → `default.png` |
  | `bash` | `bash`、`pwsh` | `bash.png` → `default.png` |
  | `edit` | `edit`、`write` | `edit.png` → `default.png` |
  | `plan` | `todo_*`、goal、workflow | `plan.png` → `default.png` |
  | `ask` | `ask_user_question` | `ask.png` → `default.png` |
  | `error` | `agent/error` | `error.png` → `default.png` |
  | `idle` / `default` | 无事发生 | `default.png` |
  | `sleep` | 连续待机 30 秒后自动入睡 | `sleep.png` / `{imgs:[...],delay}` |

- 待机睡眠：连续空闲 30 秒后自动入睡（`sleep` 帧动画，500ms 间隔），之后一直睡；**点击宠物唤醒**回 `default` 并重新计时，再空闲 30 秒又入睡。任何工具调用、思考或报错也会打断睡眠并重新计时。
- 每个动作两种配置：`"动作": "图片.png"`（静态）或 `"动作": { "imgs": [...], "delay": 1000 }`（帧动画，delay 毫秒，缺省 500）。
- 热更新：改图或改 `manifest.json`，3~4 秒生效，无需重启。
- 可拖拽（视口内钳制）、悬停 `−/+` 调尺寸（100~320px）、点击冒状态气泡、`×` 隐藏 / 🐾 唤回。
- 无需构建：纯 JavaScript（Node ESM Host + `window.__ModuleLoader__` Client）。

## 安装

前置：可用的 dsh `web` profile，`dsh` CLI 能调用 pnpm。

**从 npm（推荐）：**

```sh
dsh plugin --profile web add dsh-pet-in-frame
```

**从 GitHub（固定 commit，可审计）：**

```sh
dsh plugin --profile web add github:HarmlessFunny/dsh-pet-in-frame#<commit-sha>
```

**本地目录（开发）：**

```sh
dsh plugin --profile web add file:E:/path/to/dsh-pet-in-frame
```

然后**重启 dsh web 进程**——新插件条目在启动时加载。包内的 `cordis.patch.yml` 会自动插入自己的 loader 行，无需手改 `cordis.yml`。

## 素材与配置

图片放在包内 `assets/` 目录。想换目录，用 `DSH_PET_ASSETS` 环境变量或在 loader 行上配 `config.assetsDir`：

```yaml
- id: dsh-pet-in-frame
  name: dsh-pet-in-frame
  config:
    assetsDir: C:/path/to/your/assets
```

**文件名约定（零配置）**——`assets/<动作>.<扩展名>`，支持 `png/jpg/jpeg/gif/webp/svg`：

```
assets/
├── default.png   # 兜底
├── think.png     # 思考
├── search.png    # 查资料 / 翻代码
└── bash.png      # 可选；缺省回退 default.png
```

**`manifest.json`**——精确控制，支持动画：

```json
{
  "default": "default.png",
  "think": { "imgs": ["think1.png", "think2.png", "think3.png"], "delay": 1000 },
  "sleep": { "imgs": ["sleep1.png", "sleep2.png", "sleep3.png"], "delay": 500 },
  "bash": "bash.png",
  "read": "search.png"
}
```

- 字符串 = 静态单图；对象 `{imgs, delay}` = 帧动画。
- 不存在的文件自动跳过；manifest 写坏了会被忽略、退回文件名约定。
- manifest 没写的动作仍走约定 → 回退链。

**素材优化**：原图通常是 1254px+ 的大图，宠物最多显示 320px，直接放会明显拖慢加载。用 `scripts/optimize-assets.cjs` 一键压成 512px WebP（体积约 1/10）并原地替换，跑完把 `manifest.json` 里的文件名改成 `.webp`。

## 工作原理

Host 半提供五个路由：

| 路由 | 返回 |
|---|---|
| `/dsh-pet-in-frame/state` | `{ status, action, tool, error, idleMs, rev }` |
| `/dsh-pet-in-frame/texts` | 各动作的气泡文案 |
| `/dsh-pet-in-frame/frames/<动作>` | `{ frames: [url...], delay }`（URL 带当前 `rev`） |
| `/dsh-pet-in-frame/assets/<文件>` | 图片字节 |
| `/dsh-pet-in-frame/wake` | `POST`，点击宠物时唤醒并重置待机计时 |

Client 每秒轮询 `state`，`rev` 变化时重新拉帧——图片和配置改动无需刷新页面即可生效。

## 安全

- 只服务配置的素材目录；文件名必须匹配 `[\w.-]+`，无路径穿越。
- manifest 仅用 `JSON.parse` 当数据处理，写坏只会退化到约定模式。
- 除 `POST /wake`（只重置计时，不读请求体、不落盘）外，其余路由均为只读 GET。

## 已知的坑

- **安装后必须重启**——新 bundle 条目启动时加载，浏览器侧也要刷新页面。
- **安装后素材目录是唯一事实来源**。如果之前动态插件指向 `~/Desktop/assets`，把文件复制进包内 `assets/`（或设 `DSH_PET_ASSETS`）。
- **宠物是进程级的**。本插件在 host 平面，所有会话的事件都会喂给同一只宠物——单人部署没问题。
- **帧动画是翻书式**：定时轮播若干静态图。帧数多的话建议改用单张精灵图/GIF。

## 许可

[MIT](LICENSE)。Copyright (c) 2025 dsh-pet-in-frame contributors。
