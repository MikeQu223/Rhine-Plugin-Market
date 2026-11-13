// 波点音乐 native operation 适配：把上游接口收敛成 Rhine 统一模型。

import lyricsFormat from '../../lyrics-format.cjs';
import { makeError, Transport, secureUrl } from './transport.mjs';
import { albumOf, artistOf, chartOf, commentOf, playlistOf, trackOf } from './items.mjs';

const SEARCH_PAGE = 30;
const LIST_PAGE = 30;
const PLAYLIST_PAGE = 100;
const SQUARE_PAGE = 60;
const COMMENT_PAGE = 30;
const MAX_PLAYLIST_TRACKS = 1000;
const SONG_CACHE_LIMIT = 600;
const LIKED_TTL_MS = 60000;
const COLLECTION_TTL_MS = 60000;
const QR_CONTENT_PREFIX = 'https://bodian-oia.kuwo.cn/bodian/download.html?pageName=login_pc&pt=3';

const QUALITY_BITRATES = {
    standard: ['128'],
    high: ['20000', '320', '128'],
    lossless: ['2000', '20000', '320', '128'],
};

const TIER_RANK = {
    standard: 1,
    hq: 2,
    lossless: 3,
};

const songCache = new Map();
let likedCache = { uid: '', token: '', ids: [], at: 0 };
let likedLoading = null;
let collectionCache = { uid: '', token: '', at: 0, mine: [], saved: [], albums: [] };

function digits(value) {
    const text = String(value ?? '').trim();
    if (!/^\d+$/.test(text) || Number(text) <= 0) {
        throw makeError(404, '波点音乐条目无效');
    }
    return text;
}

function parsePrefixed(value, prefix) {
    const match = new RegExp('^' + prefix + '-(\\d+)$').exec(String(value || ''));
    if (!match) {
        throw makeError(404, '波点音乐条目无效');
    }
    return match[1];
}

function parsePlaylistId(value) {
    const match = /^pl-(\d+)-(\d+)$/.exec(String(value || ''));
    if (!match) {
        throw makeError(404, '波点音乐歌单无效');
    }
    return { source: Number(match[1]), raw: match[2] };
}

function emptyPage(extra = {}) {
    return { items: [], rawCount: 0, more: false, ...extra };
}

function pageOf(items, more, total) {
    const page = { items, rawCount: items.length, more };
    if (Number.isFinite(total) && total >= 0) {
        page.total = total;
    }
    return page;
}

function pageNumber(offset, size) {
    const safe = Number.isFinite(Number(offset)) && Number(offset) > 0 ? Number(offset) : 0;
    return Math.floor(safe / size) + 1;
}

function searchPageNumber(offset) {
    const safe = Number.isFinite(Number(offset)) && Number(offset) > 0 ? Number(offset) : 0;
    return Math.floor(safe / SEARCH_PAGE);
}

function parseSize(text) {
    const match = /^\s*([\d.]+)\s*([kmg]?)b/i.exec(String(text || ''));
    if (!match) {
        return 0;
    }
    const units = { '': 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 };
    const unit = units[String(match[2]).toLowerCase()] || 1;
    return Math.round(Number(match[1]) * unit);
}

function tierOf(format, bitrate) {
    if (format === 'flac') {
        return 'lossless';
    }
    if (Number(bitrate) >= 320) {
        return 'hq';
    }
    return 'standard';
}

function qualityOfTier(tier) {
    if (tier === 'lossless') {
        return 'lossless';
    }
    if (tier === 'hq') {
        return 'high';
    }
    return 'standard';
}

function rememberSong(raw, track) {
    songCache.set(String(raw), track);
    if (songCache.size > SONG_CACHE_LIMIT) {
        const oldest = songCache.keys().next().value;
        songCache.delete(oldest);
    }
}

function forgetLibraries() {
    likedCache = { uid: '', token: '', ids: [], at: 0 };
    likedLoading = null;
    collectionCache = { uid: '', at: 0, mine: [], saved: [], albums: [] };
}

export class BodianApi {
    constructor(host, transport) {
        this.host = host;
        this.transport = transport || new Transport(host);
    }

