# 从上游 API 到 Rhine 插件

本指南说明如何把一个上游音乐 API 包适配成 Rhine 插件。发布要求见
[插件包要求](PLUGIN-REQUIREMENTS.md)；完整 Port/模型契约见主仓库
`MusicBridge/plugins/sdk/README.md`。

## 1. 请求链路

```text
Qt 业务
  → MusicApi.call("/native/<id>/<operation>", { args })
  → C++ Host（缓存、凭据切片、epoch、限流）
  → Node worker（PluginRegistry）
  → plugin.cjs create(host)
  → dispatchNative(operation, args)
  → 插件 transport → 上游 npm 包 / HTTP / 本地 IPC
  → 统一模型校验
  → Host → Qt
```

插件的职责是**隔离 + 归一化**：

- 上游协议、加密、设备注册、平台字段只存在于插件目录。
- 对外只暴露 native operation 和统一模型。
- core 不知道上游路由、平台音质名称、平台错误码。

## 2. 目录与构建

推荐源码目录：

```text
plugins/<id>/
  manifest.json
  index.mjs              # runtime.sourceEntry，构建输入
  plugin.cjs             # 构建产物，manifest.entry.file
  adapter.mjs            # API/领域适配
  transport.mjs          # route → 上游 module
  items.mjs              # 条目归一化
  lyrics.mjs
  build.cjs              # 可选，esbuild 补丁
  upstream/              # 上游运行时资产
  LICENSE
  THIRD-PARTY-NOTICES.md
  sbom.cdx.json
```

构建：

```bash
node scripts/bundle-plugins.cjs MusicBridge/local-plugins <id>
```

构建器读取 `manifest.runtime.sourceEntry`，用 esbuild 打成单文件 CJS，执行插件自己的 `build.cjs`，
回写 `entry.sha256`、`entry.size` 和 `runtime.bundled`。发布目录不应依赖 `node_modules`。

### 移动端运行时限制

移动端（iOS / Android）的 libnode 18 没有编译完整 ICU，市场包会原样跑在这套运行时上：

- **不要使用 RegExp Unicode 属性转义**：`\p{...}`、`\P{...}`，包括写进字符串再交给 `new RegExp` 的形式。
  模块加载阶段就会编译的正则字面量会直接抛 `SyntaxError: Invalid property name in character class`，
  整个插件被判为 `plugin.load-failed`。
- 改用显式字符区段，按实际需要调整范围：

```js
// 不要这样写：移动端没有完整 ICU，加载阶段就抛 SyntaxError。
text.replace(/[\s\p{P}\p{S}]/gu, '');

// 改为显式区段（空白、ASCII 标点、CJK 与全角标点/符号）。
text.replace(/[\s!-\/:-@\[-\x60{-~\u00A0-\u00BF\u2000-\u206F\u3000-\u303F\uFF00-\uFFEF]/g, '');
```

- **不要依赖 `TextDecoder` 的 `fatal` 选项**：无 ICU 的运行时会抛 `ERR_NO_ICU`。需要校验 UTF-8 时用
  `require('node:buffer').isUtf8()`；客户端虽已加兼容，也不能把它当作可用前提。
- `runtime.mobileBundled: true` 的插件入口会被市场检查扫描 `\p{...}`，命中即发布失败。

## 3. 先写 manifest

manifest 是插件边界，不是事后补充。先回答：

1. Qt 需要哪些栏位、搜索类型、登录方式？写 `library`、`search`、`login`、`quality`。
2. 上游能提供哪些能力？写 `capabilities` 和 `operations`，两者与实现保持一致。
3. 需要哪些原始/迁移路由？写 `routes.prefixes` 或 `routes.legacyRoutes`。
4. 需要哪些运行时文件？写 `files[]`，再用市场检查脚本反向校验。

