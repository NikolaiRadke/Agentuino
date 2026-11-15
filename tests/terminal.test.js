/*
 * Opening the login in the system terminal (Linux: first terminal found in PATH)
 */

"use strict";

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openInTerminal } = env.ext('out/utils/terminal.js');

const linux = process.platform === 'linux';

test('terminal: runs the agent in the first terminal found and keeps it open', { skip: !linux }, async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'agentuino-term-'));
    const log = path.join(bin, 'args.json');
    const fake = path.join(bin, 'konsole');
    fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n`, { mode: 0o755 });
    const savedPath = process.env.PATH;
    const savedShell = process.env.SHELL;
    process.env.PATH = `${bin}${path.delimiter}${path.dirname(process.execPath)}`;
    process.env.SHELL = '/bin/bash';
    try {
        const sketch = env.makeSketch('Login');
        assert.equal(await openInTerminal('/home/x/.local/bin/codex', ['login'], sketch), true);
        for (let i = 0; i < 50 && !fs.existsSync(log); i++) await new Promise(r => setTimeout(r, 20));
        const call = JSON.parse(fs.readFileSync(log, 'utf8'));
        assert.deepEqual(call.args, ['-e', '/bin/bash', '-c', '/home/x/.local/bin/codex login; exec /bin/bash']);
        assert.equal(call.cwd, sketch);
    } finally {
        process.env.PATH = savedPath;
        process.env.SHELL = savedShell;
        fs.rmSync(bin, { recursive: true, force: true });
    }
});

test('terminal: no terminal found', { skip: !linux }, async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
        assert.equal(await openInTerminal('claude', [], os.tmpdir()), false);
    } finally {
        process.env.PATH = savedPath;
    }
});
