/*
 * Agentuino - Model Catalog
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Model suggestions and effort levels for the chat. Agents with a model list
 * command (modelsCommand in agentConfigs.json) are asked once per session,
 * the others get the fixed lists from the configuration. Effort levels come
 * from the model list where the agent reports them per model.
 * Nothing here is required: if a command fails, the fixed lists remain.
 * Pure Node.js (no vscode dependency).
 */

"use strict";

const { execFile } = require('child_process');
const { prepareSpawn, buildEnv, parseJson } = require('./agentUtils');
const { isModel, isEffort } = require('./agentConfig');

// ===== CONSTANTS =====

const LIST_TIMEOUT_MS = 30000;
// opencode models --verbose prints a JSON block per model, several hundred KB
const MAX_LIST_BUFFER = 16 * 1024 * 1024;
const MAX_MODELS = 1000;
const HIDDEN_VISIBILITY = 'hide';
// opencode-verbose: a model ID on its own line, then its JSON block up to a "}" line
const OPENCODE_BLOCK = /^(\S+)\r?\n(\{[\s\S]*?\r?\n\})\s*$/gm;

// ===== STATE =====

// Key: agent ID and executable, value: Promise of the parsed list
const cache = new Map();

// ===== PARSERS =====

/**
 * One model per line, the first word counts. Headings ("Models:") are skipped.
 * @param {string} text - Output
 * @returns {Array<{id: string, efforts: string[]|null}>} Models
 */
function parseLines(text) {
    return String(text).split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.endsWith(':'))
        .map(line => line.split(/\s+/)[0])
        .filter(isModel)
        .map(id => ({ id, efforts: null }));
}

/**
 * codex debug models: {models: [{slug, visibility, supported_reasoning_levels: [{effort}]}]}
 * @param {string} text - Output
 * @returns {Array<{id: string, efforts: string[]|null}>} Models
 */
function parseCodexJson(text) {
    const data = parseJson(text);
    if (!Array.isArray(data?.models)) return [];
    return data.models
        .filter(model => isModel(model?.slug) && model.visibility !== HIDDEN_VISIBILITY)
        .map(model => {
            const levels = Array.isArray(model.supported_reasoning_levels)
                ? model.supported_reasoning_levels.map(level => level?.effort).filter(isEffort)
                : null;
            return { id: model.slug, efforts: levels };
        });
}

/**
 * opencode models --verbose: "provider/model" lines, each followed by a JSON
 * block whose "variants" keys are the effort levels (empty: none)
 * @param {string} text - Output
 * @returns {Array<{id: string, efforts: string[]|null}>} Models
 */
function parseOpencodeVerbose(text) {
    const models = [];
    for (const match of String(text).matchAll(OPENCODE_BLOCK)) {
        if (!isModel(match[1])) continue;
        const variants = parseJson(match[2])?.variants;
        const efforts = variants && typeof variants === 'object' ? Object.keys(variants).filter(isEffort) : null;
        models.push({ id: match[1], efforts });
    }
    return models;
}

const PARSERS = {
    'lines': parseLines,
    'codex-json': parseCodexJson,
    'opencode-verbose': parseOpencodeVerbose
};

/**
 * Parse the output of a model list command
 * @param {string} format - Format from modelsCommand
 * @param {string} text - Output
 * @returns {Array<{id: string, efforts: string[]|null}>} Models, without duplicates
 */
function parse(format, text) {
    const parser = PARSERS[format];
    if (!parser) return [];
    const seen = new Set();
    return parser(text).filter(model => !seen.has(model.id) && seen.add(model.id)).slice(0, MAX_MODELS);
}

// ===== LOADING =====

/**
 * Run the model list command of an agent
 * @param {Object} adapter - Agent adapter
 * @param {string} toolPath - Agent executable
 * @returns {Promise<Array>} Models, empty on any failure
 */
function runList(adapter, toolPath) {
    const command = adapter.modelsCommand;
    if (!command || !toolPath) return Promise.resolve([]);
    return new Promise(resolve => {
        try {
            const spawnArgs = prepareSpawn(toolPath, command.args);
            const child = execFile(spawnArgs.command, spawnArgs.args, {
                env: buildEnv(toolPath),
                timeout: LIST_TIMEOUT_MS,
                maxBuffer: MAX_LIST_BUFFER,
                shell: spawnArgs.shell,
                windowsHide: true
            }, (err, stdout) => resolve(err ? [] : parse(command.format, stdout)));
            // Nothing to read: an agent waiting for a prompt on stdin ends at once
            child.stdin?.on('error', () => {});
            child.stdin?.end();
        } catch {
            resolve([]);
        }
    });
}

/**
 * Models an agent reports, asked once per session. A failed attempt is not
 * kept, so the next chat tries again (e.g. after logging in).
 * @param {Object} adapter - Agent adapter
 * @param {string} toolPath - Agent executable
 * @returns {Promise<Array<{id: string, efforts: string[]|null}>>} Models
 */
function listModels(adapter, toolPath) {
    const key = `${adapter.id}\n${toolPath}`;
    if (!cache.has(key)) {
        const promise = runList(adapter, toolPath).then(models => {
            if (models.length === 0) cache.delete(key);
            return models;
        });
        cache.set(key, promise);
    }
    return cache.get(key);
}

/**
 * Suggestions and effort levels for the chat
 * @param {Object} adapter - Agent adapter
 * @param {Array} listed - Models from listModels (may be empty)
 * @param {string} model - Model of the chat ('' = agent default)
 * @returns {{models: string[], efforts: string[]}} Suggestions and levels for this model
 */
function describe(adapter, listed, model) {
    const models = [...new Set([...adapter.models, ...listed.map(entry => entry.id)])];
    if (!adapter.supportsEffort) return { models, efforts: [] };
    // Levels of the model itself, if the agent reports them; otherwise the fixed list
    const entry = listed.find(item => item.id === model);
    const efforts = entry?.efforts || adapter.efforts;
    return { models, efforts };
}

/**
 * Forget all lists (tests)
 */
function clear() {
    cache.clear();
}

module.exports = {
    parse,
    listModels,
    describe,
    clear
};
