/*
 * Sketch projects: AGENTS.md, semantic anchors, compile evaluation, snapshots
 */

"use strict";

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const projectManager = env.ext('out/utils/projectManager.js');
const ruleBlocks = env.ext('out/utils/ruleBlocks.js');
const backupManager = env.ext('out/utils/backupManager.js');
const { CompileChecker, evaluate } = env.ext('out/utils/compileChecker.js');
const i18n = env.ext('out/utils/i18n.js');

const UNO = { fqbn: 'arduino:avr:uno', boardName: 'Arduino Uno', cliPath: env.fake('arduino-cli'), port: '/dev/ttyACM0' };
const t = i18n.createTranslator('en');
const agentsFile = sketch => fs.readFileSync(projectManager.getProjectPaths(sketch).agents, 'utf8');

// ===== PROJECT AND ANCHORS =====

test('a new project gets AGENTS.md with board, tools and the default anchors', () => {
    const sketch = env.makeSketch('NewProject');
    projectManager.ensureProject(sketch, { language: 'en', context: UNO });
    const text = agentsFile(sketch);
    assert.match(text, /arduino:avr:uno/);
    assert.match(text, /agentuino-serial/);
    assert.match(text, /## Code rules/);
    assert.ok(text.includes(t('rules.blocks.beginnerComments.text')));
    // Debug rules only with ArduDebug installed
    assert.doesNotMatch(text, /agentuino-debug/);
    projectManager.ensureProject(sketch, { language: 'en', context: { ...UNO, ardudebug: true } });
    assert.match(agentsFile(sketch), /agentuino-debug/);
});

test('anchors: defaults, own anchors, per sketch', () => {
    assert.deepEqual(ruleBlocks.getDefaults(), ['beginnerComments', 'noMagicNumbers', 'explainChanges']);
    const key = ruleBlocks.saveCustom(null, 'Pins on top', 'All pin numbers\nas const on top.');
    assert.equal(key, 'custom-pins-on-top');
    assert.equal(ruleBlocks.saveCustom(null, 'Pins on top', 'again'), 'custom-pins-on-top-2');
    assert.throws(() => ruleBlocks.saveCustom(null, '  ', 'x'));

    const sketch = env.makeSketch('Anchors');
    projectManager.ensureProject(sketch, { language: 'en', context: UNO });
    const config = projectManager.readConfig(sketch);
    config.rules = ['nonBlocking', key, 'unknownKey'];
    projectManager.writeConfig(sketch, config);
    assert.deepEqual(ruleBlocks.getActiveTexts(config, t), [t('rules.blocks.nonBlocking.text'), 'All pin numbers as const on top.']);

    ruleBlocks.deleteCustom(key);
    assert.deepEqual(ruleBlocks.getActiveKeys(config), ['nonBlocking']);
});

// ===== COMPILE EVALUATION =====

test('compile result: sizes truncated like the IDE, RAM warning above 75 %', () => {
    const data = used => ({
        success: true,
        builder_result: { executable_sections_size: [{ name: 'text', size: 924, max_size: 32256 }, { name: 'data', size: used, max_size: 2048 }] }
    });
    const ok = evaluate(data(9), 0, '', '/s');
    assert.deepEqual(ok.flash, { used: 924, max: 32256, percent: 2 });
    assert.equal(ok.ramWarning, false);
    assert.equal(evaluate(data(1600), 0, '', '/s').ramWarning, true);
});

test('compile result: errors relative to the sketch, missing libraries recognized', () => {
    const diag = (message, severity = 'ERROR') => ({ severity, file: '/s/Blink.ino', line: 3, column: 5, message });
    const missing = 'Foo.h: No such file or directory\n #include <Foo.h>\n          ^~~~~~~\ncompilation terminated.';
    const failed = (...diagnostics) => evaluate({ success: false, compiler_err: '/s/Blink.ino:3:5: error', builder_result: { diagnostics } }, 1, '', '/s');

    const error = failed(diag("'x' was not declared in this scope"), diag('just a warning', 'WARNING'));
    assert.deepEqual(error.errors, ["Blink.ino:3:5: 'x' was not declared in this scope"]);
    assert.equal(error.errorText, 'Blink.ino:3:5: error');
    assert.equal(error.missingLibraries, null);

    assert.deepEqual(failed(diag(missing, 'FATAL')).missingLibraries, ['Foo.h']);
    // A missing local header is a mistake the agent can fix
    assert.equal(failed(diag('konfig.h: No such file or directory\n #include "konfig.h"', 'FATAL')).missingLibraries, null);
    // Mixed with a real error: let the agent fix first
    assert.equal(failed(diag(missing, 'FATAL'), diag('other')).missingLibraries, null);

    const many = failed(...Array.from({ length: 7 }, (_, i) => diag(`error ${i}`)));
    assert.equal(many.errors.length, 5);
    assert.equal(many.moreErrors, 2);
});

test('compile through arduino-cli: ok, error, missing library', async () => {
    const sketch = env.makeSketch('Compile');
    const compile = () => new CompileChecker().compile({ cliPath: env.fake('arduino-cli'), fqbn: 'arduino:avr:uno', sketchPath: sketch });
    assert.equal((await compile()).ok, true);

    fs.writeFileSync(path.join(sketch, 'Compile.ino'), 'void setup() {\n  BROKEN;\n}\n');
    const broken = await compile();
    assert.equal(broken.ok, false);
    assert.deepEqual(broken.errors, ["Compile.ino:2:3: 'BROKEN' was not declared in this scope"]);

    fs.writeFileSync(path.join(sketch, 'Compile.ino'), '#include <Missing.h>\nvoid setup() {}\n');
    assert.deepEqual((await compile()).missingLibraries, ['Missing.h']);
});

// ===== SNAPSHOT =====

test('snapshot: reset restores and removes files, a question keeps the last reset', () => {
    const sketch = env.makeSketch('Snapshot', 'version 1\n');
    const ino = path.join(sketch, 'Snapshot.ino');
    const owner = time => ({ chatId: 'c1', messageTime: time });

    // Task 1 changes the sketch and adds a file
    backupManager.createSnapshot(sketch, owner(1));
    fs.writeFileSync(ino, 'version 2\n');
    fs.writeFileSync(path.join(sketch, 'extra.h'), '#pragma once\n');
    assert.equal(backupManager.settleSnapshot(sketch), true);

    // Task 2 is only a question: the reset still goes back to before task 1
    backupManager.createSnapshot(sketch, owner(2));
    assert.equal(backupManager.settleSnapshot(sketch), false);
    assert.equal(backupManager.getSnapshot(sketch).messageTime, 1);

    const plan = backupManager.planRestore(sketch);
    assert.deepEqual(plan.restore, ['Snapshot.ino']);
    assert.deepEqual(plan.remove, ['extra.h']);
    const before = backupManager.getCodeFingerprint(sketch);
    backupManager.restoreSnapshot(sketch);
    assert.equal(fs.readFileSync(ino, 'utf8'), 'version 1\n');
    assert.ok(!fs.existsSync(path.join(sketch, 'extra.h')));
    assert.notEqual(backupManager.getCodeFingerprint(sketch), before);
});

// ===== UNINSTALL =====

test('uninstall leaves nothing behind outside the sketches', () => {
    const uninstaller = env.ext('out/utils/uninstaller.js');
    const make = (file, content = 'x') => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
        return file;
    };
    // Nothing found: nothing is touched
    const rules = make(path.join(env.HOME, '.agentuino', 'rules.json'), '{}');
    assert.deepEqual(uninstaller.getTargets(), []);

    const vsix = make(path.join(env.HOME, '.arduinoIDE', 'extensions', 'agentuino-0.9.0.vsix'));
    const deployed = make(path.join(env.HOME, '.arduinoIDE', 'deployedPlugins', 'agentuino', 'package.json'));
    const other = make(path.join(env.HOME, '.arduinoIDE', 'extensions', 'aiduino-2.0.vsix'));
    const debug = make(path.join(env.TMP, 'temp', 'agentuino-debug', 'Blink-1234', 'build', 'Blink.elf'));
    const sketch = env.makeSketch('Kept');
    projectManager.ensureProject(sketch, { language: 'en', context: UNO });

    const result = uninstaller.removeTargets();
    assert.deepEqual(result.failed, []);
    for (const file of [rules, vsix, deployed, debug]) assert.ok(!fs.existsSync(file), file);
    assert.ok(fs.existsSync(other));
    assert.ok(projectManager.isProject(sketch));
});

test('uninstall.json for the Extension Manager lists every setting', () => {
    const config = JSON.parse(fs.readFileSync(path.join(env.EXTENSION, 'uninstall.json'), 'utf8'));
    const settings = Object.keys(env.ext('package.json').contributes.configuration.properties);
    assert.deepEqual([...config.settings].sort(), [...settings].sort());
    assert.deepEqual(config.directories, ['~/.agentuino']);
});
