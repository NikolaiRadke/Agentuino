/*
 * agentConfigs.json and the code that reads it
 */

"use strict";

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const agentConfig = env.ext('out/agents/agentConfig.js');
const registry = env.ext('out/agents/registry.js');

const BUNDLED = path.join(env.EXTENSION, 'config', 'agentConfigs.json');
const bundled = () => JSON.parse(fs.readFileSync(BUNDLED, 'utf8'));
const IDS = registry.getAll().map(adapter => adapter.id);

test('shipped file is valid and has an entry for every adapter', () => {
    assert.equal(agentConfig.validate(bundled(), IDS), null);
    assert.deepEqual(IDS, ['claudecode', 'codex', 'vibe', 'antigravity']);
});

test('one bad field rejects the whole file', () => {
    const cases = [
        [config => { config.schema = 2; }, 'schema 2'],
        [config => { config.version = '13.11.2026'; }, 'version'],
        [config => { delete config.agents.vibe; }, 'vibe.entry'],
        [config => { config.agents.claudecode.installUrl = 'http://claude.ai'; }, 'claudecode.installUrl'],
        [config => { config.agents.codex.args.resume = ['resume']; }, 'codex.args.resume'],
        [config => { config.agents.antigravity.sessionNotFound = '(unclosed'; }, 'antigravity.sessionNotFound'],
        [config => { config.agents.vibe.minVersion = '3'; }, 'vibe.minVersion'],
        // Install locations and the command must name the agent, not another program
        [config => { config.agents.antigravity.candidates.unix.push('/tmp/evil'); }, 'antigravity.candidates'],
        [config => { config.agents.codex.command = '/bin/sh'; }, 'codex.command']
    ];
    for (const [change, expected] of cases) {
        const config = bundled();
        change(config);
        assert.equal(agentConfig.validate(config, IDS), expected);
    }
});

test('versions compare by date and counter', () => {
    assert.ok(agentConfig.isNewer('2026-11-14', '2026-11-13'));
    assert.ok(agentConfig.isNewer('2026-11-13-2', '2026-11-13'));
    assert.ok(!agentConfig.isNewer('2026-11-13', '2026-11-13-1'));
    assert.ok(!agentConfig.isNewer('garbage', '2026-01-01'));
});

test('command lines are built in the order base, instructions, permissions, model, resume, tail', () => {
    const args = id => options => registry.get(id).buildArgs({ permissionMode: 'bypassPermissions', ...options });
    assert.deepEqual(args('claudecode')({ sessionId: 's1', model: 'opus', instructionsFile: 'agentuino/AGENTS.md' }), [
        '-p', '--output-format', 'stream-json', '--verbose',
        '--append-system-prompt-file', 'agentuino/AGENTS.md',
        '--permission-mode', 'bypassPermissions', '--model', 'opus', '--resume', 's1'
    ]);
    assert.deepEqual(args('codex')({ sessionId: 't1' }).slice(-3), ['resume', 't1', '-']);
    // Vibe takes the model only for a new session
    assert.ok(args('vibe')({ model: 'devstral', runDir: '/r' }).includes('devstral'));
    assert.ok(!args('vibe')({ model: 'devstral', runDir: '/r', sessionId: 'v1' }).includes('devstral'));
    assert.deepEqual(args('antigravity')({ permissionMode: 'acceptEdits', sessionId: 'a1' }), [
        '--output-format', 'stream-json', '--input-format', 'stream-json', '--mode', 'accept-edits', '--conversation', 'a1'
    ]);
    // Unknown mode falls back to the default
    assert.ok(args('claudecode')({ permissionMode: 'nonsense' }).includes('bypassPermissions'));
});

test('install locations fill in home and Windows folders', () => {
    const agent = { candidates: { unix: ['{home}/.local/bin/x'], windows: ['{appData}/npm/x.cmd', '{localAppData}/x/bin/x.exe', '{unknown}/x'] } };
    assert.deepEqual(agentConfig.expandCandidates(agent, false), [path.join(env.HOME, '.local', 'bin', 'x')]);
    process.env.APPDATA = path.join(env.TMP, 'Roaming');
    process.env.LOCALAPPDATA = path.join(env.TMP, 'Local');
    assert.deepEqual(agentConfig.expandCandidates(agent, true), [
        path.join(env.TMP, 'Roaming', 'npm', 'x.cmd'),
        path.join(env.TMP, 'Local', 'x', 'bin', 'x.exe'),
        path.normalize('{unknown}/x')
    ]);
});

test('a stored download is used only when it is newer and valid', () => {
    const userFile = path.join(agentConfig.USER_DIR, 'agentConfigs.json');
    fs.mkdirSync(agentConfig.USER_DIR, { recursive: true });

    const newer = bundled();
    newer.version = '2099-01-01';
    newer.agents.claudecode.name = 'Claude Code (downloaded)';
    fs.writeFileSync(userFile, JSON.stringify(newer));
    assert.equal(agentConfig.load(IDS).source, 'downloaded');
    assert.equal(registry.get('claudecode').name, 'Claude Code (downloaded)');

    // Older than the shipped file (after an extension update)
    newer.version = '2000-01-01';
    fs.writeFileSync(userFile, JSON.stringify(newer));
    assert.equal(agentConfig.load(IDS).source, 'bundled');

    // Newer but without the antigravity entry (written by an older extension)
    newer.version = '2099-01-01';
    delete newer.agents.antigravity;
    fs.writeFileSync(userFile, JSON.stringify(newer));
    assert.equal(agentConfig.load(IDS).source, 'bundled');
    assert.equal(registry.get('claudecode').name, 'Claude Code');

    fs.rmSync(userFile);
});

test('Windows: arguments are quoted for cmd.exe', () => {
    const { quoteShellArg } = env.ext('out/agents/agentUtils.js');
    assert.equal(quoteShellArg('--resume'), '--resume');
    assert.equal(quoteShellArg('agentuino/AGENTS.md'), 'agentuino/AGENTS.md');
    assert.equal(quoteShellArg('C:\\Users\\Max Mustermann\\Temp'), '"C:\\Users\\Max Mustermann\\Temp"');
    assert.equal(quoteShellArg('x & calc'), '"x & calc"');
    assert.equal(quoteShellArg('say "hi"'), '"say ""hi"""');
    assert.equal(quoteShellArg(''), '""');
});
