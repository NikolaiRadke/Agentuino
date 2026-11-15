/*
 * Agentuino - Debugger for Agents (ArduDebug)
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Lets an agent stop the sketch at a line and read variables, with the
 * ArduDebug board package: avr8-stub on the board, ardudebug-bridge as GDB
 * server, avr-gdb from the package. Everything comes from "arduino-cli debug
 * --info", like ArduDebug for VS Code does it, so nothing is maintained twice.
 * Debug builds use the ArduDebug variant of the selected board, so a sketch
 * set to "Arduino AVR Boards" can be debugged too.
 *
 * Called through the wrappers agentuino-debug (sh) and agentuino-debug.cmd.
 *
 * Usage:
 *   agentuino-debug --break FILE:LINE [--break ...] [--print a,b] [--locals] [--hits N] [--seconds N]
 *   agentuino-debug --pause [--print a,b] [--locals] [--seconds N]
 *   --send TEXT [--no-newline]       input for Serial.read() during the run
 *   agentuino-debug --upload ...     upload the debug build first (only after the user agreed)
 *   agentuino-debug --restore        upload the normal build again (only after the user agreed)
 *
 * Messages are in English: they are read by the agent, not by the user.
 */

"use strict";

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { IS_WINDOWS, DEBUG_VENDOR, SUPPORTED_ARCH, compareVersions, getToolEnv, runCli, stopProcess, cutText, toDebugFqbn } = require('./toolUtils');

// ===== CONSTANTS =====

const DEFAULT_SECONDS = 15;
const MAX_SECONDS = 60;
const DEFAULT_HITS = 1;
const MAX_HITS = 10;
const MAX_BREAKPOINTS = 8;
const MS_PER_SECOND = 1000;
const BRIDGE_TIMEOUT_MS = 20000;
const GDB_COMMAND_TIMEOUT_MS = 15000;
// The first connection can fail while the stub syncs with GDB
const CONNECT_ATTEMPTS = 2;
// Builds go to the temp folder: sketchbooks are often synced (Dropbox, OneDrive)
const TEMP_DIR_NAME = 'agentuino-debug';
const HASH_LENGTH = 8;
// Board package version with plain-text Serial in debug builds and the monitor handoff
const MIN_ARDUDEBUG_VERSION = '1.8.8-5';
// The bridge writes its handoff port to <tmp>/ardudebug-bridge-<port name>
const HANDOFF_PREFIX = 'ardudebug-bridge-';
const HANDOFF_WAIT_MS = 3000;
const HANDOFF_POLL_MS = 100;
// Serial output still on its way when the program stops (USB, bridge, socket)
const SERIAL_SETTLE_MS = 200;
// A Leonardo can still be re-enumerating after the previous session
const BRIDGE_RETRY_DELAY_MS = 2000;
// Input is sent this long after the program was started; the stub buffers it until Serial.read()
const SEND_DELAY_MS = 500;
const BRIDGE_STATUS = /^(Info |Warn |Error|Debug)\s*:/;
// Lines of a failed arduino-cli call shown to the agent
const CLI_ERROR_LINES = 15;
const NORMAL_BUILD_DIR = 'normal';
const DEBUG_BUILD_DIR = 'build';
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_NOT_AVAILABLE = 2;
const EXIT_NO_DEBUG_BUILD = 3;
const EXIT_PORT = 4;

// ===== ARGUMENTS =====

