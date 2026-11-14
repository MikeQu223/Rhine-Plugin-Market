# 案例：从上游 API 仓库到 NetEase 插件

本文件以市场中的 `plugins/netease/` 为例，说明一个平台插件如何从上游 Node API 包适配到 Rhine 契约。
当前版本：`2.1.1`，manifest `schemaVersion: 2`、`apiVersion: "2.0"`。

> 平台协议、上游依赖和平台资产只存在于独立插件仓库；主仓库 core 不含这些内容。
> 通用契约见 [插件包要求](PLUGIN-REQUIREMENTS.md) 和 [适配器开发指南](ADAPTER-GUIDE.md)。

## 1. 目标

把一个上游 Node API 包适配成 Rhine 插件，需要完成四件事：

1. **隔离**：上游包、协议代码、平台字段、平台资产只存在于插件目录。
2. **收口**：插件对外只暴露统一 native operation 和统一数据模型；Qt 不感知上游路由。
3. **归一化**：cookie、错误、分页、音质、歌词、登录状态都转换成 Rhine 模型。
4. **可发布**：打成单文件 `plugin.cjs`，manifest 的 `entry/files` 与市场 `index.json` 完整一致。

请求链路：

```text
Qt /native/netease/<operation>
  → worker PluginRegistry.load("netease")
  → plugin.cjs create(host)
  → sources/netease/index.mjs 组合兼容基底与分页适配层
  → 歌手歌曲：artist-songs.cjs → 上游 artist_songs module
  → 其他操作：legacy.cjs 中的原有适配器与 transport
  → 上游 HTTP，插件内归一化
  → models.cjs 校验
  → Host
```

## 2. 上游仓库盘点

| 上游 | 作用 | 打包方式 |
| --- | --- | --- |
| `@neteasecloudmusicapienhanced/api` | 搜索、详情、播放、歌词、登录、写操作 | esbuild 打进 `plugin.cjs` |
| `@neteasecloudmusicapienhanced/unblockmusic-utils` | 替代音源模块 | 传递依赖，构建时打入 |
| `upstream/auth.js` / `upstream/user.js` | 登录/用户 VM 脚本 | 作为运行时文件发布 |
| `jsdom` 的 `xhr-sync-worker.js` | 上游同步 XHR 依赖 | 单独 esbuild 发布 |
| `data/china_ip_ranges.txt` | 上游网络分流数据 | 作为运行时资产发布 |

关键原则：不要把上游 HTTP 服务原样跑起来。优先直接 require 上游 module，把 cookie、请求函数和参数显式传入。
这样插件能控制类型、错误和凭据边界，也不会额外暴露本地端口。

## 3. 市场目录

```text
sources/netease/              # 构建源码，不随插件下载
  index.mjs / artist-songs.cjs / build.cjs
  legacy.cjs                  # 校验摘要的原插件兼容基底
plugins/netease/              # 市场运行时文件
  manifest.json
  plugin.cjs                 # 构建产物，约 11 MB
  upstream/auth.js
  upstream/user.js
  upstream/source.json
  upstream/LICENSE
  modules/*.js               # 发布用占位文件
  data/china_ip_ranges.txt
  xhr-sync-worker.js
  assets/quality/*.png
  LICENSE / LyricsKit-LICENSE
  THIRD-PARTY-NOTICES.md
  sbom.cdx.json
```

`manifest.files[]` 必须列出以上所有运行时文件。市场安装按 `files[]` 逐文件下载；漏掉 `upstream/*`、
`xhr-sync-worker.js`、`data/*` 或 `assets/*` 会让插件安装后运行失败。

## 4. manifest 2.0 关键片段

