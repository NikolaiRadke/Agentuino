/*
 * Agentuino - Rule Blocks
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Code rules the user switches on per sketch with a click ("semantic anchors").
 * Built-in blocks live in code, their label and text in the locale files.
 * Custom blocks and the default selection for new sketches are stored in
 * ~/.agentuino/rules.json; the selection of a sketch in agentuino/config.json
 * (field "rules"; missing = follow the defaults). Active blocks end up in the
 * automatic section of AGENTS.md. Safety rules are not blocks, they stay fixed.
 * Pure Node, no VS Code API.
 */

"use strict";

const fs = require('fs');
const os = require('os');
const path = require('path');

// ===== CONSTANTS =====

const USER_FILE = path.join(os.homedir(), '.agentuino', 'rules.json');
const FILE_VERSION = 1;
const JSON_INDENT = 2;
const CUSTOM_PREFIX = 'custom-';
const MAX_LABEL_LENGTH = 60;
const MAX_TEXT_LENGTH = 500;

// Order of the groups on the page
const GROUPS = ['basic', 'pro', 'workflow', 'custom'];

// group: 'basic' (everyday), 'pro' (advanced, collapsed), 'workflow' (how the agent works)
const BUILTIN_BLOCKS = [
    { key: 'beginnerComments', group: 'basic', defaultEnabled: true },
    { key: 'noMagicNumbers', group: 'basic', defaultEnabled: true },
    { key: 'nonBlocking', group: 'basic', defaultEnabled: false },
    { key: 'lowRam', group: 'basic', defaultEnabled: false },
    { key: 'defensive', group: 'basic', defaultEnabled: false },
    { key: 'isrSafe', group: 'pro', defaultEnabled: false },
    { key: 'noDynamicMemory', group: 'pro', defaultEnabled: false },
    { key: 'flashStrings', group: 'pro', defaultEnabled: false },
    { key: 'fixedWidthTypes', group: 'pro', defaultEnabled: false },
    { key: 'explainChanges', group: 'workflow', defaultEnabled: true },
    { key: 'keepStyle', group: 'workflow', defaultEnabled: false },
    { key: 'smallSteps', group: 'workflow', defaultEnabled: false }
];

// ===== STORAGE =====

/**
 * Read the user file; a missing or damaged file means "no custom blocks, built-in defaults"
 * @returns {{defaults: string[]|null, custom: Object}} State
 */
function loadState() {
    try {
        const data = JSON.parse(fs.readFileSync(USER_FILE, 'utf8'));
        const custom = {};
        for (const [key, block] of Object.entries(data.custom || {})) {
            if (key.startsWith(CUSTOM_PREFIX) && typeof block?.label === 'string' && typeof block?.text === 'string') {
                custom[key] = { label: block.label, text: block.text };
            }
        }
        const defaults = Array.isArray(data.defaults) ? data.defaults.filter(k => typeof k === 'string') : null;
        return { defaults, custom };
    } catch {
        return { defaults: null, custom: {} };
    }
}

/**
 * Write the user file atomically
 * @param {Object} state - {defaults, custom}
 */
