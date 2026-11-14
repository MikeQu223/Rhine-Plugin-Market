// 波点插件本地回归：只覆盖映射、分页与错误路径，不发真实网络请求。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { BodianApi } from './adapter.mjs';
import { aiPlaylistOf, albumOf, commentOf, playlistOf, trackOf } from './items.mjs';
import { signKpk, signQuery } from './transport.mjs';

function host() {
    return {
        manifest: { operations: {} },
        cookies: () => ({}),
        acceptCookies() {},
    };
}

function transport(routes, options = {}) {
    const calls = [];
    return {
        calls,
        session: () => options.session || { uid: '', token: '' },
        isSignedIn: () => Boolean(options.session && options.session.uid),
        devid: () => 'device',
        async request(path, request = {}) {
            calls.push({
                path,
                query: request.query || {},
                signed: request.signed === true,
                native: request.native === true,
                kpk: request.kpk === true,
                method: request.method || 'GET',
                body: request.body,
            });
            const handler = routes[path];
            if (!handler) {
                throw new Error('unexpected path ' + path);
            }
            if (typeof handler === 'function') {
                return handler(request);
            }
            return handler;
        },
        async lyric() {
            return options.lyric || '';
        },
    };
}

test('音质重点卡只保留臻品2.0和全景声，母带回落普通列表', () => {
    const manifest = JSON.parse(
        readFileSync(new URL('../../plugins/bodian/manifest.json', import.meta.url), 'utf8'),
    );
    assert.deepEqual(manifest.quality.featured, ['zhenpin', 'spatial']);
    assert.ok(manifest.quality.options.some((option) => option.id === 'master'));
});

test('歌曲映射保留毫秒时长与业务键', () => {
    const track = trackOf({
        id: 228908,
        name: '晴天',
        album: '叶惠美',
        albumId: 1293,
        albumPic: 'http://img4.kuwo.cn/a.webp',
        artists: [{ id: 336, name: '周杰伦' }],
        duration: 269,
        payInfo: { feeType: { vip: '1' } },
    });
    assert.equal(track.key, 'bodian:song:228908');
    assert.equal(track.duration, 269000);
    assert.equal(track.artist, '周杰伦');
    assert.equal(track.cover, 'https://img4.kuwo.cn/a.jpg');
    assert.equal(track.extensions.vip, true);
});

test('歌单 id 带上游 source，专辑 id 用专辑号', () => {
    const playlist = playlistOf({ id: 2458058382, source: 4, name: '纯音乐' });
    assert.equal(playlist.id, 'pl-4-2458058382');
    assert.equal(playlist.key, 'bodian:playlist:pl-4-2458058382');
    const album = albumOf({ albumId: 1293, id: 228908, name: '叶惠美' });
    assert.equal(album.id, '1293');
});

test('空内容评论被丢弃', () => {
    assert.equal(commentOf({ id: 1, content: '   ' }), null);
    const comment = commentOf({
        id: 2,
        content: '好听',
        userInfo: { id: 9, nickname: '听众' },
        publishTime: '21-12-13 17:59',
        likeCount: 4,
    });
    assert.equal(comment.nickname, '听众');
    assert.equal(comment.likedCount, 4);
    assert.ok(comment.time > 0);
});

test('空关键词返回空页', async () => {
    const api = new BodianApi(host(), transport({}));
    const page = await api.search('  ', 'song', 0);
    assert.deepEqual(page, { items: [], rawCount: 0, more: false });
});

test('搜索第二页把 offset 换成 pn，并按 total 终止', async () => {
    const fake = transport({
        'search/music/list': () => ({
            resultList: [{ id: 2, name: '第二页' }],
            total: 31,
        }),
    });
    const api = new BodianApi(host(), fake);
    const page = await api.search('关键词', 'song', 30);
    assert.equal(fake.calls[0].query.pn, 1);
    assert.equal(page.rawCount, 1);
    assert.equal(page.more, false);
});

test('播放按格式归一等档位', async () => {
    const fake = transport({
        'play/music/v2/audioUrl': () => ({
            audioUrl: 'http://bd-er.kuwo.cn/a.mp3',
            audioHttpsUrl: 'https://bd-er.kuwo.cn/a.mp3',
            format: 'mp3',
            bitrate: 128,
            size: '4Mb',
        }),
    });
    const api = new BodianApi(host(), fake);
    const source = await api.playback({ kind: 'song', id: '294814' }, 'standard');
    assert.equal(source.tier, 'standard');
    assert.equal(source.url, 'https://bd-er.kuwo.cn/a.mp3');
    assert.equal(source.size, 4194304);
});


