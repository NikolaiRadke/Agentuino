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
