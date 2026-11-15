/*
 * Agentuino - OpenCode Adapter
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * opencode run --format json [--session <id>] [--model <provider/model>], prompt via stdin.
 * Output is JSONL with the types step_start, text, tool_use, step_finish and error
 * (checked against opencode 1.18.32). Every line carries the sessionID. A tool comes
 * as one tool_use when it is done, with input, output and for bash the exit code.
 * Cost is per step in step_finish. OpenCode talks to many providers, local ones
 * like Ollama included (--model ollama/<model>).
 * OpenCode has no option for an instructions file, so Agentuino puts AGENTS.md
 * into the prompt.
 * Command line options and install data: config/agentConfigs.json
 */

"use strict";

const { describeToolInput } = require('../agentUtils');
const { defineAdapter } = require('../agentConfig');

// ===== CONSTANTS =====

// OpenCode tool names mapped to Agentuino tool labels
const TOOL_NAMES = {
    bash: 'Bash',
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    multiedit: 'Edit',
    patch: 'Edit',
    apply_patch: 'Edit',
    grep: 'Grep',
    glob: 'Glob',
    list: 'Glob',
    webfetch: 'WebFetch',
    todowrite: 'TodoWrite',
    todoread: 'TodoWrite'
};

const STATUS_ERROR = 'error';

// ===== ADAPTER =====

/**
 * Map OpenCode parameter names to the ones describeToolInput reads
 * @param {Object} input - Tool input
 * @returns {Object} Input
 */
function normalizeInput(input) {
    if (!input || typeof input !== 'object') return input;
    return input.filePath ? { ...input, file_path: input.filePath } : input;
}

/**
 * Text of an error event
 * @param {Object} event - {error: {name, data: {message}}} or {message}
 * @returns {string} Message
 */
function errorText(event) {
    if (typeof event.message === 'string' && event.message) return event.message;
    const error = event.error || {};
    const message = error.data?.message || error.message || '';
    return [error.name, message].filter(Boolean).join(': ') || 'Unknown error';
}

/**
 * Create a parser for one run
 * @param {Object} context - {cwd, sessionId}
 * @returns {Object} Parser with onEvent() and finish()
 */
function createParser({ cwd, sessionId }) {
    let initSent = false;
    let seen = false;
    let cost = null;
    let error = null;

    const parser = {
        sessionId,

        onEvent(event) {
            const out = [];
            seen = true;
            if (event.sessionID && !initSent) {
                initSent = true;
                parser.sessionId = event.sessionID;
                out.push({ type: 'init', sessionId: event.sessionID });
            }
            const part = event.part || {};

            switch (event.type) {
                case 'text':
                    if (part.text?.trim()) out.push({ type: 'text', text: part.text });
                    break;
                case 'tool_use': {
                    const state = part.state || {};
                    const name = TOOL_NAMES[part.tool] || part.tool || '';
                    // Only shell calls get an id: their output can be shown under the line
                    const id = name === 'Bash' && part.callID ? part.callID : undefined;
                    out.push({ type: 'tool', name, detail: describeToolInput(normalizeInput(state.input), cwd), ...(id && { id }) });
                    if (id) {
                        const exit = state.metadata?.exit;
                        out.push({
                            type: 'toolOutput',
                            id,
                            output: state.output ?? state.metadata?.output ?? state.error ?? '',
                            failed: state.status === STATUS_ERROR || (typeof exit === 'number' && exit !== 0)
                        });
                    }
                    break;
                }
                case 'step_finish':
                    if (typeof part.cost === 'number') cost = (cost || 0) + part.cost;
                    break;
                case 'error':
                    error = errorText(event);
                    break;
                default:
                    break;
            }
            return out;
        },

        finish({ exitCode }) {
            // No output at all (e.g. "Session not found" on stderr): the runner decides
            if (!seen) return null;
            const isError = Boolean(error) || exitCode !== 0;
            return {
                sessionId: parser.sessionId,
                result: error || (isError ? `Exit code ${exitCode}` : ''),
                isError,
                errorType: isError && adapter.authError?.test(error || '') ? 'auth' : null,
                costUsd: cost
            };
        }
    };
    return parser;
}

const adapter = defineAdapter('opencode', {
    pathSetting: 'opencodePath',
    modelSetting: 'opencodeModel',
    needsRunDir: false,
    createParser,
    generateTitle: null
});

module.exports = adapter;
