// 波点插件本地回归：只覆盖映射、分页与错误路径，不发真实网络请求。

import assert from 'node:assert/strict';
import test from 'node:test';

import { BodianApi } from './adapter.mjs';
import { albumOf, commentOf, playlistOf, trackOf } from './items.mjs';

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
            calls.push({ path, query: request.query || {} });
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
    assert.equal(track.cover, 'https://img4.kuwo.cn/a.webp');
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
