/*
 * Agentuino - Mistral Vibe Adapter
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * vibe -p --output streaming --output-dir <runDir> [--resume <id>], prompt via stdin.
 * Streaming prints one JSON object per session message. Session ID, cost and
 * outcome only come from <runDir>/export.json (checked against Vibe 3.1.2).
 * The message layout is not documented, so parsing is deliberately tolerant.
 * --system-prompt-file would replace Vibe's own instructions, so Agentuino
 * puts AGENTS.md into the prompt instead.
 */

"use strict";

const fs = require('fs');
const path = require('path');
const { describeToolInput, parseJson, contentText } = require('../agentUtils');
const { defineAdapter } = require('../agentConfig');

// ===== CONSTANTS =====

const EXPORT_FILE = 'export.json';

// Vibe tool names mapped to Agentuino tool labels
const TOOL_NAMES = {
    read_file: 'Read',
    write_file: 'Write',
    search_replace: 'Edit',
    edit_file: 'Edit',
    bash: 'Bash',
    grep: 'Grep',
    glob: 'Glob',
    web_fetch: 'WebFetch',
    web_search: 'WebSearch',
    todo: 'TodoWrite'
};

// ===== ADAPTER =====

/**
 * Create a parser for one run
 * @param {Object} context - {cwd, sessionId}
 * @returns {Object} Parser with onEvent() and finish()
 */
function createParser({ cwd, sessionId }) {
    // IDs of shell calls whose output is still to come
    const shellCalls = new Set();
    const parser = {
        sessionId,

        onEvent(event) {
            // Accept both plain messages and wrapped ones ({message: {...}})
            const message = event.role ? event : event.message;
            if (message?.role === 'tool' && shellCalls.delete(message.tool_call_id)) {
                return [{ type: 'toolOutput', id: message.tool_call_id, output: contentText(message.content), failed: false }];
            }
            if (!message || message.role !== 'assistant') return [];

            const out = [];
            const text = contentText(message.content);
            if (text.trim()) out.push({ type: 'text', text });

            for (const call of message.tool_calls || []) {
                const rawName = call.function?.name || call.name || '';
                const rawArgs = call.function?.arguments ?? call.arguments;
                const args = typeof rawArgs === 'string' ? parseJson(rawArgs) : rawArgs;
                const name = TOOL_NAMES[rawName] || rawName;
                // Only shell calls get an id: their output can be shown under the line
                const id = name === 'Bash' && call.id ? call.id : undefined;
                if (id) shellCalls.add(id);
                out.push({ type: 'tool', name, detail: describeToolInput(args, cwd), ...(id && { id }) });
            }
            return out;
        },

        finish({ exitCode, runDir }) {
            const report = runDir ? parseJson(readFile(path.join(runDir, EXPORT_FILE))) : null;
            if (!report) return null;

            const errorMessage = report.error?.message || '';
            const isError = (report.exit_code ?? exitCode) !== 0;
            return {
                sessionId: report.session_id || parser.sessionId,
                result: errorMessage || report.outcome || '',
                isError,
                errorType: isError && adapter.authError?.test(errorMessage) ? 'auth' : null,
                costUsd: typeof report.cost_usd === 'number' ? report.cost_usd : null
            };
        }
    };
    return parser;
}

/**
 * Read a file, null if missing
 * @param {string} file - File path
 * @returns {string|null} Content
 */
function readFile(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

// Needs a run folder: session ID, cost and exit code come from export.json
const adapter = defineAdapter('vibe', {
    pathSetting: 'vibePath',
    modelSetting: 'vibeModel',
    needsRunDir: true,
    createParser,
    generateTitle: null
});

module.exports = adapter;