test('会员臻品请求根据目录 zp 档位识别为臻品音源', async () => {
    const fake = transport(
        {
            'service/music/info': () => ({
                id: 647975305,
                audios: [
                    { level: 'ff', format: 'flac', bitrate: '2000', size: '10.12Mb' },
                    { level: 'zp', format: 'zp', bitrate: '20000', size: 'zpMb' },
                ],
            }),
            'play/music/v2/audioUrl': () => ({
                audioHttpsUrl: 'https://bd-er.kuwo.cn/zp.flac',
                format: 'flac',
                bitrate: 2000,
                size: '10.12Mb',
            }),
        },
        { session: { uid: '1', token: 'token' } },
    );
    const api = new BodianApi(host(), fake);
    const source = await api.playback({ kind: 'song', id: '647975305' }, 'zhenpin');
    assert.equal(source.tier, 'hires');
    assert.equal(source.providerTier, 'zhenpin');
    assert.equal(source.qualityFallback, undefined);
    assert.equal(source.format, 'flac');
    assert.equal(source.providerFormat, 'zp');
    assert.equal(source.url, 'https://bd-er.kuwo.cn/zp.flac');
    assert.equal(fake.calls[0].path, 'service/music/info');
    assert.equal(fake.calls[0].native, true);
    assert.equal(fake.calls[1].path, 'play/music/v2/audioUrl');
    assert.equal(fake.calls[1].kpk, true);
    assert.equal(fake.calls[1].query.format, 'zp');
    assert.equal(fake.calls[1].query.br, '20000');
});

test('选择标准档不会把目录 zp 档位用于标准播放', async () => {
    const fake = transport(
        {
            'service/music/info': () => ({
                id: 1,
                audios: [
                    { level: 'h', format: 'mp3', bitrate: '128' },
                    { level: 'zp', format: 'zp', bitrate: '20000' },
                ],
            }),
            'play/music/v2/audioUrl': () => ({
                audioHttpsUrl: 'https://bd-er.kuwo.cn/standard.mp3',
                format: 'mp3',
                bitrate: 128,
            }),
        },
        { session: { uid: '1', token: 'token' } },
    );
    const api = new BodianApi(host(), fake);
    const source = await api.playback({ kind: 'song', id: '1' }, 'standard');
    assert.equal(source.providerTier, 'standard');
    assert.equal(source.url, 'https://bd-er.kuwo.cn/standard.mp3');
    assert.equal(fake.calls[1].query.format, 'mp3');
    assert.equal(fake.calls[1].query.br, '128kmp3');
});

test('没有播放地址时返回结构化错误', async () => {
    const fake = transport({
        'play/music/v2/audioUrl': () => ({}),
    });
    const api = new BodianApi(host(), fake);
    await assert.rejects(
        () => api.playback({ kind: 'song', id: '228908' }, 'high'),
        (error) => error.code === 403,
    );
});

test('歌词为空返回 null，有 LRC 时归一化', async () => {
    const empty = new BodianApi(host(), transport({}, { lyric: '' }));
    assert.equal(await empty.lyrics({ id: '1' }), null);
    const timed = new BodianApi(
        host(),
        transport({}, { lyric: '[00:01.00]第一句\n[00:03.00]第二句' }),
    );
    const document = await timed.lyrics({ id: '1' });
    assert.equal(document.version, 1);
    assert.equal(document.timing, 'line');
    assert.equal(document.lines.length, 2);
});

test('评论页过滤空内容并保留分页信息', async () => {
    const fake = transport({
        'comments/v3/hot': () => ({
            comment_list: [
                { id: 1, content: '好听', nickname: '甲' },
                { id: 2, content: '', nickname: '乙' },
            ],
            comment_total: 42,
            more: true,
        }),
    });
    const api = new BodianApi(host(), fake);
    const page = await api.comments({ kind: 'song', id: '1' }, '1', 'hot', 0);
    assert.equal(page.comments.length, 1);
    assert.equal(page.totalCount, 42);
    assert.equal(page.hasMore, true);
    assert.equal(fake.calls[0].query.pn, 1);
});

test('AI 歌单用位置序号编码，封面取预览首曲', () => {
    const playlist = aiPlaylistOf(
        {
            title: '潮趣日推',
            subTitle: '「为你量身打造的专属歌单」',
            songs: [{ albumPic: 'http://img4.kuwo.cn/a.webp' }],
        },
        0,
        { moduleId: 1 },
    );
    assert.equal(playlist.id, 'ai-1-0');
    assert.equal(playlist.key, 'bodian:playlist:ai-1-0');
    assert.equal(playlist.title, '潮趣日推');
    assert.equal(playlist.cover, 'https://img4.kuwo.cn/a.jpg');
    const themed = aiPlaylistOf(
        { title: '华文流行极致', passRecName: '0_15', songs: [] },
        0,
        { moduleId: 12 },
    );
    assert.equal(themed.id, 'ai-12-0-0_15');
    assert.equal(themed.extensions.passRecName, '0_15');
});

