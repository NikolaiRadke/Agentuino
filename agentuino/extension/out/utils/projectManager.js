/*
 * Agentuino - Project Manager Module
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Manages the project structure inside an Arduino sketch folder:
 *   <Sketch>/agentuino/AGENTS.md   user instructions + auto-generated section
 *   <Sketch>/agentuino/            knowledge, attachments, chats, backups,
 *                                  memory.md, config.json
 *
 * Nothing is written to the sketch root: the Arduino IDE opens .md files
 * there as sketch tabs. Claude Code gets AGENTS.md via a command line flag.
 *
 * Pure Node.js (no vscode dependency) so it can be tested standalone.
 * Dialogs and UI belong in the calling layer.
 */

"use strict";

const fs = require('fs');
const path = require('path');
const i18n = require('./i18n');
const ruleBlocks = require('./ruleBlocks');
const { createError, writeFileAtomic } = require('../agents/agentUtils');

// ===== CONSTANTS =====

const PROJECT_DIR_NAME = 'agentuino';
// Agentuino's serial reader in the agent's PATH (bin/agentuino-serial), example call
const SERIAL_EXAMPLE = 'agentuino-serial --seconds 10 --baud 9600';
// Agentuino's debugger (bin/agentuino-debug), only with ArduDebug and an AVR board
const DEBUG_EXAMPLES = ['agentuino-debug --break {0}:12 --print counter,ledState --hits 3', 'agentuino-debug --pause --locals'];
const DEBUG_BOARD_PATTERN = /^(arduino|ardudebug):avr:/;

const SUBDIRS = {
    knowledge: 'knowledge',
    attachments: 'attachments',
    chats: 'chats',
    backups: 'backups'
};

const FILES = {
    agents: 'AGENTS.md',
    memory: 'memory.md',
    config: 'config.json',
    gitignore: '.gitignore'
};

const AUTO_START = '<!-- agentuino:auto:start -->';
const AUTO_END = '<!-- agentuino:auto:end -->';

const CONFIG_VERSION = 1;
const JSON_INDENT = 2;
const FIRST_DUPLICATE_SUFFIX = 1;
const MAX_SKETCH_SEARCH_DEPTH = 3;
const UNKNOWN_PORT_PLACEHOLDER = '<PORT>';
const MAX_LISTED_CHATS = 10;
const CHAT_DATA_EXT = '.json';
const CHAT_PROTOCOL_EXT = '.md';

const DEFAULT_CONFIG = {
    version: CONFIG_VERSION,
    language: null,
    beginnerMode: true,
    lastChatId: null,
    context: {
        boardName: null,
        fqbn: null,
        port: null,
        cliPath: null,
        configFile: null,
        ardudebug: false
    }
};

const GITIGNORE_CONTENT = [
    `${SUBDIRS.backups}/`,
    `${SUBDIRS.attachments}/`,
    ''
].join('\n');

// ===== FILE HELPERS =====

/**
 * Get a file name that does not exist yet in the given directory
 * @param {string} dir - Target directory
 * @param {string} fileName - Desired file name
 * @returns {string} Unique file name
 */
function getUniqueFileName(dir, fileName) {
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    let candidate = fileName;
    let counter = FIRST_DUPLICATE_SUFFIX;

    while (fs.existsSync(path.join(dir, candidate))) {
        candidate = `${base}_${counter}${ext}`;
        counter++;
    }
    return candidate;
}

/**
 * Format a timestamp as local YYYY-MM-DD
 * @param {number} time - Milliseconds since epoch
 * @returns {string} Date
 */