const USAGE = [
    'Usage:',
    '  agentuino-debug --break FILE:LINE [--break ...] [--print a,b] [--locals] [--hits N] [--seconds N]',
    '  agentuino-debug --pause [--print a,b] [--locals] [--seconds N]',
    '',
    '  --break FILE:LINE  stop at this line, e.g. --break sketch.ino:25 (at most 8)',
    '  --print a,b        print these variables or expressions at each stop',
    '  --locals           print all local variables at each stop',
    `  --hits N           stop up to N times at the breakpoints (default ${DEFAULT_HITS}, at most ${MAX_HITS})`,
    `  --seconds N        wait at most N seconds (default ${DEFAULT_SECONDS}, at most ${MAX_SECONDS})`,
    '  --pause            let the program run for --seconds, then stop and show where it is',
    '  --send TEXT        send TEXT and a newline to the sketch once the run started (for Serial.read())',
    '  --no-newline       send TEXT without the newline (for sketches that read single characters)',
    '  --upload           upload the debug build first (only after the user agreed)',
    '  --restore          upload the normal build again (only if the user asks for it)',
    '  --port PORT        serial port, default: the port selected in the IDE',
    '',
    'setup() may already have run when the debugger attaches, so breakpoints there may not be reached.',
    `Exit codes: 0 ok, 1 error, 2 not available, ${EXIT_NO_DEBUG_BUILD} no debug build on the board, ${EXIT_PORT} port busy or missing.`
].join('\n');

/**
 * Parse the command line
 * @param {string[]} argv - Arguments
 * @returns {Object} Options
 */
function parseArgs(argv) {
    const options = { breaks: [], prints: [], locals: false, hits: DEFAULT_HITS, seconds: DEFAULT_SECONDS,
        pause: false, upload: false, restore: false, port: null, send: null, newline: true, help: false, unknown: [] };
    for (let i = 0; i < argv.length; i++) {
        const [key, inline] = argv[i].split(/=(.*)/s);
        const value = () => (inline !== undefined ? inline : argv[++i]) || '';
        switch (key) {
            case '--break': options.breaks.push(value()); break;
            case '--print': options.prints.push(...value().split(',').map(s => s.trim()).filter(Boolean)); break;
            case '--locals': options.locals = true; break;
            case '--hits': options.hits = Math.min(Math.max(Number(value()) || DEFAULT_HITS, 1), MAX_HITS); break;
            case '--seconds': options.seconds = Math.min(Math.max(Number(value()) || DEFAULT_SECONDS, 1), MAX_SECONDS); break;
            case '--pause': options.pause = true; break;
            case '--upload': options.upload = true; break;
            case '--restore': options.restore = true; break;
            case '--port': options.port = value(); break;
            case '--send': options.send = value(); break;
            case '--no-newline': options.newline = false; break;
            case '--help': case '-h': options.help = true; break;
            default: options.unknown.push(key); break;
        }
    }
    return options;
}

/**
 * Last lines of a failed arduino-cli call
 * @param {Object} result - From runCli
 * @returns {string} Error text
 */
function cliError(result) {
    return (result.stderr || result.stdout).trim().split('\n').slice(-CLI_ERROR_LINES).join('\n');
}

// ===== BRIDGE =====

/**
 * Find a free TCP port for the GDB connection
 * @returns {Promise<number>} Port
 */
function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

/**
 * Start ardudebug-bridge and wait until it accepts GDB
 * @param {Object} info - From "arduino-cli debug --info"
 * @param {number} gdbPort - TCP port
 * @param {string[]} serial - Collects the sketch's Serial output (text pieces)
 * @returns {Promise<ChildProcess>} Bridge process
 */
function startBridge(info, gdbPort, serial) {
    const cortex = info.custom_configs?.['cortex-debug'] || {};
    const scripts = info.server_configuration?.scripts || [];
    const args = ['-c', `gdb_port ${gdbPort}`, ...scripts.flatMap(s => ['-f', s]), ...(cortex.serverArgs || [])];

    return new Promise((resolve, reject) => {
        const bridge = spawn(info.server_path, args, { windowsHide: true, detached: !IS_WINDOWS });
        let listening = false;
        let warning = null;
        let buffer = '';
        const timer = setTimeout(() => fail(new Error('the bridge did not start')), BRIDGE_TIMEOUT_MS);
        const fail = (err) => {
            clearTimeout(timer);
            stopProcess(bridge);
            reject(err);
        };
        const onLine = (line) => {
            if (!BRIDGE_STATUS.test(line)) {
                if (listening) serial.push(`${line}\n`);
                return;
            }
            if (/^Error/.test(line)) {
                const err = new Error(line.replace(/^Error\s*:\s*/, ''));
                err.code = /busy|permission|denied/i.test(line) ? 'PORT' : 'BRIDGE';
                fail(err);
            } else if (/no answer from the board/i.test(line)) {
                warning = line;
            } else if (/Listening on port/i.test(line) && !listening) {
                listening = true;
                clearTimeout(timer);
                if (warning) {
                    const err = new Error(warning);
                    err.code = 'NO_DEBUG_BUILD';
                    stopProcess(bridge);
                    reject(err);
                } else {
                    resolve(bridge);
                }
            }
        };
        const onData = (chunk) => {
            buffer += chunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop();
            lines.forEach(onLine);
        };
        bridge.stdout.on('data', onData);
        bridge.stderr.on('data', onData);
        bridge.on('error', fail);
        bridge.on('exit', () => { if (!listening) fail(new Error('the bridge stopped')); });
    });
}

