/*
 * Agentuino - Agent Configuration
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Everything about the agents that can change without new code: command line
 * options, install commands, minimum versions, install locations, error patterns.
 * Shipped in config/agentConfigs.json; a newer copy from GitHub is stored in
 * ~/.agentuino/ only after the user agreed. Pure data (JSON), never executed.
 * Pure Node, no VS Code API.
 */

"use strict";

const fs = require('fs');
const os = require('os');
const path = require('path');
const links = require('../utils/links');
const { fetchJson } = require('../utils/remoteFile');
const { IS_WINDOWS, writeFileAtomic } = require('./agentUtils');

// ===== CONSTANTS =====

// Format the code understands; files with another schema are ignored
const SUPPORTED_SCHEMA = 1;
const BUNDLED_FILE = path.join(__dirname, '..', '..', 'config', 'agentConfigs.json');
const USER_DIR = path.join(os.homedir(), '.agentuino');
const USER_FILE = path.join(USER_DIR, 'agentConfigs.json');
const REGEX_FLAGS = 'i';
const PERMISSION_MODES = ['bypassPermissions', 'acceptEdits', 'auto'];
const DEFAULT_PERMISSION = 'bypassPermissions';
const VERSION_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:-(\d+))?$/;
const JSON_INDENT = 2;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
// A plain program name: looked up in PATH, never a path to some other program
const COMMAND_PATTERN = /^[a-z][\w-]*$/;

// ===== STATE =====

let current = null;

// ===== VALIDATION =====

const isString = value => typeof value === 'string' && value.length > 0;
const isStringArray = value => Array.isArray(value) && value.every(isString);
const isOptional = (value, check) => value === undefined || check(value);

/**
 * Install locations must point to the agent's own command, not to any program
 * @param {Object} agent - Agent entry
 * @returns {boolean} Valid
 */
function hasValidCandidates(agent) {
    const lists = [agent.candidates?.unix, agent.candidates?.windows];
    if (!lists.every(isStringArray) || !isString(agent.command)) return false;
    const names = new Set([agent.command, `${agent.command}.exe`, `${agent.command}.cmd`]);
    return lists.flat().every(entry => names.has(entry.split(/[\\/]/).pop()));
}

/**
 * Check that a string is a valid regular expression
 * @param {string} value - Pattern
 * @returns {boolean} Valid
 */
function isRegex(value) {
    if (!isString(value)) return false;
    try {
        new RegExp(value, REGEX_FLAGS);
        return true;
    } catch {
        return false;
    }
}

/**
 * Check one agent entry
 * @param {Object} agent - Agent entry
 * @returns {string|null} Name of the first bad field, null if valid
 */
function checkAgent(agent) {
    if (!agent || typeof agent !== 'object') return 'entry';
    const args = agent.args || {};
    const checks = {
        name: isString(agent.name),
        command: isString(agent.command) && COMMAND_PATTERN.test(agent.command),
        versionArgs: isStringArray(agent.versionArgs),
        helpArgs: isOptional(agent.helpArgs, v => Array.isArray(v) && v.every(isStringArray)),
        installUrl: isString(agent.installUrl) && agent.installUrl.startsWith('https://'),
        install: isString(agent.install?.unix) && isString(agent.install?.windows),
        setupCommand: isString(agent.setupCommand),
        loginHint: isString(agent.loginHint),
        candidates: hasValidCandidates(agent),
        'args.base': isStringArray(args.base),
        'args.instructions': isOptional(args.instructions, v => isStringArray(v) && v.includes('{file}')),
        'args.permissions': PERMISSION_MODES.every(mode => isStringArray(args.permissions?.[mode])),
        'args.model': isOptional(args.model, v => isStringArray(v) && v.includes('{model}')),
        'args.modelOnNewSession': isOptional(args.modelOnNewSession, v => typeof v === 'boolean'),
        'args.resume': isStringArray(args.resume) && args.resume.includes('{session}'),
        'args.tail': isOptional(args.tail, isStringArray),
        sessionNotFound: isRegex(agent.sessionNotFound),
        authError: isOptional(agent.authError, isRegex),
        minVersion: isOptional(agent.minVersion, v => SEMVER_PATTERN.test(v)),
        updateHint: isOptional(agent.updateHint, isString),
        experimental: isOptional(agent.experimental, v => typeof v === 'boolean'),
        titleModel: isOptional(agent.titleModel, isString)
    };
    return Object.keys(checks).find(key => !checks[key]) || null;
}