function formatLocalDate(time) {
    const d = new Date(time);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Command name of arduino-cli without folder and extension
 * @param {string} cliPath - Full path to arduino-cli
 * @returns {string} Command name, e.g. 'arduino-cli'
 */
function getCliCommandName(cliPath) {
    // Handles Windows paths on any platform
    const base = cliPath.split(/[\\/]/).pop();
    return base.replace(/\.exe$/i, '');
}

// ===== PATHS & VALIDATION =====

/**
 * Get all relevant paths of a project
 * @param {string} sketchPath - Absolute path of the sketch folder
 * @returns {Object} Paths object
 */
function getProjectPaths(sketchPath) {
    const projectDir = path.join(sketchPath, PROJECT_DIR_NAME);
    return {
        sketch: sketchPath,
        projectDir,
        agents: path.join(projectDir, FILES.agents),
        memory: path.join(projectDir, FILES.memory),
        config: path.join(projectDir, FILES.config),
        gitignore: path.join(projectDir, FILES.gitignore),
        knowledge: path.join(projectDir, SUBDIRS.knowledge),
        attachments: path.join(projectDir, SUBDIRS.attachments),
        chats: path.join(projectDir, SUBDIRS.chats),
        backups: path.join(projectDir, SUBDIRS.backups)
    };
}

/**
 * Check whether a folder is an Arduino sketch (folder name = .ino name)
 * @param {string} dir - Folder to check
 * @returns {boolean} True if it is a sketch folder
 */
function isSketchFolder(dir) {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
    return fs.existsSync(path.join(dir, path.basename(dir) + '.ino'));
}

/**
 * Find the sketch folder for a file or folder (walks up, e.g. from src/)
 * @param {string} startPath - File or folder inside a sketch
 * @returns {string|null} Sketch folder or null
 */
function findSketchFolder(startPath) {
    if (!startPath || !fs.existsSync(startPath)) return null;
    let dir = fs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath);

    for (let depth = 0; depth <= MAX_SKETCH_SEARCH_DEPTH; depth++) {
        if (isSketchFolder(dir)) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/**
 * Check that a folder is a valid Arduino sketch
 * @param {string} sketchPath - Absolute path of the sketch folder
 * @throws {Error} NOT_A_SKETCH if invalid
 */
function validateSketch(sketchPath) {
    if (!isSketchFolder(sketchPath)) {
        throw createError('NOT_A_SKETCH', `Not a sketch folder: ${sketchPath}`);
    }
}

/**
 * Check whether the sketch already has an Agentuino project structure
 * @param {string} sketchPath - Absolute path of the sketch folder
 * @returns {boolean} True if project exists
 */
function isProject(sketchPath) {
    return fs.existsSync(getProjectPaths(sketchPath).config);
}

// ===== CONFIG =====

/**
 * Read project config, merged with defaults
 * @param {string} sketchPath - Absolute path of the sketch folder
 * @returns {Object} Config object
 * @throws {Error} CONFIG_INVALID if the file cannot be parsed
 */
function readConfig(sketchPath) {
    const configPath = getProjectPaths(sketchPath).config;
    if (!fs.existsSync(configPath)) {
        return structuredClone(DEFAULT_CONFIG);
    }

    let stored;
    try {
        stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
        throw createError('CONFIG_INVALID', err.message);
    }

    return {
        ...structuredClone(DEFAULT_CONFIG),
        ...stored,
        context: { ...DEFAULT_CONFIG.context, ...(stored.context || {}) }
    };
}

/**
 * Write project config
 * @param {string} sketchPath - Absolute path of the sketch folder
 * @param {Object} config - Config object
 */
function writeConfig(sketchPath, config) {
    const content = JSON.stringify(config, null, JSON_INDENT) + '\n';
    writeFileAtomic(getProjectPaths(sketchPath).config, content);
}

/**
 * Get the ID of the chat that was open last
 * @param {string} sketchPath - Absolute path of the sketch folder
 * @returns {string|null} Chat ID
 */
function getLastChatId(sketchPath) {
    return isProject(sketchPath) ? readConfig(sketchPath).lastChatId : null;
}

/**
 * Remember the chat that is open
 * @param {string} sketchPath - Absolute path of the sketch folder
 * @param {string|null} chatId - Chat ID or null
 */
function setLastChatId(sketchPath, chatId) {
    const config = readConfig(sketchPath);
    if (config.lastChatId === chatId) return;
    config.lastChatId = chatId;
    writeConfig(sketchPath, config);
}

// ===== CHATS =====

/**
 * List chat summaries of a project, newest first
 * @param {string} sketchPath - Absolute path of the sketch folder
 * @returns {Array<{id, title, created, updated, agent}>} Summaries
 */
function listChatSummaries(sketchPath) {
    const dir = getProjectPaths(sketchPath).chats;
    if (!fs.existsSync(dir)) return [];

    const summaries = [];
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(CHAT_DATA_EXT)) continue;
        try {
            const chat = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
            summaries.push({
                id: chat.id,
                title: chat.title,
                created: chat.created,
                updated: chat.updated,
                agent: chat.agent
            });
        } catch {
            // Skip damaged chat files instead of hiding all chats
        }
    }
    return summaries.sort((a, b) => b.updated - a.updated);
}