/**
 * Connect to the bridge's handoff port and send ATTACH
 * @param {number} tcpPort - Handoff port
 * @param {string[]} serial - Collects the sketch's Serial output
 * @returns {Promise<net.Socket|null>} Attached connection, null on failure
 */
function sendAttach(tcpPort, serial) {
    return new Promise(resolve => {
        const socket = net.connect(tcpPort, '127.0.0.1');
        let answer = '';
        let attached = false;
        const timer = setTimeout(() => done(null), HANDOFF_WAIT_MS);
        const done = (result) => {
            clearTimeout(timer);
            if (!result) socket.destroy();
            resolve(result);
        };
        socket.setEncoding('utf8');
        socket.on('connect', () => socket.write('ATTACH\n'));
        socket.on('data', text => {
            if (attached) {
                serial.push(text);
                return;
            }
            answer += text;
            const newline = answer.indexOf('\n');
            if (newline < 0) return;
            if (answer.slice(0, newline).trim() !== 'OK') return done(null);
            attached = true;
            if (answer.length > newline + 1) serial.push(answer.slice(newline + 1));
            done(socket);
        });
        socket.on('error', () => { if (!attached) done(null); });
    });
}

/**
 * Attach to the running bridge like a Serial Monitor (ArduDebug 1.8.8-5 and later).
 * While a monitor is attached (e.g. the IDE's), the bridge sends the Serial output
 * only to monitors, not to its stdout. Attaching ourselves gets the output in any case.
 * @param {string} port - Serial port of the board, e.g. /dev/ttyACM0 or COM3
 * @param {string[]} serial - Collects the sketch's Serial output
 * @returns {Promise<net.Socket|null>} Connection, null if the bridge offers none (older package)
 */
async function attachToBridge(port, serial) {
    const file = path.join(os.tmpdir(), `${HANDOFF_PREFIX}${path.basename(port)}`);
    const deadline = Date.now() + HANDOFF_WAIT_MS;
    // The file may not be written yet, or may be left over from an earlier session
    while (Date.now() < deadline) {
        let tcpPort = null;
        try {
            tcpPort = Number(fs.readFileSync(file, 'utf8').match(/(\d+)\s*$/)?.[1]) || null;
        } catch { /* not written yet */ }
        const socket = tcpPort ? await sendAttach(tcpPort, serial) : null;
        if (socket) return socket;
        await new Promise(r => setTimeout(r, HANDOFF_POLL_MS));
    }
    return null;
}

// ===== GDB (machine interface) =====

/**
 * Read a C string from GDB/MI output starting at the opening quote
 * @param {string} text - Text
 * @param {number} start - Index of the opening quote
 * @returns {{value: string, end: number}} Value and index after the closing quote
 */
function readMiString(text, start) {
    const ESCAPES = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
    let value = '';
    let i = start + 1;
    while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') {
            const next = text[i + 1];
            if (/[0-7]/.test(next)) {
                const octal = text.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0];
                value += String.fromCharCode(parseInt(octal, 8));
                i += 1 + octal.length;
                continue;
            }
            value += ESCAPES[next] ?? next;
            i += 2;
            continue;
        }
        value += text[i++];
    }
    return { value, end: i + 1 };
}

