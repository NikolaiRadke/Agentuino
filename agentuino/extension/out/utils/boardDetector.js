/*
 * Agentuino - Board Detector Module
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * The Arduino IDE offers no API for the selected board, so the board is read
 * from the IDE log files (same approach as AI.duino) and from sketch.yaml
 * (default_fqbn / default_port), if present. Pure Node.js.
 */

"use strict";

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// ===== CONSTANTS =====

const POLL_INTERVAL_MS = 3000;
const BYTES_PER_KB = 1024;
const INITIAL_SCAN_BYTES = 1024 * BYTES_PER_KB;
const MIN_FQBN_PARTS = 3;

const TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;

// Ordered by priority: the language server line has the complete FQBN
const LOG_PATTERNS = [
    /Starting language server:\s*([^\s\n]+)/i,
    /Failed to get debug config:\s*([^,\s\n]+)/i
];

const BOARD_NAMES = {
    'arduino:avr:uno': 'Arduino Uno',
    'arduino:avr:nano': 'Arduino Nano',
    'arduino:avr:mega': 'Arduino Mega 2560',
    'arduino:avr:leonardo': 'Arduino Leonardo',
    'arduino:renesas_uno:unor4wifi': 'Arduino Uno R4 WiFi',
    'arduino:renesas_uno:minima': 'Arduino Uno R4 Minima',
    'esp32:esp32:esp32': 'ESP32 Dev Module',
    'esp8266:esp8266:generic': 'ESP8266 Generic'
};

// ===== HELPERS =====

/**
 * Check whether a string looks like an FQBN (vendor:arch:board[:options])
 * @param {string} value - Candidate
 * @returns {boolean} True if valid
 */
function isFqbn(value) {
    return typeof value === 'string' && value.split(':').length >= MIN_FQBN_PARTS;
}

/**
 * Get a readable board name for an FQBN
 * @param {string} fqbn - Fully Qualified Board Name
 * @returns {string} Board name
 */
function getBoardName(fqbn) {
    const base = fqbn.split(':').slice(0, MIN_FQBN_PARTS).join(':');
    if (BOARD_NAMES[base]) return BOARD_NAMES[base];
    const [vendor, , board] = base.split(':');
    return `${vendor.charAt(0).toUpperCase()}${vendor.slice(1)} ${board.replace(/_/g, ' ').toUpperCase()}`;
}

/**
 * Get the Arduino IDE log directory for this platform
 * @returns {string} Log directory
 */
function getLogDirectory() {
    if (process.platform === 'win32') return path.join(os.homedir(), 'AppData', 'Roaming', 'Arduino IDE');
    if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Logs', 'Arduino IDE');
    return path.join(os.homedir(), '.config', 'Arduino IDE');
}

/**
 * Read a byte range of a file
 * @param {string} file - File path
 * @param {number} start - Start offset
 * @param {number} end - End offset (exclusive)
 * @returns {string} Content
 */
function readRange(file, start, end) {
    const length = end - start;
    if (length <= 0) return '';
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try {
        fs.readSync(fd, buffer, 0, length, start);
    } finally {
        fs.closeSync(fd);
    }
    return buffer.toString('utf8');
}

/**
 * Find the newest board entries in log content
 * @param {string} content - Log content
 * @returns {Array<{fqbn: string, time: string}|null>} Newest match per pattern (same order as LOG_PATTERNS)
 */
function findBoardEntries(content) {
    const found = LOG_PATTERNS.map(() => null);
    for (const line of content.split('\n')) {
        LOG_PATTERNS.forEach((pattern, index) => {
            const value = line.match(pattern)?.[1]?.trim();
            if (isFqbn(value)) {
                found[index] = { fqbn: value, time: line.match(TIMESTAMP_PATTERN)?.[1] || '' };
            }
        });
    }
    return found;
}

/**
 * Read default_fqbn and default_port from sketch.yaml
 * @param {string} sketchPath - Sketch folder
 * @returns {{fqbn: string|null, port: string|null}} Values found
 */
function readSketchYaml(sketchPath) {
    const file = path.join(sketchPath, 'sketch.yaml');
    if (!fs.existsSync(file)) return { fqbn: null, port: null };
    const content = fs.readFileSync(file, 'utf8');
    const fqbn = content.match(/^default_fqbn:\s*(\S+)/m)?.[1] || null;
    const port = content.match(/^default_port:\s*(\S+)/m)?.[1] || null;
    return { fqbn: isFqbn(fqbn) ? fqbn : null, port };
}

// ===== DETECTOR =====

class BoardDetector extends EventEmitter {
    constructor() {
        super();
        this.logDir = getLogDirectory();
        this.fileSizes = new Map();
        this.entries = LOG_PATTERNS.map(() => null);
        this.fqbn = null;
        this.timer = null;
    }

    /**
     * Start polling the IDE logs. Emits 'change' with {fqbn, boardName}.
     */
    start() {
        this.poll();
        this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    }

    /**
     * Stop polling
     */
    dispose() {
        clearInterval(this.timer);
        this.timer = null;
        this.removeAllListeners();
    }

    /**
     * Get board info for a sketch: sketch.yaml wins over the IDE log
     * @param {string} sketchPath - Sketch folder
     * @returns {{fqbn: string|null, boardName: string|null, port: string|null}} Board info
     */
    getBoardInfo(sketchPath) {
        const yaml = sketchPath ? readSketchYaml(sketchPath) : { fqbn: null, port: null };
        const fqbn = yaml.fqbn || this.fqbn;
        return {
            fqbn,
            boardName: fqbn ? getBoardName(fqbn) : null,
            port: yaml.port
        };
    }

    /**
     * Scan all IDE log files: the first time up to INITIAL_SCAN_BYTES,
     * afterwards only what was appended since the last poll
     */
    poll() {
        try {
            if (!fs.existsSync(this.logDir)) return;
            const logs = fs.readdirSync(this.logDir).filter(f => f.endsWith('.log'));

            for (const name of logs) {
                const file = path.join(this.logDir, name);
                const size = fs.statSync(file).size;
                const previous = this.fileSizes.get(file);
                if (previous === size) continue;

                const isNewOrTruncated = previous === undefined || previous > size;
                const start = isNewOrTruncated ? Math.max(0, size - INITIAL_SCAN_BYTES) : previous;
                this.fileSizes.set(file, size);

                findBoardEntries(readRange(file, start, size)).forEach((entry, index) => {
                    const current = this.entries[index];
                    if (entry && (!current || entry.time >= current.time)) {
                        this.entries[index] = entry;
                    }
                });
            }

            // The language server line carries the full FQBN incl. options, so it wins
            const fqbn = this.entries.find(Boolean)?.fqbn || null;
            if (fqbn && fqbn !== this.fqbn) {
                this.fqbn = fqbn;
                this.emit('change', { fqbn, boardName: getBoardName(fqbn) });
            }
        } catch {
            // Logs are optional, detection simply stays unknown
        }
    }
}

module.exports = {
    BoardDetector,
    getBoardName
};
