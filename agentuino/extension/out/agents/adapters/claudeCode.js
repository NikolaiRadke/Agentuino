/*
 * Agentuino - Claude Code Adapter
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * claude -p --output-format stream-json --verbose, prompt via stdin.
 * Project instructions are passed with --append-system-prompt-file.
 * Command line options and install data: config/agentConfigs.json
 */

"use strict";

const os = require('os');
const { spawn } = require('child_process');
const { describeToolInput, prepareSpawn, buildEnv, parseJson, contentText } = require('../agentUtils');
const { defineAdapter } = require('../agentConfig');

// ===== CONSTANTS =====

const TITLE_TIMEOUT_MS = 30000;
const MAX_TITLE_CHARS = 60;

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
        apiError: null,
        result: null,

        onEvent(event) {
            if (event.session_id) parser.sessionId = event.session_id;

            if (event.type === 'system' && event.subtype === 'init') {
                return [{ type: 'init', sessionId: event.session_id }];
            }

            // API errors (e.g. expired login) arrive as synthetic assistant messages
            if (event.type === 'assistant' && event.is_api_error_message) {
                parser.apiError = event.error || 'api_error';
                return [];
            }

            // Skip subagent chatter, the main conversation carries the answer
            if (event.type === 'assistant' && !event.parent_tool_use_id) {
                const out = [];
                for (const block of event.message?.content || []) {
                    if (block.type === 'text' && block.text?.trim()) {
                        out.push({ type: 'text', text: block.text });
                    } else if (block.type === 'tool_use') {
                        // Only shell calls get an id: their output can be shown under the line
                        const id = block.name === 'Bash' && block.id ? block.id : undefined;
                        if (id) shellCalls.add(id);
                        out.push({ type: 'tool', name: block.name, detail: describeToolInput(block.input, cwd), ...(id && { id }) });
                    }
                }
                return out;
            }

            // Tool results come back as user messages
            if (event.type === 'user' && !event.parent_tool_use_id) {
                const out = [];
                for (const block of event.message?.content || []) {
                    if (block?.type === 'tool_result' && shellCalls.delete(block.tool_use_id)) {
                        out.push({ type: 'toolOutput', id: block.tool_use_id, output: contentText(block.content), failed: !!block.is_error });
                    }
                }
                return out;
            }

            if (event.type === 'result') {
                parser.result = {
                    sessionId: event.session_id || parser.sessionId,
                    result: event.result || '',
                    isError: !!event.is_error,
                    errorType: parser.apiError === 'authentication_failed' ? 'auth' : parser.apiError,
                    costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null
                };
            }
            return [];
        },

        finish() {
            return parser.result;
        }
    };
    return parser;
}

/**
 * Generate a short chat title with the smallest model.
 * Runs outside the sketch folder, without session, single turn.
 * @param {string} toolPath - Claude Code executable
 * @param {string} prompt - Complete title prompt
 * @returns {Promise<string|null>} Title or null on any failure
 */
function generateTitle(toolPath, prompt) {
    return new Promise(resolve => {
        const args = ['-p', '--model', adapter.titleModel, '--output-format', 'json', '--max-turns', '1'];
        const spawnArgs = prepareSpawn(toolPath, args);
        let stdout = '';
        let child;

        try {
            child = spawn(spawnArgs.command, spawnArgs.args, {
                cwd: os.tmpdir(),
                env: buildEnv(toolPath),
                stdio: ['pipe', 'pipe', 'ignore'],
                shell: spawnArgs.shell,
                windowsHide: true
            });
        } catch {
            resolve(null);
            return;
        }

        const timer = setTimeout(() => child.kill(), TITLE_TIMEOUT_MS);
        child.stdout.on('data', data => { stdout += data.toString(); });
        child.on('error', () => { clearTimeout(timer); resolve(null); });
        child.on('close', () => {
            clearTimeout(timer);
            const result = parseJson(stdout);
            const title = String(result?.result || '')
                .split('\n')[0]
                .replace(/^["'„“#*\s]+|["'“”*.\s]+$/g, '')
                .slice(0, MAX_TITLE_CHARS);
            resolve(result && !result.is_error && title ? title : null);
        });
        child.stdin.on('error', () => {});
        child.stdin.end(prompt);
    });
}

const adapter = defineAdapter('claudecode', {
    pathSetting: 'claudePath',
    modelSetting: 'claudeModel',
    needsRunDir: false,
    createParser,
    generateTitle
});

module.exports = adapter;