/**
 * Get the string value of a field like name="..." from an MI record
 * @param {string} record - MI record
 * @param {string} field - Field name
 * @returns {string|null} Value
 */
function miField(record, field) {
    const index = record.search(new RegExp(`(^|[,{\\[])${field}="`));
    if (index < 0) return null;
    return readMiString(record, record.indexOf('"', index)).value;
}

class Gdb {
    /**
     * @param {string} gdbPath - avr-gdb
     * @param {string} elf - Debug build
     * @param {string[]} serial - Collects target output (if the bridge passes it through)
     */
    constructor(gdbPath, elf, serial) {
        this.token = 0;
        this.pending = new Map();
        this.stopWaiters = [];
        this.buffer = '';
        this.serial = serial;
        this.process = spawn(gdbPath, ['--interpreter=mi2', '-nx', '-q', elf], { windowsHide: true, detached: !IS_WINDOWS });
        this.process.stdout.on('data', chunk => this.onData(chunk));
        this.process.stderr.on('data', () => {});
        this.process.on('error', err => this.failAll(err));
        this.process.on('exit', () => this.failAll(new Error('GDB stopped')));
    }

    onData(chunk) {
        this.buffer += chunk;
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop();
        for (const line of lines) {
            const result = line.match(/^(\d+)\^(\w+)(?:,(.*))?$/);
            if (result && this.pending.has(Number(result[1]))) {
                const { resolve } = this.pending.get(Number(result[1]));
                this.pending.delete(Number(result[1]));
                resolve({ status: result[2], body: result[3] || '' });
            } else if (line.startsWith('*stopped')) {
                const waiter = this.stopWaiters.shift();
                if (waiter) waiter(line);
                else this.lastStop = line;
            } else if (line.startsWith('@"')) {
                this.serial.push(readMiString(line, 1).value);
            }
        }
    }

    failAll(err) {
        for (const { reject } of this.pending.values()) reject(err);
        this.pending.clear();
    }

    /**
     * Send an MI command and wait for its result
     * @param {string} command - MI command
     * @returns {Promise<{status: string, body: string}>} Result
     */
    send(command) {
        const token = ++this.token;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(token);
                reject(new Error(`GDB did not answer: ${command}`));
            }, GDB_COMMAND_TIMEOUT_MS);
            this.pending.set(token, {
                resolve: (r) => { clearTimeout(timer); resolve(r); },
                reject: (e) => { clearTimeout(timer); reject(e); }
            });
            this.process.stdin.write(`${token}${command}\n`);
        });
    }

    /**
     * Wait for the program to stop
     * @param {number} timeoutMs - Maximum time
     * @returns {Promise<string|null>} *stopped record or null on timeout
     */
    waitForStop(timeoutMs) {
        if (this.lastStop) {
            const stop = this.lastStop;
            this.lastStop = null;
            return Promise.resolve(stop);
        }
        return new Promise(resolve => {
            const waiter = (line) => { clearTimeout(timer); resolve(line); };
            const timer = setTimeout(() => {
                this.stopWaiters = this.stopWaiters.filter(w => w !== waiter);
                resolve(null);
            }, timeoutMs);
            this.stopWaiters.push(waiter);
        });
    }

    /**
     * Run a console command (e.g. "skip -gfi ...")
     * @param {string} command - Console command
     */
    console(command) {
        return this.send(`-interpreter-exec console "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    }

    stop() {
        stopProcess(this.process);
    }
}

/**
 * Describe where the program stopped and read the requested values
 * @param {Gdb} gdb - GDB
 * @param {string} stop - *stopped record
 * @param {Object} options - {prints, locals}
 * @returns {Promise<string[]>} Report lines
 */
async function describeStop(gdb, stop, options) {
    const file = miField(stop, 'file');
    const line = miField(stop, 'line');
    const func = miField(stop, 'func');
    const where = file ? `${path.basename(file)}:${line} in ${func}()` : `${func || '?'}() (no source line, e.g. inside the Arduino core)`;
    const lines = [where];

    for (const expression of options.prints) {
        const result = await gdb.send(`-data-evaluate-expression "${expression.replace(/"/g, '\\"')}"`);
        lines.push(result.status === 'done'
            ? `  ${expression} = ${miField(result.body, 'value')}`
            : `  ${expression}: ${miField(result.body, 'msg')}`);
    }
    if (options.locals) {
        const result = await gdb.send('-stack-list-variables --simple-values');
        const variables = [...result.body.matchAll(/\{name="([^"]*)"(?:,arg="1")?(?:,type="(?:[^"\\]|\\.)*")?(?:,value="((?:[^"\\]|\\.)*)")?\}/g)];
        lines.push(variables.length
            ? `  locals: ${variables.map(v => `${v[1]} = ${v[2] !== undefined ? readMiString(`"${v[2]}"`, 0).value : '{…}'}`).join(', ')}`
            : '  locals: none');
    }
    return lines;
}