    async search(text, kind, offset = 0) {
        const keyword = String(text || '').trim();
        if (!keyword) {
            return emptyPage();
        }
        const pn = searchPageNumber(offset);
        const base = { keyword, pn, rn: SEARCH_PAGE };
        if (kind === 'song') {
            const data = await this.transport.request('search/music/list', {
                query: { ...base, correct: 1 },
            });
            const raw = Array.isArray(data.resultList) ? data.resultList : [];
            return this.searchPage(raw, raw.map(trackOf), data.total, offset);
        }
        if (kind === 'album') {
            const data = await this.transport.request('search/album/list', { query: base });
            const raw = Array.isArray(data.resultList) ? data.resultList : [];
            return this.searchPage(raw, raw.map(albumOf), data.total, offset);
        }
        if (kind === 'artist') {
            const data = await this.transport.request('search/artist/list', { query: base });
            const raw = Array.isArray(data.resultList) ? data.resultList : [];
            return this.searchPage(raw, raw.map(artistOf), data.total, offset);
        }
        if (kind === 'playlist') {
            const data = await this.transport.request('search/playlist/list', { query: base });
            const raw = Array.isArray(data.resultList) ? data.resultList : [];
            return this.searchPage(raw, raw.map((wire) => this.playlistEntity(wire)), data.total, offset);
        }
        throw makeError(400, '波点音乐不支持该搜索类型');
    }

    searchPage(raw, items, total, offset) {
        const count = Number(total);
        let more = raw.length >= SEARCH_PAGE;
        if (Number.isFinite(count) && count > 0) {
            more = Number(offset) + raw.length < count;
        }
        if (raw.length === 0) {
            more = false;
        }
        return pageOf(items, more, Number.isFinite(count) && count >= 0 ? count : undefined);
    }

    playlistEntity(wire, options = {}) {
        if (wire.id === undefined && wire.playlistId === undefined) {
            throw makeError(502, '波点音乐返回了无效的歌单');
        }
        return playlistOf(wire, options);
    }

    async suggest(text) {
        const keyword = String(text || '').trim();
        try {
            if (keyword) {
                const data = await this.transport.request('search/tip/v2/list', { query: { keyword } });
                const raw = Array.isArray(data.resultList) ? data.resultList : [];
                return raw.map((item) => String(item.relword || '')).filter(Boolean).slice(0, 10);
            }
            const data = await this.transport.request('search/hot/list');
            const raw = Array.isArray(data.resultList) ? data.resultList : [];
            return raw.map((item) => String(item.key || '')).filter(Boolean).slice(0, 10);
        } catch (error) {
            // 搜索建议是附加能力，失败时让输入框保持安静。
            return [];
        }
    }

    async songs(ids) {
        const list = (Array.isArray(ids) ? ids : [])
            .map((id) => String(id || '').trim())
            .filter(Boolean);
        const results = new Map();
        const pending = [];
        for (const raw of list) {
            const cached = songCache.get(raw);
            if (cached) {
                results.set(raw, cached);
            } else {
                pending.push(raw);
            }
        }
        for (let start = 0; start < pending.length; start += 6) {
            const chunk = pending.slice(start, start + 6);
            const found = await Promise.all(
                chunk.map((raw) => this.musicInfo(raw).catch(() => null)),
            );
            for (const track of found) {
                if (track) {
                    results.set(track.id, track);
                }
            }
        }
        return list.map((raw) => results.get(raw)).filter(Boolean);
    }

    async musicInfo(raw) {
        const key = String(raw);
        const cached = songCache.get(key);
        if (cached) {
            return cached;
        }
        const data = await this.transport.request('service/music/info', {
            query: { musicId: key },
        });
        if (!data || !data.id) {
            throw makeError(404, '波点音乐暂不提供这首歌');
        }
        const track = trackOf(data);
        rememberSong(key, track);
        return track;
    }

    async detail(ref) {
        if (!ref || typeof ref !== 'object') {
            throw makeError(400, '缺少波点音乐条目');
        }
        if (ref.kind === 'song') {
            const track = await this.musicInfo(ref.id);
            return [track, [], []];
        }
        if (ref.kind === 'album') {
            return this.albumDetail(ref.id);
        }
        if (ref.kind === 'artist') {
            return this.artistDetail(ref.id);
        }
        if (ref.kind === 'playlist') {
            return this.playlistDetail(ref.id);
        }
        throw makeError(400, '波点音乐不支持该条目');
    }

