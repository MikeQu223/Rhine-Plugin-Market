'use strict';

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createRequire, isBuiltin } = require('node:module');
const path = require('node:path');

const marketRoot = path.resolve(__dirname, '..');
const panelRoot = path.resolve(process.env.RHINE_PANEL_ROOT || path.join(marketRoot, '..', 'RhineMusicPanel'));
const indexFile = path.join(marketRoot, 'index.json');
const packageCli = path.join(panelRoot, 'scripts', 'plugin-package.cjs');
const releaseTag = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;

// 已核对这些发行产物中的可选分支。缺失时走包内回退，不进入安装包。
const optionalPackages = {
    netease: new Set(['canvas', 'bufferutil', 'utf-8-validate']),
    qq: new Set(['supports-color', 'bufferutil', 'utf-8-validate']),
    kugou: new Set(['supports-color']),
};

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assetName(plugin) {
    const { id, version } = plugin;
    const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
    if (!/^[a-z0-9-]{1,40}$/.test(id) || !versionPattern.test(version)) {
        throw new Error('插件包文件名无法从 id/version 生成');
    }
    return id + '-' + version.replace('+', '_') + '.rhineplugin';
}

function marketFiles(plugin, manifest) {
    const listed = new Set([plugin.entry.file, ...plugin.files.map((file) => file.path ?? file)]);
    const declared = new Set([manifest.entry.file, ...manifest.files.map((file) => file.path)]);
    if (plugin.entry.file !== manifest.entry.file || listed.size !== declared.size ||
        [...listed].some((file) => !declared.has(file))) {
        throw new Error('市场索引与安装包的运行时文件不一致：' + plugin.id);
    }
    return declared;
}

/** 复用 SDK 构建所用的 esbuild 检查可解析的 JS 运行依赖，不执行插件入口。 */
async function verifyDependencies(esbuild, directory, id, files) {
    const result = await esbuild.build({
        absWorkingDir: directory,
        entryPoints: [...files].filter((file) => /\.[cm]?js$/.test(file)),
        outdir: 'dist',
        bundle: true,
        write: false,
        metafile: true,
        platform: 'node',
        target: 'node18',
        logLevel: 'silent',
        external: id === 'netease' ? ['@/utils/request'] : [],
    });
    for (const [inputFile, input] of Object.entries(result.metafile.inputs)) {
        if (!files.has(inputFile)) {
            throw new Error(id + ' 依赖未打包的文件：' + inputFile);
        }
        for (const imported of input.imports) {
            if (!imported.external || isBuiltin(imported.path)) {
                continue;
            }
            if (optionalPackages[id]?.has(imported.path) && imported.kind === 'require-call') {
                continue;
            }
            // 网易云入口给这两份上游脚本注入包内 request，原始 import 不会保留。
            const isInjectedRequest = id === 'netease' && imported.path === '@/utils/request' &&
                (inputFile === 'upstream/auth.js' || inputFile === 'upstream/user.js');
            const relativeFile = path.posix.normalize(path.posix.join(path.posix.dirname(inputFile), imported.path));
            if (isInjectedRequest || (imported.path.startsWith('./') && files.has(relativeFile))) {
                continue;
            }
            throw new Error(id + ' 依赖未打包的模块：' + imported.path);
        }
    }
}

/** 用同一份 SDK CLI 为文件分发和市场下载生成字节完全相同的产物。 */
async function buildPackages() {
    const output = path.join(marketRoot, 'plugins');
    const esbuild = createRequire(path.join(panelRoot, 'package.json'))('esbuild');
    const { validatePluginDirectory } = require(path.join(panelRoot, 'MusicBridge', 'plugin-package.cjs'));
    const { createHostContext, safeRelativePath } = require(
        path.join(panelRoot, 'MusicBridge/plugins/sdk/compatibility.cjs'),
    );
    const clientVersion = (process.env.RHINE_RELEASE_CLIENT_VERSION || '').replace(/^v/, '');
    if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(clientVersion)) {
        throw new Error('RHINE_RELEASE_CLIENT_VERSION 必须是 vMAJOR.MINOR.PATCH 或 MAJOR.MINOR.PATCH');
    }
    const packageIndex = readJson(indexFile);
    const run = (script, ...args) => execFileSync(process.execPath, [script, ...args], { stdio: 'inherit' });
    run(path.join(panelRoot, 'scripts', 'check-marketplace.cjs'), indexFile);
    const host = createHostContext({ clientVersion });
    const staging = fs.mkdtempSync(path.join(marketRoot, '.rhineplugin-'));
    const artifacts = [];
    try {
        for (const plugin of packageIndex.plugins) {
            const name = assetName(plugin);
            const relativeDirectory = plugin.path || 'plugins/' + plugin.id;
            if (!safeRelativePath(relativeDirectory)) {
                throw new Error('市场插件目录无效：' + plugin.id);
            }
            const directory = path.join(marketRoot, relativeDirectory);
            if (path.relative(directory, fs.realpathSync(directory)) !== '') {
                throw new Error('市场插件目录不得经过符号链接：' + plugin.id);
            }
            const manifest = await validatePluginDirectory(directory, {
                expected: plugin,
                host,
                requireDeclarations: true,
                skipNoise: true,
            });
            await verifyDependencies(esbuild, directory, plugin.id, marketFiles(plugin, manifest));
            const archive = path.join(staging, name);
            execFileSync(process.execPath, [packageCli, 'pack', directory, '--out', archive], {
                stdio: ['ignore', 'ignore', 'inherit'],
            });
            run(packageCli, 'verify', archive);

            artifacts.push(name);
        }
        for (const name of artifacts) {
            const target = path.join(output, name);
            fs.renameSync(path.join(staging, name), target);
            console.log('产物 ' + target);
        }
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
}

/** 只为 digest 与本次生成包一致、且已公开发布的附件生成索引。 */
function prepareIndex(releaseFile, artifacts, repository) {
    const index = readJson(indexFile);
    const release = readJson(releaseFile);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !releaseTag.test(release.tag_name) ||
        release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) {
        throw new Error('市场索引要求同仓库的正式 Release');
    }
    for (const plugin of index.plugins) {
        const name = assetName(plugin);
        const bytes = fs.readFileSync(path.join(artifacts, name));
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        const url = 'https://github.com/' + repository + '/releases/download/' + release.tag_name + '/' + name;
        const asset = release.assets.find((item) => item.name === name);
        if (!asset || asset.state !== 'uploaded' || asset.size !== bytes.length ||
            asset.digest !== 'sha256:' + sha256 || asset.browser_download_url !== url) {
            throw new Error('正式 Release 附件与本地安装包不一致：' + name);
        }
        plugin.package = { url, size: bytes.length, sha256 };
    }
    const result = path.join(artifacts, 'index.json');
    fs.writeFileSync(result, JSON.stringify(index, null, 4) + '\n', { flag: 'wx' });
    console.log('待核对的市场索引：' + result);
}

async function main([command, first, second, third]) {
    if (command === 'build' && first === undefined) {
        await buildPackages();
    } else if (command === 'index' && first && second && third) {
        prepareIndex(path.resolve(first), path.resolve(second), third);
    } else {
        throw new Error('用法：release-plugins.cjs build | index <release.json> <包目录> <owner/repo>');
    }
}

main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