```json
{
    "schemaVersion": 2,
    "apiVersion": "2.0",
    "id": "netease",
    "version": "2.1.1",
    "requiresHost": ">=2.0 <3.0",
    "entry": { "file": "plugin.cjs" },
    "runtime": { "hosting": ["module"], "bundled": true },
    "operations": {
        "search": true,
        "suggest": true,
        "resolveLink": true,
        "songs": true,
        "detail": true,
        "artistAlbums": true,
        "trackPage": true,
        "playback": true,
        "lyrics": true,
        "account": true,
        "loginBegin": true,
        "loginPoll": true,
        "loginCancel": true,
        "loginSms": true,
        "loginSubmit": true,
        "likedIDs": true,
        "likedSongs": true,
        "likedAlbums": true,
        "likedState": true,
        "mutate": true,
        "comments": true,
        "commentReplies": true,
        "mv": true,
        "mvVersions": true,
        "request": true
    },
    "capabilities": {
        "search": true,
        "suggest": true,
        "resolveLink": true,
        "detail": true,
        "playback": true,
        "lyrics": true,
        "account": true,
        "login": true,
        "discover": true,
        "categories": true,
        "userPlaylists": true,
        "likedSongs": true,
        "likedAlbums": true,
        "mv": true,
        "officialPlayback": true,
        "alternativeSource": true,
        "comments": true
    },
    "credentials": {
        "namespace": "netease",
        "shape": "opaque",
        "auth": {
            "anyOf": [{ "cookie": "MUSIC_U" }],
            "expiredCodes": [301, 401]
        },
        "legacy": { "default": true }
    },
    "media": {
        "hosts": ["music.126.net", "*.music.126.net", "music.163.com", "*.music.163.com"],
        "coverHosts": ["music.126.net", "*.music.126.net", "music.163.com", "*.music.163.com"],
        "allowHttp": false,
        "schemePolicy": "https"
    }
}
```

## 5. 入口与 transport

当前入口组合兼容基底和歌手歌曲分页适配层。下例仅展示一般分派模式，不是当前入口源码：

