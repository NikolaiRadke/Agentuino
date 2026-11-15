/*
 * The four agent adapters, each through the real runner against a fake CLI
 * that speaks the agent's output format
 */

"use strict";

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const registry = env.ext('out/agents/registry.js');
const { AgentRunner } = env.ext('out/agents/agentRunner.js');

const FAKES = { claudecode: 'claude', codex: 'codex', vibe: 'vibe', antigravity: 'agy' };
const EXPECTED = {
    claudecode: { session: 'claude-session-1', text: 'Written.', tool: 'Write' },
    codex: { session: 'codex-thread-1', text: 'Codex answer.', tool: 'Bash' },
    vibe: { session: 'vibe-session-1', text: 'Vibe answer.', tool: 'Edit' },
    antigravity: { session: 'agy-conversation-1', text: 'Agy answer.', tool: 'Read' }
};

const sketch = env.makeSketch('Test');

/**
 * Run one agent
 * @param {string} id - Agent ID
 * @param {string} prompt - Prompt
 * @param {string|null} sessionId - Session to resume
 * @returns {Promise<{result: Object, events: Object[]}>} Result and chat events
 */
async function run(id, prompt, sessionId = null) {
    const events = [];
    const result = await new AgentRunner().run({
        adapter: registry.get(id),
        toolPath: env.fake(FAKES[id]),
        prompt,
        cwd: sketch,
        sessionId,
        permissionMode: 'bypassPermissions',
        instructionsFile: 'agentuino/AGENTS.md',
        onEvent: event => events.push(event)
    });
    return { result, events };
}

for (const id of Object.keys(FAKES)) {
    test(`${id}: session, text and tool activity`, async () => {
        const { result, events } = await run(id, 'WRITE_OK please');
        const expected = EXPECTED[id];
        assert.equal(result.isError, false);
        assert.equal(result.sessionId, expected.session);
        // Vibe reports its session only at the end (export.json)
        if (id !== 'vibe') assert.ok(events.some(e => e.type === 'init' && e.sessionId === expected.session));
        assert.ok(events.some(e => e.type === 'text' && e.text.includes(expected.text)), JSON.stringify(events));
        const tool = events.find(e => e.type === 'tool' && e.name === expected.tool);
        assert.ok(tool, JSON.stringify(events));
        // File paths are shown relative to the sketch
        assert.equal(tool.detail, expected.tool === 'Bash' ? 'arduino-cli compile .' : 'Test.ino');
    });

    test(`${id}: resumes the session`, async () => {
        const { result } = await run(id, 'next question', 'earlier');
        assert.equal(result.sessionId, 'earlier');
        assert.ok(env.agentCalls().pop().args.includes('earlier'));
    });

    test(`${id}: expired login is reported as auth error`, async () => {
        const { result } = await run(id, 'AUTH_FAIL');
        assert.equal(result.isError, true);
        assert.equal(result.errorType, 'auth');
    });
}

for (const id of ['claudecode', 'codex', 'vibe']) {
    test(`${id}: a lost session is reported so the chat can start a new one`, async () => {
        await assert.rejects(run(id, 'hello', 'gone'), { code: 'SESSION_NOT_FOUND' });
    });
}

test('antigravity: prompt goes in as one JSON line', async () => {
    await run('antigravity', 'Line one\n"quoted"');
    const call = env.agentCalls().pop();
    assert.equal(call.input.trim().split('\n').length, 1);
    assert.equal(call.prompt, 'Line one\n"quoted"');
});

test('antigravity: unknown tool parameters still show a file', () => {
    const parser = registry.get('antigravity').createParser({ cwd: sketch, sessionId: null });
    const tool = parameters => parser.onEvent({
        event: 'step_update',
        step_update: { conversation_id: 'c', step_index: Math.random(), state: 'DONE', step_type: 'tool', tool_info: { name: 'replace_file_content', parameters } }
    }).find(e => e.type === 'tool');
    assert.deepEqual(tool({ TargetFile: `${sketch}/Test.ino` }), { type: 'tool', name: 'Edit', detail: 'Test.ino' });
    assert.equal(tool({ someFileUri: `file://${sketch}/src/a.h` }).detail, 'src/a.h');
    assert.equal(tool(JSON.stringify({ Path: `${sketch}/Test.ino` })).detail, 'Test.ino');
});