// ===== MAIN STEPS =====

/**
 * Compile (and optionally upload) a build
 * @param {Object} env - Tool settings
 * @param {string} fqbn - Board
 * @param {string} buildPath - Build folder
 * @param {boolean} debug - Debug build
 * @param {boolean} upload - Upload afterwards
 * @param {string} port - Serial port
 * @returns {Promise<string|null>} Error text or null
 */
async function build(env, fqbn, buildPath, debug, upload, port) {
    const args = ['compile', '-b', fqbn, '--build-path', buildPath];
    if (debug) args.push('--optimize-for-debug');
    const compiled = await runCli(env, [...args, env.sketch]);
    if (compiled.code !== 0) return `Compiling failed:\n${cliError(compiled)}`;
    if (!upload) return null;
    const uploaded = await runCli(env, ['upload', '-b', fqbn, '-p', port, '--input-dir', buildPath, env.sketch]);
    return uploaded.code === 0 ? null : `Upload failed:\n${cliError(uploaded)}`;
}

/**
 * Installed version of the ArduDebug board package
 * @param {Object} env - Tool settings
 * @returns {Promise<string|null>} Version, '' if installed but unknown, null if not installed
 */
async function getArdudebugVersion(env) {
    const result = await runCli(env, ['core', 'list', '--format', 'json']);
    if (result.code !== 0) return null;
    const id = `${DEBUG_VENDOR}:${SUPPORTED_ARCH}`;
    try {
        const data = JSON.parse(result.stdout);
        // arduino-cli 1.x: {platforms: [...]}, older versions: [...]
        const platforms = Array.isArray(data) ? data : (data.platforms || []);
        const platform = platforms.find(p => p.id === id);
        return platform ? String(platform.installed_version || platform.installed || '') : null;
    } catch {
        return result.stdout.includes(`"${id}"`) ? '' : null;
    }
}

/**
 * The debug run: bridge, GDB, breakpoints or pause, report
 * @param {Object} info - From "arduino-cli debug --info"
 * @param {Object} options - Parsed options
 * @param {string|null} port - Serial port for the monitor handoff, null to skip it (older package)
 * @returns {Promise<string[]>} Report lines
 */
