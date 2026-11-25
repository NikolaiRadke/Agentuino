/*
 * Agentuino - Library Usage
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Finds the installed libraries a sketch includes, so AGENTS.md can point
 * the agent to their headers and examples. Agents do not know new or rare
 * libraries and would otherwise guess their functions. Pure Node.js.
 */

"use strict";

const fs = require('fs');
const path = require('path');

const backupManager = require('./backupManager');

// #include <Name.h> or #include "Name.h"
const INCLUDE_PATTERN = /^[ \t]*#[ \t]*include[ \t]*[<"]([^>"]+)[>"]/gm;

/**
 * Collect the header names the sketch includes
 * @param {string} sketchPath - Sketch folder
 * @returns {Set<string>} Header file names without folders (e.g. "TinyRTOS.h")
 */
function collectIncludes(sketchPath) {
    const headers = new Set();
    for (const rel of backupManager.collectCodeFiles(sketchPath)) {
        let code;
        try {
            code = fs.readFileSync(path.join(sketchPath, ...rel.split('/')), 'utf8');
        } catch {
            continue;
        }
        for (const match of code.matchAll(INCLUDE_PATTERN)) headers.add(path.basename(match[1]));
    }
    return headers;
}

/**
 * Pick the installed libraries the sketch includes
 * @param {string} sketchPath - Sketch folder
 * @param {Array<{name, version, dir, includes}>} libraries - From toolDetector.listLibraries()
 * @returns {Array<{name: string, version: string, dir: string}>} Used libraries, sorted by name
 */
function findUsedLibraries(sketchPath, libraries) {
    const headers = collectIncludes(sketchPath);
    if (headers.size === 0) return [];
    return libraries
        .filter(lib => lib.includes.some(header => headers.has(path.basename(header))))
        .map(({ name, version, dir }) => ({ name, version, dir }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { findUsedLibraries };
