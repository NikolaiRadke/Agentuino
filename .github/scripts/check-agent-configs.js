#!/usr/bin/env node
/*
 * Agentuino - Check agentConfigs.json against the real CLIs
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Run before publishing a changed agentConfigs.json: every published change
 * reaches all installations. The script validates the file like the extension
 * does, then asks each installed agent for its help text and checks that every
 * option from the templates exists. Effort levels are compared with the help
 * text where it lists them, model list commands must answer. No login needed.
 *
 * Usage: node .github/scripts/check-agent-configs.js [config file] [--<agentId>=<path>] [--all]
 * --all: a missing agent is an error (CI, where all agents are installed)
 */

"use strict";

const path = require('path');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');

const EXTENSION_DIR = path.join(__dirname, '..', '..', 'agentuino', 'extension');
const agentConfig = require(path.join(EXTENSION_DIR, 'out', 'agents', 'agentConfig'));
const modelCatalog = require(path.join(EXTENSION_DIR, 'out', 'agents', 'modelCatalog'));
const { IS_WINDOWS } = require(path.join(EXTENSION_DIR, 'out', 'agents', 'agentUtils'));

const HELP_TIMEOUT_MS = 20000;
const MAX_HELP_BUFFER = 4 * 1024 * 1024;
const OPTION_PATTERN = /^--?[a-zA-Z]/;
const VERSION_NUMBER = /\d+\.\d+\.\d+/;
const ALL_FLAG = '--all';
// How far after the effort option the help text may list the levels
const EFFORT_HELP_CHARS = 200;
const MIN_HELP_LEVELS = 2;

/**
 * Parse the command line
 * @returns {{file: string, paths: Object, all: boolean}} Config file, agent paths, all required
 */
function parseArgs() {
    const paths = {};
    let all = false;
    let file = path.join(EXTENSION_DIR, 'config', 'agentConfigs.json');
    for (const arg of process.argv.slice(2)) {
        if (arg === ALL_FLAG) {
            all = true;
            continue;
        }
        const match = arg.match(/^--([\w-]+)=(.+)$/);
        if (match) paths[match[1]] = match[2];
        else file = path.resolve(arg);
    }
    return { file, paths, all };
}

/**
 * Find an executable in PATH
 * @param {string} command - Command name
 * @returns {string|null} Path
 */
function which(command) {
    try {
        const out = execFileSync(IS_WINDOWS ? 'where' : 'which', [command], { encoding: 'utf8' });
        return out.split(/\r?\n/).find(Boolean) || null;
    } catch {
        return null;
    }
}

/**
 * Run a CLI and return stdout and stderr (help often goes to stderr)
 * @param {string} toolPath - Executable
 * @param {string[]} args - Arguments
 * @returns {string} Output
 */
function run(toolPath, args) {
    // Some CLIs (e.g. agy) print their help to stderr and still exit with 0
    const out = spawnSync(toolPath, args, {
        encoding: 'utf8', timeout: HELP_TIMEOUT_MS, maxBuffer: MAX_HELP_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'], shell: IS_WINDOWS && /\.cmd$/i.test(toolPath)
    });
    return `${out.stdout || ''}${out.stderr || ''}`;
}

/**
 * Compare two version numbers (x.y.z)
 * @param {string} a - Version
 * @param {string} b - Version
 * @returns {boolean} True if a is older than b
 */
function isOlder(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < pa.length; i++) {
        if (pa[i] !== pb[i]) return pa[i] < pb[i];
    }
    return false;
}

/**
 * All options (words starting with '-') used in the templates of an agent
 * @param {Object} agent - Agent entry
 * @returns {string[]} Options
 */
function collectOptions(agent) {
    const { args } = agent;
    const parts = [
        ...args.base, ...(args.instructions || []), ...Object.values(args.permissions).flat(),
        ...(args.model || []), ...(args.effort || []), ...args.resume, ...(args.tail || [])
    ];
    return [...new Set(parts.filter(part => OPTION_PATTERN.test(part)))];
}

