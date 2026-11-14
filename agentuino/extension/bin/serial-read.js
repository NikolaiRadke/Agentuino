/*
 * Agentuino - Serial Reader for Agents
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Reads the serial output of the board for a fixed time and prints it, so an
 * agent can check what the sketch does. "arduino-cli monitor" itself runs until
 * it is interrupted, which would block the agent.
 *
 * Called through the wrappers agentuino-serial (sh) and agentuino-serial.cmd,
 * which run it with the IDE's own Node runtime. Agentuino passes the paths in
 * AGENTUINO_CLI, AGENTUINO_CLI_CONFIG and AGENTUINO_PORT.
 *
 * Usage: agentuino-serial [--seconds 10] [--baud 9600] [--port PORT] [--send TEXT [--no-newline]]
 *
 * Source: the serial port via arduino-cli monitor. If the port is busy because an
 * ArduDebug debug session holds it, the read is repeated with the ArduDebug
 * monitor (-b <ArduDebug FQBN>), which attaches to the bridge (package 1.8.8-5+).
 * Messages are in English: they are read by the agent, not by the user.
 */

"use strict";

const path = require('path');
const { spawn } = require('child_process');
const { detectSerialPort } = require(path.join(__dirname, '..', 'out', 'agents', 'toolDetector'));
const { buildEnv } = require(path.join(__dirname, '..', 'out', 'agents', 'agentUtils'));
const { IS_WINDOWS, stopProcess, cutText, toDebugFqbn } = require('./toolUtils');

// ===== CONSTANTS =====

const DEFAULT_SECONDS = 10;
const MAX_SECONDS = 60;
const DEFAULT_BAUD = 9600;
const MS_PER_SECOND = 1000;
// Opening the port resets an Uno; the bootloader needs a moment before the sketch runs
const SEND_DELAY_MS = 2000;
// Share of unreadable characters above which the output is probably garbage
const GARBAGE_RATIO = 0.3;
const BUSY_PATTERN = /busy|in use|access is denied|permission denied|zugriff verweigert/i;
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_BUSY = 2;
const EXIT_NO_PORT = 3;

const USAGE = [
    'Usage: agentuino-serial [--seconds N] [--baud N] [--port PORT] [--send TEXT [--no-newline]]',
    '',
    `  --seconds N   read for N seconds (default ${DEFAULT_SECONDS}, at most ${MAX_SECONDS})`,
    `  --baud N      baud rate, as in Serial.begin() (default ${DEFAULT_BAUD})`,
    '  --port PORT   serial port, default: the port selected in the IDE',
    '  --send TEXT   send TEXT and a newline to the sketch after the start (for Serial.read())',
    '  --no-newline  send TEXT without the newline (for sketches that read single characters)',
    '',
    'Works with normal and debug builds (ArduDebug), also during a debug session.',
    `Exit codes: 0 ok, 1 error, ${EXIT_BUSY} port busy, ${EXIT_NO_PORT} no port found.`
].join('\n');

/**
 * Parse the command line
 * @param {string[]} argv - Arguments
 * @returns {{seconds: number, baud: number, port: string|null, send: string|null, newline: boolean, help: boolean, unknown: string[]}} Options
 */
function parseArgs(argv) {
    const options = { seconds: DEFAULT_SECONDS, baud: DEFAULT_BAUD, port: null, send: null, newline: true, help: false, unknown: [] };
    for (let i = 0; i < argv.length; i++) {
        const [key, inline] = argv[i].split(/=(.*)/s);
        if (key === '--help' || key === '-h') {
            options.help = true;
            continue;
        }
        if (key === '--no-newline') {
            options.newline = false;
            continue;
        }
        if (!['--seconds', '--baud', '--port', '--send'].includes(key)) {
            options.unknown.push(key);
            continue;
        }
        const value = inline !== undefined ? inline : argv[++i];
        if (key === '--seconds') options.seconds = Math.min(Math.max(Number(value) || DEFAULT_SECONDS, 1), MAX_SECONDS);
        else if (key === '--baud') options.baud = Number(value) || DEFAULT_BAUD;
        else if (key === '--port') options.port = value || null;
        else if (key === '--send') options.send = value ?? null;
    }
    return options;
}

/**
 * Check whether the output is mostly unreadable (usually a wrong baud rate)
 * @param {string} text - Output
 * @returns {boolean} Probably garbage
 */
function looksLikeGarbage(text) {
    if (!text) return false;
    const unreadable = (text.match(/[^\x20-\x7E\t\r\nÄÖÜäöüß°µ]/g) || []).length;
    return unreadable / text.length > GARBAGE_RATIO;
}

