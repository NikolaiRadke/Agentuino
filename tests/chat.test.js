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
const lastRunArgs = () => env.agentCalls().filter(call => !call.args.includes('json')).pop().args;

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
    assert.deepEqual(entries.map(e => e.role), ['user', 'activity', 'agent', 'compile', 'changes']);
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

test('a failed check is not repeated for a question, only after the code changed', async () => {
    const sketch = await newSketch('Unchanged');
    await ide.send('WRITE_STUBBORN');
    const before = callCount();
    const question = await ide.send('Why did that fail?');
    assert.deepEqual(compiles(question), []);
    assert.equal(callCount() - before, 1);

    // Code edited by the user outside the agent: checked again
    fs.appendFileSync(path.join(sketch, 'Unchanged.ino'), '\n// edited by hand\n');
    const edited = compiles(await ide.send('Another question'));
    assert.equal(edited.length > 0, true);
});

test('a missing library stops the loop and is checked again after installing', async () => {
    const sketch = await newSketch('Library');
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

    // The next task points the agent to the installed library it uses
    await ide.send('A question');
    const agents = fs.readFileSync(projectManager.getProjectPaths(sketch).agents, 'utf8');
    assert.match(agents, /## Libraries used/);
    assert.match(agents, /- TM1637Display 1\.0\.0: `.*TM1637Display`/);
    assert.match(agents, /lib list --format json/);
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

test('with "Upload automatically" the repair run may upload', async () => {
    const sketch = await newSketch('AutoFixUpload');
    await ide.send('Hello');
    const config = projectManager.readConfig(sketch);
    config.rules = ['autoUpload'];
    projectManager.writeConfig(sketch, config);
    await ide.send('WRITE_BROKEN');
    assert.match(lastPrompt(), /Upload as soon as it compiles without errors/);
});

/**
 * Wait for the next model state the chat sends to the webview
 * @param {Function} check - Condition on the message
 * @returns {Promise<Object>} Message
 */
async function modelState(check = () => true) {
    const WAIT_MS = 20;
    const MAX_TRIES = 250;
    for (let i = 0; i < MAX_TRIES; i++) {
        const found = ide.posted.filter(m => m.command === 'model' && check(m)).pop();
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, WAIT_MS));
    }
    throw new Error('No model state');
}

test('model and effort are chosen per chat and reach the command line', async () => {
    const sketch = await newSketch('ModelChoice');
    const initial = await modelState();
    assert.ok(initial.models.includes('opus'));
    assert.ok(initial.efforts.includes('max'));

    // Chosen before the first message: belongs to the new chat
    await ide.message({ command: 'setModel', model: 'opus', effort: 'high' });
    await ide.send('Hello');
    let args = lastRunArgs();
    assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 4), ['--model', 'opus', '--effort', 'high']);
    const chatId = projectManager.getLastChatId(sketch);
    assert.equal(chatStore.loadChat(sketch, chatId).model, 'opus');

    // An option instead of a model is refused, the old choice stays
    ide.posted.length = 0;
    await ide.message({ command: 'setModel', model: '--dangerously-skip-permissions', effort: '' });
    assert.equal((await modelState()).model, 'opus');
    assert.equal(chatStore.loadChat(sketch, chatId).effort, 'high');

    // A new chat starts with the choice of the last one
    await ide.message({ command: 'newChat' });
    await ide.send('Second chat');
    args = lastRunArgs();
    assert.ok(args.includes('opus') && args.includes('high'));
});

test('Vibe keeps the model of a running session, the chat says so', async () => {
    ide.settings.agent = 'vibe';
    try {
        await newSketch('VibeModel');
        await ide.send('Hello');
        const entries = await ide.message({ command: 'setModel', model: 'devstral', effort: '' });
        assert.ok(entries.some(e => e.role === 'info' && /next new chat/.test(e.text)), JSON.stringify(entries));
        // Vibe has no effort option
        assert.deepEqual((await modelState(m => m.model === 'devstral')).efforts, []);
    } finally {
        ide.settings.agent = 'claudecode';
    }
});

