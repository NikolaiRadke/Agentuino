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
 * Usage: agentuino-serial [--seconds 10] [--baud 9600] [--port PORT] [--send TEXT]
 *
 * Source today: the serial port via arduino-cli monitor. An ArduDebug debug
 * session (port held by the bridge) is planned as a second source.
 * Messages are in English: they are read by the agent, not by the user.
 */

"use strict";

const path = require('path');
const { spawn, execFile } = require('child_process');
const { detectSerialPort } = require(path.join(__dirname, '..', 'out', 'agents', 'toolDetector'));
const { buildEnv } = require(path.join(__dirname, '..', 'out', 'agents', 'agentUtils'));

// ===== CONSTANTS =====

const IS_WINDOWS = process.platform === 'win32';
const DEFAULT_SECONDS = 10;
const MAX_SECONDS = 60;
const DEFAULT_BAUD = 9600;
const MS_PER_SECOND = 1000;
// Opening the port resets an Uno; the bootloader needs a moment before the sketch runs
const SEND_DELAY_MS = 2000;
// Longer output keeps its start (setup messages) and its end
const KEEP_HEAD_CHARS = 4000;
const KEEP_TAIL_CHARS = 12000;
// Share of unreadable characters above which the output is probably garbage
const GARBAGE_RATIO = 0.3;
const BUSY_PATTERN = /busy|in use|access is denied|permission denied|zugriff verweigert/i;
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_BUSY = 2;
const EXIT_NO_PORT = 3;

/**
 * Parse the command line
 * @param {string[]} argv - Arguments
 * @returns {{seconds: number, baud: number, port: string|null, send: string|null}} Options
 */
function parseArgs(argv) {
    const options = { seconds: DEFAULT_SECONDS, baud: DEFAULT_BAUD, port: null, send: null };
    for (let i = 0; i < argv.length; i++) {
        const [key, inline] = argv[i].split(/=(.*)/s);
        const value = inline !== undefined ? inline : argv[++i];
        if (key === '--seconds') options.seconds = Math.min(Math.max(Number(value) || DEFAULT_SECONDS, 1), MAX_SECONDS);
        else if (key === '--baud') options.baud = Number(value) || DEFAULT_BAUD;
        else if (key === '--port') options.port = value || null;
        else if (key === '--send') options.send = value ?? null;
    }
    return options;
}

/**
 * Check whether the output is mostly unreadable (wrong baud rate or a debug build)
 * @param {string} text - Output
 * @returns {boolean} Probably garbage
 */
function looksLikeGarbage(text) {
    if (!text) return false;
    const unreadable = (text.match(/[^\x20-\x7E\t\r\nÄÖÜäöüß°µ]/g) || []).length;
    return unreadable / text.length > GARBAGE_RATIO;
}

/**
 * Stop arduino-cli monitor including its child processes
 * @param {ChildProcess} child - Monitor process
 */
function stopMonitor(child) {
    if (IS_WINDOWS) {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        return;
    }
    try {
        process.kill(-child.pid, 'SIGTERM');
    } catch {
        child.kill('SIGTERM');
    }
}

/**
 * Read from the serial port for a fixed time
 * @param {Object} options - {cli, configFile, port, baud, seconds, send}
 * @returns {Promise<{output: string, error: string, early: boolean}>} Result
 */
function readPort({ cli, configFile, port, baud, seconds, send }) {
    const args = ['monitor', '-p', port, '--config', `baudrate=${baud}`, '--quiet'];
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
            stopMonitor(child);
            finish(false);
        }, seconds * MS_PER_SECOND);
        // Some sketches wait for input; stdin stays open, closing it would end the monitor
        const sendTimer = send === null ? null : setTimeout(() => child.stdin.write(`${send}\n`), SEND_DELAY_MS);

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
    const cli = process.env.AGENTUINO_CLI || 'arduino-cli';
    const configFile = process.env.AGENTUINO_CLI_CONFIG || null;
    const port = options.port || process.env.AGENTUINO_PORT || await detectSerialPort(cli, configFile);

    if (!port) {
        console.log('No serial port found (none or more than one board connected).');
        console.log('List the ports with "arduino-cli board list" and call agentuino-serial --port <PORT>,');
        console.log('or ask the user to connect the board.');
        process.exit(EXIT_NO_PORT);
    }

    const result = await readPort({ cli, configFile, port, baud: options.baud, seconds: options.seconds, send: options.send });

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
    if (text.length > KEEP_HEAD_CHARS + KEEP_TAIL_CHARS) {
        const skipped = text.length - KEEP_HEAD_CHARS - KEEP_TAIL_CHARS;
        text = `${text.slice(0, KEEP_HEAD_CHARS)}\n… (${skipped} characters cut) …\n${text.slice(-KEEP_TAIL_CHARS)}`;
    }

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
        console.log('Note: the output is mostly unreadable. Either the baud rate does not match Serial.begin(),');
        console.log('or the sketch was uploaded with "Optimize for Debugging" (ArduDebug): then the serial port');
        console.log('belongs to the debugger. Do not interpret this output.');
    }
    process.exit(EXIT_OK);
}

main().catch(err => {
    console.log(`agentuino-serial failed: ${err.message}`);
    process.exit(EXIT_ERROR);
});
