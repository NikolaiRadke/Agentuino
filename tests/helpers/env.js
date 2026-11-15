/*
 * Agentuino tests - environment. Require this first in every test file:
 * each file runs in its own process with its own temporary home folder,
 * so ~/.agentuino and ~/.arduinoIDE of the developer are never touched.
 */

"use strict";

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentuino-test-')));
const HOME = path.join(TMP, 'home');
const REPO = path.join(__dirname, '..', '..');
const EXTENSION = path.join(REPO, 'agentuino', 'extension');
const FAKES = path.join(__dirname, '..', 'fakes');

fs.mkdirSync(HOME);
fs.mkdirSync(path.join(TMP, 'temp'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
// Run folders and debug builds also stay inside the test folder
process.env.TMPDIR = path.join(TMP, 'temp');
// Read by the fakes
process.env.FAKE_CLI_STATE = path.join(TMP, 'cli-state.json');
process.env.FAKE_AGENT_LOG = path.join(TMP, 'agent-log.jsonl');
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

/**
 * Require a module of the extension
 * @param {string} rel - Path below agentuino/extension
 * @returns {*} Module
 */
function ext(rel) {
    return require(path.join(EXTENSION, rel));
}

/**
 * Path of a fake tool
 * @param {string} name - arduino-cli, claude, codex, vibe, agy or opencode
 * @returns {string} Path
 */
function fake(name) {
    return path.join(FAKES, name);
}

/**
 * Create a sketch folder with sketch.yaml (board for the compile check)
 * @param {string} name - Sketch name
 * @param {string} code - Content of <name>.ino
 * @returns {string} Sketch folder
 */
function makeSketch(name, code = '// new sketch\nvoid setup() {}\nvoid loop() {}\n') {
    const dir = path.join(TMP, 'sketches', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.ino`), code);
    fs.writeFileSync(path.join(dir, 'sketch.yaml'), 'default_fqbn: arduino:avr:uno\n');
    return dir;
}

/**
 * Calls of the fake agents so far
 * @returns {Object[]} {agent, args, prompt}
 */
function agentCalls() {
    try {
        return fs.readFileSync(process.env.FAKE_AGENT_LOG, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch {
        return [];
    }
}

module.exports = { TMP, HOME, REPO, EXTENSION, FAKES, ext, fake, makeSketch, agentCalls };
