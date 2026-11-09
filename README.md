# Rhine Plugin Market

插件市场仓库。客户端读取根目录 `index.json`，按 `path` 下载插件文件。

## 目录

```text
index.json
plugins/<id>/manifest.json
plugins/<id>/plugin.cjs
plugins/<id>/...
```

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
    "files": ["LICENSE"]
}
```

`files` 必须列出除 `manifest.json` 外所有需要下载的文件。客户端不做签名或哈希校验。

## 本地测试

```bash
RHINE_PLUGIN_MARKETPLACE_URL="file:///Users/mikequ/Desktop/RhineMarket/index.json" npm run build
```

或通过任意静态 HTTP 服务指向 `index.json`。
