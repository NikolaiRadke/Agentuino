/*
 * Agentuino - Antigravity CLI Adapter
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * agy --output-format stream-json --input-format stream-json [--conversation <id>],
 * prompt as one JSON line via stdin, closing stdin ends the run after the turn.
 * Every output line is {"event": "<type>", "<type>": {...}} with the types
 * init, step_update and result (checked against agy 1.5.8 and the headless docs).
 * Text arrives in fragments (text_delta) per step and is joined until the step
 * is DONE. Tool names and parameters are not documented, so parsing is tolerant.
 * agy has no option for an instructions file, so Agentuino puts AGENTS.md
 * into the prompt.
 */

"use strict";

const { describeToolInput, parseJson } = require('../agentUtils');
const { defineAdapter } = require('../agentConfig');

// ===== CONSTANTS =====

const STEP_DONE = 'DONE';
const STEP_TEXT = 'agent_response';
const STEP_TOOL = 'tool';
const STATUS_SUCCESS = 'SUCCESS';

// Antigravity tool names mapped to Agentuino tool labels
const TOOL_NAMES = {
    view_file: 'Read',
    view_file_outline: 'Read',
    read_file: 'Read',
    write_to_file: 'Write',
    write_file: 'Write',
    replace_file_content: 'Edit',
    multi_replace_file_content: 'Edit',
    edit_file: 'Edit',
    run_command: 'Bash',
    run_shell_command: 'Bash',
    find_by_name: 'Glob',
    list_dir: 'Glob',
    glob: 'Glob',
    grep_search: 'Grep',
    codebase_search: 'Grep',
    read_url_content: 'WebFetch',
    web_fetch: 'WebFetch',
    search_web: 'WebSearch',
    write_todos: 'TodoWrite'
};

// Parameter names of Antigravity tools mapped to the ones describeToolInput reads
const PARAMETER_NAMES = {
    TargetFile: 'file_path',
    AbsolutePath: 'file_path',
    File: 'file_path',
    CommandLine: 'command',
    SearchPath: 'path',
    SearchDirectory: 'path',
    DirectoryPath: 'path',
    Pattern: 'pattern',
    Query: 'query',
    Url: 'url'
};

// ===== ADAPTER =====

/**
 * Wrap the prompt as one streaming input message
 * @param {string} prompt - Prompt
 * @returns {string} JSON line
 */
function formatInput(prompt) {
    return JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n';
}

/**
 * Bring tool parameters into the form describeToolInput understands
 * @param {*} parameters - Object or JSON string
 * @returns {Object|null} Parameters
 */
function normalizeParameters(parameters) {
    const input = typeof parameters === 'string' ? parseJson(parameters) : parameters;
    if (!input || typeof input !== 'object') return null;
    const result = {};
    for (const [key, value] of Object.entries(input)) {
        result[PARAMETER_NAMES[key] || key] = value;
    }
    return result;
}

/**
 * Create a parser for one run
 * @param {Object} context - {cwd, sessionId}
 * @returns {Object} Parser with onEvent() and finish()
 */
function createParser({ cwd, sessionId }) {
    const texts = new Map();
    const toolsShown = new Set();
    let initSent = false;
    let textShown = false;

    const parser = {
        sessionId,
        result: null,

        onEvent(event) {
            const type = event.event;
            const payload = (type && event[type]) || event;
            const out = [];

            if (payload.conversation_id && payload.conversation_id !== parser.sessionId) {
                parser.sessionId = payload.conversation_id;
            }
            if (!initSent && payload.conversation_id) {
                initSent = true;
                out.push({ type: 'init', sessionId: payload.conversation_id });
            }

            if (type === 'step_update') {
                out.push(...parser.onStep(payload));
            } else if (type === 'result') {
                out.push(...parser.flushTexts());
                parser.onResult(payload);
                // Answer only in the result (no text steps seen)
                if (!textShown && payload.response?.trim() && parser.result && !parser.result.isError) {
                    textShown = true;
                    out.push({ type: 'text', text: payload.response });
                }
            }
            return out;
        },

        onStep(step) {
            const key = step.step_index;
            const done = step.state === STEP_DONE;

            if (step.step_type === STEP_TEXT) {
                texts.set(key, (texts.get(key) || '') + (step.text_delta || ''));
                if (!done) return [];
                const text = texts.get(key);
                texts.delete(key);
                if (!text.trim()) return [];
                textShown = true;
                return [{ type: 'text', text }];
            }

            if (step.step_type === STEP_TOOL && !toolsShown.has(key)) {
                const info = step.tool_info || {};
                const input = normalizeParameters(info.parameters);
                // Wait for the parameters, they may come with a later update of the step
                if (!input && !done) return [];
                toolsShown.add(key);
                const rawName = info.name || step.tool_name || '';
                return [{
                    type: 'tool',
                    name: TOOL_NAMES[rawName] || rawName,
                    detail: describeToolInput(input, cwd)
                }];
            }
            return [];
        },

        flushTexts() {
            const out = [];
            for (const text of texts.values()) {
                if (text.trim()) out.push({ type: 'text', text });
            }
            if (out.length) textShown = true;
            texts.clear();
            return out;
        },

        onResult(result) {
            const isError = result.status !== STATUS_SUCCESS;
            const message = result.error || '';
            parser.result = {
                sessionId: result.conversation_id || parser.sessionId,
                result: isError ? (message || result.status || '') : (result.response || ''),
                isError,
                errorType: isError && adapter.authError?.test(message) ? 'auth' : null,
                costUsd: null
            };
        },

        finish({ stderr }) {
            if (parser.result) return parser.result;
            // No result line: only a login problem is worth a message of its own
            if (adapter.authError?.test(stderr || '')) {
                return { sessionId: parser.sessionId, result: stderr.trim(), isError: true, errorType: 'auth', costUsd: null };
            }
            return null;
        }
    };
    return parser;
}

const adapter = defineAdapter('antigravity', {
    pathSetting: 'antigravityPath',
    modelSetting: 'antigravityModel',
    needsRunDir: false,
    formatInput,
    createParser,
    generateTitle: null
});

module.exports = adapter;