test('shell output: claudecode, codex and vibe pass it on for shell calls only', () => {
    const outputs = (id, events) => {
        const parser = registry.get(id).createParser({ cwd: sketch, sessionId: null });
        return events.flatMap(e => parser.onEvent(e)).filter(e => e.type === 'tool' || e.type === 'toolOutput');
    };

    const claude = outputs('claudecode', [
        { type: 'assistant', message: { content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'agentuino-serial' } },
            { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: `${sketch}/Test.ino` } }] } },
        { type: 'user', message: { content: [
            { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Hello' }], is_error: true },
            { type: 'tool_result', tool_use_id: 't2', content: 'void setup() {}' }] } }
    ]);
    assert.equal(claude[0].id, 't1');
    assert.equal(claude[1].id, undefined);
    assert.deepEqual(claude[2], { type: 'toolOutput', id: 't1', output: 'Hello', failed: true });
    assert.equal(claude.length, 3);

    const codex = outputs('codex', [
        { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls' } },
        { type: 'item.completed', item: { id: 'i1', type: 'command_execution', aggregated_output: 'a.ino\n', exit_code: 0 } }
    ]);
    assert.equal(codex[0].id, 'i1');
    assert.deepEqual(codex[1], { type: 'toolOutput', id: 'i1', output: 'a.ino\n', failed: false });

    const vibe = outputs('vibe', [
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'a.ino' }
    ]);
    assert.equal(vibe[0].id, 'c1');
    assert.deepEqual(vibe[1], { type: 'toolOutput', id: 'c1', output: 'a.ino', failed: false });

    // Real lines of agy 1.5.8, the output header is cut off
    const step = (index, state, command, output) => ({ event: 'step_update', step_update: {
        conversation_id: 'c', step_index: index, state, step_type: 'tool', tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: command }, output } } });
    const header = code => `Created At: 2026-11-15T09:09:16+01:00\nCompleted At: 2026-11-15T09:09:16+01:00\nCommand exited with code ${code}.\n\nCommand output:\n`;
    const agy = outputs('antigravity', [
        step(2, 'ACTIVE', 'echo hallo'),
        step(2, 'DONE', 'echo hallo', `${header(0)}hallo\r\n`),
        step(4, 'ACTIVE', 'ls /gibtsnicht'),
        step(4, 'DONE', 'ls /gibtsnicht', `${header(2)}ls: Zugriff auf '/gibtsnicht' nicht möglich\r\n`)
    ]);
    assert.equal(agy.length, 4);
    assert.equal(agy[0].id, 'step-2');
    assert.deepEqual(agy[1], { type: 'toolOutput', id: 'step-2', output: 'hallo\r\n', failed: false });
    assert.equal(agy[3].failed, true);
    assert.equal(agy[3].output, "ls: Zugriff auf '/gibtsnicht' nicht möglich\r\n");
});

test('auth errors: expired or revoked logins that come only as text', () => {
    const claude = text => {
        const parser = registry.get('claudecode').createParser({ cwd: sketch, sessionId: null });
        parser.onEvent({ type: 'result', is_error: true, result: text, session_id: 's' });
        return parser.finish().errorType;
    };
    assert.equal(claude('Login expired · Please run /login'), 'auth');
    assert.equal(claude('Failed to authenticate: OAuth token revoked'), 'auth');
    assert.equal(claude('API Error: 401 {"type":"error","error":{"type":"authentication_error"}} · Please run /login'), 'auth');
    assert.notEqual(claude('Prompt is too long'), 'auth');
    assert.ok(registry.get('codex').authError.test('Your access token could not be refreshed'));
    assert.ok(registry.get('antigravity').authError.test('OAuth credentials missing'));
});

test('claudecode: generates a chat title with a single call', async () => {
    const title = await registry.get('claudecode').generateTitle(env.fake('claude'), 'Title please');
    assert.equal(title, 'Test title');
});

test('runner: a run can be stopped', async () => {
    const slow = `${env.TMP}/slow-agent`;
    fs.writeFileSync(slow, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    const runner = new AgentRunner();
    const pending = runner.run({ adapter: registry.get('claudecode'), toolPath: slow, prompt: 'x', cwd: sketch });
    setTimeout(() => runner.stop(), 200);
    const result = await pending;
    assert.equal(result.stopped, true);
});
