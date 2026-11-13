// 波点音乐上游传输层：请求头、设备标识、会话与接口信封处理。

import { randomBytes } from 'node:crypto';

const API_ORIGIN = 'https://bd-api.kuwo.cn/api/';
const LYRIC_ORIGIN = 'https://mlyric.kuwo.cn/mobi.s';
const USER_AGENT = 'Dart/3.3 (dart:io)';
const REQUEST_TIMEOUT_MS = 10000;
const LYRIC_TIMEOUT_MS = 12000;
const SIGNED_OUT_CODES = new Set([-101, 11012]);
const NO_STREAM_CODES = new Set([20012, 20018, 20019]);

/**
 * 构造可交付给 Host 的错误对象。
 * 只保留白名单字段，避免把上游原文或凭据带进错误消息。
 */
export function makeError(code, message, extra = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, extra);
    return error;
}

function randomHex(bytes) {
    return randomBytes(bytes).toString('hex');
}

/** 上游地址只接受 http(s)，避免把非网页协议交给播放器或封面加载器。 */
export function safeUrl(value) {
    const url = String(value || '');
    return /^https?:\/\//i.test(url) ? url : '';
}

/** 封面统一升级到 https；上游多数图片同时支持两种协议。 */
export function secureUrl(value) {
    return safeUrl(value).replace(/^http:\/\//i, 'https://');
}

export class Transport {
    constructor(host) {
        this.host = host;
    }

    session() {
        const cookies = this.host.cookies();
        return {
            uid: String(cookies.bodian_uid || ''),
            token: String(cookies.bodian_token || ''),
        };
    }

    isSignedIn() {
        const current = this.session();
        return Boolean(current.uid && current.token);
    }

    /** 设备标识首次生成后作为私有 cookie 保存；波点按它区分试听额度。 */
    devid() {
        const cookies = this.host.cookies();
        const saved = String(cookies.bodian_devid || '');
        if (saved) {
            return saved;
        }
        const created = randomHex(16);
        this.host.acceptCookies(JSON.stringify(['bodian_devid=' + created + '; Path=/']));
        return created;
    }

    persistSession(uid, token) {
        this.host.acceptCookies(
            JSON.stringify([
                'bodian_uid=' + String(uid) + '; Path=/',
                'bodian_token=' + String(token) + '; Path=/',
            ]),
        );
    }

    clearSession() {
        this.host.acceptCookies(
            JSON.stringify(['bodian_uid=; Path=/', 'bodian_token=; Path=/']),
        );
    }

    headers(extra) {
        const current = this.session();
        const device = this.devid();
        const values = {
            'User-Agent': USER_AGENT,
            plat: 'win',
            channel: 'W1',
            ver: '1.1.7',
            svrver: '13',
            'api-ver': 'application/json',
            brand: 'Windows',
            net: 'wifi',
            devid: device,
            qimei36: device,
            ...extra,
        };
        if (current.uid && current.token) {
            values.uid = current.uid;
            values.token = current.token;
        }
        return values;
    }

    /**
     * 向波点 JSON 接口发请求，并统一处理业务码与登录过期。
     * 业务失败在 HTTP 200 中返回，必须读取信封 code 才能判断成功。
     */
    async request(path, options = {}) {
        const query = options.query || {};
        const current = this.session();
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
            if (value === undefined || value === null) {
                continue;
            }
            params.set(key, String(value));
        }
        if (options.sessionInQuery !== false) {
            // 匿名请求也要显式带上 uid=-1 与空 token，部分接口缺参会返回 402。
            params.set('uid', current.uid && current.token ? current.uid : '-1');
            params.set('token', current.uid && current.token ? current.token : '');
        }
        const suffix = params.toString();
        const url = API_ORIGIN + path + (suffix ? '?' + suffix : '');
        const init = {
            method: options.method || 'GET',
            headers: this.headers(options.headers),
        };
        if (options.body !== undefined) {
            init.method = init.method === 'GET' ? 'POST' : init.method;
            init.body = JSON.stringify(options.body);
            init.headers['Content-Type'] = 'application/json';
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        init.signal = controller.signal;
        let response;
        try {
            response = await fetch(url, init);
        } catch (error) {
            if (controller.signal.aborted) {
                throw makeError(504, '波点音乐请求超时，请重试', { retryable: true });
            }
            throw makeError(503, '无法连接波点音乐，请检查网络', { retryable: true });
        } finally {
            clearTimeout(timer);
        }
        if (!response.ok) {
            throw makeError(503, '波点音乐接口暂时不可用（' + response.status + '）', {
                retryable: response.status >= 500,
            });
        }
        let envelope;
        try {
            envelope = await response.json();
        } catch (error) {
            throw makeError(502, '波点音乐返回了无法解析的数据');
        }
        const code = Number(envelope && envelope.code);
        if (code !== 200) {
            this.raise(path, code, envelope && envelope.msg);
        }
        return (envelope && envelope.data) || {};
    }

    raise(path, code, message) {
        if (SIGNED_OUT_CODES.has(code)) {
            this.clearSession();
            throw makeError(401, '波点音乐登录已过期，请重新登录', { authExpired: true });
        }
        if (NO_STREAM_CODES.has(code)) {
            throw makeError(403, '波点音乐暂不提供这首歌的播放地址', {
                restriction: 'vip',
            });
        }
        const label = Number.isFinite(code) ? String(code) : '未知';
        const detail = typeof message === 'string' && message ? '：' + message : '';
        throw makeError(502, '波点音乐返回错误（' + label + '）' + detail);
    }

    /** 歌词接口独立于 JSON API，返回 base64 编码的 LRC 文本。 */
    async lyric(songId) {
        const plain = [
            'type=lyric',
            'req=2',
            'lrcx=0',
            'rid=' + encodeURIComponent(String(songId)),
            'songname=',
            'artist=',
            'corp=kuwo',
            'fromchannel=bodian',
        ].join('&');
        const encoded = Buffer.from(plain, 'utf8').toString('base64');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), LYRIC_TIMEOUT_MS);
        try {
            const response = await fetch(LYRIC_ORIGIN + '?f=bodian&q=' + encodeURIComponent(encoded), {
                headers: { 'User-Agent': USER_AGENT },
                signal: controller.signal,
            });
            const body = await response.json();
            const payload = (body && body.data) || body || {};
            const content = String(payload.content || '');
            if (!content) {
                return '';
            }
            return Buffer.from(content, 'base64').toString('utf8');
        } catch (error) {
            // 歌词缺失不应影响播放；上游超时或格式变化时返回空串。
            return '';
        } finally {
            clearTimeout(timer);
        }
    }
}

export { API_ORIGIN, USER_AGENT };