    async albumDetail(id) {
        const raw = digits(id);
        const [info, songs, state] = await Promise.all([
            this.transport.request('service/album/' + raw),
            this.transport.request('service/album/music/' + raw, {
                query: { pn: 1, rn: 1000 },
            }),
            this.transport
                .request('service/collect/multipleState', { query: { source: 6, sourceIds: raw } })
                .catch(() => ({ result: [] })),
        ]);
        const albumInfo = info.albumInfo || {};
        if (!albumInfo.id && !albumInfo.name) {
            throw makeError(404, '波点音乐暂不提供这张专辑');
        }
        const album = albumOf({ ...albumInfo, albumId: albumInfo.albumId || albumInfo.id });
        const rows = Array.isArray(state.result) ? state.result : [];
        album.isFavorite = rows.some((row) => String(row.id) === raw && !!row.collect);
        const tracks = (Array.isArray(songs.resultList) ? songs.resultList : []).map(trackOf);
        if (tracks.length && !album.trackCount) {
            album.trackCount = tracks.length;
        }
        return [album, tracks, []];
    }

    async artistDetail(id) {
        const raw = digits(id);
        const [info, songs, state] = await Promise.all([
            this.transport.request('service/artist/' + raw),
            this.transport
                .request('service/artist/music/' + raw, { query: { pn: 1, rn: 50 } })
                .catch(() => ({ resultList: [] })),
            this.transport
                .request('service/collect/multipleState', { query: { source: 7, sourceIds: raw } })
                .catch(() => ({ result: [] })),
        ]);
        const artistInfo = info.artistInfo || {};
        if (!artistInfo.id && !artistInfo.name) {
            throw makeError(404, '波点音乐暂不提供这位歌手');
        }
        const artist = artistOf(artistInfo);
        const rows = Array.isArray(state.result) ? state.result : [];
        artist.isFavorite = rows.some((row) => String(row.id) === raw && !!row.collect);
        const tracks = (Array.isArray(songs.resultList) ? songs.resultList : []).map(trackOf);
        return [artist, tracks, []];
    }

    async playlistDetail(id) {
        if (/^bang-\d+$/.test(String(id || ''))) {
            return this.chartDetail(parsePrefixed(id, 'bang'));
        }
        const parsed = parsePlaylistId(id);
        const found = await this.resolvePlaylist(parsed.raw, parsed.source);
        const playlist = this.playlistEntity(found.info, { source: found.source });
        const tracks = await this.playlistTracks(parsed.raw, found.source, MAX_PLAYLIST_TRACKS);
        if (!playlist.trackCount) {
            playlist.trackCount = tracks.length;
        }
        return [playlist, tracks, []];
    }

    async chartDetail(raw) {
        const data = await this.transport.request('service/bang/' + raw + '/musics', {
            query: { pn: 1, rn: MAX_PLAYLIST_TRACKS },
        });
        const chart = chartOf({ ...data, id: raw });
        const tracks = (Array.isArray(data.musics) ? data.musics : []).map(trackOf);
        if (!chart.trackCount) {
            chart.trackCount = tracks.length;
        }
        return [chart, tracks, []];
    }

    /** 歌单 id 里的 source 可能过期，按自建、收藏、平台的顺序再找一次。 */
    async resolvePlaylist(raw, source) {
        const tried = [];
        const order = [source, 5, 4, 13];
        for (const candidate of order) {
            const current = Number(candidate) || 0;
            if (!current || tried.includes(current)) {
                continue;
            }
            tried.push(current);
            try {
                const info = await this.transport.request('service/playlist/info/' + raw, {
                    query: { source: current },
                });
                if (info && info.id && info.name) {
                    return { info, source: current };
                }
            } catch (error) {
                // 只有“不在这个目录”能继续尝试，网络错误要直接返回。
                if (error && error.code === 502) {
                    continue;
                }
                throw error;
            }
        }
        throw makeError(404, '这个波点音乐歌单已失效或当前账号不可见');
    }

    async playlistTracks(raw, source, limit) {
        const tracks = [];
        for (let pn = 1; pn <= 20; pn += 1) {
            let data;
            try {
                data = await this.transport.request('service/playlist/' + raw + '/musicList', {
                    query: { pn, rn: PLAYLIST_PAGE, source },
                });
            } catch (error) {
                if (pn === 1) {
                    throw error;
                }
                break;
            }
            const rows = Array.isArray(data.list) ? data.list : [];
            if (!rows.length) {
                break;
            }
            tracks.push(...rows.map(trackOf));
            const total = Number(data.total) || 0;
            if (tracks.length >= limit) {
                break;
            }
            if (total > 0 && tracks.length >= total) {
                break;
            }
        }
        return tracks.slice(0, limit);
    }