/**
 * Validate a complete configuration. Strict: one bad field rejects the file.
 * @param {Object} config - Parsed configuration
 * @param {string[]} requiredIds - Agents the code has adapters for
 * @returns {string|null} Error description, null if valid
 */
function validate(config, requiredIds) {
    if (!config || typeof config !== 'object') return 'not an object';
    if (config.schema !== SUPPORTED_SCHEMA) return `schema ${config.schema}`;
    if (!isString(config.version) || !VERSION_PATTERN.test(config.version)) return 'version';
    for (const id of requiredIds) {
        const bad = checkAgent(config.agents?.[id]);
        if (bad) return `${id}.${bad}`;
    }
    return null;
}

/**
 * Compare configuration versions (YYYY-MM-DD with optional -N for several per day)
 * @param {string} a - Version
 * @param {string} b - Version
 * @returns {boolean} True if a is newer than b
 */
function isNewer(a, b) {
    const parse = v => {
        const match = String(v || '').match(VERSION_PATTERN);
        return match ? { date: match[1], count: parseInt(match[2] || '0', 10) } : { date: '', count: 0 };
    };
    const pa = parse(a);
    const pb = parse(b);
    if (pa.date !== pb.date) return pa.date > pb.date;
    return pa.count > pb.count;
}

// ===== LOADING =====

/**
 * Read and validate a configuration file
 * @param {string} file - Path
 * @param {string[]} requiredIds - Agents the code has adapters for
 * @returns {Object|null} Configuration or null
 */
function readFile(file, requiredIds) {
    try {
        const config = JSON.parse(fs.readFileSync(file, 'utf8'));
        return validate(config, requiredIds) ? null : config;
    } catch {
        return null;
    }
}

/**
 * Load the newest valid configuration: the stored download or the shipped file.
 * After an extension update the shipped file may be newer than the download.
 * @param {string[]} requiredIds - Agents the code has adapters for
 * @returns {Object} {config, source: 'bundled'|'downloaded'}
 */
function load(requiredIds) {
    const bundled = readFile(BUNDLED_FILE, requiredIds);
    const downloaded = readFile(USER_FILE, requiredIds);
    if (downloaded && (!bundled || isNewer(downloaded.version, bundled.version))) {
        current = { config: downloaded, source: 'downloaded' };
    } else if (bundled) {
        current = { config: bundled, source: 'bundled' };
    } else {
        // Only possible with a damaged installation
        throw new Error(`Invalid agent configuration: ${BUNDLED_FILE}`);
    }
    return current;
}

/**
 * Get the configuration of one agent
 * @param {string} id - Agent ID
 * @returns {Object} Agent entry
 */
function getAgent(id) {
    if (!current) throw new Error('Agent configuration not loaded');
    return current.config.agents[id];
}

/**
 * Version and source of the active configuration (for the about page)
 * @returns {{version: string, source: string}|null} Info
 */
function getInfo() {
    return current ? { version: current.config.version, source: current.source } : null;
}

// ===== HELPERS FOR ADAPTERS =====

const regexCache = new Map();

/**
 * Compile a pattern from the configuration (cached)
 * @param {string} pattern - Pattern
 * @returns {RegExp|null} Regular expression
 */
function toRegex(pattern) {
    if (!pattern) return null;
    if (!regexCache.has(pattern)) regexCache.set(pattern, new RegExp(pattern, REGEX_FLAGS));
    return regexCache.get(pattern);
}