// ===== KNOWLEDGE & ATTACHMENTS =====

/**
 * List knowledge files (file names only, sorted)
 * @param {string} sketchPath - Absolute path of the sketch folder
 * @returns {string[]} File names
 */
function listKnowledgeFiles(sketchPath) {
    const dir = getProjectPaths(sketchPath).knowledge;
    if (!fs.existsSync(dir)) return [];

    return fs.readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b));
}

/**
 * Copy a file into a project subfolder under a unique name
 * @param {string} targetDir - Destination directory
 * @param {string} sourcePath - Source file
 * @returns {string} Destination file name
 * @throws {Error} FILE_NOT_FOUND if the source does not exist
 */
function copyIntoProject(targetDir, sourcePath) {
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
        throw createError('FILE_NOT_FOUND', sourcePath);
    }
    fs.mkdirSync(targetDir, { recursive: true });
    const fileName = getUniqueFileName(targetDir, path.basename(sourcePath));
    fs.copyFileSync(sourcePath, path.join(targetDir, fileName));
    return fileName;
}

/**
 * Add a permanent knowledge file and refresh AGENTS.md
 * @param {string} sketchPath - Absolute path of the sketch folder
 * @param {string} sourcePath - File to add
 * @returns {string} Path relative to the sketch folder (forward slashes)
 */
function addKnowledgeFile(sketchPath, sourcePath) {
    const fileName = copyIntoProject(getProjectPaths(sketchPath).knowledge, sourcePath);
    refreshAutoSection(sketchPath);
    return `${PROJECT_DIR_NAME}/${SUBDIRS.knowledge}/${fileName}`;
}

/**
 * Add a one-off attachment for the next message
 * @param {string} sketchPath - Absolute path of the sketch folder
 * @param {string} sourcePath - File to attach
 * @returns {string} Path relative to the sketch folder (forward slashes)
 */
function addAttachment(sketchPath, sourcePath) {
    const fileName = copyIntoProject(getProjectPaths(sketchPath).attachments, sourcePath);
    return `${PROJECT_DIR_NAME}/${SUBDIRS.attachments}/${fileName}`;
}

// ===== AGENTS.md AUTO SECTION =====

/**
 * Build the auto-generated section of AGENTS.md
 * @param {string} sketchPath - Absolute path of the sketch folder
 * @param {Object} config - Project config (uses context, language, beginnerMode)
 * @returns {string} Section including markers
 */