    async trackPage(ref, offset = 0) {
        if (!ref || typeof ref !== 'object') {
            throw makeError(400, '缺少波点音乐条目');
        }
        const pn = pageNumber(offset, LIST_PAGE);
        if (ref.kind === 'album') {
            const raw = digits(ref.id);
            const data = await this.transport.request('service/album/music/' + raw, {
                query: { pn, rn: LIST_PAGE },
            });
            const rows = Array.isArray(data.resultList) ? data.resultList : [];
            return pageOf(rows.map(trackOf), rows.length >= LIST_PAGE, Number(data.total));
        }
        if (ref.kind === 'artist') {
            const raw = digits(ref.id);
            const data = await this.transport.request('service/artist/music/' + raw, {
                query: { pn, rn: LIST_PAGE },
            });
            const rows = Array.isArray(data.resultList) ? data.resultList : [];
            return pageOf(rows.map(trackOf), rows.length >= LIST_PAGE, Number(data.total));
        }
        if (String(ref.id || '').startsWith('bang-')) {
            const raw = parsePrefixed(ref.id, 'bang');
            const data = await this.transport.request('service/bang/' + raw + '/musics', {
                query: { pn, rn: LIST_PAGE },
            });
            const rows = Array.isArray(data.musics) ? data.musics : [];
            return pageOf(rows.map(trackOf), rows.length >= LIST_PAGE, Number(data.total));
        }
        if (ref.kind === 'playlist') {
            const parsed = parsePlaylistId(ref.id);
            const found = await this.resolvePlaylist(parsed.raw, parsed.source);
            const data = await this.transport.request(
                'service/playlist/' + parsed.raw + '/musicList',
                { query: { pn, rn: LIST_PAGE, source: found.source } },
            );
            const rows = Array.isArray(data.list) ? data.list : [];
            return pageOf(rows.map(trackOf), rows.length >= LIST_PAGE, Number(data.total));
        }
        return emptyPage();
    }

    async artistAlbums(id, offset = 0) {
        const raw = digits(id);
        const pn = pageNumber(offset, LIST_PAGE);
        const data = await this.transport.request('service/artist/album/' + raw, {
            query: { pn, rn: LIST_PAGE },
        });
        const rows = Array.isArray(data.resultList) ? data.resultList : [];
        return pageOf(rows.map(albumOf), rows.length >= LIST_PAGE, Number(data.total));
    }

    async playback(track, qualityId) {
        const raw = digits(track && track.id);
        const requested = QUALITY_BITRATES[qualityId] ? qualityId : 'high';
        const bitrates = QUALITY_BITRATES[requested];
        let best = null;
        let lastError = null;
        for (const br of bitrates) {
            let data;
            try {
                data = await this.transport.request('play/music/v2/audioUrl', {
                    query: {
                        devId: this.transport.devid(),
                        musicId: raw,
                        br,
                        freeSign: '',
                    },
                });
            } catch (error) {
                lastError = error;
                continue;
            }
            const found = this.playbackSource(data, br, requested);
            if (!found) {
                continue;
            }
            if (!best || TIER_RANK[found.tier] > TIER_RANK[best.tier]) {
                best = found;
            } else if (TIER_RANK[found.tier] === TIER_RANK[best.tier] && found.bitrate > best.bitrate) {
                best = found;
            }
            if (best.tier === 'lossless') {
                break;
            }
        }
        if (!best) {
            if (lastError && lastError.code === 401) {
                throw lastError;
            }
            const signedIn = this.transport.isSignedIn();
            const message = signedIn
                ? '当前波点音乐账号没有这首歌的播放权限'
                : '这首歌需要登录或开通会员，可改用试听';
            throw makeError(403, message, { restriction: 'vip' });
        }
        return best;
    }

