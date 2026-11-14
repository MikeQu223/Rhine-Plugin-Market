'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 只公开兼容基底已有的请求实现和映射，分页模块直接引用锁定的上游包。
const exposeLegacy = {
    name: 'expose-legacy-netease-artist-songs',
    setup(build) {
        build.onLoad({ filter: /[/\\]legacy\.cjs$/ }, async (args) => {
            const source = await fs.promises.readFile(args.path, 'utf8');
            const contents = source.replace(
                /(?<!__rhineTmpdir \|\| )require\(["'](?:node:)?os["']\)\.tmpdir\(\)/g,
                '(globalThis.__rhineTmpdir || require("os").tmpdir())',
            );
            const exports = '\nmodule.exports = { ...module.exports, __rhine: {' +
                ' request: (...args) => require_request()(...args), songItem: parse } };\n';
            return { contents: contents + exports, loader: 'js', resolveDir: path.dirname(args.path) };
        });
        build.onResolve({ filter: /^@neteasecloudmusicapienhanced\/api\/module\/artist_songs\.js$/ }, () => {
            const root = process.env.RHINE_PANEL_ROOT || process.cwd();
            return { path: require.resolve('@neteasecloudmusicapienhanced/api/module/artist_songs.js', {
                paths: [path.join(root, 'MusicBridge')],
            }) };
        });
    },
};

module.exports = { plugins: [exposeLegacy] };