/**
 * Effort levels the help text lists after the effort option, like
 * "--effort <level>  Effort level ... (low, medium, high, xhigh, max)"
 * @param {Object} agent - Agent entry
 * @param {string} help - Help text
 * @returns {string[]|null} Levels, null if the help lists none
 */
function effortsInHelp(agent, help) {
    const option = (agent.args.effort || []).find(part => OPTION_PATTERN.test(part));
    if (!option) return null;
    const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = help.match(new RegExp(`${escaped}\\b[^(]{0,${EFFORT_HELP_CHARS}}\\(([\\w\\s,-]+)\\)`));
    const levels = match ? match[1].split(',').map(level => level.trim()).filter(Boolean) : [];
    // A single word in brackets is a remark like "(repeatable)", not a list
    return levels.length >= MIN_HELP_LEVELS ? levels : null;
}

/**
 * Compare the effort levels of the configuration with the help text
 * @param {Object} agent - Agent entry
 * @param {string} help - Help text
 * @returns {string[]} Problems
 */
function checkEfforts(agent, help) {
    const listed = effortsInHelp(agent, help);
    if (!listed) return [];
    const configured = agent.efforts || [];
    return [
        ...listed.filter(level => !configured.includes(level)).map(level => `effort level not in config: ${level}`),
        ...configured.filter(level => !listed.includes(level)).map(level => `effort level not in help: ${level}`)
    ];
}

/**
 * Run the model list command and count what the extension would read from it
 * @param {Object} agent - Agent entry
 * @param {string} toolPath - Executable
 * @returns {string[]} Problems
 */
function checkModels(agent, toolPath) {
    if (!agent.modelsCommand) return [];
    const count = modelCatalog.parse(agent.modelsCommand.format, run(toolPath, agent.modelsCommand.args)).length;
    console.log(`    ${count} models from '${agent.command} ${agent.modelsCommand.args.join(' ')}'`);
    return count > 0 ? [] : ['model list command gave no models'];
}

function main() {
    const { file, paths, all } = parseArgs();
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ids = Object.keys(config.agents || {});
    const error = agentConfig.validate(config, ids);
    if (error) {
        console.error(`✗ ${path.basename(file)} is invalid: ${error}`);
        process.exit(1);
    }
    console.log(`✓ ${path.basename(file)} valid (schema ${config.schema}, version ${config.version})`);

    let failed = false;
    for (const id of ids) {
        const agent = config.agents[id];
        const toolPath = paths[id] || which(agent.command);
        if (!toolPath) {
            if (all) {
                console.log(`✗ ${agent.name}: not installed`);
                failed = true;
            } else {
                console.log(`- ${agent.name}: not installed, skipped (use --${id}=<path>)`);
            }
            continue;
        }
        const version = run(toolPath, agent.versionArgs).trim().split(/\r?\n/)[0];
        // Help texts abbreviate variants: "--append-system-prompt[-file]" means both
        const help = (agent.helpArgs || [['--help']]).map(args => run(toolPath, args)).join('\n')
            .replace(/(--[\w-]+)\[(-[\w-]+)\]/g, '$1 $1$2');
        const missing = collectOptions(agent).filter(option =>
            !new RegExp(`(^|[\\s,\\[(])${option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s,=\\])]|$)`, 'm').test(help));

        // A fresh install older than minVersion means the entry is wrong
        const number = version.match(VERSION_NUMBER)?.[0];
        const tooOld = Boolean(agent.minVersion && number && isOlder(number, agent.minVersion));
        const problems = [...missing.map(option => `option not in help: ${option}`), ...checkEfforts(agent, help)];
        console.log(`${problems.length || tooOld ? '✗' : '✓'} ${agent.name} (${version || '?'}, ${toolPath})`);
        if (agent.minVersion) console.log(`    minimum version ${agent.minVersion}${tooOld ? ': installed version is older' : ''}`);
        problems.forEach(problem => console.log(`    ${problem}`));
        // Without login some agents may not list models: a warning, not a failure
        checkModels(agent, toolPath).forEach(problem => console.log(`    ⚠ ${problem}`));
        failed = failed || problems.length > 0 || tooOld;
    }
    process.exit(failed ? 1 : 0);
}

main();
