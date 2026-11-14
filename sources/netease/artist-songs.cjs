'use strict';

const PAGE_SIZE = 100;

/** 保留原插件的全部操作，使用上游全部歌曲接口读取歌手分页。 */
function wrapCreate(createLegacy, artistSongs, request, songItem) {
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
                const cookies = Object.fromEntries(
                    Object.entries(host.cookies()).filter(([key]) =>
                        !['__qqSessions', '__kugou', 'qqmusic_session'].includes(key),
                    ),
                );
                const readArtistSongs = options?.artistSongs || artistSongs;
                const response = await readArtistSongs(
                    { id: args[0].id, offset, limit: PAGE_SIZE, order: 'hot', cookie: cookies },
                    options?.artistRequest || request,
                );
                if (response.cookie?.length) {
                    host.acceptCookies(JSON.stringify(response.cookie));
                }
                const body = response.body || {};
                if (response.status !== 200 || body.code !== 200 || !Array.isArray(body.songs)) {
                    const error = new Error('读取歌手歌曲失败');
                    error.code = response.status || 503;
                    throw error;
                }
                const raw = body.songs;
                const hasTotal = Number.isSafeInteger(body.total) && body.total >= 0;
                if (typeof body.more !== 'boolean' && !hasTotal) {
                    return { items: [], rawCount: 0, more: false, incomplete: true };
                }
                const page = {
                    items: raw.map((value) => songItem(value, 'song')).filter(Boolean),
                    rawCount: raw.length,
                    more: typeof body.more === 'boolean' ? body.more : offset + raw.length < body.total,
                };
                if (hasTotal) {
                    page.total = body.total;
                }
                return page;
            },
        };
    };
}

module.exports = { wrapCreate };
