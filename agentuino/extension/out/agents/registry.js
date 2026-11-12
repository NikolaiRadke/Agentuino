/*
 * Agentuino - Agent Registry
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * All supported agents in order of preference for automatic selection.
 * A new agent needs an adapter file, an entry here and one in
 * config/agentConfigs.json.
 */

"use strict";

const agentConfig = require('./agentConfig');

const ADAPTERS = [
    require('./adapters/claudeCode'),
    require('./adapters/codex'),
    require('./adapters/mistralVibe')
];

const AUTO = 'auto';
const IDS = ADAPTERS.map(adapter => adapter.id);

// Shipped file or a newer accepted download
agentConfig.load(IDS);

/**
 * Get all adapters
 * @returns {Object[]} Adapters
 */
function getAll() {
    return ADAPTERS;
}

/**
 * Get an adapter by ID
 * @param {string} id - Agent ID
 * @returns {Object|null} Adapter
 */
function get(id) {
    return ADAPTERS.find(adapter => adapter.id === id) || null;
}

/**
 * Get the display name of an agent
 * @param {string} id - Agent ID
 * @returns {string} Name (the ID if unknown)
 */
function getName(id) {
    return get(id)?.name || id;
}

/**
 * Look for a newer agent configuration on GitHub (nothing is stored)
 * @param {string} skipped - Version the user chose to skip
 * @returns {Promise<Object|null>} Newer, valid configuration or null
 */
function findConfigUpdate(skipped) {
    return agentConfig.findUpdate(IDS, skipped);
}

module.exports = {
    AUTO,
    getAll,
    get,
    getName,
    findConfigUpdate,
    applyConfig: agentConfig.apply,
    getConfigInfo: agentConfig.getInfo
};
