/*
 * Agentuino - Agent Utilities
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Helpers shared by the runner, the agent adapters and the other modules
 * (errors, Windows processes, atomic files, versions). Pure Node.js.
 */

"use strict";

const fs = require('fs');
const path = require('path');

// ===== CONSTANTS =====

const IS_WINDOWS = process.platform === 'win32';
const MAX_DETAIL_CHARS = 80;
const FILE_MODE = 0o644;
const TEMP_SUFFIX = '.tmp';
// Arguments that need no quotes in cmd.exe
const SAFE_SHELL_ARG = /^[\w\-.:\\/=,@+]+$/;

// ===== FUNCTIONS =====

/**
 * Create an error with a machine-readable code
 * @param {string} code - Error code
 * @param {string} message - Technical message
 * @param {Object} extra - Additional properties
 * @returns {Error} Error object
 */
function createError(code, message, extra = {}) {
    return Object.assign(new Error(message), { code }, extra);
}

/**
 * Shorten a string for display
 * @param {string} text - Text
 * @returns {string} Single-line, shortened text
 */
function shorten(text) {
    const single = String(text).replace(/\s+/g, ' ').trim();
    return single.length > MAX_DETAIL_CHARS ? single.slice(0, MAX_DETAIL_CHARS - 1) + '…' : single;
}

/**
 * Make a path relative to the sketch folder for display
 * @param {string} file - File path (absolute or relative)
 * @param {string} cwd - Sketch folder
 * @returns {string} Path with forward slashes
 */
function displayPath(file, cwd) {
    const rel = path.isAbsolute(file) ? path.relative(cwd, file) : file;
    return rel.split(path.sep).join('/') || '.';
}

/**
 * Make a shell command readable for the chat: unwrap 'bash -lc "…"' and
 * drop arduino-cli's long --config-file argument (the agent still runs it)
 * @param {string} command - Command line
 * @returns {string} Shortened command
 */
function describeCommand(command) {
    let text = String(command).trim();
    const wrapped = text.match(/^(?:\S*\/)?(?:bash|sh|zsh)\s+-l?c\s+(["'])([\s\S]*)\1$/);
    if (wrapped) text = wrapped[2];
    text = text
        .replace(/"[^"]*[\\/](arduino-cli)(?:\.exe)?"/gi, '$1')
        .replace(/\s--config-file\s+(?:"[^"]*"|'[^']*'|\S+)/g, '');
    return shorten(text);
}

/**
 * Extract a short, human-readable detail from tool arguments
 * @param {Object} input - Tool arguments
 * @param {string} cwd - Sketch folder (to shorten file paths)
 * @returns {string} Detail text
 */
function describeToolInput(input, cwd) {
    if (!input || typeof input !== 'object') return '';
    const file = input.file_path || input.notebook_path || input.path || input.file;
    if (file) return displayPath(String(file), cwd);
    const command = input.command || input.cmd;
    if (command) return describeCommand(Array.isArray(command) ? command.join(' ') : command);
    const value = input.pattern || input.url || input.query || input.description;
    return value ? shorten(value) : '';
}

/**
 * Check whether an executable must be started through a shell on Windows.
 * npm installs .cmd wrappers, and paths with dot folders (\.local) fail
 * with spawn() on some Windows versions.
 * @param {string} toolPath - Executable path
 * @returns {boolean} True if a shell is needed
 */
function needsShell(toolPath) {
    if (!IS_WINDOWS) return false;
    const lower = toolPath.toLowerCase();
    return lower.endsWith('.cmd') || lower.endsWith('.bat') || toolPath.includes('\\.');
}

/**
 * Quote one argument for cmd.exe. With a shell, Node joins the arguments with
 * spaces, so a path with spaces would fall apart and "&" would start a command.
 * @param {string} arg - Argument
 * @returns {string} Argument, quoted if needed
 */
function quoteShellArg(arg) {
    const text = String(arg);
    return SAFE_SHELL_ARG.test(text) ? text : `"${text.replace(/"/g, '""')}"`;
}

/**
 * Command, arguments and shell flag for spawn() and execFile()
 * @param {string} toolPath - Executable
 * @param {string[]} args - Arguments
 * @returns {{command: string, args: string[], shell: boolean}} Spawn parameters
 */
function prepareSpawn(toolPath, args) {
    if (!needsShell(toolPath)) return { command: toolPath, args, shell: false };
    return { command: `"${toolPath}"`, args: args.map(quoteShellArg), shell: true };
}

/**
 * Build the environment for a spawned tool. The tool's own folder goes to
 * the front of PATH: IDEs started from the desktop often have a short PATH,
 * and npm-installed agents (e.g. via nvm) need 'node' from that folder.
 * @param {string|null} toolPath - Executable
 * @param {Object} extra - Additional variables
 * @param {string[]} extraDirs - More folders for the front of PATH (e.g. arduino-cli)
 * @returns {Object} Environment
 */
function buildEnv(toolPath, extra = {}, extraDirs = []) {
    const env = { ...process.env, ...extra };
    const dirs = [toolPath && path.dirname(toolPath), ...extraDirs].filter(Boolean);
    if (dirs.length === 0) return env;
    // Windows names it 'Path'; keep the existing key instead of adding a second one
    const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
    const parts = (env[key] || '').split(path.delimiter).filter(Boolean);
    const front = dirs.filter((dir, index) => dirs.indexOf(dir) === index);
    env[key] = [...front, ...parts.filter(part => !front.includes(part))].join(path.delimiter);
    return env;
}

/**
 * Write a file atomically via temp file and rename, so a crash never leaves half a file
 * @param {string} file - Target path
 * @param {string} content - Content
 */
function writeFileAtomic(file, content) {
    const tempFile = file + TEMP_SUFFIX;
    fs.writeFileSync(tempFile, content, { encoding: 'utf8', mode: FILE_MODE });
    fs.renameSync(tempFile, file);
}

/**
 * Compare version numbers like '3.1.2' or folder names like 'v20.11.0'
 * @param {string} a - Version
 * @param {string} b - Version
 * @returns {number} Negative if a is older, 0 if equal, positive if a is newer
 */
function compareVersions(a, b) {
    const parse = v => String(v || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    const pa = parse(a);
    const pb = parse(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/**
 * Parse a JSON string safely
 * @param {string} text - JSON text
 * @returns {*} Parsed value or null
 */
function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

module.exports = {
    IS_WINDOWS,
    createError,
    shorten,
    displayPath,
    describeToolInput,
    describeCommand,
    quoteShellArg,
    prepareSpawn,
    buildEnv,
    writeFileAtomic,
    compareVersions,
    parseJson
};