function buildAutoSection(sketchPath, config) {
    const t = i18n.createTranslator(config.language || i18n.FALLBACK_LOCALE);
    const { boardName, fqbn, port, cliPath, configFile } = config.context;
    const sketchFile = path.basename(sketchPath) + '.ino';
    const memoryRel = `${PROJECT_DIR_NAME}/${FILES.memory}`;
    const knowledgeRel = `${PROJECT_DIR_NAME}/${SUBDIRS.knowledge}`;

    const lines = [
        AUTO_START,
        t('project.auto.notice'),
        '',
        t('project.auto.rulesTitle'),
        '',
        t('project.auto.ruleSketch', sketchFile),
        t('project.auto.ruleScope'),
        t('project.auto.ruleSrc'),
        t('project.auto.ruleProjectDir', PROJECT_DIR_NAME, memoryRel),
        t('project.auto.ruleMemory', memoryRel),
        t('project.auto.ruleNoUpload'),
        t('project.auto.ruleLibraries')
    ];

    if (config.beginnerMode) {
        lines.push(t('project.auto.ruleBeginner'));
    }

    // Semantic anchors chosen for this sketch (page "Semantic anchors")
    const codeRules = ruleBlocks.getActiveTexts(config, t);
    if (codeRules.length > 0) {
        lines.push('', t('project.auto.codeRulesTitle'), '', ...codeRules.map(text => `- ${text}`));
    }

    lines.push('', t('project.auto.hardwareTitle'), '');
    lines.push(fqbn
        ? t('project.auto.board', boardName || fqbn, fqbn)
        : t('project.auto.boardUnknown'));
    lines.push(t('project.auto.port', port || t('project.auto.portUnknown')));

    if (cliPath && fqbn) {
        // The agent gets the arduino-cli folder in its PATH, so the plain command name
        // works the same in Bash, PowerShell and CMD (a quoted path does not in PowerShell)
        const command = getCliCommandName(cliPath);
        const cli = configFile ? `${command} --config-file "${configFile}"` : command;
        lines.push(
            '',
            t('project.auto.buildTitle'),
            '',
            t('project.auto.compile'),
            '',
            '```',
            `${cli} compile --fqbn ${fqbn} .`,
            '```',
            '',
            t('project.auto.upload'),
            '',
            '```',
            `${cli} upload --fqbn ${fqbn} --port ${port || UNKNOWN_PORT_PLACEHOLDER} .`,
            '```'
        );
        if (!port) {
            lines.push('', t('project.auto.portHint', `${cli} board list`));
        }
        lines.push('', t('project.auto.libList', `${cli} lib list`));
        lines.push(
            '',
            t('project.auto.serialTitle'),
            '',
            t('project.auto.serialIntro'),
            '',
            '```',
            SERIAL_EXAMPLE,
            '```',
            '',
            ...t.strings.project.auto.serialRules
        );
        if (config.context.ardudebug && DEBUG_BOARD_PATTERN.test(fqbn)) {
            lines.push(
                '',
                t('project.auto.debugTitle'),
                '',
                t('project.auto.debugIntro'),
                '',
                '```',
                ...DEBUG_EXAMPLES.map(example => example.replace('{0}', sketchFile)),
                '```',
                '',
                ...t.strings.project.auto.debugRules
            );
        }
    }

    const chats = listChatSummaries(sketchPath).slice(0, MAX_LISTED_CHATS);
    const chatsRel = `${PROJECT_DIR_NAME}/${SUBDIRS.chats}`;
    lines.push('', t('project.auto.chatsTitle'), '', t('project.auto.chatsIntro', `${chatsRel}/*${CHAT_PROTOCOL_EXT}`));
    if (chats.length > 0) {
        lines.push('', t('project.auto.chatsRecent'), '');
        chats.forEach(chat => {
            const date = formatLocalDate(chat.created);
            lines.push(`- ${date} – ${chat.title || '?'} (\`${chatsRel}/${chat.id}${CHAT_PROTOCOL_EXT}\`)`);
        });
    }

    const knowledgeFiles = listKnowledgeFiles(sketchPath);
    lines.push('', t('project.auto.knowledgeTitle'), '');
    if (knowledgeFiles.length > 0) {
        lines.push(t('project.auto.knowledgeIntro'), '');
        knowledgeFiles.forEach(name => lines.push(`- \`${knowledgeRel}/${name}\``));
    } else {
        lines.push(t('project.auto.knowledgeNone'));
    }

    lines.push('', AUTO_END);
    return lines.join('\n');
}