test('每日推荐优先取首页 AI 歌单', async () => {
    const fake = transport({
        'service/home/aiPlaylistDetail': () => ({
            musicList: [{ id: 1, name: '日推歌曲' }, { id: 2, name: '第二首' }],
        }),
    });
    const api = new BodianApi(host(), fake);
    const page = await api.discover('daily', 0, '');
    assert.equal(page.items.length, 2);
    assert.equal(page.more, false);
    assert.equal(fake.calls[0].query.index, 0);
});

test('猜你想听显示四个官方入口', async () => {
    const api = new BodianApi(host(), transport({}));
    const page = await api.discover('guess', 0, '');
    assert.deepEqual(
        page.items.map((item) => item.title),
        ['私人推荐', '热歌熟悉', '新鲜探索', '我喜欢的'],
    );
    assert.deepEqual(
        page.items.map((item) => item.id),
        ['guess-normal', 'guess-familiar', 'guess-explore', 'guess-favorite'],
    );
});

test('推荐歌单同时包含个性化歌单和主题歌单', async () => {
    const fake = transport({
        'service/home/module': ({ query }) => {
            if (query.moduleId === 1) {
                return {
                    moduleName: '个性化歌单',
                    songList: [{ title: '潮趣日推', songs: [] }],
                };
            }
            if (query.moduleId === 12) {
                return {
                    moduleName: '你的主题歌单',
                    songList: [{ title: '华文流行极致', passRecName: '0_15', songs: [] }],
                };
            }
            return { moduleName: '宝藏歌单库', songList: [] };
        },
    });
    const api = new BodianApi(host(), fake);
    const page = await api.discover('playlists', 0, '');
    assert.deepEqual(
        page.items.slice(0, 2).map((item) => item.id),
        ['ai-1-0', 'ai-12-0-0_15'],
    );
    assert.equal(page.items[1].extensions.section, '你的主题歌单');
});

test('主题歌单详情把 passRecName 传给上游', async () => {
    const fake = transport({
        'service/home/aiPlaylistDetail': () => ({
            title: '华文流行极致',
            musicList: [{ id: 1, name: '第一首' }],
        }),
    });
    const api = new BodianApi(host(), fake);
    const [playlist] = await api.detail({ kind: 'playlist', id: 'ai-12-0-0_15' });
    assert.equal(fake.calls[0].query.index, 0);
    assert.equal(fake.calls[0].query.passRecName, '0_15');
    assert.equal(playlist.id, 'ai-12-0-0_15');
});

test('私人推荐卡片按推荐模式加载歌曲', async () => {
    const fake = transport({
        'service/music/recommendList': () => ({
            musicList: [{ id: 1, name: '私人推荐歌曲' }],
        }),
    });
    const api = new BodianApi(host(), fake);
    const page = await api.trackPage({ kind: 'playlist', id: 'guess-normal' }, 0);
    assert.equal(page.items.length, 1);
    assert.equal(page.more, true);
    assert.equal(fake.calls[0].query.recoMode, 'normal');
    assert.equal(fake.calls[0].query.select_card, 1);
    assert.equal(fake.calls[0].query.scrollNum, 1);
    assert.equal(fake.calls[0].query.repeat_cut, undefined);
});

test('我喜欢的卡片复用账号收藏歌曲', async () => {
    const fake = transport(
        {
            'service/playlist/fond': () => ({ id: 88 }),
            'service/playlist/88/musicList': () => ({
                list: [{ id: 9, name: '收藏歌曲' }],
                total: 1,
            }),
        },
        { session: { uid: '1', token: 'token' } },
    );
    const api = new BodianApi(host(), fake);
    const page = await api.trackPage({ kind: 'playlist', id: 'guess-favorite' }, 0);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].title, '收藏歌曲');
    assert.equal(fake.calls[1].query.source, 5);
});

test('未登录打开我喜欢的卡片时提示登录', async () => {
    const api = new BodianApi(host(), transport({}));
    await assert.rejects(
        () => api.trackPage({ kind: 'playlist', id: 'guess-favorite' }, 0),
        (error) => error.code === 401,
    );
});

