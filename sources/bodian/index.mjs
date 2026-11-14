// 波点音乐插件入口：只按 manifest 白名单分派，平台语义留在 adapter。

import { BodianApi } from './adapter.mjs';

export function create(host) {
    const manifest = host.manifest || {};
    const operations = new Set(
        Object.entries(manifest.operations || {})
            .filter(([, enabled]) => enabled)
            .map(([name]) => name),
    );
    const api = new BodianApi(host);
    return {
        async dispatchNative(operation, args) {
            if (!operations.has(operation) || typeof api[operation] !== 'function') {
                const error = new Error('此来源不支持该接口');
                error.code = 400;
                throw error;
            }
            return api[operation].apply(api, args || []);
        },
        async capabilities() {
            return manifest.capabilities || {};
        },
    };
}
