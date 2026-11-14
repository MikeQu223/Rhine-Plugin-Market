# Rhine 插件包要求

本文件是插件作者提交到 Rhine Plugin Market 的最小要求。完整契约以
`MusicBridge/plugins/sdk/README.md`、`port.d.ts` 和 `manifest.schema.json` 为准；本文件只列发布前必须满足的项。

当前契约：

- `manifest.schemaVersion`：`2`
- `manifest.apiVersion`：`2.0`
- `requiresHost`：建议 `>=2.0 <3.0`
- 运行时：桌面 bundled Node；移动端 libnode 18
- 入口：CommonJS 单文件 `plugin.cjs`

## 1. 包结构

```text
plugins/<id>/
  manifest.json          # 必需，运行时与展示元数据
  plugin.cjs             # 必需，manifest.entry.file
  LICENSE                # 建议必需
  THIRD-PARTY-NOTICES.md # 建议
  sbom.cdx.json          # 建议
  ...                    # 上游运行所需的额外文件
```

市场索引：

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
            "files": ["LICENSE", "THIRD-PARTY-NOTICES.md", "assets/quality/sq.png"]
        }
    ]
}
```

`files` 必须列出除 `manifest.json` 之外所有需要下载的运行时文件。市场校验会反向遍历插件目录，
拒绝未列出的文件。源码、测试、构建脚本不要写进 `files`。

## 2. manifest 必填字段

`schemaVersion`、`apiVersion`、`id`、`version`、`entry` 是 schema 必填项。实际能被客户端正确展示和使用的插件，
还应声明：

| 字段 | 要求 |
| --- | --- |
| `id` | `^[a-z0-9-]{1,40}$`，全局唯一；同时用于凭据切片、路由和缓存命名空间 |
| `version` | 语义化版本，例如 `1.2.0` |
| `entry.file` | 必须存在，通常是 `plugin.cjs` |
| `entry.sha256` / `entry.size` | 构建器生成；客户端不做信任校验，仅作元数据 |
| `files[]` | 所有运行时文件；市场下载与校验使用 |
| `display.name` / `display.label` / `display.detail` | 客户端展示；`display.default` 只能有一个插件声明 |
| `capabilities` | UI 功能门控；声明了就必须真的可用 |
| `operations` | 运行时 operation 白名单；声明了就必须实现 |
| `runtime.sourceEntry` | 可选；常规构建器据此生成 `plugin.cjs`，由独立构建脚本处理的包可省略 |
| `quality` | 音质选项；`id` 不透明，`tier` 使用统一档位 |
| `library` | 资料库栏位、喜欢的模型、歌单编辑规则 |
| `login` | 登录方式、轮询、失败文案 |
| `credentials` | 凭据命名空间、注入/回写、auth 表达式、legacy 迁移 |
| `media` | 播放/封面 host、scheme 策略、封面 transform |
| `cache` | TTL、磁盘缓存 operation、版本、最大条目 |
| `routes` | 需要原始路由时的 prefix/legacy 声明 |

最小示例：

```json
{
    "schemaVersion": 2,
    "apiVersion": "2.0",
    "id": "example",
    "version": "1.0.0",
    "publisher": "Example Lab",
    "requiresHost": ">=2.0 <3.0",
    "entry": { "file": "plugin.cjs" },
    "runtime": { "hosting": ["module"], "sourceEntry": "index.mjs", "bundled": true },
    "display": {
        "name": "Example Music",
        "label": "EXAMPLE",
        "detail": "示例来源",
        "order": 50
    },
    "capabilities": {
        "search": true,
        "detail": true,
        "playback": true,
        "lyrics": true
    },
    "operations": {
        "search": true,
        "songs": true,
        "detail": true,
        "playback": true,
        "lyrics": true
    },
    "quality": {
        "default": "standard",
        "options": [
            { "id": "standard", "label": "标准", "tier": "standard" },
            { "id": "lossless", "label": "无损", "tier": "lossless" }
        ]
    }
}
```

## 3. operations

插件入口必须按 `manifest.operations` 建立白名单，未声明或未实现的 operation 抛 400 结构化错误，
不能静默回退到其他 provider。常用 operation：

| operation | 参数 | 返回 |
| --- | --- | --- |
| `search` | `(text, kind, offset)` | `Page<MusicEntity>` |
| `suggest` | `(text)` | `string[]` |
| `resolveLink` | `(text)` | `EntityRef \| null` |
| `songs` | `(ids: string[])` | `Track[]` |
| `detail` | `(ref: EntityRef)` | `[MusicEntity, Track[], string[]]` |
| `artistAlbums` | `(id, offset)` | `Page<Album>` |
| `trackPage` | `(ref, offset)`，歌手页使用 `kind=artist` | `Page<Track>` |
| `catalog` | `()` | `Page<MusicEntity>` |
| `playback` | `(track, qualityId, alternative)` | `PlaybackSource` |
| `preview` | `(track, qualityId, alternative)` | `PlaybackSource` |
| `lyrics` | `(track)` | `LyricsDocument \| null` |
| `account` | `()` | `Account \| null` |
| `loginBegin` | `(method)` | `{ token, qrText?, qrImage?, pollIntervalMs? }` |
| `loginPoll` | `(token)` | `{ code?, status?, account?, message? }` |
| `loginCancel` | `(token?)` | 任意 |
| `loginSms` | `(phone)` | 任意 |
| `loginSubmit` | `(phone, code)` | 任意 |
| `logout` | `()` | 任意 |
| `userPlaylists` | `(uid?)` | `Page<Playlist>` |
| `likedIDs` | `(uid?)` | `string[]` |
| `likedSongs` | `(offset?)` | `Page<Track>` |
| `likedAlbums` | `(offset?)` | `Page<Album>` |
| `likedState` | `(ids, uid?)` | `Record<string, LikeState>` |
| `discover` | `(tab, offset?, category?)` | `Page<MusicEntity>` |
| `categories` | `()` | `{ id, name }[]` |
| `mutate` | `(route, values)` | `MutationResult` |
| `comments` | `(track, id, sort, page, cursor?)` | `CommentsPage` |
| `commentReplies` | `(track, id, parentCommentId, cursor?, limit?)` | `CommentReplies` |
| `vip` | `()` | `VipStatus` |
| `request` | `(route, params)` | 原始上游 body（不做模型校验） |

平台扩展 operation（例如 MV）可以保留，但必须写进 `manifest.operations`，并在 Qt 侧有对应消费方。

## 4. 运行时入口

```ts
export interface PluginModule {
    create(host: PluginHost, options?: Record<string, unknown>): PluginRuntime | Promise<PluginRuntime>;
}