/**
 * Install locations with {home}, {appData} and {localAppData} filled in
 * @param {Object} agent - Agent entry
 * @param {boolean} windows - Windows paths
 * @returns {string[]} Paths
 */
function expandCandidates(agent, windows) {
    const home = os.homedir();
    const values = {
        home,
        appData: process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
        localAppData: process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    };
    return (windows ? agent.candidates.windows : agent.candidates.unix)
        .map(entry => path.normalize(entry.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match)));
}

/**
 * Build the command line from the templates of an agent.
 * Order: base, instructions, permissions, model, resume, tail.
 * @param {Object} agent - Agent entry
 * @param {Object} options - {sessionId, model, permissionMode, instructionsFile, runDir}
 * @returns {string[]} Arguments
 */
function buildArgs(agent, { sessionId, model, permissionMode, instructionsFile, runDir }) {
    const values = { session: sessionId, model, file: instructionsFile, runDir };
    const fill = template => template.map(part => part.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match));
    const { args } = agent;

    const result = fill(args.base);
    if (args.instructions && instructionsFile) result.push(...fill(args.instructions));
    result.push(...fill(args.permissions[permissionMode] || args.permissions[DEFAULT_PERMISSION]));
    if (args.model && model && !(args.modelOnNewSession && sessionId)) result.push(...fill(args.model));
    if (sessionId) result.push(...fill(args.resume));
    if (args.tail) result.push(...fill(args.tail));
    return result;
}

/**
 * Create an adapter: the code parts (output parser, title) come from the
 * adapter module, everything else is read from the active configuration
 * on every access, so an accepted update applies from the next run on.
 * @param {string} id - Agent ID (key in agentConfigs.json)
 * @param {Object} code - {pathSetting, modelSetting, needsRunDir, createParser, generateTitle}
 * @returns {Object} Adapter
 */
function defineAdapter(id, code) {
    return {
        id,
        ...code,
        get config() { return getAgent(id); },
        get name() { return this.config.name; },
        get experimental() { return Boolean(this.config.experimental); },
        get command() { return this.config.command; },
        get versionArgs() { return this.config.versionArgs; },
        get installUrl() { return this.config.installUrl; },
        get install() { return this.config.install; },
        get setupCommand() { return this.config.setupCommand; },
        get loginHint() { return this.config.loginHint; },
        get minVersion() { return this.config.minVersion || null; },
        get updateHint() { return this.config.updateHint || ''; },
        get titleModel() { return this.config.titleModel || null; },
        get supportsInstructionsFile() { return Boolean(this.config.args.instructions); },
        get sessionNotFound() { return toRegex(this.config.sessionNotFound); },
        get authError() { return toRegex(this.config.authError); },
        candidates() { return expandCandidates(this.config, IS_WINDOWS); },
        buildArgs(options) { return buildArgs(this.config, options); }
    };
}

// ===== REMOTE =====

/**
 * Look for a newer valid configuration on GitHub
 * @param {string[]} requiredIds - Agents the code has adapters for
 * @param {string} skipped - Version the user chose to skip
 * @returns {Promise<Object|null>} Newer configuration or null
 */
async function findUpdate(requiredIds, skipped) {
    const remote = await fetchJson(links.RAW_AGENT_CONFIG_PATH);
    if (!remote || validate(remote, requiredIds)) return null;
    if (remote.version === skipped || !current || !isNewer(remote.version, current.config.version)) return null;
    return remote;
}

/**
 * Store a configuration the user agreed to and use it from now on
 * @param {Object} config - Validated configuration
 */
function apply(config) {
    fs.mkdirSync(USER_DIR, { recursive: true });
    writeFileAtomic(USER_FILE, JSON.stringify(config, null, JSON_INDENT) + '\n');
    current = { config, source: 'downloaded' };
}

module.exports = {
    USER_DIR,
    load,
    getInfo,
    validate,
    isNewer,
    expandCandidates,
    buildArgs,
    defineAdapter,
    findUpdate,
    apply
};
