/*
 * Agentuino - Codex CLI Adapter
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * codex exec --json [...] -          new session, prompt via stdin
 * codex exec --json [...] resume <id> -
 * Output is JSONL: thread.started, item.started/item.completed,
 * turn.completed, turn.failed (checked against codex-cli 0.167).
 * Codex has no option for an extra instructions file, so Agentuino puts
 * AGENTS.md into the prompt instead.
 * Command line options and install data: config/agentConfigs.json
 */

"use strict";

const { displayPath, shorten, describeCommand } = require('../agentUtils');
const { defineAdapter } = require('../agentConfig');

// ===== CONSTANTS =====

// Codex file change kinds mapped to Agentuino tool labels
const CHANGE_TOOLS = { add: 'Write', update: 'Edit', delete: 'Delete' };

// ===== ADAPTER =====

/**
 * Get the item type (older versions used item_type and assistant_message)
 * @param {Object} item - Codex item
 * @returns {string} Normalized type
 */
function itemType(item) {
    const type = item?.type || item?.item_type || '';
    return type === 'assistant_message' ? 'agent_message' : type;
}

/**
 * Create a parser for one run
 * @param {Object} context - {cwd, sessionId}
 * @returns {Object} Parser with onEvent() and finish()
 */
function createParser({ cwd, sessionId }) {
    const parser = {
        sessionId,
        result: null,

        onEvent(event) {
            const item = event.item;
            const type = itemType(item);

            switch (event.type) {
                case 'thread.started':
                    parser.sessionId = event.thread_id || parser.sessionId;
                    return [{ type: 'init', sessionId: parser.sessionId }];

                case 'item.started':
                    if (type === 'command_execution') {
                        return [{ type: 'tool', name: 'Bash', detail: describeCommand(item.command || '') }];
                    }
                    return [];

                case 'item.completed':
                    if (type === 'agent_message' && item.text?.trim()) {
                        return [{ type: 'text', text: item.text }];
                    }
                    if (type === 'file_change') {
                        return (item.changes || []).map(change => ({
                            type: 'tool',
                            name: CHANGE_TOOLS[change.kind] || 'Edit',
                            detail: displayPath(change.path || '', cwd)
                        }));
                    }
                    if (type === 'web_search') {
                        return [{ type: 'tool', name: 'WebSearch', detail: shorten(item.query || '') }];
                    }
                    if (type === 'mcp_tool_call') {
                        return [{ type: 'tool', name: `${item.server}.${item.tool}`, detail: '' }];
                    }
                    if (type === 'todo_list') {
                        return [{ type: 'tool', name: 'TodoWrite', detail: '' }];
                    }
                    return [];

                case 'turn.completed':
                    parser.result = { sessionId: parser.sessionId, result: '', isError: false, costUsd: null };
                    return [];

                case 'turn.failed': {
                    const message = event.error?.message || 'turn failed';
                    parser.result = {
                        sessionId: parser.sessionId,
                        result: message,
                        isError: true,
                        errorType: adapter.authError?.test(message) ? 'auth' : null,
                        costUsd: null
                    };
                    return [];
                }

                // Top-level 'error' events are reconnect notices, the outcome comes with turn.*
                default:
                    return [];
            }
        },

        finish() {
            return parser.result;
        }
    };
    return parser;
}

const adapter = defineAdapter('codex', {
    pathSetting: 'codexPath',
    modelSetting: 'codexModel',
    needsRunDir: false,
    createParser,
    generateTitle: null
});

module.exports = adapter;