async function debugRun(info, options, port) {
    const serial = [];
    let gdbPort = await freePort();
    let bridge;
    try {
        bridge = await startBridge(info, gdbPort, serial);
    } catch (err) {
        if (err.code !== 'NO_DEBUG_BUILD') throw err;
        // "No answer" right after a session can be a board that is still restarting
        await new Promise(r => setTimeout(r, BRIDGE_RETRY_DELAY_MS));
        gdbPort = await freePort();
        bridge = await startBridge(info, gdbPort, serial);
    }
    // The program waits for GDB, so no Serial output is lost before attaching
    const monitor = port ? await attachToBridge(port, serial) : null;
    const prefix = info.toolchain_prefix.endsWith('-') ? info.toolchain_prefix : `${info.toolchain_prefix}-`;
    const gdb = new Gdb(path.join(info.toolchain_path, `${prefix}gdb${IS_WINDOWS ? '.exe' : ''}`), info.executable, serial);
    const report = [];
    let stoppedOutput = null;
    let sent = false;
    // Input goes through the handoff connection, once, after the first continue
    const sendInput = () => {
        if (options.send === null || sent) return;
        sent = true;
        const text = options.newline ? `${options.send}\n` : options.send;
        setTimeout(() => { if (!monitor.destroyed) monitor.write(text); }, SEND_DELAY_MS);
    };

    try {
        if (options.send !== null && !monitor) {
            throw new Error('--send needs the ArduDebug board package 1.8.8-5 or newer (no connection to the bridge)');
        }
        // Without async mode GDB accepts no command (interrupt) while the program runs
        await gdb.send('-gdb-set mi-async on');
        let connected;
        for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
            connected = await gdb.send(`-target-select remote localhost:${gdbPort}`);
            if (connected.status !== 'error') break;
        }
        if (connected.status === 'error') throw new Error(`GDB could not connect: ${miField(connected.body, 'msg')}`);
        gdb.lastStop = null;

        // Launch commands from platform.txt, e.g. "skip -gfi */cores/arduino/*"
        const launch = info.custom_configs?.['cortex-debug']?.overrideLaunchCommands || [];
        for (const command of launch.filter(c => !c.trim().startsWith('echo'))) await gdb.console(command);

        for (const location of options.breaks) {
            const result = await gdb.send(`-break-insert ${location}`);
            if (result.status === 'error') report.push(`Breakpoint ${location} not set: ${miField(result.body, 'msg')}`);
        }

        const deadline = Date.now() + options.seconds * MS_PER_SECOND;
        if (options.pause) {
            await gdb.send('-exec-continue');
            sendInput();
            await new Promise(r => setTimeout(r, options.seconds * MS_PER_SECOND));
            await gdb.send('-exec-interrupt');
            const stop = await gdb.waitForStop(GDB_COMMAND_TIMEOUT_MS);
            report.push(...(stop ? await describeStop(gdb, stop, options) : ['The program did not pause.']).map(
                (l, i) => (i === 0 ? `Paused after ${options.seconds} s at ${l}` : l)));
        } else {
            for (let hit = 1; hit <= options.hits; hit++) {
                await gdb.send('-exec-continue');
                sendInput();
                const stop = await gdb.waitForStop(Math.max(deadline - Date.now(), 0));
                if (!stop) {
                    await gdb.send('-exec-interrupt');
                    const paused = await gdb.waitForStop(GDB_COMMAND_TIMEOUT_MS);
                    const where = paused ? (await describeStop(gdb, paused, { prints: [], locals: false }))[0] : '?';
                    report.push(`${hit === 1 ? 'No breakpoint' : 'No further breakpoint'} reached within ${options.seconds} s. The program was at ${where}.`);
                    break;
                }
                const lines = await describeStop(gdb, stop, options);
                report.push(`Hit ${hit} at ${lines[0]}`, ...lines.slice(1));
            }
        }

        // Keep only the output up to the stop: after detaching, the program runs on and
        // the amount read until the bridge stops would be random
        await new Promise(r => setTimeout(r, SERIAL_SETTLE_MS));
        stoppedOutput = serial.join('');

        // Leave the board running without breakpoints
        await gdb.send('-break-delete');
        await gdb.send('-target-detach');
        await gdb.send('-gdb-exit').catch(() => {});
    } finally {
        monitor?.destroy();
        gdb.stop();
        stopProcess(bridge);
    }

    // GDB delivers target output in pieces, the bridge in whole lines
    const output = cutText((stoppedOutput ?? serial.join('')).replace(/\r\n/g, '\n').trim());
    report.push(output ? `Serial output up to the stop:\n${output}` : 'No Serial output up to the stop.');
    return report;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help || options.unknown.length) {
        if (options.unknown.length) console.log(`Unknown option: ${options.unknown.join(' ')}`);
        console.log(USAGE);
        process.exit(options.help ? EXIT_OK : EXIT_ERROR);
    }
    const env = getToolEnv();
    const port = options.port || env.port;
    const sketchName = path.basename(env.sketch);
    const sketchHash = crypto.createHash('sha1').update(env.sketch).digest('hex').slice(0, HASH_LENGTH);
    const debugDir = path.join(os.tmpdir(), TEMP_DIR_NAME, `${sketchName}-${sketchHash}`);

    if (!fs.existsSync(path.join(env.sketch, `${sketchName}.ino`))) {
        console.log(`Not a sketch folder: ${env.sketch}`);
        process.exit(EXIT_ERROR);
    }
    if (!port) {
        console.log('No serial port known. Ask the user to connect the board and select the port in the IDE.');
        process.exit(EXIT_PORT);
    }

    // Back to the normal sketch
    if (options.restore) {
        const error = await build(env, env.fqbn, path.join(debugDir, NORMAL_BUILD_DIR), false, true, port);
        console.log(error || 'The normal build is on the board again.');
        process.exit(error ? EXIT_ERROR : EXIT_OK);
    }

    const debugFqbn = toDebugFqbn(env.fqbn);
    if (!debugFqbn) {
        console.log(`Debugging needs an AVR board (Uno, Nano, Leonardo, Mega …). Selected board: ${env.fqbn || 'none'}.`);
        process.exit(EXIT_NOT_AVAILABLE);
    }
    const ardudebugVersion = await getArdudebugVersion(env);
    if (ardudebugVersion === null) {
        console.log('The ArduDebug board package is not installed. See https://github.com/NikolaiRadke/ArduDebug');
        process.exit(EXIT_NOT_AVAILABLE);
    }
    const outdated = ardudebugVersion && compareVersions(ardudebugVersion, MIN_ARDUDEBUG_VERSION) < 0;
    if (outdated) {
        console.log(`Note: ArduDebug ${ardudebugVersion} is installed, ${MIN_ARDUDEBUG_VERSION} or newer is recommended`);
        console.log('(readable Serial in debug builds, Serial output with the Serial Monitor open, Leonardo fix on Windows).');
        console.log('Tell the user to update the ArduDebug board package in the Boards Manager.');
    }
    if (!options.pause && options.breaks.length === 0) {
        console.log('Give at least one --break FILE:LINE, or --pause.');
        process.exit(EXIT_ERROR);
    }
    if (options.breaks.length > MAX_BREAKPOINTS) {
        console.log(`At most ${MAX_BREAKPOINTS} breakpoints at a time.`);
        process.exit(EXIT_ERROR);
    }

    const buildPath = path.join(debugDir, DEBUG_BUILD_DIR);
    const buildError = await build(env, debugFqbn, buildPath, true, options.upload, port);
    if (buildError) {
        console.log(buildError);
        process.exit(EXIT_ERROR);
    }
    if (options.upload) console.log('Debug build uploaded.');

    const infoResult = await runCli(env, ['debug', '--info', '--format', 'json', '-b', debugFqbn, '--build-path', buildPath, '-p', port, env.sketch]);
    if (infoResult.code !== 0) {
        console.log(`No debug information: ${cliError(infoResult)}`);
        process.exit(EXIT_ERROR);
    }

    try {
        const report = await debugRun(JSON.parse(infoResult.stdout), options, outdated ? null : port);
        console.log(`--- ArduDebug run of ${sketchName} on ${port} ---`);
        report.forEach(line => console.log(line));
        console.log('--- breakpoints removed, the program keeps running (debug build) ---');
        process.exit(EXIT_OK);
    } catch (err) {
        if (err.code === 'NO_DEBUG_BUILD') {
            console.log('The board does not run a debug build. Ask the user whether to upload one,');
            console.log('then call agentuino-debug again with --upload.');
            process.exit(EXIT_NO_DEBUG_BUILD);
        }
        if (err.code === 'PORT') {
            console.log(`${err.message}`);
            console.log('Ask the user to close the Serial Monitor or a running debug session in the IDE.');
            process.exit(EXIT_PORT);
        }
        console.log(`Debugging failed: ${err.message}`);
        process.exit(EXIT_ERROR);
    }
}

main().catch(err => {
    console.log(`agentuino-debug failed: ${err.message}`);
    process.exit(EXIT_ERROR);
});
