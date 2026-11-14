'use strict';

const fs = require('node:fs');

// 仅暴露兼容基底中已打包的上游接口和原有映射，不改写上游实现。
const exposeLegacy = {
    name: 'expose-legacy-qq-artist-songs',
    setup(build) {
        build.onLoad({ filter: /[/\\]legacy\.cjs$/ }, async (args) => {
            const source = await fs.promises.readFile(args.path, 'utf8');
            const contents = source.replace(
                /(?<!__rhineTmpdir \|\| )require\(["'](?:node:)?os["']\)\.tmpdir\(\)/g,
                '(globalThis.__rhineTmpdir || require("os").tmpdir())',
            );
            const exports = '\nmodule.exports = { ...module.exports, __rhine: {' +
                ' singerSongs: require_catalog3().singerSongsResult, songItem: qqItem } };\n';
            return { contents: contents + exports, loader: 'js', resolveDir: require('node:path').dirname(args.path) };
        });
    },
};

module.exports = { plugins: [exposeLegacy] };
