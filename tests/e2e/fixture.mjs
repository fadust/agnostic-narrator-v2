import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMock } from './mock-llm.mjs';

const hostFiles = ['server.js', 'package.json', 'webpack.config.js', 'src', 'public', 'default', 'node_modules'];
const omitted = ['public/scripts/extensions/third-party', 'node_modules/.cache', 'node_modules/.bin'].map(p => p.split('/').join(sep));

async function availableLoopbackPort() {
    const socket = createServer();
    await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.listen(0, '127.0.0.1', resolve);
    });
    const { port } = socket.address();
    await new Promise(resolve => socket.close(resolve));
    return port;
}

/** ST_DIR supplies host code and installed dependencies. All writes go to a fresh fixture. */
export async function startFixture(source, extensionRoot, chromium) {
    if (!source || !existsSync(join(source, 'server.js')) || !existsSync(join(source, 'node_modules'))) {
        throw new Error('Set ST_DIR to a SillyTavern checkout with npm dependencies installed.');
    }
    const sourceRoot = realpathSync(source);
    const tempRoot = mkdtempSync(join(realpathSync(tmpdir()), 'nd-e2e-'));
    const host = join(tempRoot, 'host');
    const dataRoot = join(tempRoot, 'profile');
    let mock, child, browser, cleanup;

    async function stopHost() {
        if (!child) return;
        child.process.kill();
        await child.closed;
        child = undefined;
    }

    function close() {
        cleanup ??= (async () => {
            try {
                await browser?.close();
            } finally {
                try {
                    await stopHost();
                } finally {
                    if (mock) {
                        const closed = new Promise(resolve => mock.server.close(resolve));
                        mock.server.closeAllConnections();
                        await closed;
                    }
                    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
                }
            }
        })();
        return cleanup;
    }

    try {
        for (const file of hostFiles) {
            cpSync(join(sourceRoot, file), join(host, file), {
                recursive: true,
                dereference: true,
                filter: path => !omitted.includes(relative(sourceRoot, path)),
            });
        }
        const extension = join(host, 'public/scripts/extensions/third-party/narrator-director');
        for (const file of ['index.js', 'manifest.json', 'style.css', 'core', 'st']) {
            cpSync(join(extensionRoot, file), join(extension, file), { recursive: true, dereference: true });
        }
        mock = await startMock(0);
        const port = await availableLoopbackPort();
        const baseURL = `http://127.0.0.1:${port}`;
        const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^SILLYTAVERN_/i.test(name)));
        Object.assign(env, { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' });

        async function startHost() {
            const config = join(host, 'config.yaml');
            const server = spawn(process.execPath, [
                join(host, 'server.js'), '--configPath', config, '--dataRoot', dataRoot, '--port', String(port),
                '--listen', 'false', '--browserLaunchEnabled', 'false',
            ], { cwd: host, env, stdio: ['ignore', 'pipe', 'pipe'] });
            child = { process: server, closed: new Promise(resolve => server.once('close', resolve)) };
            let output = '', ended = false;
            const collect = chunk => { output = (output + chunk).slice(-12000); };
            server.stdout.on('data', collect);
            server.stderr.on('data', collect);
            server.on('error', error => { collect(error.message); ended = true; });
            server.once('exit', () => { ended = true; });
            for (let attempt = 0; attempt < 120 && !ended; attempt++) {
                if (output.includes('SillyTavern is listening on')) {
                    try {
                        if ((await fetch(baseURL, { signal: AbortSignal.timeout(1500) })).ok) return;
                    } catch { /* The listener is still starting. */ }
                }
                await sleep(500);
            }
            throw new Error(`Fixture SillyTavern did not start.\n${output}`);
        }

        await startHost();
        await stopHost();
        const settingsPath = join(dataRoot, 'default-user/settings.json');
        const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
        Object.assign(settings, { firstRun: false, main_api: 'openai', username: 'Rowan' });
        Object.assign(settings.oai_settings, {
            chat_completion_source: 'custom', custom_url: `http://127.0.0.1:${mock.port}/v1`,
            custom_model: 'mock', stream_openai: false, openai_max_context: 32000,
        });
        settings.power_user.auto_connect = true;
        writeFileSync(settingsPath, JSON.stringify(settings));
        await startHost();

        browser = await chromium.launch();
        const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
        const restart = async () => {
            await stopHost();
            await startHost();
        };
        return { baseURL, page, mock, close, restart };
    } catch (error) {
        await close();
        throw error;
    }
}
