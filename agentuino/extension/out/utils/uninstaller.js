/*
 * Agentuino - Uninstaller
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Removes Agentuino from the Arduino IDE: the VSIX in ~/.arduinoIDE/extensions
 * and the unpacked copy in ~/.arduinoIDE/deployedPlugins. The agentuino/
 * folders in the sketches are the user's projects and stay untouched.
 * Pure Node.js; settings are reset by the caller.
 */

"use strict";

const fs = require('fs');
const os = require('os');
const path = require('path');

// ===== CONSTANTS =====

const IDE_DIR = path.join(os.homedir(), '.arduinoIDE');
const SEARCH_DIRS = [path.join(IDE_DIR, 'extensions'), path.join(IDE_DIR, 'deployedPlugins')];
const NAME_PATTERN = /^(nikolairadke\.)?agentuino([-.@].*)?(\.vsix)?$/i;
// Downloaded agent configuration (see agents/agentConfig.js)
const USER_DIR = path.join(os.homedir(), '.agentuino');

/**
 * List everything that belongs to the installation
 * @returns {string[]} Absolute paths
 */
function getTargets() {
    const targets = [];
    for (const dir of SEARCH_DIRS) {
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
            if (NAME_PATTERN.test(name)) targets.push(path.join(dir, name));
        }
    }
    if (targets.length > 0 && fs.existsSync(USER_DIR)) targets.push(USER_DIR);
    return targets;
}

/**
 * Delete the installation
 * @returns {{deleted: string[], failed: Array<{path: string, error: string}>}} Result
 */
function removeTargets() {
    const result = { deleted: [], failed: [] };
    for (const target of getTargets()) {
        try {
            fs.rmSync(target, { recursive: true, force: true });
            result.deleted.push(target);
        } catch (err) {
            // Windows may lock files of the running extension
            result.failed.push({ path: target, error: err.code || err.message });
        }
    }
    return result;
}

module.exports = { getTargets, removeTargets };
