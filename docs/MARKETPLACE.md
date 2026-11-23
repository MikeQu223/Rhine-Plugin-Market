# 插件市场约定

市场和本地导入共用 `.rhineplugin` 包及客户端安装检查。校验文件完整性、manifest 和版本兼容性，确认页单独提示发布者身份未验证。

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
- 已发布的条目可加 `package`，字段为 `url`、`size` 和 `sha256`，分别记录下载地址、字节数和十六进制 SHA-256。
- 支持安装包的客户端优先下载 `package` 附件。条目没有附件字段时才按 `path + file` 下载。保留这两项用于旧客户端和旧市场索引。
- `files` 必须覆盖所有运行时文件，除 `manifest.json` 和已在 `entry.file` 指定的入口。`check-marketplace.cjs` 会反向遍历目录并拒绝未列出的文件。
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
- 插件管理支持本地 `.rhineplugin` 和既有目录导入入口。安装、更新、启用与加载均校验当前运行环境。
- 插件详情支持卸载用户安装的插件；内置插件不能卸载，卸载前需切换到其他来源。
- 插件详情面板显示版本、发布者、许可证、入口、能力数量和状态。

## 5. 构建默认值

- `npm run build` 默认 `--plugins=core`，干净安装不带插件。
- 开发/完整回归使用 `npm run build -- --plugins=full` 或 `--plugins=<id,...>`。

## 6. 打包与发布

1. 使用现有构建脚本准备 `plugins/<id>/` 中的运行产物，核对文件清单、依赖、版本和摘要。网易云、QQ 音乐和波点音乐的源码构建入口位于 `scripts/`，当前酷狗音乐以仓库内审计过的运行产物为发布输入。市场安装的目录与发行包使用同一份运行产物。
2. 使用 Node.js 26 和主仓锁定的构建依赖，在本仓执行 `RHINE_RELEASE_CLIENT_VERSION=vMAJOR.MINOR.PATCH node scripts/release-plugins.cjs build`。版本值与不带 `v` 的 `MAJOR.MINOR.PATCH` 均可。脚本检查市场清单、兼容性和可解析的运行依赖，通过同一 SDK CLI 在 `plugins/` 下生成并校验 ZIP。打包时不会安装或运行插件。直接分享此步骤生成的 `.rhineplugin` 即可供客户端离线导入。
3. 在 Actions 手动运行 **Rhine plugin packages**，工作流会自动检出主仓 `main` 的最新提交。只需填写 `vMAJOR.MINOR.PATCH` 格式的 `release_tag` 和 `client_version`；工作流默认生成下载产物。必须从 `main` 运行并打开发布选项，工作流才会发布 Release 附件和索引候选；其他分支勾选发布会直接失败。
4. 工作流发布后用 GitHub 返回的附件大小和 SHA-256 核对本次生成包，输出索引候选。下载候选并核对当前 `index.json` 中的插件版本和字段，再将 `package` 信息应用到索引。若期间有新插件版本合入，先确认发布附件与当前目录匹配。

需要在本地复核附件时，保存该 Release 的 API JSON，并执行以下命令。索引候选写到包目录内的 `index.json`，原市场索引由发布者按上述流程更新。

```bash
node scripts/release-plugins.cjs index /tmp/rhine-release.json plugins MikeQu223/Rhine-Plugin-Market
```

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