    playbackSource(data, br, requested) {
        if (!data || !data.audioUrl) {
            return null;
        }
        const format = String(data.format || '').toLowerCase();
        if (format !== 'mp3' && format !== 'flac') {
            return null;
        }
        const url = secureUrl(data.audioHttpsUrl) || secureUrl(data.audioUrl);
        if (!url) {
            return null;
        }
        const bitrate = Number(data.bitrate) || Number(br) || 128;
        const tier = tierOf(format, bitrate);
        const source = {
            url,
            format,
            type: format,
            bitrate,
            size: parseSize(data.size),
            tier,
            providerTier: String(br),
            qualityId: requested,
        };
        const fallback = qualityOfTier(tier);
        if (fallback !== requested) {
            source.qualityFallback = fallback;
        }
        return source;
    }

    async preview(track) {
        const raw = digits(track && track.id);
        const data = await this.transport.request('play/music/v2/checkRight', {
            query: { musicId: raw, freeSign: '' },
        });
        const audition = data.audition || null;
        const url = audition
            ? secureUrl(audition.https) || secureUrl(audition.url) || secureUrl(audition.car_url_https)
            : '';
        if (!url) {
            throw makeError(403, '这首歌没有可用的试听片段', { restriction: 'vip' });
        }
        return {
            url,
            format: 'mp3',
            type: 'mp3',
            bitrate: Number(audition.br) || 128,
            tier: 'standard',
            providerTier: 'audition',
            qualityId: 'standard',
            trial: true,
            restriction: 'VIP 歌曲试听片段',
        };
    }

    async lyrics(track) {
        const raw = String((track && track.id) || '').trim();
        if (!/^\d+$/.test(raw)) {
            return null;
        }
        const text = await this.transport.lyric(raw);
        if (!text.trim()) {
            return null;
        }
        const normalized = lyricsFormat.normalizeLyrics('bodian', { lrc: text });
        if (!normalized || normalized.code !== 200 || !normalized.document) {
            return null;
        }
        return normalized.document;
    }

    async account() {
        const current = this.transport.session();
        if (!current.uid || !current.token) {
            return null;
        }
        const data = await this.transport.request('ucenter/users/pub/' + current.uid, {
            query: { fromUid: current.uid, platform: 'ios' },
        });
        const user = data.userInfo || data || {};
        return {
            uid: String(user.id || current.uid),
            nickname: String(user.nickname || user.name || '波点音乐用户'),
        };
    }

    async loginBegin(method) {
        if (method && method !== 'qr') {
            throw makeError(400, '波点音乐只支持扫码登录');
        }
        const data = await this.transport.request('ucenter/login/qrCode');
        const qrCode = String(data.qrCode || '');
        if (!qrCode) {
            throw makeError(502, '波点音乐没有返回登录二维码');
        }
        return {
            token: qrCode,
            qrText: QR_CONTENT_PREFIX + '&id=' + encodeURIComponent(qrCode),
            pollIntervalMs: 1500,
        };
    }

    async loginPoll(token) {
        const qrCode = String(token || '').trim();
        if (!qrCode) {
            throw makeError(400, '登录二维码已失效，请重新生成');
        }
        const data = await this.transport.request('ucenter/login/qrCodeStatus', {
            query: { qrCode },
        });
        const status = Number(data.status);
        if (status === 2) {
            return { code: 800, status: 'expired' };
        }
        if (status === 3) {
            await this.finishLogin(qrCode);
            return { code: 200, status: 'confirmed' };
        }
        return { code: 801, status: 'waiting' };
    }

    async finishLogin(qrCode) {
        const data = await this.transport.request('ucenter/users/login', {
            method: 'POST',
            body: { authType: 10, qrCode },
        });
        const user = data.userInfo || {};
        const uid = String(data.id || user.id || '');
        const token = String(data.token || '');
        if (!uid || !token) {
            throw makeError(502, '波点音乐登录失败，请重新扫码');
        }
        this.transport.persistSession(uid, token);
        forgetLibraries();
    }

    async loginCancel() {
        return true;
    }

    async logout() {
        this.transport.clearSession();
        forgetLibraries();
        return true;
    }

    async userPlaylists(uid) {
        const current = this.transport.session();
        const target = String(uid || current.uid || '');
        if (!current.uid || !current.token || !target) {
            return emptyPage();
        }
        const collections = await this.loadCollections(target);
        const items = [...collections.mine, ...collections.saved];
        return pageOf(items, false, items.length);
    }

