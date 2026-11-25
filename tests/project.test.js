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

test('.gitignore: whole folder by default, local data only on request, own edits stay', () => {
    const sketch = env.makeSketch('GitIgnore');
    const file = projectManager.getProjectPaths(sketch).gitignore;
    projectManager.ensureProject(sketch, { language: 'en', context: UNO });
    assert.equal(fs.readFileSync(file, 'utf8'), '*\n');
    projectManager.ensureProject(sketch, { language: 'en', context: UNO, gitignoreAll: false });
    assert.equal(fs.readFileSync(file, 'utf8'), 'backups/\nattachments/\n');
    fs.writeFileSync(file, 'chats/\n');
    assert.equal(projectManager.updateGitignore(sketch, true), false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'chats/\n');
});

test('listChanges tells changed, new and deleted code files apart', () => {
    const sketch = env.makeSketch('Changes');
    fs.mkdirSync(path.join(sketch, 'src'));
    fs.writeFileSync(path.join(sketch, 'src', 'old.h'), '// old\n');
    backupManager.createSnapshot(sketch, { chatId: 'c1', messageTime: 1 });
    fs.appendFileSync(path.join(sketch, 'Changes.ino'), '// changed\n');
    fs.unlinkSync(path.join(sketch, 'src', 'old.h'));
    fs.writeFileSync(path.join(sketch, 'src', 'new.h'), '// new\n');
    assert.deepEqual(backupManager.listChanges(sketch), [
        { rel: 'Changes.ino', kind: 'changed' },
        { rel: 'src/old.h', kind: 'deleted' },
        { rel: 'src/new.h', kind: 'added' }
    ]);
    assert.equal(fs.readFileSync(backupManager.getSnapshotFile(sketch, 'src/old.h'), 'utf8'), '// old\n');
    assert.equal(backupManager.getSnapshotFile(sketch, 'src/new.h'), null);
});

test('used libraries: only installed ones the sketch includes, in root and src/', () => {
    const libraryUsage = env.ext('out/utils/libraryUsage.js');
    const sketch = env.makeSketch('Libs');
    fs.writeFileSync(path.join(sketch, 'Libs.ino'), '#include <TinyRTOS.h>\n#include "local.h"\nvoid setup() {}\nvoid loop() {}\n');
    fs.mkdirSync(path.join(sketch, 'src'));
    fs.writeFileSync(path.join(sketch, 'src', 'led.cpp'), '  #  include <Adafruit_NeoPixel.h>\n');
    const installed = [
        { name: 'TinyRTOS', version: '1.0', dir: '/l/TinyRTOS', includes: ['TinyRTOS.h'] },
        { name: 'Adafruit NeoPixel', version: '1.12', dir: '/l/NeoPixel', includes: ['Adafruit_NeoPixel.h'] },
        { name: 'Servo', version: '1.2', dir: '/l/Servo', includes: ['Servo.h'] }
    ];
    assert.deepEqual(libraryUsage.findUsedLibraries(sketch, installed).map(lib => lib.name), ['Adafruit NeoPixel', 'TinyRTOS']);
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
    assert.deepEqual(config.directories, ['~/.agentuino', '{tmp}/agentuino-debug']);
});

test('anchor "Upload automatically" replaces the no-upload rule', () => {
    const sketch = env.makeSketch('AutoUpload');
    projectManager.ensureProject(sketch, { language: 'en', context: UNO });
    assert.ok(agentsFile(sketch).includes(t('project.auto.ruleNoUpload')));
    assert.ok(agentsFile(sketch).includes(t('project.auto.serialBoardCode')));

    const config = projectManager.readConfig(sketch);
    config.rules = ['autoUpload'];
    projectManager.writeConfig(sketch, config);
    projectManager.ensureProject(sketch, { language: 'en', context: UNO });
    const text = agentsFile(sketch);
    assert.ok(!text.includes(t('project.auto.ruleNoUpload')));
    assert.ok(text.includes(t('project.auto.uploadAuto')));
    assert.ok(text.includes(t('project.auto.serialBoardCodeAuto')));
    assert.ok(text.includes(t('rules.blocks.autoUpload.text')));
    assert.ok(!ruleBlocks.getDefaults().includes('autoUpload'));
});
