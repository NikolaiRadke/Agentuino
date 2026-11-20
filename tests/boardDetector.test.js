/*
 * Board detection: the Arduino IDE API (ArduinoContext) of this window wins,
 * the shared IDE log is only used without it.
 */

"use strict";

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { BoardDetector } = env.ext('out/utils/boardDetector.js');

const ATTINY = 'ATTinyCore:avr:attinyx5:chip=85,clock=8internal';
const line = (time, fqbn) => `${time} 2026-01-01T00:00:00.000Z root INFO Starting language server: ${fqbn}\n`;

/**
 * Minimal ArduinoContext with onDidChange(property)(listener)
 * @param {Object} state - fqbn, port, sketchPath
 * @returns {Object} Fake API with set(property, value)
 */
function fakeApi(state) {
    const listeners = {};
    return {
        ...state,
        onDidChange: property => listener => {
            (listeners[property] ||= []).push(listener);
            return { dispose: () => { listeners[property] = []; } };
        },
        set(property, value) {
            this[property] = value;
            (listeners[property] || []).forEach(l => l(value));
        }
    };
}

/**
 * Log folder whose newest entry is another window's board
 * @returns {string} Folder
 */
function foreignLog() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentuino-log-'));
    fs.writeFileSync(path.join(dir, 'ide.log'), line('2026-11-20 13:05:43', 'ardudebug:avr:uno:lto=on'));
    return dir;
}

test('the IDE selection of this window wins over the shared log', () => {
    const sketch = env.makeSketch('ApiBoard');
    const api = fakeApi({ fqbn: ATTINY, port: { address: '/dev/ttyUSB0' }, sketchPath: sketch });
    const detector = new BoardDetector({ arduinoContext: api });
    detector.logDir = foreignLog();
    const changes = [];
    detector.on('change', board => changes.push(board.fqbn));
    detector.start();

    assert.deepEqual(detector.getBoardInfo(sketch), { fqbn: ATTINY, boardName: 'ATTinyCore ATTINYX5', port: '/dev/ttyUSB0' });

    api.set('fqbn', 'arduino:avr:nano');
    assert.deepEqual(changes, ['arduino:avr:nano']);
    assert.equal(detector.getBoardInfo(sketch).fqbn, 'arduino:avr:nano');

    // The IDE state belongs to another sketch: its own sketch.yaml counts
    assert.equal(detector.getBoardInfo(env.makeSketch('OtherSketch')).fqbn, 'arduino:avr:uno');
    detector.dispose();
});

test('without the IDE API the log is used', () => {
    const detector = new BoardDetector();
    detector.logDir = foreignLog();
    detector.poll();
    assert.equal(detector.getBoardInfo(null).fqbn, 'ardudebug:avr:uno:lto=on');
    detector.dispose();
});