最小 manifest 见 [插件包要求](PLUGIN-REQUIREMENTS.md#2-manifest-必填字段)。

要点：

- `operations` 是运行时白名单；入口必须据此拒绝未声明 operation。
- `capabilities` 是 UI 门控；声明 `login` 就必须有登录流程，声明 `comments` 就必须实现评论。
- `quality.options[].id` 是不透明平台档位；`tier` 使用统一档位。
- `display.default` 全局只能有一个插件声明。
- `credentials` 必须声明命名空间；需要持久化的 secret 用 `inject` / `responseSecrets`。
- `media.hosts` / `coverHosts` 必须覆盖真实媒体和封面域名；HTTP 只在明确允许时使用。

## 4. 入口只做分派

`plugin.cjs` 的入口应保持轻量：

```js
export function create(host) {
    const operations = new Set(
        Object.entries(host.manifest.operations || {})
            .filter(([, enabled]) => enabled)
            .map(([name]) => name),
    );
    const api = new Api(host);
    return {
        async dispatchNative(operation, args) {
            if (!operations.has(operation) || typeof api[operation] !== 'function') {
                const error = new Error('此来源不支持该接口');
                error.code = 400;
                throw error;
            }
            return api[operation].apply(api, args);
        },
        async dispatchRoute(route, params = {}) {
            return api.request(route, params);
        },
        async capabilities() {
            return host.manifest.capabilities || {};
        },
    };
}
```

约束：

- `create` 每次请求都会执行；不要依赖跨请求实例状态。模块级/transport 单例可以复用缓存。
- `dispatchNative` 的参数是位置参数，不是对象。
- `dispatchRoute` 返回原始 body，不做模型校验；只用于迁移或特殊查询。
- 不要直接写 stdout/stderr；worker 的 stdout 是 JSON-lines IPC。
- 不要把平台名称、平台资产、平台文案带进主仓库；它们只属于插件。

## 5. transport：只接需要的上游模块

维护“插件 route → 上游 module”的显式白名单：

```js
const routes = Object.freeze({
    '/search': 'search',
    '/search/suggest': 'search_suggest',
    '/song/detail': 'song_detail',
    '/song/url': 'song_url',
    '/lyric': 'lyric',
});

module.exports = {
    search: require('upstream-api/module/search.js'),
    search_suggest: require('upstream-api/module/search_suggest.js'),
    song_detail: require('upstream-api/module/song_detail.js'),
    song_url: require('upstream-api/module/song_url.js'),
    lyric: require('upstream-api/module/lyric.js'),
};
```

不要为了省事把上游整个 server/中间件跑起来。优先直接 require 上游 module，把 cookie、请求函数和参数显式传进去。
这样插件能控制类型、错误和凭据边界，也不会额外暴露本地端口。

cookie 处理：

- 只过滤插件私有键和其他 provider 的 session；不要过滤所有 `__*`，CSRF cookie 往往以 `__` 开头。
- 上游返回的 Set-Cookie 交给 `host.acceptCookies(JSON.stringify(lines))`。
- 不要把 cookie/token 写进日志、错误消息或诊断字段。

## 6. 条目归一化

上游对象不能直接返回。先把一条结果映射成统一模型，再用 `models.cjs` 思路自检：

```js
function track(raw) {
    return {
        provider: manifest.id,
        kind: 'song',
        id: String(raw.id),
        key: `${manifest.id}:song:${raw.id}`,
        title: raw.name || '',
        artist: (raw.artists || []).map((item) => item.name).join(' / '),
        artists: (raw.artists || []).map((item) => ({ id: String(item.id), name: item.name })),
        album: raw.album?.name,
        albumID: raw.album?.id ? String(raw.album.id) : undefined,
        cover: raw.album?.picUrl,
        duration: Number(raw.dt) || undefined,
        extensions: {},
    };
}
```

分页：

- 请求使用 `offset`，插件自己换算成 page/cursor。
- `rawCount` 是本页实际返回数，不是累计值。
- `more` 必须诚实；没有可靠 total 时用 `rawCount >= pageSize` 或上游 hasMore。
- 空页必须 `more=false`。

平台特有字段放 `extensions`，不要污染 `Track` 顶层。

## 7. 逐 operation 实现

建议顺序：

1. `search` / `suggest` / `songs` / `detail`
2. `playback` / `preview` / `lyrics`
3. `account` / `loginBegin` / `loginPoll` / `loginCancel`
4. `userPlaylists` / `likedIDs` / `likedSongs` / `likedAlbums` / `likedState`
5. `discover` / `categories`
6. `mutate`
7. `comments` / `commentReplies`
8. 平台扩展（MV、wiki 等）

每加一个 operation，就同步：

- `manifest.operations`
- `manifest.capabilities`
- 对应的统一模型
- 测试/固定回包
- 错误路径

空结果要返回空 `Page` 或 `null`，不要返回 `undefined`。

## 8. 登录与凭据

二维码登录：

- `loginBegin` 返回 `{ token, qrText?, qrImage?, pollIntervalMs? }`。
- `loginPoll` 返回 `{ code?, status?, account?, message? }`，`status` 为
  `waiting` / `scanned` / `confirmed` / `expired`。
- 确认后 Host 调用 `account()` 验证；成功后通过 `host.acceptCookies` 写回。

短信登录：

- manifest `login.methods[].flow.send` / `flow.submit` 指定 operation，默认 `loginSms` / `loginSubmit`。
- `phonePattern`、`flow.codePattern`、`resendCooldownMs` 由 Qt 读取。

规则：

- 每个 provider 独立存储 cookie/secret；插件只能看到自己的切片。
- 认证过期加 `authExpired: true`。
- 写操作不自动重试；未确认的写入标记 `verification: 'unconfirmed'`。
- 不依赖 `host.authenticated()` 做安全判断；它只是 manifest auth 表达式的结果。

## 9. 评论（只读）

评论是插件声明的两个 operation：

```text
comments(track, id, sort, page, cursor?) -> CommentsPage
commentReplies(track, id, parentCommentId, cursor?, limit?) -> CommentReplies
```

manifest：

```json
{
    "capabilities": { "comments": true },
    "operations": { "comments": true, "commentReplies": true }
}
```

返回示例：

```js
async comments(track, id, sort = 'hot', page = 0, cursor = '') {
    const body = await this.request('/comment/list', { id, sort, page, cursor });
    return {
        comments: (body.comments || []).map(commentItem),
        totalCount: Number(body.total) || 0,
        hasMore: Boolean(body.hasMore),
        cursor: body.cursor ? String(body.cursor) : undefined,
    };
}
```

`CommentItem` 至少 `{ id, content, nickname }`。分页、楼层去重、空页和 `hasMore` 必须明确。
没有实现评论就不要声明评论能力；客户端会隐藏入口。

## 10. 打包与发布

1. 构建 `plugin.cjs`，确认 `manifest.entry.sha256` / `size` 已更新。
2. 检查 `manifest.files[]` 覆盖所有运行时文件。
3. 把插件目录放进市场 `plugins/<id>/`。
4. 在 `index.json` 添加条目，`version`、`entry`、`files` 与插件目录一致。
5. 运行市场检查。

```bash
node scripts/check-marketplace.cjs /Users/mikequ/Desktop/RhineMarket/index.json
```

市场安装不验签、不校验哈希、不做版本信任链；只校验 manifest 结构、id、相对路径和入口存在性。
`files[]` 漏文件会导致安装后运行失败。

## 11. 测试

最小验证：

```bash
node scripts/check-plugin-contracts.cjs --enforce
node scripts/check-contract-freeze.cjs
node scripts/check-packaged-bridge.cjs output/resources/MusicBridge
node scripts/check-marketplace.cjs /Users/mikequ/Desktop/RhineMarket/index.json
```

worker IPC smoke：

```bash
printf '%s\n' '{"id":"1","route":"/native/<id>/search","params":{"args":["hello","song",0]},"cookies":{}}' \
  | RHINE_USER_PLUGINS="$PWD/plugins" node MusicBridge/worker.cjs
```

插件自身至少覆盖：

- 第一页、第二页、空页、`more` 终止；
- 每个 operation 的参数位置和返回模型；
- 登录成功/失败/过期/取消；
- 播放 tier、试听/受限/无 URL；
- 歌词 `null` 与有歌词；
- mutation `applied` 与未确认写入；
- 评论分页、楼层、空结果；
- 错误路径不泄漏 cookie/token。

## 12. 常见错误

1. 把 native operation 参数当对象接收；实际是位置参数。
2. `manifest.operations` 与入口实现不一致。
3. `Page.rawCount` 返回累计值，导致 UI 跳页。
4. 空结果仍 `more=true`，导致无限请求。
5. 直接返回上游对象；模型校验会拒绝，平台字段会泄漏到 UI。
6. 把上游布尔参数原样传透；部分上游只接受字符串 `"true"/"false"`。
7. 过度过滤 cookie，把 CSRF cookie 删掉。
8. 搜索/详情成功后被一次封面补全失败拖垮整个请求。
9. 播放 URL 是 HTTP，但 manifest 声明 HTTPS-only，移动端 ATS 拦截。
10. 写操作没有 `applied`，失败后没有 `verification: 'unconfirmed'`。
11. 依赖 `host.authenticated()` 做安全判断。
12. 依赖 core 调用 `dispose()` 做每请求清理。
13. 在插件里读取其他 provider 的 cookie，或把 token 写进错误消息。
14. 把平台名称/文案/资产放进主仓库；应放在插件目录或本地 `docs/PLUGIN/`。
15. 在插件里使用 `\p{...}` 正则；移动端 libnode 没有完整 ICU，插件加载阶段就会失败。

## 13. 验收清单

- [ ] 上游依赖只在插件目录，core 产物不含平台协议/资产。
- [ ] manifest 2.0、operations/capabilities/实现一致。
- [ ] 所有 native operation 返回统一模型。
- [ ] 分页、空页、错误、认证过期都有明确行为。
- [ ] 插件入口不写 stdout/stderr，不读取其他 provider 凭据。
- [ ] `plugin.cjs` 自包含，`files[]` 完整。
- [ ] 市场索引和插件目录一致，`check-marketplace` 通过。
- [ ] 只读 smoke 通过；有真实账号时再做受控写操作验证。