function saveState(state) {
    fs.mkdirSync(path.dirname(USER_FILE), { recursive: true });
    const data = { version: FILE_VERSION, defaults: state.defaults, custom: state.custom };
    const tempFile = `${USER_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, JSON_INDENT) + '\n', 'utf8');
    fs.renameSync(tempFile, USER_FILE);
}

// ===== BLOCKS =====

/**
 * Check whether a key belongs to a built-in or an existing custom block
 * @param {string} key - Block key
 * @param {Object} state - User state
 * @returns {boolean} Known
 */
function isKnown(key, state) {
    return BUILTIN_BLOCKS.some(b => b.key === key) || Boolean(state.custom[key]);
}

/**
 * Default selection for new sketches
 * @param {Object} [state] - User state (loaded if omitted)
 * @returns {string[]} Block keys
 */
function getDefaults(state = loadState()) {
    const keys = state.defaults ?? BUILTIN_BLOCKS.filter(b => b.defaultEnabled).map(b => b.key);
    return keys.filter(key => isKnown(key, state));
}

/**
 * Store the default selection for new sketches
 * @param {string[]} keys - Block keys
 */
function setDefaults(keys) {
    const state = loadState();
    state.defaults = keys.filter(key => isKnown(key, state));
    saveState(state);
}

/**
 * Active blocks of a sketch: its own selection or, if it never chose, the defaults
 * @param {Object} config - Project config (field "rules")
 * @param {Object} [state] - User state (loaded if omitted)
 * @returns {string[]} Block keys
 */
function getActiveKeys(config, state = loadState()) {
    if (!Array.isArray(config?.rules)) return getDefaults(state);
    return config.rules.filter(key => isKnown(key, state));
}

/**
 * All blocks with label and text in the given language
 * @param {Function} t - Translator
 * @param {Object} [state] - User state (loaded if omitted)
 * @returns {Array<{key, group, label, text, custom}>} Blocks in page order
 */
function listBlocks(t, state = loadState()) {
    const builtin = BUILTIN_BLOCKS.map(b => ({
        key: b.key,
        group: b.group,
        label: t(`rules.blocks.${b.key}.label`),
        text: t(`rules.blocks.${b.key}.text`),
        custom: false
    }));
    const custom = Object.entries(state.custom).map(([key, b]) => ({
        key, group: 'custom', label: b.label, text: b.text, custom: true
    }));
    return [...builtin, ...custom];
}

/**
 * Texts of the active blocks for AGENTS.md, one line each
 * @param {Object} config - Project config
 * @param {Function} t - Translator in the project language
 * @returns {string[]} Rule texts
 */
function getActiveTexts(config, t) {
    const state = loadState();
    const active = new Set(getActiveKeys(config, state));
    return listBlocks(t, state)
        .filter(block => active.has(block.key))
        .map(block => block.text.replace(/\s*\n\s*/g, ' ').trim())
        .filter(Boolean);
}

/**
 * Clean user input for a custom block
 * @param {string} label - Name
 * @param {string} text - Rule text
 * @returns {{label: string, text: string}} Cleaned values
 * @throws {Error} When label or text is empty
 */
function cleanCustom(label, text) {
    const cleaned = {
        label: String(label || '').trim().slice(0, MAX_LABEL_LENGTH),
        text: String(text || '').trim().slice(0, MAX_TEXT_LENGTH)
    };
    if (!cleaned.label || !cleaned.text) throw new Error('Label and text are required');
    return cleaned;
}

/**
 * Create or change a custom block
 * @param {string|null} key - Existing key, or null for a new block
 * @param {string} label - Name
 * @param {string} text - Rule text
 * @returns {string} Key of the block
 */
function saveCustom(key, label, text) {
    const state = loadState();
    const block = cleanCustom(label, text);
    let target = key;
    if (!target || !state.custom[target]) {
        const base = CUSTOM_PREFIX + (block.label.toLowerCase()
            .normalize('NFKD').replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'block');
        target = base;
        for (let i = 2; state.custom[target]; i++) target = `${base}-${i}`;
    }
    state.custom[target] = block;
    saveState(state);
    return target;
}

/**
 * Delete a custom block (it disappears from all sketches, unknown keys are ignored)
 * @param {string} key - Block key
 */
function deleteCustom(key) {
    const state = loadState();
    if (!state.custom[key]) return;
    delete state.custom[key];
    if (state.defaults) state.defaults = state.defaults.filter(k => k !== key);
    saveState(state);
}

module.exports = {
    GROUPS,
    MAX_LABEL_LENGTH,
    MAX_TEXT_LENGTH,
    loadState,
    getDefaults,
    setDefaults,
    getActiveKeys,
    listBlocks,
    getActiveTexts,
    saveCustom,
    deleteCustom
};