/**
 * Read from the serial port for a fixed time
 * @param {Object} options - {cli, configFile, port, baud, seconds, send, newline, fqbn}
 * @returns {Promise<{output: string, error: string, early: boolean}>} Result
 */
function readPort({ cli, configFile, port, baud, seconds, send, newline, fqbn }) {
    const args = ['monitor', '-p', port, '--config', `baudrate=${baud}`, '--quiet'];
    // With a board, arduino-cli takes that board's monitor (e.g. ardudebug-monitor)
    if (fqbn) args.push('-b', fqbn);
    if (configFile) args.push('--config-file', configFile);

    return new Promise(resolve => {
        let output = '';
        let error = '';
        let finished = false;
        const child = spawn(cli, args, {
            env: buildEnv(null, { ARDUINO_UPDATER_ENABLE_NOTIFICATION: 'false' }),
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            detached: !IS_WINDOWS
        });
        const finish = (early) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            clearTimeout(sendTimer);
            resolve({ output, error, early });
        };
        const timer = setTimeout(() => {
            stopProcess(child);
            finish(false);
        }, seconds * MS_PER_SECOND);
        // Some sketches wait for input; stdin stays open, closing it would end the monitor
        const sendTimer = send === null ? null : setTimeout(() => child.stdin.write(newline ? `${send}\n` : send), SEND_DELAY_MS);

        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { error += chunk; });
        child.stdin.on('error', () => {});
        child.on('error', err => {
            error += err.message;
            finish(true);
        });
        child.on('close', () => finish(true));
    });
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help || options.unknown.length) {
        if (options.unknown.length) console.log(`Unknown option: ${options.unknown.join(' ')}`);
        console.log(USAGE);
        process.exit(options.help ? EXIT_OK : EXIT_ERROR);
    }
    const cli = process.env.AGENTUINO_CLI || 'arduino-cli';
    const configFile = process.env.AGENTUINO_CLI_CONFIG || null;
    const port = options.port || process.env.AGENTUINO_PORT || await detectSerialPort(cli, configFile);

    if (!port) {
        console.log('No serial port found (none or more than one board connected).');
        console.log('List the ports with "arduino-cli board list" and call agentuino-serial --port <PORT>,');
        console.log('or ask the user to connect the board.');
        process.exit(EXIT_NO_PORT);
    }

    const readOptions = { cli, configFile, port, baud: options.baud, seconds: options.seconds, send: options.send, newline: options.newline };
    let result = await readPort(readOptions);

    // Busy may mean a debug session: the ArduDebug monitor reads through the bridge
    const debugFqbn = toDebugFqbn(process.env.AGENTUINO_FQBN);
    if (result.early && BUSY_PATTERN.test(result.error) && debugFqbn) {
        const retry = await readPort({ ...readOptions, fqbn: debugFqbn });
        if (!(retry.early && retry.error.trim())) result = retry;
    }

    if (result.early && BUSY_PATTERN.test(result.error)) {
        console.log(`Port ${port} is busy. Probably the Serial Monitor of the Arduino IDE is open,`);
        console.log('or a debug session is running (ArduDebug). Ask the user to close it, then try again.');
        process.exit(EXIT_BUSY);
    }
    if (result.early && result.error.trim()) {
        console.log(`Reading ${port} failed: ${result.error.trim()}`);
        process.exit(EXIT_ERROR);
    }

    let text = result.output.replace(/\r\n/g, '\n');
    text = cutText(text);

    // Opening the port does not always reset the board: the sketch keeps running
    console.log(`--- Serial output of ${port} at ${options.baud} baud, ${options.seconds} s. The first line may be incomplete ---`);
    if (text.trim()) {
        process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
        console.log(`--- end, ${text.split('\n').filter(Boolean).length} lines ---`);
    } else {
        console.log(`--- no output within ${options.seconds} s ---`);
        console.log('Check: Serial.begin() baud rate, Serial.print() in the code, sketch uploaded.');
        console.log('After an upload the Serial Monitor of the IDE can keep the port in the background and take');
        console.log('the data, even when its tab looks closed. Then ask the user to open and close the Serial Monitor once.');
    }
    if (looksLikeGarbage(text)) {
        console.log('Note: the output is mostly unreadable. Probably the baud rate does not match Serial.begin().');
        console.log('Only a debug build uploaded with ArduDebug 1.8.8-3 or older sends no readable Serial output.');
        console.log('Do not interpret this output.');
    }
    process.exit(EXIT_OK);
}

main().catch(err => {
    console.log(`agentuino-serial failed: ${err.message}`);
    process.exit(EXIT_ERROR);
});