/**
 * Replace the auto section in AGENTS.md content, or append it if missing
 * @param {string} content - Current AGENTS.md content
 * @param {string} section - New auto section
 * @returns {string} Updated content
 */
function replaceAutoSection(content, section) {
    const start = content.indexOf(AUTO_START);
    const end = content.indexOf(AUTO_END);

    if (start !== -1 && end > start) {
        return content.slice(0, start) + section + content.slice(end + AUTO_END.length);
    }
    return content.trimEnd() + '\n\n' + section + '\n';
}

/**
 * Update stored context and regenerate the auto section of AGENTS.md
 * @param {string} sketchPath - Absolute path of the sketch folder
 * @param {Object} context - Partial context {boardName, fqbn, port, cliPath}
 * @returns {boolean} True if AGENTS.md was changed
 */
function updateAutoSection(sketchPath, context = {}) {
    const paths = getProjectPaths(sketchPath);
    const config = readConfig(sketchPath);
    const newContext = { ...config.context, ...context };

    if (JSON.stringify(newContext) !== JSON.stringify(config.context)) {
        config.context = newContext;
        writeConfig(sketchPath, config);
    }

    const t = i18n.createTranslator(config.language || i18n.FALLBACK_LOCALE);
    const template = t('project.agentsTemplate').join('\n');
    const current = fs.existsSync(paths.agents) ? fs.readFileSync(paths.agents, 'utf8') : template;
    const updated = replaceAutoSection(current, buildAutoSection(sketchPath, config));

    if (updated === current && fs.existsSync(paths.agents)) return false;
    writeFileAtomic(paths.agents, updated);
    return true;
}

/**
 * Regenerate the auto section with the stored context
 * @param {string} sketchPath - Absolute path of the sketch folder
 * @returns {boolean} True if AGENTS.md was changed
 */
function refreshAutoSection(sketchPath) {
    return updateAutoSection(sketchPath, {});
}

// ===== PROJECT SETUP =====

/**
 * Create the project structure if missing. Existing files are preserved.
 * @param {string} sketchPath - Absolute path of the sketch folder
 * @param {Object} options - {language, context}
 * @returns {{created: boolean, paths: Object}} Whether a new project was created
 * @throws {Error} NOT_A_SKETCH, CONFIG_INVALID
 */
function ensureProject(sketchPath, options = {}) {
    validateSketch(sketchPath);
    const paths = getProjectPaths(sketchPath);
    const created = !isProject(sketchPath);

    Object.values(SUBDIRS).forEach(dir => {
        fs.mkdirSync(path.join(paths.projectDir, dir), { recursive: true });
    });

    if (!fs.existsSync(paths.config)) {
        const config = structuredClone(DEFAULT_CONFIG);
        config.language = options.language || i18n.FALLBACK_LOCALE;
        // A new sketch starts with the current default anchors
        config.rules = ruleBlocks.getDefaults();
        writeConfig(sketchPath, config);
    }

    const t = i18n.createTranslator(readConfig(sketchPath).language || i18n.FALLBACK_LOCALE);
    if (!fs.existsSync(paths.memory)) writeFileAtomic(paths.memory, t('project.memoryTemplate').join('\n'));
    if (!fs.existsSync(paths.gitignore)) writeFileAtomic(paths.gitignore, GITIGNORE_CONTENT);

    updateAutoSection(sketchPath, options.context || {});

    return { created, paths };
}

// ===== EXPORTS =====

module.exports = {
    AGENTS_FILE_REL: `${PROJECT_DIR_NAME}/${FILES.agents}`,
    getProjectPaths,
    isSketchFolder,
    findSketchFolder,
    isProject,
    ensureProject,
    readConfig,
    writeConfig,
    getLastChatId,
    setLastChatId,
    CHAT_DATA_EXT,
    CHAT_PROTOCOL_EXT,
    listChatSummaries,
    updateAutoSection,
    refreshAutoSection,
    addKnowledgeFile,
    addAttachment
};
