/*
 * The tools Agentuino gives the agent: agentuino-serial and agentuino-debug,
 * called through their shell wrappers like the agent does
 */

"use strict";

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFile } = require('child_process');

const BIN = path.join(env.EXTENSION, 'bin');
const sketch = env.makeSketch('Tools');

/**
 * Run a tool wrapper with the variables Agentuino sets
 * @param {string} tool - agentuino-serial or agentuino-debug
 * @param {string[]} args - Arguments
 * @param {Object} vars - Extra variables
 * @returns {Promise<{code: number, out: string}>} Exit code and output
 */
function runTool(tool, args, vars = {}) {
    const variables = {
        ...process.env,
        AGENTUINO_NODE: process.execPath,
        AGENTUINO_CLI: env.fake('arduino-cli'),
        AGENTUINO_SKETCH: sketch,
        AGENTUINO_FQBN: 'arduino:avr:uno',
        ...vars
    };
    return new Promise(resolve => {
        execFile(path.join(BIN, tool), args, { env: variables, cwd: sketch }, (error, stdout) => {
            resolve({ code: error ? error.code : 0, out: stdout });
        });
    });
}

test('serial: reads for the given time at the given baud rate', async () => {
    const { code, out } = await runTool('agentuino-serial', ['--seconds', '1', '--baud', '115200'], { AGENTUINO_PORT: '/dev/ttyACM0' });
    assert.equal(code, 0);
    assert.match(out, /Serial output of \/dev\/ttyACM0 at 115200 baud/);
    assert.match(out, /hello at 115200/);
    assert.match(out, /tick \d+/);
});

test('serial: finds the only USB port itself', async () => {
    const { code, out } = await runTool('agentuino-serial', ['--seconds', '1']);
    assert.equal(code, 0);
    assert.match(out, /\/dev\/ttyACM0 at 9600 baud/);
});

test('serial: a busy port gets a hint about the Serial Monitor', async () => {
    const { code, out } = await runTool('agentuino-serial', ['--seconds', '1', '--port', '/dev/busy0']);
    assert.equal(code, 2);
    assert.match(out, /busy.*Serial Monitor/s);
});

test('serial: sends a line to sketches that wait for input', async () => {
    const { out } = await runTool('agentuino-serial', ['--seconds', '3', '--send', 'start'], { AGENTUINO_PORT: '/dev/ttyACM0' });
    assert.match(out, /echo start/);
});

test('debug: without the ArduDebug package the agent gets a clear answer', async () => {
    const { code, out } = await runTool('agentuino-debug', ['--break', 'Tools.ino:2'], { AGENTUINO_PORT: '/dev/ttyACM0' });
    assert.equal(code, 2);
    assert.match(out, /ArduDebug board package is not installed/);
});

test('debug: only for AVR boards', async () => {
    const { code, out } = await runTool('agentuino-debug', ['--break', 'Tools.ino:2'], { AGENTUINO_PORT: '/dev/ttyACM0', AGENTUINO_FQBN: 'esp32:esp32:esp32' });
    assert.equal(code, 2);
    assert.match(out, /needs an AVR board/);
});
