# dsh-pet-in-frame

Agent 桌面宠物插件（DeepSeek Harness）——一只悬浮在页面右下角的小宠物，会随着 Agent 的状态和工具调用切换姿态：思考、查资料、跑命令、改文件、出错、空闲。支持**静态单图**和**多帧动画**（翻转书式轮播），图片与配置支持热更新。

一个能打的差异点：素材目录即配置——丢一张 `bash.png` 进去，跑命令时自动换图；丢一组帧 + 写一行 manifest，就能做出动画。

## 特性

- 🐾 按 Agent 状态/工具自动换姿态：
  `think`（思考）、`search`（web_search/web_fetch）、`read`（read/glob/grep）、`bash`（bash/pwsh）、`edit`（edit/write）、`plan`（todo/goal/workflow）、`error`、`idle`
- 🖼️ 每个动作两种配置：`"动作": "图片.png"`（静态）或 `"动作": {"imgs": [...], "delay": 1000}`（帧动画）
- 🔄 图片/配置文件热更新：改图或改 `manifest.json`，3~4 秒生效，无需重启
- 🖱️ 拖拽移动（边界钳制）、悬停 ± 尺寸调节（100~320px）、点击气泡、× 隐藏 / 🐾 唤回
- 🧩 无需构建：纯 JavaScript（Node ESM Host + `window.__ModuleLoader__` Client）

## 安装

1. 把本仓库放进你的 DSH 环境可访问的路径（例如 `E:\DeepSeek\dsh-pet-in-frame`）。
2. 找到你的 **web profile** 目录（通常是 `~/.dsh/profiles/web`），在它的 `package.json` 里：
   - `dsh.profile.bundles` 数组追加 `"dsh-pet-in-frame"`
   - `dependencies` 追加 `"dsh-pet-in-frame": "file:<本仓库路径>"`
3. 在 profile 目录执行 `pnpm install`。
4. **重启 DSH web 进程**（新插件条目在启动时加载）。

> 包内的 `cordis.patch.yml` 会自动把 `dsh-pet-in-frame` 行插入组合，无需手改 profile 的 `cordis.yml`。

## 素材配置

所有图片放在本包的 `assets/` 目录（也可通过 `DSH_PET_ASSETS` 环境变量或组合行 `config.assetsDir` 指向其他目录）。

**方式一：文件名约定（零配置）**——`动作名.扩展名`（png/jpg/jpeg/gif/webp/svg），放进去自动生效：

```
assets/
├── default.png   # 兜底
├── think.png     # 思考
├── search.png    # 查资料 / 翻代码（read 会回退到这里）
└── bash.png      # （可选）跑命令，缺省回退 default.png
```

**方式二：`manifest.json`**——精确控制，支持动画：

```json
{
  "default": "default.png",
  "think": { "imgs": ["think1.png", "think2.png", "think3.png"], "delay": 1000 },
  "bash": "bash.png",
  "read": "search.png"
}
```

- 字符串 = 静态单图；对象 `{imgs, delay}` = 帧动画（`delay` 毫秒轮播，缺省 500ms）
- 引用的文件缺失会自动跳过；manifest 非法 JSON 会被忽略并退回文件名约定
- 没在 manifest 里写的动作仍走文件名约定 → 回退链（`read` → `search` → `default`）

## 仓库结构

```
dsh-pet-in-frame/
├── package.json       # dsh.client 声明 + exports["./client"]
├── cordis.patch.yml   # 自动插入组合行
├── lib/
│   ├── index.js       # Host 半：事件管道 + HTTP 路由 + 热更新
│   └── client.js      # Client 半：宠物 UI（__ModuleLoader__）
├── assets/            # 你的图片 + manifest.json
├── README.md
└── LICENSE
```

Host 面提供四个 HTTP 端点：`/dsh-pet-in-frame/state`（状态+rev）、`/texts`（气泡文案）、`/frames/<动作>`（帧列表）、`/assets/<文件>`（图片）。

## 许可

MIT
