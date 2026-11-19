/*
 * Agentuino - Agent Runner
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Runs one turn of a CLI agent in the sketch folder. Everything agent
 * specific (arguments, output format, sessions) lives in the adapters;
 * the runner handles the process: stdin prompt, line-wise JSON parsing,
 * inactivity timeout and stopping the whole process tree.
 * Pure Node.js (no vscode dependency).
 */

"use strict";

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { IS_WINDOWS, createError, prepareSpawn, buildEnv } = require('./agentUtils');

// ===== CONSTANTS =====

const MS_PER_MINUTE = 60 * 1000;
const INACTIVITY_TIMEOUT_MINUTES = 10;
const INACTIVITY_TIMEOUT_MS = INACTIVITY_TIMEOUT_MINUTES * MS_PER_MINUTE;
const STOP_GRACE_MS = 3000;
const MAX_STDERR_CHARS = 4000;
const RUN_DIR_PREFIX = 'agentuino-run-';
const RUN_DIR_RANDOM_BYTES = 4;

// Inherited by the agent's shell commands: no arduino-cli update nag
const EXTRA_ENV = { ARDUINO_UPDATER_ENABLE_NOTIFICATION: 'false' };

class AgentRunner {
    constructor() {
        this.child = null;
        this.stopRequested = false;
        this.timedOut = false;
        this.inactivityTimer = null;
    }

    /**
     * Whether a run is in progress
     * @returns {boolean} True while running
     */
    get isRunning() {
        return this.child !== null;
    }