```js
export function create(host) {
    const operations = new Set(
        Object.entries(host.manifest.operations || {})
            .filter(([, enabled]) => enabled)
            .map(([name]) => name),
    );
    const api = new API(host);
    return {
        async dispatchNative(operation, args) {
            if (!operations.has(operation)) {
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

兼容基底的 transport 维护“插件 route → 上游 module”白名单，例如：

```js
const routes = Object.freeze({
    '/search': 'search',
    '/song/detail': 'song_detail',
    '/song/url/v1': 'song_url_v1',
    '/lyric': 'lyric',
    '/comment/new': 'comment_new',
    '/comment/floor': 'comment_floor',
});
```

只 require 需要的 module；不要引入上游整个 server/中间件。
歌手歌曲分页由 `sources/netease/artist-songs.cjs` 单独调用锁定版本的 `artist_songs` 模块，
复用兼容基底的请求实现和歌曲映射，不修改上游模块。`detail` 仍可返回热门歌曲作为兼容数据；
支持分页的本体从第零页加载全部歌曲。接口按热门顺序排列不意味着只返回热门歌曲。

## 6. 条目归一化

上游对象不能直接返回；先映射成统一模型：

```js
function track(raw) {
    return {
        provider: 'netease',
        kind: 'song',
        id: String(raw.id),
        key: `netease:song:${raw.id}`,
        title: raw.name || '',
        artist: (raw.ar || []).map((item) => item.name).join(' / '),
        artists: (raw.ar || []).map((item) => ({ id: String(item.id), name: item.name })),
        album: raw.al?.name,
        albumID: raw.al?.id ? String(raw.al.id) : undefined,
        cover: raw.al?.picUrl,
        duration: Number(raw.dt) || undefined,
        extensions: {},
    };
}
```

分页时 `rawCount` 是本页消费的原始数量，不是过滤后的歌曲数。既没有可靠 `more` 也没有可靠 `total` 时返回
`incomplete: true`，本体保留已显示的内容并允许重试。此插件的 `trackPage` 不配置缓存，避免不完整
结果阻止重试。

## 7. 播放与音质

- manifest `quality.options[]` 定义平台档位，`tier` 归一化为统一档位。
- 播放结果返回 `PlaybackSource`：`url`、`tier`、`bitrate`、`size`、`type` 等。
- 平台内部档位放 `qualityId` / `providerTier`；core 不做平台音质翻译。
- 替代音源由 `alternativeSource` 声明；没有 URL 时返回结构化错误，不要返回空对象。
- HTTP URL 在 `media.allowHttp: false` 下会被拒绝；移动端 ATS 也会拦截。

## 8. 登录与凭据

- 凭据是 provider 私有的 opaque 切片；插件只能看到 `netease` 命名空间。
- 二维码：`loginBegin` 返回 `token/qrText/qrImage`；`loginPoll` 返回 `waiting/scanned/confirmed/expired`。
- 短信：`loginSms` / `loginSubmit`；manifest `login.methods[].flow` 指定 operation。
- 登录成功后 `host.acceptCookies(...)` 写回；`MUSIC_U` 失效时 `expiredCodes: [301, 401]` 触发 `authExpired`。
- 不要把 cookie/token 写进错误消息、日志或诊断字段。

## 9. 评论（2.1.0）

网易云插件实现了两个只读 operation：

```text
comments(track, id, sort, page, cursor?) -> CommentsPage
commentReplies(track, id, parentCommentId, cursor?, limit?) -> CommentReplies
```

实现要点：

- 上游 `/comment/new` → `comment_new`，`/comment/floor` → `comment_floor`。
- 在插件内把 `commentId`、`user`、`content`、`beReplied`、`ipLocation` 等字段映射成 canonical `CommentItem`。
- 返回 `{ comments, totalCount, hasMore, cursor }` / `{ comments, hasMore, time }`。
- `sort` 由 `hot` / `new` 映射到上游参数；分页和 cursor 由插件解释。
- 楼层回复去重；没有更多时 `hasMore=false`。
- 这些 operation 不写任何状态，不触发登录或写操作。

## 10. 构建与发布

```bash
node scripts/build-artist-plugins.cjs
node --test scripts/test-artist-plugins.cjs
node ../RhineMusicPanel/scripts/check-marketplace.cjs index.json
```

发布前确认：

- `manifest.entry.sha256` / `size` 已由市场构建脚本回写，兼容基底摘要已校验。
- `manifest.files[]` 覆盖所有运行时文件。
- 市场 `index.json` 的 `version`、`entry`、`files` 与插件目录一致。
- 插件目录不依赖 `node_modules`。
- `plugin.cjs` 是自包含 CommonJS，Node 18 可加载。

## 11. 实际踩坑

1. **cookie 过滤过度**：过滤所有 `__*` 会删掉 CSRF cookie，写操作失败。只过滤插件私有键和其他 provider 的 session。
2. **XEAPI 密钥**：部分请求需要先注册公钥；上游还会读取 `$TMPDIR/anonymous_token`，启动时必须先创建 0600 文件。
3. **多文件发布**：市场按 `files[]` 下载，漏 `xhr-sync-worker.js` 或 `upstream/*` 会在运行时才炸。
4. **上游对象直出**：模型校验会拒绝，平台字段会泄漏到 UI；必须在插件内归一化。
5. **错误码**：认证过期要标 `authExpired`；不要把上游原始响应塞进 `message`。
6. **空结果**：搜索/评论空结果要返回空数组和 `more=false`，否则 UI 会无限请求。
7. **写操作**：不自动重试；未确认的写入标记 `verification: 'unconfirmed'`。
8. **平台资产**：音质 badge、平台文案只放在插件目录，不进入 core。

## 12. 验收清单

- [ ] 上游依赖只在独立插件仓库，core 产物不含平台协议/资产。
- [ ] manifest 2.0，operations/capabilities/实现一致。
- [ ] 搜索、详情、播放、歌词、登录、喜欢、评论逐项 smoke 通过。
- [ ] 分页第二页、空页、`more` 终止有测试。
- [ ] 认证过期、无 URL、受限音质有结构化错误。
- [ ] 评论分页、楼层、空结果有测试。
- [ ] `files[]` 完整，市场索引一致，`check-marketplace` 通过。
- [ ] 错误路径不泄漏 cookie/token。
