# 第三方声明

本插件是波点音乐（Bodian）的非官方第三方适配器，与平台运营方无任何关联，未获其授权或认可。

## 代码来源

- `mygo-music-bodian`（MIT，Copyright (c) 2026 mygo-music-bodian contributors）：
  本插件的接口路径、参数形态与字段映射以其公开实现为参考改写。
- `MusicBridge/lyrics-format.cjs`（MPL-2.0，改编自 LyricsKit）：
  构建时被打进 `plugin.cjs`，用于把 LRC 归一化为 Rhine 歌词文档。
- 协议行为参考了公开的第三方客户端实现；本仓库未复制 GPL / AGPL 项目的源码。

## 平台声明

波点音乐由北京酷我科技有限公司运营。使用本插件接入其服务可能违反平台用户协议；
插件默认关闭任何绕过账号权限的通道，未登录时只使用官方匿名试听能力。
请通过官方渠道支持正版。