    /**
     * Run one agent turn
     * @param {Object} options
     * @param {Object} options.adapter - Agent adapter
     * @param {string} options.toolPath - Agent executable
     * @param {string} options.prompt - Prompt (sent via stdin)
     * @param {string} options.cwd - Sketch folder
     * @param {string|null} options.sessionId - Session to resume
     * @param {string} options.model - Model or ''
     * @param {string} options.effort - Effort level or ''
     * @param {string} options.permissionMode - 'bypassPermissions' | 'acceptEdits' | 'auto'
     * @param {string} options.instructionsFile - AGENTS.md relative to cwd
     * @param {string[]} options.pathDirs - Folders the agent's commands need in PATH
     * @param {Object} options.env - Additional environment variables
     * @param {Function} options.onEvent - Receives {type:'init'|'text'|'tool'|'toolOutput', ...}
     * @returns {Promise<Object>} {sessionId, result, isError, errorType, costUsd, stopped}
     */
    run({ adapter, toolPath, prompt, cwd, sessionId = null, model = '', effort = '', permissionMode = '',
        instructionsFile = '', pathDirs = [], env = {}, onEvent = () => {} }) {
        if (this.isRunning) {
            return Promise.reject(createError('BUSY', 'Agent is already running'));
        }

        this.stopRequested = false;
        this.timedOut = false;

        // Some agents report session and cost only in files, they get a private folder
        const runDir = adapter.needsRunDir
            ? fs.mkdtempSync(path.join(os.tmpdir(), RUN_DIR_PREFIX + crypto.randomBytes(RUN_DIR_RANDOM_BYTES).toString('hex')))
            : null;
        const cleanup = () => {
            if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
        };

        return new Promise((resolve, reject) => {
            const args = adapter.buildArgs({ sessionId, model, effort, permissionMode, instructionsFile, runDir });
            const parser = adapter.createParser({ cwd, sessionId });

            let child;
            try {
                const spawnArgs = prepareSpawn(toolPath, args);
                child = spawn(spawnArgs.command, spawnArgs.args, {
                    cwd,
                    env: buildEnv(toolPath, { ...EXTRA_ENV, ...env }, pathDirs),
                    stdio: ['pipe', 'pipe', 'pipe'],
                    shell: spawnArgs.shell,
                    windowsHide: true,
                    detached: !IS_WINDOWS
                });
            } catch (err) {
                cleanup();
                reject(createError('AGENT_NOT_FOUND', err.message));
                return;
            }
            this.child = child;

            let buffer = '';
            let stderr = '';

            const processLines = (flush = false) => {
                const lines = buffer.split('\n');
                buffer = flush ? '' : lines.pop();
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('{')) continue;
                    let event;
                    try {
                        event = JSON.parse(trimmed);
                    } catch {
                        continue;
                    }
                    for (const out of parser.onEvent(event)) onEvent(out);
                }
            };

            this.resetInactivityTimer();

            child.stdout.on('data', (data) => {
                this.resetInactivityTimer();
                buffer += data.toString();
                processLines();
            });

            child.stderr.on('data', (data) => {
                this.resetInactivityTimer();
                stderr = (stderr + data.toString()).slice(-MAX_STDERR_CHARS);
            });

            child.on('error', (err) => {
                this.cleanupRun();
                cleanup();
                reject(createError(err.code === 'ENOENT' ? 'AGENT_NOT_FOUND' : 'PROCESS_FAILED', err.message));
            });

            child.on('close', (exitCode) => {
                processLines(true);
                const wasStopped = this.stopRequested;
                const wasTimedOut = this.timedOut;
                this.cleanupRun();

                let result = null;
                try {
                    result = parser.finish({ exitCode, stderr, runDir });
                } catch {
                    result = null;
                }
                cleanup();

                if (wasTimedOut) {
                    reject(createError('TIMEOUT', 'Inactivity timeout', { minutes: INACTIVITY_TIMEOUT_MINUTES }));
                } else if (wasStopped) {
                    resolve({
                        sessionId: result?.sessionId || parser.sessionId || sessionId,
                        result: '', isError: false, errorType: null, costUsd: null, stopped: true
                    });
                } else if (result) {
                    resolve({ stopped: false, errorType: null, costUsd: null, ...result });
                } else if (sessionId && adapter.sessionNotFound?.test(stderr)) {
                    reject(createError('SESSION_NOT_FOUND', stderr.trim()));
                } else {
                    reject(createError('PROCESS_FAILED', stderr.trim() || `Exit code ${exitCode}`, { exitCode }));
                }
            });

            child.stdin.on('error', () => { /* process ended before reading stdin */ });
            // Some agents expect the prompt wrapped in their own input format
            child.stdin.end(adapter.formatInput ? adapter.formatInput(prompt) : prompt);
        });
    }

    /**
     * Stop the running agent: SIGINT first (ends the turn cleanly), then force
     */
    stop() {
        if (!this.child) return;
        this.stopRequested = true;
        const pid = this.child.pid;

        if (IS_WINDOWS) {
            execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
            return;
        }

        this.signalGroup(pid, 'SIGINT');
        setTimeout(() => {
            if (this.child?.pid === pid) this.signalGroup(pid, 'SIGTERM');
        }, STOP_GRACE_MS);
        setTimeout(() => {
            if (this.child?.pid === pid) this.signalGroup(pid, 'SIGKILL');
        }, STOP_GRACE_MS * 2);
    }

    /**
     * Send a signal to the whole process group (Unix)
     * @param {number} pid - Process ID of the group leader
     * @param {string} signal - Signal name
     */
    signalGroup(pid, signal) {
        try {
            process.kill(-pid, signal);
        } catch {
            try { process.kill(pid, signal); } catch { /* already gone */ }
        }
    }

    /**
     * Restart the inactivity watchdog
     */
    resetInactivityTimer() {
        clearTimeout(this.inactivityTimer);
        this.inactivityTimer = setTimeout(() => {
            this.timedOut = true;
            this.stop();
        }, INACTIVITY_TIMEOUT_MS);
    }

    /**
     * Reset state after a run
     */
    cleanupRun() {
        clearTimeout(this.inactivityTimer);
        this.inactivityTimer = null;
        this.child = null;
    }
}

module.exports = { AgentRunner };
