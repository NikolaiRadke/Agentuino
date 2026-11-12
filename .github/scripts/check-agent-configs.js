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
 * option from the templates exists. No login needed.
 *
 * Usage: node .github/scripts/check-agent-configs.js [config file] [--<agentId>=<path>]
 */

"use strict";

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const EXTENSION_DIR = path.join(__dirname, '..', '..', 'agentuino', 'extension');
const agentConfig = require(path.join(EXTENSION_DIR, 'out', 'agents', 'agentConfig'));
const { IS_WINDOWS } = require(path.join(EXTENSION_DIR, 'out', 'agents', 'agentUtils'));

const HELP_TIMEOUT_MS = 20000;
const MAX_HELP_BUFFER = 4 * 1024 * 1024;
const OPTION_PATTERN = /^--?[a-zA-Z]/;

/**
 * Parse the command line
 * @returns {{file: string, paths: Object}} Config file and agent paths
 */
function parseArgs() {
    const paths = {};
    let file = path.join(EXTENSION_DIR, 'config', 'agentConfigs.json');
    for (const arg of process.argv.slice(2)) {
        const match = arg.match(/^--([\w-]+)=(.+)$/);
        if (match) paths[match[1]] = match[2];
        else file = path.resolve(arg);
    }
    return { file, paths };
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
    try {
        return execFileSync(toolPath, args, {
            encoding: 'utf8', timeout: HELP_TIMEOUT_MS, maxBuffer: MAX_HELP_BUFFER,
            stdio: ['ignore', 'pipe', 'pipe'], shell: IS_WINDOWS && /\.cmd$/i.test(toolPath)
        });
    } catch (err) {
        return `${err.stdout || ''}${err.stderr || ''}`;
    }
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
        ...(args.model || []), ...args.resume, ...(args.tail || [])
    ];
    return [...new Set(parts.filter(part => OPTION_PATTERN.test(part)))];
}

function main() {
    const { file, paths } = parseArgs();
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
            console.log(`- ${agent.name}: not installed, skipped (use --${id}=<path>)`);
            continue;
        }
        const version = run(toolPath, agent.versionArgs).trim().split(/\r?\n/)[0];
        // Help texts abbreviate variants: "--append-system-prompt[-file]" means both
        const help = (agent.helpArgs || [['--help']]).map(args => run(toolPath, args)).join('\n')
            .replace(/(--[\w-]+)\[(-[\w-]+)\]/g, '$1 $1$2');
        const missing = collectOptions(agent).filter(option =>
            !new RegExp(`(^|[\\s,\\[(])${option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s,=\\])]|$)`, 'm').test(help));

        console.log(`${missing.length ? '✗' : '✓'} ${agent.name} (${version || '?'}, ${toolPath})`);
        if (agent.minVersion) console.log(`    minimum version ${agent.minVersion}`);
        missing.forEach(option => console.log(`    option not in help: ${option}`));
        failed = failed || missing.length > 0;
    }
    process.exit(failed ? 1 : 0);
}

main();
