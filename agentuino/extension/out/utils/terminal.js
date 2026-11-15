/*
 * Agentuino - System Terminal
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * The Arduino IDE has no terminal of its own, and logging in to an agent
 * (claude → /login, codex login, ...) needs an interactive one with a browser.
 * So the login runs in the terminal of the system, which stays open afterwards.
 */

"use strict";

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { IS_WINDOWS } = require('../agents/agentUtils');

// ===== CONSTANTS =====

// Linux terminals in order of preference, each with the option after which the
// rest of the line is the command. x-terminal-emulator comes last: what its -e
// takes depends on the terminal it points to.
const LINUX_TERMINALS = [
    { name: 'gnome-terminal', run: ['--'] },
    { name: 'konsole', run: ['-e'] },
    { name: 'xfce4-terminal', run: ['-x'] },
    { name: 'mate-terminal', run: ['-x'] },
    { name: 'kitty', run: [] },
    { name: 'alacritty', run: ['-e'] },
    { name: 'xterm', run: ['-e'] },
    { name: 'x-terminal-emulator', run: ['-e'] }
];
const OSASCRIPT = '/usr/bin/osascript';

// ===== HELPERS =====

/**
 * Quote an argument for a POSIX shell
 * @param {string} arg - Argument
 * @returns {string} Quoted argument
 */
function quotePosix(arg) {
    return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

/**
 * Find an executable in PATH
 * @param {string} name - Executable name
 * @returns {string|null} Full path
 */
function findInPath(name) {
    for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
        const file = path.join(dir, name);
        try {
            fs.accessSync(file, fs.constants.X_OK);
            return file;
        } catch { /* not here */ }
    }
    return null;
}

/**
 * Start a detached process, report whether it could be started
 * @param {string} command - Executable
 * @param {string[]} args - Arguments
 * @param {Object} options - spawn() options
 * @returns {Promise<boolean>} Started
 */
function launch(command, args, options) {
    return new Promise(resolve => {
        try {
            const child = spawn(command, args, { ...options, detached: true, stdio: 'ignore' });
            child.once('error', () => resolve(false));
            child.once('spawn', () => {
                child.unref();
                resolve(true);
            });
        } catch {
            resolve(false);
        }
    });
}

// ===== PUBLIC =====

/**
 * Open the system terminal in a folder and run a command in it
 * @param {string} toolPath - Executable of the agent (full path or name)
 * @param {string[]} args - Arguments, e.g. ['login']
 * @param {string} cwd - Folder for the terminal
 * @returns {Promise<boolean>} A terminal was opened
 */
async function openInTerminal(toolPath, args, cwd) {
    if (IS_WINDOWS) {
        // The outer quotes keep cmd /k from stripping the quotes of the path
        const line = [toolPath, ...args].map(a => (/[\s&()^|<>"]/.test(a) ? `"${a}"` : a)).join(' ');
        return launch('cmd.exe', ['/d', '/c', `start "" cmd /k "${line}"`], { cwd, windowsVerbatimArguments: true });
    }

    const line = [toolPath, ...args].map(quotePosix).join(' ');
    if (process.platform === 'darwin') {
        const script = `cd ${quotePosix(cwd)} && ${line}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return launch(OSASCRIPT, [
            '-e', `tell application "Terminal" to do script "${script}"`,
            '-e', 'tell application "Terminal" to activate'
        ], { cwd });
    }

    // Keep the terminal open after the agent ends, so messages stay readable
    const shell = process.env.SHELL || '/bin/sh';
    const script = `${line}; exec ${quotePosix(shell)}`;
    for (const terminal of LINUX_TERMINALS) {
        const found = findInPath(terminal.name);
        if (found && await launch(found, [...terminal.run, shell, '-c', script], { cwd })) return true;
    }
    return false;
}

module.exports = { openInTerminal };
