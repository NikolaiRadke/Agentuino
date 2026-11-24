/*
 * Agentuino - Tool Detector Module
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Finds the Claude Code executable and the arduino-cli bundled with the
 * Arduino IDE. The IDE is often started from the desktop, so PATH may miss
 * user folders like ~/.local/bin. Common install locations are checked too.
 */

"use strict";

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { IS_WINDOWS, buildEnv, prepareSpawn, compareVersions } = require('./agentUtils');

// ===== CONSTANTS =====

const LOOKUP_TIMEOUT_MS = 3000;
const VERSION_TIMEOUT_MS = 5000;
const PORT_LIST_TIMEOUT_MS = 8000;
const PORT_CACHE_MS = 30000;
// Installed board packages change rarely
const CORE_CACHE_MS = 5 * 60 * 1000;
const ARDUDEBUG_CORE = 'ardudebug:avr';

// ===== HELPERS =====

/**
 * Check whether a path points to an existing file
 * @param {string} p - Path to check
 * @returns {boolean} True if file exists
 */
function isFile(p) {
    try {
        return !!p && fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

/**
 * Look up a command in PATH via which/where
 * @param {string} command - Command name
 * @returns {Promise<string[]>} Matching paths (may be empty)
 */
function lookupInPath(command) {
    const finder = IS_WINDOWS ? 'where' : 'which';
    return new Promise(resolve => {
        execFile(finder, [command], { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
            if (error || !stdout) return resolve([]);
            resolve(stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
        });
    });
}

/**
 * Prefer native executables over .cmd wrappers on Windows
 * @param {string[]} paths - Candidate paths
 * @returns {string[]} Sorted paths
 */
function preferNative(paths) {
    if (!IS_WINDOWS) return paths;
    const rank = p => (p.toLowerCase().endsWith('.exe') ? 0 : 1);
    return [...paths].sort((a, b) => rank(a) - rank(b));
}

// ===== NODE VERSION MANAGERS =====

/**
 * List version subfolders of a node manager, newest first
 * @param {string} dir - Folder with one subfolder per Node version
 * @returns {string[]} Version folder paths
 */
function listVersionDirs(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && /^v?\d+\./.test(entry.name))
            .map(entry => entry.name)
            .sort((a, b) => compareVersions(b, a))
            .map(name => path.join(dir, name));
    } catch {
        return [];
    }
}

/**
 * Folders where npm-installed agents end up with nvm, Volta or a plain Node install.
 * These are often missing from the PATH an IDE gets when started from the desktop.
 * @returns {string[]} Folders
 */
function getNodeManagerDirs() {
    const home = os.homedir();
    if (IS_WINDOWS) {
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        return [
            process.env.NVM_SYMLINK,
            ...listVersionDirs(process.env.NVM_HOME || path.join(appData, 'nvm')),
            path.join(home, 'AppData', 'Local', 'Volta', 'bin'),
            path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs')
        ].filter(Boolean);
    }
    const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm');
    return [
        ...listVersionDirs(path.join(nvmDir, 'versions', 'node')).map(dir => path.join(dir, 'bin')),
        path.join(home, '.volta', 'bin')
    ];
}

/**
 * Possible file names of a command
 * @param {string} command - Command name
 * @returns {string[]} File names
 */
function executableNames(command) {
    return IS_WINDOWS ? [`${command}.exe`, `${command}.cmd`] : [command];
}

// ===== AGENTS =====

/**
 * Find the executable of an agent: setting, PATH, then common install locations
 * @param {Object} adapter - Agent adapter (command, candidates)
 * @param {string} configuredPath - Path from settings (may be empty)
 * @returns {Promise<string|null>} Path or null
 */
async function findAgent(adapter, configuredPath) {
    if (configuredPath) {
        return isFile(configuredPath) ? configuredPath : null;
    }
    const fromPath = preferNative(await lookupInPath(adapter.command)).find(isFile);
    if (fromPath) return fromPath;
    const fromManagers = getNodeManagerDirs()
        .flatMap(dir => executableNames(adapter.command).map(name => path.join(dir, name)));
    return [...adapter.candidates(), ...fromManagers].find(isFile) || null;
}

// ===== ARDUINO CLI =====

/**
 * Find arduino-cli: setting, then the copy bundled with the Arduino IDE, then PATH
 * @param {string} configuredPath - Path from settings (may be empty)
 * @param {string} appRoot - IDE application root (vscode.env.appRoot)
 * @returns {Promise<string|null>} Path or null
 */
async function findArduinoCli(configuredPath, appRoot) {
    if (configuredPath) {
        return isFile(configuredPath) ? configuredPath : null;
    }

    const exe = IS_WINDOWS ? 'arduino-cli.exe' : 'arduino-cli';
    const bundledRel = path.join('lib', 'backend', 'resources', exe);
    const execDir = path.dirname(process.execPath);
    const candidates = [
        appRoot && path.join(appRoot, bundledRel),
        path.join(execDir, 'resources', 'app', bundledRel),
        path.join(execDir, '..', 'Resources', 'app', bundledRel)
    ].filter(Boolean);

    const bundled = candidates.find(isFile);
    if (bundled) return path.normalize(bundled);

    return (await lookupInPath('arduino-cli')).find(isFile) || null;
}

/**
 * Get the arduino-cli config of the Arduino IDE (sketchbook, libraries, cores)
 * @returns {string|null} Path or null
 */
function findArduinoCliConfig() {
    const configFile = path.join(os.homedir(), '.arduinoIDE', 'arduino-cli.yaml');
    return isFile(configFile) ? configFile : null;
}

// ===== SERIAL PORT =====

let portCache = { time: 0, key: '', port: null };

/**
 * Detect the serial port of the connected board via 'arduino-cli board list'.
 * Returns a port only if exactly one USB serial port is present.
 * @param {string} cliPath - arduino-cli executable
 * @param {string|null} configFile - arduino-cli config file
 * @returns {Promise<string|null>} Port address or null
 */
function detectSerialPort(cliPath, configFile) {
    const key = `${cliPath}|${configFile}`;
    if (key === portCache.key && Date.now() - portCache.time < PORT_CACHE_MS) {
        return Promise.resolve(portCache.port);
    }

    const args = ['board', 'list', '--format', 'json'];
    if (configFile) args.push('--config-file', configFile);

    return new Promise(resolve => {
        execFile(cliPath, args, { timeout: PORT_LIST_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
            let port = null;
            if (!error && stdout) {
                try {
                    const data = JSON.parse(stdout);
                    // arduino-cli 1.x: {detected_ports: [...]}, older versions: [...]
                    const entries = Array.isArray(data) ? data : (data.detected_ports || []);
                    const usbPorts = entries
                        .map(entry => entry.port || entry)
                        .filter(p => p?.protocol === 'serial' && (p.properties?.vid || p.hardware_id));
                    if (usbPorts.length === 1) port = usbPorts[0].address;
                } catch {
                    // Unexpected output, leave the port to the agent
                }
            }
            portCache = { time: Date.now(), key, port };
            resolve(port);
        });
    });
}

let coreCache = { time: 0, key: null, installed: false };

/**
 * Check whether the ArduDebug board package is installed ('arduino-cli core list')
 * @param {string} cliPath - arduino-cli executable
 * @param {string|null} configFile - arduino-cli config file
 * @param {boolean} [force=false] - Ignore the cache
 * @returns {Promise<boolean>} Installed
 */
function hasArdudebug(cliPath, configFile, force = false) {
    const key = `${cliPath}|${configFile}`;
    if (!force && key === coreCache.key && Date.now() - coreCache.time < CORE_CACHE_MS) {
        return Promise.resolve(coreCache.installed);
    }
    const args = ['core', 'list', '--format', 'json'];
    if (configFile) args.push('--config-file', configFile);

    return new Promise(resolve => {
        execFile(cliPath, args, { timeout: PORT_LIST_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
            const installed = !error && String(stdout).includes(`"${ARDUDEBUG_CORE}"`);
            coreCache = { time: Date.now(), key, installed };
            resolve(installed);
        });
    });
}

// ===== VERSIONS =====

/**
 * Get the first output line of '<tool> <args>' (e.g. a version string)
 * @param {string} toolPath - Executable
 * @param {string[]} args - Arguments
 * @returns {Promise<string|null>} Version number or null
 */
function getToolVersion(toolPath, args) {
    if (!toolPath) return Promise.resolve(null);
    const spawnArgs = prepareSpawn(toolPath, args);
    return new Promise(resolve => {
        const options = { timeout: VERSION_TIMEOUT_MS, windowsHide: true, shell: spawnArgs.shell, env: buildEnv(toolPath) };
        execFile(spawnArgs.command, spawnArgs.args, options, (error, stdout) => {
            const line = (stdout || '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
            // Keep only the version number, e.g. "2.1.322" or "1.5.1"
            const version = line?.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0];
            resolve(error || !version ? null : version);
        });
    });
}

// ===== AGENT VERSION CHECK =====

const versionCache = new Map();

/**
 * Check whether a version is at least the required one
 * @param {string} version - Version like '3.1.2'
 * @param {string} minimum - Required version like '3.0.0'
 * @returns {boolean} True if new enough (or unknown, to not block by mistake)
 */
function isVersionAtLeast(version, minimum) {
    const match = String(version || '').match(/\d+(\.\d+)*/);
    if (!match) return true;
    return compareVersions(match[0], minimum) >= 0;
}

/**
 * Check an agent's version against the adapter's minimum (cached per file)
 * @param {Object} adapter - Agent adapter (minVersion optional)
 * @param {string} toolPath - Executable
 * @returns {Promise<{version: string|null, tooOld: boolean}>} Result
 */
async function checkAgentVersion(adapter, toolPath) {
    if (!adapter.minVersion) return { version: null, tooOld: false };
    let mtime = 0;
    try {
        mtime = fs.statSync(toolPath).mtimeMs;
    } catch {
        // Missing file is reported elsewhere
    }
    const key = `${toolPath}|${mtime}`;
    if (!versionCache.has(key)) {
        versionCache.set(key, await getToolVersion(toolPath, adapter.versionArgs));
    }
    // The minimum version can change with an accepted configuration update
    const version = versionCache.get(key);
    return { version, tooOld: !isVersionAtLeast(version, adapter.minVersion) };
}

module.exports = {
    getToolVersion,
    isVersionAtLeast,
    checkAgentVersion,
    findAgent,
    findArduinoCli,
    findArduinoCliConfig,
    detectSerialPort,
    hasArdudebug
};