    async loadCollections(uid) {
        const current = this.transport.session();
        const key = String(uid);
        if (
            collectionCache.uid === key &&
            collectionCache.token === current.token &&
            Date.now() - collectionCache.at < COLLECTION_TTL_MS
        ) {
            return collectionCache;
        }
        const mine = [];
        const saved = [];
        const albums = [];
        const created = await this.transport.request('service/playlist/userCreate', {
            query: { userId: key },
        });
        for (const wire of Array.isArray(created.playLists) ? created.playLists : []) {
            mine.push(
                this.playlistEntity(
                    { ...wire, sourceType: 5, creatorId: wire.creatorId || key },
                    { source: 5, owned: true },
                ),
            );
        }
        for (let pn = 1; pn <= 10; pn += 1) {
            const collected = await this.transport.request('service/collect/4/list', {
                query: { userId: key, pn, rn: PLAYLIST_PAGE },
            });
            const rows = Array.isArray(collected.playLists) ? collected.playLists : [];
            for (const wire of rows) {
                if (wire.albumId) {
                    albums.push(albumOf(wire));
                } else {
                    saved.push(this.playlistEntity(wire, { source: wire.sourceType || 4 }));
                }
            }
            if (rows.length < PLAYLIST_PAGE) {
                break;
            }
        }
        collectionCache = { uid: key, token: current.token, at: Date.now(), mine, saved, albums };
        return collectionCache;
    }

    async likedPlaylistId(uid) {
        const data = await this.transport.request('service/playlist/fond', {
            query: { userId: uid },
        });
        return String(data.id || '');
    }

    async likedIDs(uid) {
        const current = this.transport.session();
        if (!current.uid || !current.token) {
            return [];
        }
        const key = String(uid || current.uid);
        if (
            likedCache.uid === key &&
            likedCache.token === current.token &&
            Date.now() - likedCache.at < LIKED_TTL_MS
        ) {
            return likedCache.ids;
        }
        if (likedLoading && likedLoading.uid === key && likedLoading.token === current.token) {
            return likedLoading.promise;
        }
        const promise = this.loadLikedIDs(key);
        likedLoading = { uid: key, token: current.token, promise };
        try {
            return await promise;
        } finally {
            if (likedLoading && likedLoading.promise === promise) {
                likedLoading = null;
            }
        }
    }

    async loadLikedIDs(uid) {
        const playlistID = await this.likedPlaylistId(uid);
        if (!playlistID) {
            return [];
        }
        const ids = [];
        for (let pn = 1; pn <= 100; pn += 1) {
            const data = await this.transport.request(
                'service/playlist/' + playlistID + '/musicList',
                { query: { pn, rn: 100, source: 5 } },
            );
            const rows = Array.isArray(data.list) ? data.list : [];
            for (const row of rows) {
                ids.push(String(row.id));
            }
            if (rows.length < 100) {
                break;
            }
        }
        const current = this.transport.session();
        likedCache = { uid, token: current.token, ids, at: Date.now() };
        return ids;
    }

    async likedSongs(offset = 0) {
        const current = this.transport.session();
        if (!current.uid || !current.token) {
            return emptyPage();
        }
        const playlistID = await this.likedPlaylistId(current.uid);
        if (!playlistID) {
            return emptyPage();
        }
        const data = await this.transport.request(
            'service/playlist/' + playlistID + '/musicList',
            { query: { pn: pageNumber(offset, SEARCH_PAGE), rn: SEARCH_PAGE, source: 5 } },
        );
        const rows = Array.isArray(data.list) ? data.list : [];
        return pageOf(rows.map(trackOf), rows.length >= SEARCH_PAGE, Number(data.total));
    }

    async likedAlbums(offset = 0) {
        const current = this.transport.session();
        if (!current.uid || !current.token) {
            return emptyPage();
        }
        const collections = await this.loadCollections(current.uid);
        const start = Math.max(0, Number(offset) || 0);
        const items = collections.albums.slice(start, start + SEARCH_PAGE);
        return pageOf(items, start + items.length < collections.albums.length, collections.albums.length);
    }

    async likedState(ids) {
        const list = Array.isArray(ids) ? ids : [];
        const result = {};
        const current = this.transport.session();
        if (!current.uid || !current.token) {
            for (const id of list) {
                result[String(id)] = 'unknown';
            }
            return result;
        }
        const liked = new Set(await this.likedIDs(current.uid));
        for (const id of list) {
            result[String(id)] = liked.has(String(id)) ? 'subscribed' : 'not-subscribed';
        }
        return result;
    }

