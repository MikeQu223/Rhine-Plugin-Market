# Rhine Plugin Market

[Rhine-Music-Database](https://github.com/MikeQu223/Rhine-Music-Database) 的插件市场仓库。

客户端读取根目录 `index.json`，按 `path` 下载插件文件。

## 目录

```text
index.json
docs/                      # 插件要求与适配文档
plugins/<id>/manifest.json
plugins/<id>/plugin.cjs
plugins/<id>/...
```

## 开发者文档

- [插件包要求](docs/PLUGIN-REQUIREMENTS.md)：manifest 字段、operation、统一模型、文件清单、验收项。
- [适配器开发指南](docs/ADAPTER-GUIDE.md)：从上游 API 包到 `plugin.cjs` 的完整流程、transport、
  归一化、登录、评论、测试与常见错误。
- [插件市场约定](docs/MARKETPLACE.md)：索引格式、安装流程、数据目录、启用/禁用/卸载。
- [案例：NetEase 插件](docs/CASE-NETEASE.md)：当前 `2.1.1` 插件的实际目录、manifest、transport、
  条目映射、评论和发布检查。

完整 Port/模型契约以主仓库 `MusicBridge/plugins/sdk/README.md`、`port.d.ts` 和
`manifest.schema.json` 为准。

## 新增插件

1. 在 `plugins/<id>/` 放入 `manifest.json`、`plugin.cjs` 和运行时文件。
2. 在 `index.json` 的 `plugins` 数组添加：

```json
{
    "id": "example",
    "name": "显示名称",
    "description": "一句话描述",
    "version": "1.0.0",
    "publisher": "发布者",
    "license": "MIT",
    "path": "plugins/example",
    "entry": { "file": "plugin.cjs" },
    "files": ["LICENSE", "THIRD-PARTY-NOTICES.md"]
}
```

`files` 必须列出除 `manifest.json` 外所有需要下载的文件。客户端不做签名或哈希校验；只校验
manifest 结构、id、相对路径和入口存在性。发布前运行：

```bash
node scripts/check-marketplace.cjs /Users/mikequ/Desktop/RhineMarket/index.json
```

## 本地测试

```bash
RHINE_PLUGIN_MARKETPLACE_URL="file:///Users/mikequ/Desktop/RhineMarket/index.json" npm run build
```

或通过任意静态 HTTP 服务指向 `index.json`。

### 歌手歌曲分页插件的构建

网易云与 QQ 插件的适配层位于 `sources/`。其中 `legacy.cjs` 是原插件包的兼容基底，
构建时校验其摘要；新增的分页代码调用锁定的上游 API，不修改上游源码。构建脚本从相邻的
`RhineMusicPanel` 读取已安装的构建工具与锁定依赖，也可以通过 `RHINE_PANEL_ROOT` 指定目录：

```bash
node scripts/build-artist-plugins.cjs
node --test scripts/test-artist-plugins.cjs
```

生成的 `plugins/<id>/plugin.cjs` 和 manifest 是市场运行时文件；`sources/` 不随插件下载。

## 客户端默认地址

客户端默认读取：

```text
https://raw.githubusercontent.com/MikeQu223/Rhine-Plugin-Market/main/index.json
```

也可用 `RHINE_PLUGIN_MARKETPLACE_URL` 覆盖。

## 参考项目

- **[NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)**: 网易云接入
- **[MakcRe/KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi)**: 酷狗音乐标准版及概念版接入
- **[yakult-green-tea/qq-music-api](https://github.com/yakult-green-tea/qq-music-api)**: QQ 音乐接入
- **[amqsy/mygo-music-bodian](https://github.com/amqsy/mygo-music-bodian)**: 波点音乐接入