export interface PluginRuntime {
    dispatchNative(operation: string, args: unknown[]): Promise<unknown>;
    dispatchRoute?(route: string, params?: Record<string, unknown>): Promise<unknown>;
    capabilities?(): Promise<ProviderCapabilities>;
    dispose?(): Promise<void>;
}
```

必须遵守：

- `create(host)` 每次请求都会重新调用；不要依赖跨请求单例，`create` 应轻量。
- `dispatchNative` 的 `args` 是位置参数，不是对象。
- 不要直接写 stdout/stderr；worker 的 stdout 是 JSON-line IPC。诊断只能用 `host.diagnostics.record`。
- 不读取其他 provider 的 cookie/secret；不把 cookie、token、原始 URL 写进日志、诊断或错误消息。
- `dispose()` 不是每请求清理钩子；需要跨请求缓存时放在模块级或 transport 单例。
- 不得使用 RegExp Unicode 属性转义（`\p{...}` / `\P{...}`，含字符串形式）：移动端 libnode 没有完整 ICU，
  插件会在加载阶段被判 `plugin.load-failed`。需要 UTF-8 校验时用 `node:buffer` 的 `isUtf8`，
  不要依赖 `TextDecoder` 的 `fatal` 选项。

## 5. 统一模型

worker 会在 native operation 返回后调用 `models.cjs` 校验；返回原始上游对象会被拒绝。

### Entity

必填 `provider`、`kind`、`id`、`key`、`title`、`artist`、`artists[]`：

- `provider` 必须等于插件 id。
- `kind` 为 `song` / `album` / `artist` / `playlist`。
- `key` 必须是 `<provider>:<kind>:<id>`。
- `artists[]` 为 `{ id, name }`，可为空。
- 平台特有字段放 `extensions`，不要污染顶层。

### Page

```ts
interface Page<T> {
    items: T[];
    rawCount: number; // 本页消费的上游原始条目数
    total?: number;
    more: boolean;
    notice?: string;
    incomplete?: boolean;
    category?: string;
    areas?: { id: string; name: string }[];
    area?: number;
}
```

`rawCount` 是本页消费的上游原始条目数，过滤和去重前计数，不是累计值或 `items.length`。
`more=true` 时 `rawCount` 必须大于零；过滤后 `items` 为空但原始消费数大于零时仍可继续分页。
无法可靠判断续页或原始消费数时，返回 `incomplete: true` 或抛出错误，不把部分结果标成完整。

歌手页对声明了 `trackPage` 的来源从 `offset=0` 请求 `kind=artist`，按 `rawCount` 递增并去重；
播放全部前会补齐后续页。请求失败或结果不完整时保留已显示歌曲并允许重试。未声明该 operation
的旧插件继续使用 `detail` 返回的歌曲，不能保证完整。插件应使用上游完整歌曲分页，不能把热门
列表视为完整曲库；排序和实际可读取范围以来源能力为准。如果缓存无法识别不完整响应，应关闭该
operation 的缓存以保证重试有效。

### PlaybackSource

必填 `url` 与 `tier`。`tier` 取值：`auto`、`standard`、`hq`、`lossless`、`hires`、`master`、`original`。
平台内部档位放 `qualityId`、`providerTier` 或 manifest `quality`；core 不做平台音质翻译。

### 歌词、账号、写操作

- 歌词用 `lyrics-format.cjs` 的 `normalizeLyrics` 生成 `LyricsDocument`；没有歌词返回 `null`。
- 未登录的 `account` 返回 `null`。
- `MutationResult` 必须明确 `applied`；未确认的写入标记 `verification: 'unconfirmed'`。
- 错误至少 `{ code, message }`；认证过期加 `authExpired: true`。

### 评论

`comments` 返回 `{ comments, totalCount, hasMore, cursor? }`；`commentReplies` 返回
`{ comments, hasMore, time? }`。`CommentItem` 至少 `{ id, content, nickname }`，可选 `userId`、`avatarUrl`、
`time`、`likedCount`、`replyCount`、`replyTo`、`location`、`inlineReplies`。没有实现评论就不要声明
`operations.comments`。

## 6. 凭据与媒体安全

- Host 按 provider 切片保存 `providers.<id>.cookies` / `secrets`；插件只能看到自己的切片。
- 登录成功后用 `host.acceptCookies(...)` 写回；认证过期用 `authExpired`。
- 需要跨 cookie 保存的私有状态用 manifest `credentials.responseSecrets`；需要注入的用 `credentials.inject`。
- 媒体 URL 必须落在 manifest `media.hosts` / `alternativeHosts` 内；封面落在 `media.coverHosts`。
- `media.allowHttp` / `schemePolicy` 必须与真实 URL 一致；移动端 ATS 会拦截 HTTP。
- 不签名、不校验哈希、不做信任链；只校验 manifest 结构、id、相对路径和入口存在性。

## 7. 发布前验证

在主仓库根目录运行：

```bash
node scripts/check-contract-freeze.cjs
node scripts/check-plugin-contracts.cjs --enforce
node scripts/check-provider-literals.cjs --enforce
node scripts/check-marketplace.cjs /Users/mikequ/Desktop/RhineMarket/index.json
```

插件自身至少覆盖：

- manifest 通过 Registry/schema 校验；
- 每个 operation 的参数位置、返回模型、空结果和错误；
- 分页第二页、空页、`more` 终止；
- 登录成功/失败/过期/取消；
- 播放 tier、试听/受限/无 URL；
- 歌词 `null` 与有歌词；
- mutation 的 `applied` 与未确认写入；
- 错误路径不泄漏 cookie/token；
- `runtime.mobileBundled` 插件入口不含 `\p{...}`（`check-marketplace.cjs` 会拦截）。

## 8. 验收清单

- [ ] `manifest.json` 的 `schemaVersion` 是 `2`，`apiVersion` 是 `2.0`。
- [ ] `id` 唯一且符合 `^[a-z0-9-]{1,40}$`。
- [ ] `entry.file` 存在，`files[]` 覆盖所有运行时文件。
- [ ] `manifest.operations`、`capabilities`、实际实现三者一致。
- [ ] `plugin.cjs` 是自包含 CommonJS，不依赖发布目录里的 `node_modules`。
- [ ] 所有 native operation 返回统一模型，平台字段放 `extensions`。
- [ ] 分页、空页、错误、认证过期路径都有明确行为。
- [ ] 没有把 cookie/token/原始认证记录写进日志或错误消息。
- [ ] 市场 `index.json` 的 `version`、`entry`、`files` 与插件目录一致。
- [ ] `check-marketplace` 通过。
