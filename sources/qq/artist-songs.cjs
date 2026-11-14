'use strict';

const PAGE_SIZE = 30;

/** 保留原插件的全部操作，仅为歌手歌曲提供上游的独立分页接口。 */
function wrapCreate(createLegacy, singerSongs, songItem) {
    return function create(host, options) {
        const plugin = createLegacy(host, options);
        const dispatch = plugin.dispatchNative.bind(plugin);
        return {
            ...plugin,
            async dispatchNative(operation, args = []) {
                if (operation !== 'trackPage') {
                    return dispatch(operation, args);
                }
                if (!host.manifest?.operations?.trackPage || args[0]?.kind !== 'artist') {
                    const error = new Error('此来源不支持该曲目分页');
                    error.code = 400;
                    throw error;
                }
                const offset = Math.max(0, Number(args[1]) || 0);
                const request = options?.artistSongs || singerSongs;
                const transportOptions = options?.artistFetcher ? { fetcher: options.artistFetcher } : {};
                const response = await request({ mid: args[0].id, offset, limit: PAGE_SIZE }, transportOptions);
                if (response.status !== 200 || response.body?.code !== 200) {
                    const error = new Error('读取歌手歌曲失败');
                    error.code = response.status || 503;
                    throw error;
                }
                const body = response.body;
                const raw = Array.isArray(body.songs) ? body.songs : [];
                const hasTotal = Number.isSafeInteger(body.total) && body.total >= 0;
                if (!hasTotal) {
                    return { items: [], rawCount: 0, more: false, incomplete: true };
                }
                if (typeof body.more !== 'boolean' || (body.more && raw.length < PAGE_SIZE)) {
                    return { items: [], rawCount: 0, more: false, incomplete: true };
                }
                // 上游会过滤无效条目，游标仍按已消费的原始条目推进。
                const rawCount = Math.min(PAGE_SIZE, Math.max(0, body.total - offset));
                if (body.more !== (offset + rawCount < body.total)) {
                    return { items: [], rawCount: 0, more: false, incomplete: true };
                }
                const items = raw.map((value) => songItem(value, 'song')).filter(Boolean);
                return { items, rawCount, total: body.total, more: Boolean(body.more) };
            },
        };
    };
}

module.exports = { wrapCreate };
