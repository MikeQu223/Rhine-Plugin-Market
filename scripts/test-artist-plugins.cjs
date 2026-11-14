'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const panelRoot = path.resolve(process.env.RHINE_PANEL_ROOT || path.join(root, '..', 'RhineMusicPanel'));
const { validate } = require(path.join(panelRoot, 'MusicBridge', 'plugins', 'sdk', 'models.cjs'));

function plugin(id, artistSongs, artistRequest, artistFetcher) {
    const manifest = require(path.join(root, 'plugins', id, 'manifest.json'));
    const entry = require(path.join(root, 'plugins', id, 'plugin.cjs'));
    const cookies = [];
    const host = {
        manifest,
        cookies: () => ({ MUSIC_U: 'fixture', qqmusic_session: 'excluded' }),
        acceptCookies: (value) => cookies.push(value),
        secretState: () => ({}),
        env: () => ({}),
    };
    const transport = {
        configure() {},
        async dispatch() {
            return { body: { code: 200 }, cookies: [] };
        },
    };
    return { instance: entry.create(host, { artistSongs, artistRequest, artistFetcher, transport }), cookies };
}

test('QQ 使用打包的上游接口构建歌手歌曲请求', async () => {
    let observed;
    const source = plugin('qq', undefined, undefined, async (url, options) => {
        observed = { url, payload: JSON.parse(options.body) };
        const songInfo = { mid: 'song1', name: '歌曲', singer: [], album: {} };
        return new Response(JSON.stringify({
            code: 0,
            req_0: { code: 0, data: { songList: [{ songInfo }], totalNum: 1 } },
        }), { status: 200 });
    });
    const page = await source.instance.dispatchNative('trackPage', [{ kind: 'artist', id: 'artist1' }, 0]);
    assert.equal(validate('trackPage', page), true);
    assert.equal(observed.payload.req_0.module, 'musichall.song_list_server');
    assert.equal(observed.payload.req_0.method, 'GetSingerSongList');
    assert.equal(observed.payload.req_0.param.number, 30);
    assert.equal(observed.payload.req_0.param.begin, 0);
    assert.equal(page.items[0].id, 'song1');
    assert.equal(page.more, false);
});

test('网易使用锁定的上游模块生成歌手歌曲请求', async () => {
    let observed;
    const source = plugin('netease', undefined, async (url, data, options) => {
        observed = { url, data, options };
        return { status: 200, body: { code: 200, songs: [], more: false }, cookie: [] };
    });
    const page = await source.instance.dispatchNative('trackPage', [{ kind: 'artist', id: '8' }, 100]);
    assert.equal(validate('trackPage', page), true);
    assert.equal(observed.url, '/api/v1/artist/songs');
    assert.equal(observed.data.id, '8');
    assert.equal(observed.data.offset, 100);
    assert.equal(observed.data.limit, 100);
    assert.equal(observed.options.cookie.MUSIC_U, 'fixture');
});

test('网易分页使用完整歌曲接口并保留原始游标', async () => {
    const calls = [];
    const source = plugin('netease', async (query) => {
        calls.push(query);
        const songs = query.offset === 0
            ? [{ id: 1, name: '第一首', ar: [{ id: 8, name: '歌手' }] }, { id: null }]
            : [{ id: 2, name: '最后一首', ar: [] }];
        return { status: 200, body: { code: 200, songs, more: query.offset === 0 }, cookie: ['a=b'] };
    });
    const first = await source.instance.dispatchNative('trackPage', [{ kind: 'artist', id: '8' }, 0]);
    const last = await source.instance.dispatchNative('trackPage', [{ kind: 'artist', id: '8' }, first.rawCount]);
    assert.equal(validate('trackPage', first), true);
    assert.equal(validate('trackPage', last), true);
    assert.equal(first.rawCount, 2);
    assert.equal(first.items.length, 1);
    assert.equal(first.more, true);
    assert.equal(last.more, false);
    assert.deepEqual(calls.map((value) => value.offset), [0, 2]);
    assert.equal(calls[0].limit, 100);
    assert.equal(calls[0].cookie.qqmusic_session, undefined);
    assert.equal(source.cookies.length, 2);
});

test('QQ 歌手歌曲按上游 30 首分页并转换统一模型', async () => {
    const calls = [];
    const source = plugin('qq', async (query) => {
        calls.push(query);
        const size = query.offset === 0 ? 30 : 1;
        const songs = Array.from({ length: size }, (_, index) => ({
            mid: 'song' + (query.offset + index),
            name: '歌曲',
            singer: [{ mid: 'artist1', name: '歌手' }],
            album: { mid: 'album1', name: '专辑' },
        }));
        return { status: 200, body: { code: 200, songs, total: 31, more: query.offset === 0 } };
    });
    const first = await source.instance.dispatchNative('trackPage', [{ kind: 'artist', id: 'artist1' }, 0]);
    const last = await source.instance.dispatchNative('trackPage', [{ kind: 'artist', id: 'artist1' }, 30]);
    assert.equal(validate('trackPage', first), true);
    assert.equal(validate('trackPage', last), true);
    assert.equal(first.rawCount, 30);
    assert.equal(first.items.length, 30);
    assert.equal(last.rawCount, 1);
    assert.equal(last.more, false);
    assert.deepEqual(calls.map((value) => value.offset), [0, 30]);
    assert.equal(calls[0].limit, 30);
});

test('上游缺少可靠分页信息时不冒充完整结果', async () => {
    const netease = plugin('netease', async () => ({ status: 200, body: { code: 200, songs: [] } }));
    const qq = plugin('qq', async () => ({
        status: 200,
        body: { code: 200, songs: [{ mid: 'song1', name: '歌曲' }], total: 100, more: true },
    }));
    for (const source of [netease, qq]) {
        const page = await source.instance.dispatchNative('trackPage', [{ kind: 'artist', id: '1' }, 0]);
        assert.equal(page.incomplete, true);
        assert.equal(page.rawCount, 0);
    }
});

test('拒绝未声明操作与非歌手分页', async () => {
    const source = plugin('qq', async () => { throw new Error('不应发起请求'); });
    await assert.rejects(source.instance.dispatchNative('trackPage', [{ kind: 'album', id: '1' }, 0]));
});

test('原有详情操作仍由兼容基底处理', async () => {
    for (const id of ['netease', 'qq']) {
        const source = plugin(id);
        const ref = {
            provider: id,
            kind: 'artist',
            id: '8',
            key: id + ':artist:8',
            title: '歌手',
            artist: '',
            artists: [],
        };
        const detail = await source.instance.dispatchNative('detail', [ref]);
        assert.equal(validate('detail', detail), true);
        assert.equal(detail[0].id, '8');
    }
});