    async discover(tab, offset = 0, category) {
        if (tab === 'daily') {
            const data = await this.transport.request('service/home/module', {
                query: { moduleId: 3 },
            });
            const rows = Array.isArray(data.musicList) ? data.musicList : [];
            return pageOf(rows.map(trackOf), false, rows.length);
        }
        if (tab === 'charts') {
            const groups = await this.transport.request('service/home/bangNew');
            const charts = [];
            for (const group of Array.isArray(groups) ? groups : []) {
                for (const bang of Array.isArray(group.bangList) ? group.bangList : []) {
                    if (!bang || !bang.id) {
                        continue;
                    }
                    charts.push(chartOf(bang));
                }
            }
            return pageOf(charts, false, charts.length);
        }
        if (tab === 'guess') {
            const data = await this.transport.request('service/music/recommendList', {
                query: { pn: pageNumber(offset, SEARCH_PAGE), rn: SEARCH_PAGE, select_card: 1 },
            });
            const rows = Array.isArray(data.musicList) ? data.musicList : [];
            return pageOf(rows.map(trackOf), rows.length >= SEARCH_PAGE);
        }
        if (tab === 'categories') {
            return this.categoryPage(offset, category);
        }
        return this.squarePage(offset);
    }

    async squarePage(offset) {
        const data = await this.transport.request('service/category/playlist', {
            query: { pn: pageNumber(offset, SQUARE_PAGE), rn: SQUARE_PAGE },
        });
        const rows = Array.isArray(data.playLists) ? data.playLists : [];
        const items = rows.map((wire) => this.playlistEntity(wire));
        return pageOf(items, rows.length >= SQUARE_PAGE, Number(data.total));
    }

    async categoryPage(offset, category) {
        const id = String(category || '全部');
        if (id === '全部') {
            const page = await this.squarePage(offset);
            page.category = id;
            return page;
        }
        const data = await this.transport.request('service/category/' + digits(id) + '/playlist', {
            query: { pn: pageNumber(offset, SQUARE_PAGE), rn: SQUARE_PAGE },
        });
        const rows = Array.isArray(data.playLists) ? data.playLists : [];
        const page = pageOf(
            rows.map((wire) => this.playlistEntity(wire)),
            rows.length >= SQUARE_PAGE,
            Number(data.total),
        );
        page.category = id;
        return page;
    }

    async categories() {
        const data = await this.transport.request('service/category/list');
        const categories = [{ id: '全部', name: '全部' }];
        for (const group of Array.isArray(data.categories) ? data.categories : []) {
            for (const sub of Array.isArray(group.subCategories) ? group.subCategories : []) {
                if (!sub || !sub.id || !sub.name) {
                    continue;
                }
                categories.push({ id: String(sub.id), name: String(sub.name) });
            }
        }
        return categories;
    }

    async mutate(route, values) {
        const input = values && typeof values === 'object' ? values : {};
        if (route === '/like') {
            return this.mutateLike(input);
        }
        if (route === '/playlist/subscribe') {
            const parsed = parsePlaylistId(input.id);
            return this.mutateCollect(4, parsed.raw, Number(input.t) === 1);
        }
        if (route === '/album/sub') {
            return this.mutateCollect(6, digits(input.id), Number(input.t) === 1);
        }
        if (route === '/artist/sub') {
            return this.mutateCollect(7, digits(input.id), Number(input.t) === 1);
        }
        if (route === '/playlist/create') {
            return this.createPlaylist(input.name);
        }
        if (route === '/playlist/name/update') {
            return this.renamePlaylist(input.id, input.name);
        }
        if (route === '/playlist/delete') {
            return this.deletePlaylist(input.id);
        }
        if (route === '/playlist/tracks') {
            return this.editPlaylistTracks(input);
        }
        throw makeError(400, '波点音乐不支持该编辑操作');
    }

    async mutateLike(values) {
        const current = this.requireSession();
        const raw = digits(values.id);
        const enabled = Boolean(values.like);
        const playlistID = await this.likedPlaylistId(current.uid);
        if (!playlistID) {
            throw makeError(409, '这个波点音乐账号还没有“我喜欢的音乐”歌单');
        }
        const path = enabled ? 'service/playlist/music' : 'service/playlist/music/delete';
        await this.transport.request(path, {
            method: 'POST',
            body: { playListId: Number(playlistID), musicIdList: [Number(raw)] },
        });
        if (likedCache.uid === current.uid) {
            const ids = new Set(likedCache.ids);
            if (enabled) {
                ids.add(raw);
            } else {
                ids.delete(raw);
            }
            likedCache = { ...likedCache, ids: [...ids], at: Date.now() };
        }
        return { applied: true, state: enabled ? 'subscribed' : 'not-subscribed' };
    }

