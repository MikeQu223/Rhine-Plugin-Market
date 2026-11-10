# 插件市场约定

- 目标：开发者按目录规范提交插件，客户端直接下载安装。
- 当前策略：不签名、不做信任链、不做哈希/版本校验；只校验 manifest 结构、id、相对路径和入口存在性。

## 1. 市场仓库布局

```text
index.json
plugins/<id>/manifest.json
plugins/<id>/plugin.cjs
plugins/<id>/LICENSE
plugins/<id>/...
```

`index.json`：

```json
{
    "schemaVersion": 1,
    "plugins": [
        {
            "id": "example",
            "name": "Example Music",
            "description": "一句话描述",
            "version": "1.0.0",
            "publisher": "Example Lab",
            "license": "MIT",
            "path": "plugins/example",
            "entry": { "file": "plugin.cjs" },
            "files": ["LICENSE", "THIRD-PARTY-NOTICES.md"]
        }
    ]
}
```

- `path` 是插件目录；默认 `plugins/<id>`。
- `entry.file` 必填；`files` 列出除 `manifest.json` 外需要下载的文件。
- 客户端不解析 tar、不验签；按 `path + file` 从市场 raw 地址下载到插件目录。
- `files` 必须列出所有运行时文件；`check-marketplace.cjs` 会反向遍历目录并拒绝未列出的文件。
- `manifest.json` 至少包含 `schemaVersion`、`apiVersion`、`id`、`version`、`entry.file`、`display.name`、
  `capabilities`；完整要求见 [插件包要求](PLUGIN-REQUIREMENTS.md)。

## 2. 客户端配置

- 干净安装默认 core-only，不预装任何第三方平台插件；首次启动只有内置 local/siren。
- 默认市场地址：`https://raw.githubusercontent.com/MikeQu223/Rhine-Plugin-Market/main/index.json`。
- 环境变量 `RHINE_PLUGIN_MARKETPLACE_URL` 可覆盖默认地址（本地联调可用 `file://.../index.json`）。
- 地址不可用时插件管理面板显示读取失败，不影响已安装插件。
- 市场安装显示文件进度、总字节速度和进度条；安装中重复点击会被拒绝。

## 3. 数据目录

- 下载目录：`<应用数据目录>/plugins/<id>/`（桌面、iOS、Android 同一规则）。
- 启用状态：`<应用数据目录>/plugins-state.json`，格式 `{ "disabled": ["id"] }`。
- 临时目录：`.staging-*`；回滚备份：`.backup-*`。Registry 会忽略这些目录。
- 用户目录中的同 id 插件覆盖构建期插件。

## 4. 启用/禁用/卸载

- 禁用后 Qt ProviderRegistry 与 worker Registry 都不加载该插件。
- 启用/禁用会写入状态文件并重启音乐服务；当前正在使用的来源不能直接禁用。
- 桌面端插件管理支持“导入文件夹”；只接受带有效 `manifest.json` 和入口文件的目录。
- 插件详情支持卸载用户安装的插件；内置插件不能卸载，卸载前需切换到其他来源。
- 插件详情面板显示版本、发布者、许可证、入口、能力数量和状态。

## 5. 构建默认值

- `npm run build` 默认 `--plugins=core`，干净安装不带插件。
- 开发/完整回归使用 `npm run build -- --plugins=full` 或 `--plugins=<id,...>`。

## 6. 本地打包工具（可选）

`MusicBridge/plugin-package.cjs` 可用于本地生成 `.rhineplugin`（确定性 tar），但市场安装不依赖它。
格式校验仅检查 manifest 结构，不做签名/哈希/版本校验。

## 7. 本地联调

在市场仓库根目录启动静态 HTTP 服务，或直接使用 `file://`：

```bash
RHINE_PLUGIN_MARKETPLACE_URL="file:///Users/mikequ/Desktop/RhineMarket/index.json" \
  ./output/qt-build/RhineMusicDatabase.app/Contents/MacOS/RhineMusicDatabase
```

校验：

```bash
node scripts/check-marketplace.cjs /Users/mikequ/Desktop/RhineMarket/index.json
```
