/*
 * The chat in a fake IDE: agentic compile loop, missing libraries, reset,
 * lost sessions, agent choice. Agent and arduino-cli are fakes.
 */

"use strict";

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startIde } = require('./helpers/ide');

const ide = startIde();
const chatStore = env.ext('out/chat/chatStore.js');
const projectManager = env.ext('out/utils/projectManager.js');
test.after(() => ide.stop());

const compiles = entries => entries.filter(e => e.role === 'compile').map(e => e.data);
const lastPrompt = () => env.agentCalls().filter(call => !call.args.includes('json')).pop().prompt;
const callCount = () => env.agentCalls().filter(call => !call.args.includes('json')).length;

/**
 * Open the chat for a new sketch
 * @param {string} name - Sketch name
 * @returns {Promise<string>} Sketch folder
 */
async function newSketch(name) {
    const sketch = env.makeSketch(name);
    await ide.openChat(sketch);
    return sketch;
}

test('a task that changes code is compiled, the agent learns the result', async () => {
    await newSketch('Task');
    const entries = (await ide.send('WRITE_OK')).filter(e => e.role !== 'info');
    assert.deepEqual(entries.map(e => e.role), ['user', 'activity', 'agent', 'compile']);
    assert.match(entries[1].text, /Task\.ino$/);
    const [check] = compiles(entries);
    assert.equal(check.ok, true);
    assert.equal(check.compact, true);
    assert.match(check.line, /Arduino Uno|arduino:avr:uno/);
    // Compiler output goes to the output panel
    assert.ok(ide.output.some(line => line.includes('Sketch uses')));

    await ide.send('A question');
    assert.match(lastPrompt(), /Agentuino compiled the sketch itself, successfully/);
});

test('a question without code changes is not compiled', async () => {
    await newSketch('Question');
    const entries = await ide.send('How much RAM has an Uno?');
    assert.deepEqual(compiles(entries), []);
});

test('compile errors are fixed by the agent in a second run', async () => {
    await newSketch('Fix');
    const before = callCount();
    const entries = await ide.send('WRITE_BROKEN');
    assert.deepEqual(compiles(entries).map(c => c.ok), [false, true]);
    assert.equal(callCount() - before, 2);
    assert.match(lastPrompt(), /Compiler output:[\s\S]*'BROKEN' was not declared/);
    assert.ok(entries.some(e => e.role === 'info' && e.text.includes('attempt 2 of 3')));
});

test('the loop ends after three runs, the user can still ask for a fix', async () => {
    await newSketch('Stubborn');
    const before = callCount();
    const entries = await ide.send('WRITE_STUBBORN');
    const checks = compiles(entries);
    assert.deepEqual(checks.map(c => c.ok), [false, false, false]);
    assert.equal(callCount() - before, 3);
    assert.equal(checks[2].fixable, true);
});

test('a missing library stops the loop and is checked again after installing', async () => {
    await newSketch('Library');
    const before = callCount();
    const first = compiles(await ide.send('WRITE_LIB'));
    assert.equal(callCount() - before, 1);
    assert.equal(first.length, 1);
    assert.deepEqual(first[0].missingLibraries, ['TM1637Display.h']);
    assert.equal(first[0].fixable, false);
    assert.match(first[0].hint, /library for TM1637Display\.h is missing/);

    // Installing changes no code, the failed check forces a new one
    const second = await ide.send('INSTALL_LIB');
    assert.ok(second.some(e => e.role === 'activity' && e.text.includes('arduino-cli lib install TM1637Display')));
    assert.deepEqual(compiles(second).map(c => c.ok), [true]);
});

test('high RAM use shows a card with warning instead of the short line', async () => {
    await newSketch('Ram');
    const [check] = compiles(await ide.send('WRITE_RAM'));
    assert.equal(check.ok, true);
    assert.equal(check.compact, false);
    assert.ok(check.warning);
});

test('reset brings back the code before the task and tells the agent', async () => {
    const sketch = await newSketch('Reset');
    const ino = path.join(sketch, 'Reset.ino');
    const original = fs.readFileSync(ino, 'utf8');
    await ide.send('WRITE_RAM');
    await ide.send('Only a question');
    assert.notEqual(fs.readFileSync(ino, 'utf8'), original);

    const entries = await ide.message({ command: 'restore' });
    assert.equal(fs.readFileSync(ino, 'utf8'), original);
    assert.ok(entries.some(e => e.role === 'info' && e.text.includes('restored')));
    await ide.send('Go on');
    assert.match(lastPrompt(), /I have reset the code to the state before my task "WRITE_RAM"/);
});

test('a lost session starts a new one and runs the message again', async () => {
    const sketch = await newSketch('Lost');
    await ide.send('Hello');
    const chatId = projectManager.getLastChatId(sketch);
    const chat = chatStore.loadChat(sketch, chatId);
    chat.sessionId = 'gone';
    chatStore.saveChat(sketch, chat);
    await ide.openChat(env.makeSketch('Other'));
    await ide.openChat(sketch);

    const entries = await ide.send('Still there?');
    assert.ok(entries.some(e => e.role === 'info' && /session/i.test(e.text)), JSON.stringify(entries));
    assert.ok(entries.some(e => e.role === 'agent'));
    assert.equal(chatStore.loadChat(sketch, chatId).sessionId, 'claude-session-1');
});

test('an expired login gets a message with the login command', async () => {
    await newSketch('Login');
    const entries = await ide.send('AUTH_FAIL');
    const error = entries.find(e => e.role === 'error');
    assert.ok(error);
    assert.match(error.text, /claude → \/login/);
});

test('without compile check nothing is compiled', async () => {
    ide.settings.compileCheck = false;
    try {
        await newSketch('NoCheck');
        assert.deepEqual(compiles(await ide.send('WRITE_BROKEN')), []);
    } finally {
        ide.settings.compileCheck = true;
    }
});

test('a new chat uses the chosen agent, AGENTS.md goes into the prompt once', async () => {
    ide.settings.agent = 'antigravity';
    try {
        await newSketch('Agy');
        const entries = await ide.send('First question');
        assert.ok(entries.some(e => e.role === 'agent' && e.text === 'Agy answer.'));
        assert.ok(entries.some(e => e.role === 'activity' && e.text === 'Reading Test.ino'), JSON.stringify(entries));
        const first = env.agentCalls().pop();
        assert.equal(first.agent, 'agy');
        assert.match(first.prompt, /## Code rules/);

        await ide.send('Second question');
        const second = env.agentCalls().pop();
        assert.ok(second.args.includes('agy-conversation-1'));
        assert.equal(second.prompt, 'Second question');
    } finally {
        ide.settings.agent = 'claudecode';
    }
});

test('webview messages cannot reach files outside the chats or open other URLs', async () => {
    const sketch = await newSketch('Guard');
    await ide.send('Hello');
    const config = path.join(sketch, 'agentuino', 'config.json');
    await ide.message({ command: 'deleteChat', id: '../config' });
    await ide.message({ command: 'selectChat', id: '../config' });
    assert.ok(fs.existsSync(config));

    ide.opened.length = 0;
    await ide.message({ command: 'openUrl', url: 'file:///etc/passwd' });
    await ide.message({ command: 'openUrl', url: 'https://code.claude.com' });
    assert.deepEqual(ide.opened, ['https://code.claude.com']);
});