    async mutateCollect(source, raw, enabled) {
        const current = this.requireSession();
        await this.transport.request('service/collect', {
            method: 'POST',
            body: {
                source,
                sourceId: [Number(raw)],
                op: enabled ? 1 : 2,
                uid: Number(current.uid),
                token: current.token,
            },
        });
        collectionCache = { uid: '', at: 0, mine: [], saved: [], albums: [] };
        return { applied: true, state: enabled ? 'subscribed' : 'not-subscribed' };
    }

    async createPlaylist(name) {
        const title = String(name || '').trim();
        if (!title) {
            throw makeError(400, '歌单名称不能为空');
        }
        const current = this.requireSession();
        const data = await this.transport.request('service/playlist', {
            method: 'POST',
            body: { name: title, private: false },
        });
        const raw = String(data.id || data.playlistId || '');
        if (!raw) {
            throw makeError(502, '波点音乐没有返回新歌单的 id');
        }
        collectionCache = { uid: '', at: 0, mine: [], saved: [], albums: [] };
        const item = {
            provider: 'bodian',
            kind: 'playlist',
            id: 'pl-5-' + raw,
            key: 'bodian:playlist:pl-5-' + raw,
            title,
            artist: '',
            artists: [],
            creatorID: current.uid,
            trackCount: 0,
            owned: true,
            extensions: { source: 5 },
        };
        return { applied: true, item, state: 'subscribed' };
    }

    async renamePlaylist(id, name) {
        const title = String(name || '').trim();
        if (!title) {
            throw makeError(400, '歌单名称不能为空');
        }
        this.requireSession();
        const parsed = parsePlaylistId(id);
        const info = await this.transport.request('service/playlist/info/' + parsed.raw, {
            query: { source: 5 },
        });
        await this.transport.request('service/playlist', {
            method: 'PUT',
            body: {
                id: Number(parsed.raw),
                name: title,
                description: info.description || '',
                pic: info.pic || '',
                categoryList: [],
            },
        });
        collectionCache = { uid: '', at: 0, mine: [], saved: [], albums: [] };
        return { applied: true, name: title };
    }

    async deletePlaylist(id) {
        this.requireSession();
        const parsed = parsePlaylistId(id);
        await this.transport.request('service/playlist', {
            method: 'DELETE',
            body: { playlistIds: [Number(parsed.raw)] },
        });
        collectionCache = { uid: '', at: 0, mine: [], saved: [], albums: [] };
        return { applied: true };
    }

    async editPlaylistTracks(values) {
        this.requireSession();
        const parsed = parsePlaylistId(values.pid);
        const song = digits(values.tracks);
        const remove = String(values.op || '') === 'del';
        const path = remove ? 'service/playlist/music/delete' : 'service/playlist/music';
        await this.transport.request(path, {
            method: 'POST',
            body: { playListId: Number(parsed.raw), musicIdList: [Number(song)] },
        });
        return { applied: true, countDelta: remove ? -1 : 1 };
    }

    requireSession() {
        const current = this.transport.session();
        if (!current.uid || !current.token) {
            throw makeError(401, '请先登录波点音乐', { authExpired: true });
        }
        return current;
    }

    async comments(track, id, sort, page) {
        const raw = digits(id || (track && track.id));
        if (Number(raw) > 2147483647) {
            return { comments: [], totalCount: 0, hasMore: false };
        }
        const pn = Math.max(0, Number(page) || 0) + 1;
        const data = await this.transport.request('comments/v3/hot', {
            query: { moduleType: 2, moduleId: raw, pn, rn: COMMENT_PAGE },
            headers: { plat: 'android' },
        });
        const rows = Array.isArray(data.comment_list) ? data.comment_list : [];
        const comments = [];
        for (const row of rows) {
            const comment = commentOf(row);
            if (comment) {
                comments.push(comment);
            }
        }
        return {
            comments,
            totalCount: Number(data.comment_total) || 0,
            hasMore: Boolean(data.more),
        };
    }
}