test('an effort level the model does not offer is left out', async () => {
    ide.settings.agent = 'codex';
    try {
        await newSketch('CodexEffort');
        await modelState(m => m.models.includes('gpt-fast'));
        await ide.message({ command: 'setModel', model: 'gpt-old', effort: 'ultra' });
        await ide.send('Hello');
        let args = lastRunArgs();
        assert.ok(args.includes('gpt-old'));
        assert.ok(!args.some(arg => arg.startsWith('model_reasoning_effort')));

        await ide.message({ command: 'setModel', model: 'gpt-fast', effort: 'ultra' });
        await ide.send('Again');
        args = lastRunArgs();
        assert.ok(args.includes('model_reasoning_effort=ultra'));
    } finally {
        ide.settings.agent = 'claudecode';
    }
});

test('settings submenu: toggles, Git folder and program paths with a check', async () => {
    const sketch = await newSketch('Prefs');
    await ide.send('A question');
    const gitignore = projectManager.getProjectPaths(sketch).gitignore;
    assert.equal(fs.readFileSync(gitignore, 'utf8'), '*\n');

    // Answer the menus one after the other by label, undefined = Escape
    const picks = ['⚙️', 'Git:', 'Compile check', 'Program paths', 'arduino-cli', 'Choose file', 'arduino-cli', 'Choose file'];
    ide.answerQuickPick = items => {
        const want = picks.shift();
        return want === undefined ? undefined : items.find(item => item.label.includes(want));
    };
    // First a file without version (the user cancels the warning), then the real one
    const files = [path.join(sketch, 'Prefs.ino'), env.fake('arduino-cli')];
    ide.vscode.window.showOpenDialog = async () => [ide.vscode.Uri.file(files.shift())];
    const warnings = [];
    ide.answerWarning = message => { warnings.push(message); return undefined; };
    ide.settings.arduinoCliPath = '';
    try {
        await ide.runCommand('agentuino.settings');
        assert.equal(ide.settings.gitignoreAll, false);
        assert.equal(fs.readFileSync(gitignore, 'utf8'), 'backups/\nattachments/\n');
        assert.equal(ide.settings.compileCheck, false);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /Prefs\.ino/);
        assert.equal(ide.settings.arduinoCliPath, env.fake('arduino-cli'));
        assert.deepEqual(picks, []);
    } finally {
        ide.answerQuickPick = items => items[0];
        ide.answerWarning = (message, options, ...buttons) => buttons[0];
        ide.vscode.window.showOpenDialog = async () => undefined;
        ide.settings.gitignoreAll = true;
        ide.settings.compileCheck = true;
        ide.settings.arduinoCliPath = env.fake('arduino-cli');
    }
});

test('changes line lists the files of the task, a click opens the diff of before and now', async () => {
    const sketch = await newSketch('Diff');
    const ino = path.join(sketch, 'Diff.ino');
    const original = fs.readFileSync(ino, 'utf8');
    const [changes] = (await ide.send('WRITE_OK')).filter(e => e.role === 'changes');
    assert.deepEqual(changes.data.files, [{ rel: 'Diff.ino', kind: 'changed' }]);

    ide.executed.length = 0;
    await ide.message({ command: 'showChange', rel: 'Diff.ino' });
    const [name, before, after, title] = ide.executed.find(args => args[0] === 'vscode.diff');
    assert.equal(name, 'vscode.diff');
    assert.equal(after.fsPath, ino);
    assert.match(title, /Diff\.ino/);
    // The old side is read-only content from the snapshot
    assert.equal(ide.providers[before.scheme].provideTextDocumentContent(before), original);

    // A question changes no code: no new line, the diff still works
    const question = await ide.send('A question');
    assert.ok(!question.some(e => e.role === 'changes'));

    // Paths that did not change are refused
    ide.executed.length = 0;
    await ide.message({ command: 'showChange', rel: '../../etc/passwd' });
    assert.ok(!ide.executed.some(args => args[0] === 'vscode.diff'));
});

test('a chat keeps the title the user gives it', async () => {
    const sketch = await newSketch('Rename');
    await ide.send('A question');
    const id = projectManager.getLastChatId(sketch);
    ide.answerInput = () => '  My title  ';
    try {
        await ide.message({ command: 'renameChat', id });
    } finally {
        ide.answerInput = () => undefined;
    }
    const chat = chatStore.loadChat(sketch, id);
    assert.equal(chat.title, 'My title');
    assert.equal(chat.titleByUser, true);
    const header = ide.posted.filter(m => m.command === 'header').pop();
    assert.equal(header.title, 'My title');
});
