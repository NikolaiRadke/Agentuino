/*
 * Agentuino - Helpers for the agent tools (agentuino-serial, agentuino-debug)
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 */

"use strict";

const path = require('path');
const { execFile } = require('child_process');
const { buildEnv } = require(path.join(__dirname, '..', 'out', 'agents', 'agentUtils'));

// ===== CONSTANTS =====

const IS_WINDOWS = process.platform === 'win32';
const CLI_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CLI_BUFFER = 32 * 1024 * 1024;
const CLI_ENV = { ARDUINO_UPDATER_ENABLE_NOTIFICATION: 'false' };
// Long output keeps its start and its end
const KEEP_HEAD_CHARS = 4000;
const KEEP_TAIL_CHARS = 12000;

/**
 * Settings Agentuino passes to its tools
 * @returns {{cli: string, configFile: string|null, port: string|null, fqbn: string|null, sketch: string}} Settings
 */
function getToolEnv() {
    return {
        cli: process.env.AGENTUINO_CLI || 'arduino-cli',
        configFile: process.env.AGENTUINO_CLI_CONFIG || null,
        port: process.env.AGENTUINO_PORT || null,
        fqbn: process.env.AGENTUINO_FQBN || null,
        sketch: process.env.AGENTUINO_SKETCH || process.cwd()
    };
}

/**
 * Run arduino-cli and collect its output
 * @param {Object} env - From getToolEnv()
 * @param {string[]} args - Arguments (--config-file is added)
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} Result
 */
function runCli(env, args) {
    const fullArgs = env.configFile ? [...args, '--config-file', env.configFile] : args;
    return new Promise(resolve => {
        execFile(env.cli, fullArgs, {
            env: buildEnv(null, CLI_ENV),
            timeout: CLI_TIMEOUT_MS,
            maxBuffer: MAX_CLI_BUFFER,
            windowsHide: true
        }, (err, stdout, stderr) => {
            const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
            resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
        });
    });
}

/**
 * Stop a process including its children
 * @param {ChildProcess} child - Process (started detached on Unix)
 */
function stopProcess(child) {
    if (!child || child.exitCode !== null) return;
    if (IS_WINDOWS) {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        return;
    }
    try {
        process.kill(-child.pid, 'SIGTERM');
    } catch {
        child.kill('SIGTERM');
    }
}

/**
 * Shorten long output, keeping start and end
 * @param {string} text - Text
 * @returns {string} Text
 */
function cutText(text) {
    if (text.length <= KEEP_HEAD_CHARS + KEEP_TAIL_CHARS) return text;
    const skipped = text.length - KEEP_HEAD_CHARS - KEEP_TAIL_CHARS;
    return `${text.slice(0, KEEP_HEAD_CHARS)}\n… (${skipped} characters cut) …\n${text.slice(-KEEP_TAIL_CHARS)}`;
}

module.exports = { IS_WINDOWS, getToolEnv, runCli, stopProcess, cutText };