test('推荐模式为空时回退到通用推荐流', async () => {
    const fake = transport({
        'service/music/recommendList': ({ query }) => {
            if (query.recoMode) {
                return { musicList: [] };
            }
            return { musicList: [{ id: 3, name: '通用推荐歌曲' }] };
        },
    });
    const api = new BodianApi(host(), fake);
    const page = await api.trackPage({ kind: 'playlist', id: 'guess-explore' }, 0);
    assert.equal(page.items[0].title, '通用推荐歌曲');
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[1].query.pn, 1);
    assert.equal(fake.calls[1].query.recoMode, undefined);
});

test('推荐流按实际返回数量推进下一页', async () => {
    const fake = transport({
        'service/music/recommendList': ({ query }) => {
            if (query.recoMode) {
                return { musicList: [] };
            }
            const page = Number(query.pn);
            return {
                musicList: Array.from({ length: 7 }, (_, index) => ({
                    id: page * 100 + index,
                    name: '歌曲' + page + '-' + index,
                })),
            };
        },
    });
    const api = new BodianApi(host(), fake);
    const first = await api.trackPage({ kind: 'playlist', id: 'guess-normal' }, 0);
    const second = await api.trackPage({ kind: 'playlist', id: 'guess-normal' }, first.items.length);
    assert.equal(second.items[0].title, '歌曲2-0');
    assert.ok(fake.calls.some((call) => call.query.pn === 2));
});

test('收藏专辑从独立专辑收藏目录读取', async () => {
    const fake = transport(
        {
            'service/playlist/userCreate': () => ({ playLists: [] }),
            'service/collect/4/list': () => ({ playLists: [], total: 0 }),
            'service/collect/6/list': () => ({
                albumList: [{ id: 1293, name: '叶惠美', artist: '周杰伦' }],
                total: 1,
            }),
        },
        { session: { uid: '1', token: 'token' } },
    );
    const api = new BodianApi(host(), fake);
    const page = await api.likedAlbums(0);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].id, '1293');
    assert.ok(fake.calls.some((call) => call.path === 'service/collect/6/list'));
});

test('音源签名匹配官方路径与参数算法', () => {
    const params = new URLSearchParams({
        devId: 'abc',
        musicId: '647975305',
        format: 'zp',
        br: '20000kzp',
        freeSign: '',
        uid: '-1',
        token: '',
        timestamp: '123',
    });
    assert.equal(
        signQuery('/api/play/music/v2/audioUrl', params),
        '2dbe2e1cf4bfce6f54d433e56f5adb14',
    );
    const body = JSON.stringify({
        devId: 'abc',
        musicId: '647975305',
        format: 'zp',
        br: '20000kzp',
        freeSign: '',
    });
    assert.equal(
        signQuery('/api/play/music/v2/audioUrl', params, body),
        'b171ba0946035d433b52316e898f3ffe',
    );
});

test('KPK 签名只使用查询字符且不包含请求体', () => {
    const params = new URLSearchParams({
        musicId: '647975305',
        format: 'zp',
        br: '20000kzp',
        uid: '1',
        token: 'token',
        timestamp: '123',
    });
    assert.match(signKpk('/api/play/music/v2/audioUrl', params), /^[a-f0-9]{32}$/);
});

test('高码率无损不会误标为臻品母带', async () => {
    const fake = transport({
        'play/music/v2/audioUrl': () => ({
            audioHttpsUrl: 'https://bd-er.kuwo.cn/master.flac',
            format: 'flac',
            bitrate: 20000,
            size: '81Mb',
        }),
    });
    const api = new BodianApi(host(), fake);
    const source = await api.playback({ kind: 'song', id: '1' }, 'master');
    assert.equal(source.qualityId, 'master');
    assert.equal(source.providerTier, 'lossless');
    assert.equal(source.qualityFallback, 'lossless');
    assert.equal(fake.calls[0].signed, false);
    assert.equal(fake.calls[0].query.format, 'mflac');
    assert.equal(fake.calls[0].query.br, '20900');
});

test('只有上游明确标记 master 时实际档位才显示母带', async () => {
    const fake = transport({
        'play/music/v2/audioUrl': () => ({
            audioHttpsUrl: 'https://bd-er.kuwo.cn/master.flac',
            format: 'flac',
            bitrate: 20000,
            level: 'master',
            size: '81Mb',
        }),
    });
    const api = new BodianApi(host(), fake);
    const source = await api.playback({ kind: 'song', id: '1' }, 'master');
    assert.equal(source.tier, 'master');
    assert.equal(source.providerTier, 'master');
    assert.equal(source.qualityFallback, undefined);
});
