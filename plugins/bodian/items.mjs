// 波点响应到 Rhine 统一模型的纯映射；不在这里发请求或写凭据。

import { secureUrl } from './transport.mjs';

const PROVIDER = 'bodian';

function firstText(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            return String(value);
        }
    }
    return '';
}

function positiveNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function plainText(value) {
    return String(value || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .trim();
}

function artistRefs(wire) {
    const list = Array.isArray(wire.artists) ? wire.artists : [];
    const artists = [];
    for (const item of list) {
        const name = String(item && item.name ? item.name : '').trim();
        if (!name) {
            continue;
        }
        artists.push({ id: String(item.id || item.artistId || ''), name });
    }
    if (artists.length) {
        return artists;
    }
    const name = String(wire.artist || '').trim();
    if (!name) {
        return [];
    }
    return [{ id: String(wire.artistId || ''), name }];
}

function artistText(artists) {
    return artists.map((artist) => artist.name).join(' / ');
}

export function trackOf(wire) {
    const id = firstText(wire.id, wire.rid, wire.musicRid);
    const artists = artistRefs(wire);
    const track = {
        provider: PROVIDER,
        kind: 'song',
        id,
        key: PROVIDER + ':song:' + id,
        title: firstText(wire.name, wire.songName) || '未知歌曲',
        artist: artistText(artists),
        artists,
        extensions: {},
    };
    const albumID = firstText(wire.albumId);
    if (albumID) {
        track.albumID = albumID;
    }
    const album = firstText(wire.album);
    if (album) {
        track.album = album;
    }
    const cover = secureUrl(wire.albumPic || wire.albumPic120 || wire.pic || wire.cover);
    if (cover) {
        track.cover = cover;
    }
    const seconds = positiveNumber(wire.duration);
    if (seconds) {
        track.duration = Math.round(seconds * 1000);
    }
    const feeType = wire.payInfo && wire.payInfo.feeType ? wire.payInfo.feeType : {};
    if (String(feeType.vip || '') === '1') {
        track.extensions.vip = true;
    }
    return track;
}

export function albumOf(wire) {
    const id = firstText(wire.albumId, wire.id);
    const artists = artistRefs(wire);
    const album = {
        provider: PROVIDER,
        kind: 'album',
        id,
        key: PROVIDER + ':album:' + id,
        title: firstText(wire.name, wire.album) || '未知专辑',
        artist: artistText(artists),
        artists,
        extensions: {},
    };
    const cover = secureUrl(wire.pic || wire.albumPic || wire.cover);
    if (cover) {
        album.cover = cover;
    }
    const date = firstText(wire.showtime, wire.releaseDate);
    if (date) {
        album.date = date;
    }
    const count = positiveNumber(wire.musicCount ?? wire.musicnum ?? wire.total);
    if (count) {
        album.trackCount = count;
    }
    const description = plainText(wire.info || wire.description);
    if (description) {
        album.description = description;
    }
    const creator = firstText(wire.artistId);
    if (creator) {
        album.creatorID = creator;
    }
    return album;
}

export function artistOf(wire) {
    const id = firstText(wire.artistId, wire.id);
    const name = firstText(wire.name, wire.artist) || '未知歌手';
    const artist = {
        provider: PROVIDER,
        kind: 'artist',
        id,
        key: PROVIDER + ':artist:' + id,
        title: name,
        artist: name,
        artists: [{ id, name }],
        extensions: {},
    };
    const cover = secureUrl(wire.pic || wire.artistPic);
    if (cover) {
        artist.cover = cover;
    }
    const description = plainText(wire.desc || wire.description || wire.info);
    if (description) {
        artist.description = description;
    }
    const count = positiveNumber(wire.musicCnt ?? wire.songNum);
    if (count) {
        artist.trackCount = count;
    }
    return artist;
}

/**
 * 歌单 id 带上游目录 source，详情与曲目请求都靠它区分同号歌单。
 * 自建歌单固定 source 5，平台歌单通常是 4 或 13。
 */
export function playlistOf(wire, options = {}) {
    const source = Number(wire.sourceType ?? wire.source ?? options.source ?? 0);
    const raw = firstText(wire.id, wire.playlistId);
    const id = 'pl-' + source + '-' + raw;
    const playlist = {
        provider: PROVIDER,
        kind: 'playlist',
        id,
        key: PROVIDER + ':playlist:' + id,
        title: firstText(wire.name, wire.title) || '未命名歌单',
        artist: firstText(wire.creatorName, wire.creator_name, wire.nickname),
        artists: [],
        extensions: { source },
    };
    const cover = secureUrl(wire.pic || wire.cover);
    if (cover) {
        playlist.cover = cover;
    }
    const description = plainText(wire.description);
    if (description) {
        playlist.description = description;
    }
    const count = positiveNumber(wire.musicCount ?? wire.musicnum ?? wire.total);
    if (count) {
        playlist.trackCount = count;
    }
    const creator = firstText(wire.creatorId, wire.creator_id);
    if (creator) {
        playlist.creatorID = creator;
    }
    const playCount = positiveNumber(wire.playNum ?? wire.playnum);
    if (playCount) {
        playlist.playCount = playCount;
        playlist.extensions.playCount = playCount;
    }
    if (options.owned === true) {
        playlist.owned = true;
    }
    return playlist;
}

export function chartOf(wire) {
    const raw = firstText(wire.id);
    const id = 'bang-' + raw;
    const chart = {
        provider: PROVIDER,
        kind: 'playlist',
        id,
        key: PROVIDER + ':playlist:' + id,
        title: firstText(wire.name) || '排行榜',
        artist: '',
        artists: [],
        chart: true,
        extensions: {},
    };
    const cover = secureUrl(wire.pic);
    if (cover) {
        chart.cover = cover;
    }
    const count = positiveNumber(wire.total);
    if (count) {
        chart.trackCount = count;
    }
    const period = firstText(wire.pub);
    if (period) {
        chart.period = period;
        chart.description = '更新于 ' + period;
    }
    return chart;
}

function commentTime(text) {
    const value = String(text || '').trim();
    let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
    if (!match) {
        const short = /^(\d{2})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
        if (!short) {
            return 0;
        }
        match = [short[0], '20' + short[1], short[2], short[3], short[4], short[5], short[6]];
    }
    const at = Date.UTC(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        (Number(match[4]) || 0) - 8,
        Number(match[5]) || 0,
        Number(match[6]) || 0,
    );
    return Number.isFinite(at) ? at : 0;
}

export function commentOf(wire) {
    const content = String(wire.content || '').trim();
    if (!content) {
        return null;
    }
    const user = wire.userInfo || {};
    const comment = {
        id: String(wire.id || ''),
        content,
        nickname: firstText(user.nickname, wire.nickname) || '波点音乐听众',
        likedCount: Number(wire.likeCount) || 0,
        replyCount: Number(wire.replyCount) || 0,
    };
    const userId = firstText(user.id, wire.uid);
    if (userId) {
        comment.userId = userId;
    }
    const avatar = secureUrl(user.headImg || wire.headImg);
    if (avatar) {
        comment.avatarUrl = avatar;
    }
    const time = commentTime(wire.publishTime || wire.createTime);
    if (time) {
        comment.time = time;
    }
    const location = firstText(wire.ipProvince, wire.ipCity);
    if (location) {
        comment.location = location;
    }
    return comment;
}
