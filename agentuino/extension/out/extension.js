/*
 * Agentuino
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Agentic coding for Arduino beginners: a chat that drives CLI agents
 * (Claude Code, Codex CLI, Mistral Vibe, Antigravity CLI, OpenCode)
 * inside the sketch folder of the Arduino IDE 2.x.
 */

"use strict";

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const i18n = require('./utils/i18n');
const projectManager = require('./utils/projectManager');
const toolDetector = require('./agents/toolDetector');
const registry = require('./agents/registry');
const links = require('./utils/links');
const updateChecker = require('./utils/updateChecker');
const libraryUsage = require('./utils/libraryUsage');
const uninstaller = require('./utils/uninstaller');
const { BoardDetector } = require('./utils/boardDetector');
const { ChatPanel } = require('./chat/chatPanel');
const changesView = require('./chat/changesView');
const { AboutPanel } = require('./ui/aboutPanel');
const { RulesPanel } = require('./ui/rulesPanel');

// ===== CONSTANTS =====

const CONFIG_SECTION = 'agentuino';
const STATUS_BAR_PRIORITY = 100;
const UPDATE_CHECK_DELAY_MS = 5000;
const EXECUTABLE_MODE = 0o755;
// Agentuino's commands for the agent in bin/
const AGENT_TOOLS = ['agentuino-serial', 'agentuino-debug'];

// ===== STATE =====

let t = i18n.createTranslator(i18n.FALLBACK_LOCALE);
let currentLocale = i18n.FALLBACK_LOCALE;
let lastSketchPath = null;
let statusBarItem = null;
let boardDetector = null;
let extensionPath = null;
let updateTimer = null;

// ===== SETTINGS & LOCALE =====

/**
 * Read all Agentuino settings
 * @returns {Object} Settings
 */
function getSettings() {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const paths = {};
    const models = {};
    for (const adapter of registry.getAll()) {
        paths[adapter.id] = config.get(adapter.pathSetting, '');
        models[adapter.id] = config.get(adapter.modelSetting, '');
    }
    return {
        language: config.get('language', i18n.AUTO),
        agent: config.get('agent', registry.AUTO),
        paths,
        models,
        permissionMode: config.get('permissionMode', 'bypassPermissions'),
        compileCheck: config.get('compileCheck', true),
        gitignoreAll: config.get('gitignoreAll', true),
        checkForUpdates: config.get('checkForUpdates', true),
        arduinoCliPath: config.get('arduinoCliPath', '')
    };
}

/**
 * Store a setting for all windows
 * @param {string} key - Setting without the 'agentuino.' prefix
 * @param {*} value - New value ('' or undefined resets it)
 * @returns {Thenable<void>} Done
 */
function updateSetting(key, value) {
    // Global target is the reliable persistence mechanism in the Arduino IDE
    return vscode.workspace.getConfiguration(CONFIG_SECTION).update(key, value, vscode.ConfigurationTarget.Global);
}

/**
 * Load the UI language from settings
 */
function loadLocale() {
    currentLocale = i18n.resolveLocale(getSettings().language, vscode.env.language);
    t = i18n.createTranslator(currentLocale);
}

// ===== SKETCH DETECTION =====

/**
 * Find the current sketch: active editor, workspace folder, last known
 * @returns {string|null} Sketch folder
 */
function findSketch() {
    const editor = vscode.window.activeTextEditor;
    const candidates = [
        editor?.document?.uri?.scheme === 'file' ? editor.document.uri.fsPath : null,
        ...(vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath)
    ];

    for (const candidate of candidates) {
        const sketch = projectManager.findSketchFolder(candidate);
        if (sketch) {
            lastSketchPath = sketch;
            return sketch;
        }
    }
    return lastSketchPath && projectManager.isSketchFolder(lastSketchPath) ? lastSketchPath : null;
}

const ARDUDEBUG_EXTENSION = 'NikolaiRadke.ardudebug';
let ardudebugSetupTried = false;

/**
 * Let the ArduDebug extension install its board package (VS Code only, once per session)
 * @returns {Promise<boolean>} True if the setup ran without error
 */
async function setupArdudebug() {
    if (ardudebugSetupTried || !vscode.extensions.getExtension(ARDUDEBUG_EXTENSION)) return false;
    ardudebugSetupTried = true;
    try {
        await vscode.commands.executeCommand('ardudebug.setup');
        return true;
    } catch {
        return false;
    }
}

/**
 * Collect tool paths, board and port for AGENTS.md
 * @param {string} sketchPath - Sketch folder
 * @returns {Promise<Object>} Context {cliPath, configFile, port, fqbn?, boardName?}
 */
async function collectContext(sketchPath) {
    const settings = getSettings();
    const cliPath = await toolDetector.findArduinoCli(settings.arduinoCliPath, vscode.env.appRoot);
    const configFile = cliPath ? toolDetector.findArduinoCliConfig() : null;
    const board = boardDetector.getBoardInfo(sketchPath);
    const port = board.port || (cliPath ? await toolDetector.detectSerialPort(cliPath, configFile) : null);

    let ardudebug = cliPath ? await toolDetector.hasArdudebug(cliPath, configFile) : false;
    if (!ardudebug && cliPath && await setupArdudebug()) {
        ardudebug = await toolDetector.hasArdudebug(cliPath, configFile, true);
    }

    // Installed libraries the sketch includes, AGENTS.md points to their docs
    const libraries = cliPath
        ? libraryUsage.findUsedLibraries(sketchPath, await toolDetector.listLibraries(cliPath, configFile))
        : [];

    const context = { cliPath, configFile, port, ardudebug, libraries };
    if (board.fqbn) Object.assign(context, { fqbn: board.fqbn, boardName: board.boardName });
    return context;
}

/**
 * Get the current sketch and make sure its project exists
 * @returns {Promise<string|null>} Sketch folder or null (message shown)
 */
async function ensureCurrentProject() {
    const sketchPath = findSketch();
    if (!sketchPath) {
        vscode.window.showWarningMessage(t('errors.notASketch'));
        return null;
    }
    return (await ensureProjectFor(sketchPath)) ? sketchPath : null;
}

/**
 * Make sure the project folder of a sketch exists
 * @param {string} sketchPath - Sketch folder
 * @returns {Promise<boolean>} True if the project exists (otherwise a message was shown)
 */
async function ensureProjectFor(sketchPath) {
    try {
        const context = await collectContext(sketchPath);
        projectManager.ensureProject(sketchPath, { language: currentLocale, context, gitignoreAll: getSettings().gitignoreAll });
    } catch (err) {
        const message = err.code === 'CONFIG_INVALID'
            ? t('errors.configInvalid', err.message)
            : t('errors.unknown', err.message);
        vscode.window.showErrorMessage(message);
        return false;
    }
    return true;
}

/**
 * Write a changed board into AGENTS.md of the current project
 * @param {Object} board - {fqbn, boardName}
 */
function handleBoardChange(board) {
    const sketchPath = findSketch();
    if (!sketchPath || !projectManager.isProject(sketchPath)) return;
    try {
        const info = boardDetector.getBoardInfo(sketchPath);
        projectManager.updateAutoSection(sketchPath, {
            fqbn: info.fqbn || board.fqbn,
            boardName: info.boardName || board.boardName
        });
    } catch {
        // A damaged config is reported when the user opens the chat
    }
}

// ===== UI: STATUS BAR =====

/**
 * Update the status bar item
 * @param {boolean} busy - Agent running
 */
function updateStatusBar(busy = false) {
    if (!statusBarItem) return;
    statusBarItem.text = busy ? `$(sync~spin) ${t('status.text')}` : `$(comment-discussion) ${t('status.text')}`;
    statusBarItem.tooltip = busy ? t('status.busy') : t('status.tooltip');
}

// ===== CHAT =====

/**
 * Open (or reveal) the chat panel
 * @returns {ChatPanel} Panel
 */
function openChat() {
    return ChatPanel.show({
        extensionPath,
        getT: () => t,
        getLocale: () => currentLocale,
        findSketch,
        collectContext,
        getSettings,
        onBusyChange: updateStatusBar,
        showSettingsMenu,
        chooseAgent
    });
}

// ===== COMMANDS =====

/**
 * Set up the project folder and open AGENTS.md
 */
async function setupProject() {
    const sketchPath = await ensureCurrentProject();
    if (!sketchPath) return;
    const agentsFile = projectManager.getProjectPaths(sketchPath).agents;
    await vscode.window.showTextDocument(vscode.Uri.file(agentsFile), { viewColumn: vscode.ViewColumn.One });
    vscode.window.showInformationMessage(t('chat.projectCreated'));
}

/**
 * Open AGENTS.md of the current project
 */
async function openInstructions() {
    const sketchPath = await ensureCurrentProject();
    if (!sketchPath) return;
    const agentsFile = projectManager.getProjectPaths(sketchPath).agents;
    await vscode.window.showTextDocument(vscode.Uri.file(agentsFile), { viewColumn: vscode.ViewColumn.One });
}

/**
 * Open memory.md of the current project
 */
async function openMemory() {
    const sketchPath = await ensureCurrentProject();
    if (!sketchPath) return;
    const memoryFile = projectManager.getProjectPaths(sketchPath).memory;
    await vscode.window.showTextDocument(vscode.Uri.file(memoryFile), { viewColumn: vscode.ViewColumn.One });
}

/**
 * Add knowledge files via the chat panel
 */
async function addKnowledge() {
    const panel = openChat();
    try {
        await panel.addKnowledge();
    } catch (err) {
        vscode.window.showErrorMessage(panel.describeError(err));
    }
}

/**
 * The IDE unpacks the VSIX without execute permissions, but the agent calls
 * the tools in bin/ directly (Linux, macOS, Git Bash)
 */
function makeToolsExecutable() {
    if (process.platform === 'win32') return;
    for (const tool of AGENT_TOOLS) {
        try {
            fs.chmodSync(path.join(extensionPath, 'bin', tool), EXECUTABLE_MODE);
        } catch {
            // Read-only installation: the tool is then only missing, the chat still works
        }
    }
}

/**
 * Version and origin of the agent configuration
 * @returns {string} e.g. "2026-11-12 (mitgeliefert)"
 */
function describeConfigInfo() {
    const info = registry.getConfigInfo();
    return info ? `${info.version} (${t(`about.config.${info.source}`)})` : '?';
}

/**
 * Show the about page: quick start, agents, details for bug reports, support
 */
async function showAbout() {
    const settings = getSettings();
    const notFound = t('about.notFound');
    const version = getVersion();

    // Status per agent, the detail lines show versions and paths
    const agents = await Promise.all(registry.getAll().map(async adapter => {
        const toolPath = await toolDetector.findAgent(adapter, settings.paths[adapter.id]);
        // The version check already asks for the version if the agent has a minimum
        const check = toolPath ? await toolDetector.checkAgentVersion(adapter, toolPath) : { version: null, tooOld: false };
        const agentVersion = check.version || (toolPath ? await toolDetector.getToolVersion(toolPath, adapter.versionArgs) : null);
        const tooOld = check.tooOld;
        return {
            name: adapter.name,
            status: !toolPath ? 'missing' : (tooOld ? 'tooOld' : 'ok'),
            version: agentVersion,
            minVersion: adapter.minVersion,
            experimental: Boolean(adapter.experimental),
            url: adapter.installUrl,
            detail: toolPath ? `${agentVersion || '?'} (${toolPath})` : notFound
        };
    }));
    const cliPath = await toolDetector.findArduinoCli(settings.arduinoCliPath, vscode.env.appRoot);
    const cliVersion = await toolDetector.getToolVersion(cliPath, ['version']);
    const board = boardDetector.getBoardInfo(findSketch());
    const agentSetting = settings.agent === registry.AUTO ? t('about.agentAuto') : registry.getName(settings.agent);

    const details = [
        ...agents.map(agent => [agent.name, agent.detail]),
        [t('about.cli'), cliPath ? `${cliVersion || '?'} (${cliPath})` : notFound],
        [t('about.board'), board.fqbn || notFound],
        [t('about.ide'), `${vscode.env.appName || '?'} (API ${vscode.version})`],
        [t('about.system'), `${process.platform} ${os.release()} / Node ${process.versions.node}`],
        [t('about.agentConfig'), describeConfigInfo()]
    ];
    const copyText = [
        `Agentuino ${version}`,
        `${t('about.agentSetting')}: ${agentSetting}`,
        ...details.map(([key, value]) => `${key}: ${value}`)
    ].join('\n');

    AboutPanel.show({ extensionPath, t }, {
        version,
        agentSetting,
        agents,
        details,
        copyText,
        links: {
            repo: links.REPO_URL,
            issues: links.ISSUES_URL,
            kofi: links.KOFI_URL,
            sponsors: links.SPONSORS_URL
        }
    });
}

/**
 * Choose the agent for new chats (existing chats keep theirs)
 */
async function chooseAgent() {
    const settings = getSettings();
    const mark = (selected) => (selected ? '✓ ' : '    ');
    const items = [{
        label: mark(settings.agent === registry.AUTO) + t('agent.auto'),
        description: t('agent.autoDescription'),
        value: registry.AUTO
    }];
    for (const adapter of registry.getAll()) {
        const toolPath = await toolDetector.findAgent(adapter, settings.paths[adapter.id]);
        const check = toolPath ? await toolDetector.checkAgentVersion(adapter, toolPath) : null;
        let description = t('agent.notInstalled');
        if (check?.tooOld) {
            description = t('agent.tooOld', check.version || '?', adapter.minVersion);
        } else if (toolPath) {
            description = t('agent.installed');
        }
        if (adapter.experimental) description += ` · ${t('agent.experimental')}`;
        items.push({
            label: mark(settings.agent === adapter.id) + adapter.name,
            description,
            value: adapter.id
        });
    }

    const selected = await vscode.window.showQuickPick(items, { placeHolder: t('agent.select') });
    if (!selected || selected.value === settings.agent) return;

    // Global target is the reliable persistence mechanism in the Arduino IDE
    await vscode.workspace.getConfiguration(CONFIG_SECTION)
        .update('agent', selected.value, vscode.ConfigurationTarget.Global);
    ChatPanel.current?.updateAgentName();
}

/**
 * Read the installed version from package.json
 * @returns {string} Version
 */
function getVersion() {
    return require(path.join(extensionPath, 'package.json')).version;
}

/**
 * Tell the user about a newer version (the IDE has no marketplace for this)
 */
async function checkForUpdates() {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    if (!config.get('checkForUpdates', true)) return;

    const current = getVersion();
    const latest = await updateChecker.findUpdate(current, config.get('skipUpdateVersion', ''));
    if (!latest) return;

    const download = t('update.download');
    const skip = t('update.skip');
    const choice = await vscode.window.showInformationMessage(
        t('update.available', latest, current), download, t('update.later'), skip);
    if (choice === download) {
        await vscode.env.openExternal(vscode.Uri.parse(links.RELEASES_URL));
    } else if (choice === skip) {
        await config.update('skipUpdateVersion', latest, vscode.ConfigurationTarget.Global);
    }
}

/**
 * Offer a newer agent configuration (command line options, install data).
 * Only the check runs on its own; storing needs the user's ok.
 */
async function checkForConfigUpdate() {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    if (!config.get('checkForUpdates', true)) return;

    const update = await registry.findConfigUpdate(config.get('skipConfigVersion', ''));
    if (!update) return;

    const apply = t('configUpdate.apply');
    const skip = t('configUpdate.skip');
    const choice = await vscode.window.showInformationMessage(
        t('configUpdate.available', update.version, registry.getConfigInfo().version), apply, t('configUpdate.later'), skip);
    if (choice === apply) {
        try {
            registry.applyConfig(update);
            vscode.window.showInformationMessage(t('configUpdate.applied', update.version));
        } catch (err) {
            vscode.window.showErrorMessage(t('errors.unknown', err.message));
        }
    } else if (choice === skip) {
        await config.update('skipConfigVersion', update.version, vscode.ConfigurationTarget.Global);
    }
}

/**
 * Remove Agentuino from the Arduino IDE (projects in the sketches stay)
 */
async function uninstall() {
    // VS Code manages its extensions itself
    if (/visual studio code/i.test(vscode.env.appName || '')) {
        vscode.window.showInformationMessage(t('uninstall.vscode'));
        return;
    }
    const targets = uninstaller.getTargets();
    if (targets.length === 0) {
        vscode.window.showWarningMessage(t('uninstall.notFound'));
        return;
    }

    const confirm = t('uninstall.button');
    const answer = await vscode.window.showWarningMessage(t('uninstall.confirm'), { modal: true }, confirm);
    if (answer !== confirm) return;

    ChatPanel.current?.runner.stop();

    // Reset all settings this extension contributes
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const properties = require(path.join(extensionPath, 'package.json')).contributes.configuration.properties;
    for (const fullKey of Object.keys(properties)) {
        try {
            await config.update(fullKey.slice(CONFIG_SECTION.length + 1), undefined, vscode.ConfigurationTarget.Global);
        } catch {
            // Setting was never set
        }
    }

    const result = uninstaller.removeTargets();
    if (result.failed.length > 0) {
        const list = result.failed.map(f => `${f.path} (${f.error})`).join(', ');
        vscode.window.showErrorMessage(t('uninstall.partial', list));
        return;
    }
    const reload = t('uninstall.reload');
    const choice = await vscode.window.showInformationMessage(t('uninstall.done'), reload);
    if (choice === reload) await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

/**
 * Settings menu behind the gear button of the chat
 */
async function showSettingsMenu() {
    const items = [
        { label: t('menu.chooseAgent'), action: chooseAgent },
        { label: t('menu.openInstructions'), action: openInstructions },
        { label: t('menu.rules'), action: showRules },
        { label: t('menu.addKnowledge'), action: addKnowledge },
        { label: t('menu.openMemory'), action: openMemory },
        { label: t('menu.preferences'), action: showPreferencesMenu },
        { label: t('menu.about'), action: showAbout },
        { label: t('menu.uninstall'), action: uninstall }
    ];
    const selected = await vscode.window.showQuickPick(items, { placeHolder: t('menu.title') });
    if (selected) await selected.action();
}

/**
 * Open the semantic anchors of the current sketch (or the defaults without a sketch)
 */
function showRules() {
    RulesPanel.show({ extensionPath, getT: () => t, ensureProject: ensureProjectFor }, findSketch());
}

/**
 * Let the user pick the UI language
 */
async function switchLanguage() {
    const items = [{ label: `🌐 ${t('language.auto')}`, value: i18n.AUTO }];
    for (const code of i18n.getAvailableLocales()) {
        items.push({ label: i18n.createTranslator(code)('language.name'), description: code, value: code });
    }
    const selected = await vscode.window.showQuickPick(items, { placeHolder: t('language.select') });
    if (!selected) return;
    await updateSetting('language', selected.value);
}

// ===== PREFERENCES =====

// Permission modes in the order shown in the menu
const PERMISSION_MODES = ['bypassPermissions', 'acceptEdits', 'auto'];

/**
 * Name of the language setting for the menu
 * @param {string} value - 'auto' or a locale code
 * @returns {string} e.g. "Deutsch"
 */
function describeLanguage(value) {
    return value === i18n.AUTO ? t('language.auto') : i18n.createTranslator(value)('language.name');
}

/**
 * Short name of a permission mode for the menu
 * @param {string} mode - Setting value
 * @returns {string} Label, or the raw value if unknown
 */
function describePermissionMode(mode) {
    return PERMISSION_MODES.includes(mode) ? t(`prefs.permission.${mode}.label`) : mode;
}

/**
 * Settings that people rarely change, in a submenu of the gear menu.
 * Each entry shows its current value; the menu reopens after a change.
 */
async function showPreferencesMenu() {
    for (;;) {
        // The language may just have changed
        loadLocale();
        const settings = getSettings();
        const onOff = value => t(value ? 'prefs.on' : 'prefs.off');
        const items = [
            { label: t('prefs.language'), description: describeLanguage(settings.language), action: switchLanguage },
            {
                label: t('prefs.compileCheck'),
                description: onOff(settings.compileCheck),
                action: () => updateSetting('compileCheck', !settings.compileCheck)
            },
            { label: t('prefs.permissionMode'), description: describePermissionMode(settings.permissionMode), action: choosePermissionMode },
            { label: t('prefs.gitignoreAll'), description: onOff(settings.gitignoreAll), action: toggleGitignore },
            {
                label: t('prefs.checkForUpdates'),
                description: onOff(settings.checkForUpdates),
                action: () => updateSetting('checkForUpdates', !settings.checkForUpdates)
            },
            { label: t('prefs.paths'), action: showPathsMenu }
        ];
        const selected = await vscode.window.showQuickPick(items, { placeHolder: t('prefs.title') });
        if (!selected) return;
        await selected.action();
    }
}

/**
 * Choose what the agent may do without asking
 */
async function choosePermissionMode() {
    const current = getSettings().permissionMode;
    const items = PERMISSION_MODES.map(mode => ({
        label: (mode === current ? '✓ ' : '    ') + describePermissionMode(mode),
        description: t(`prefs.permission.${mode}.description`),
        value: mode
    }));
    const selected = await vscode.window.showQuickPick(items, { placeHolder: t('prefs.permissionSelect') });
    if (selected && selected.value !== current) await updateSetting('permissionMode', selected.value);
}

/**
 * Toggle whether the whole project folder is kept out of Git
 */
async function toggleGitignore() {
    const ignoreAll = !getSettings().gitignoreAll;
    await updateSetting('gitignoreAll', ignoreAll);
    // Rewrite the .gitignore of the open sketch right away, the others follow on their next use
    const sketchPath = findSketch();
    if (sketchPath && projectManager.isProject(sketchPath)) {
        try {
            projectManager.updateGitignore(sketchPath, ignoreAll);
        } catch (err) {
            vscode.window.showErrorMessage(t('errors.unknown', err.message));
        }
    }
}

/**
 * All programs Agentuino calls, with how to find and check them
 * @returns {Object[]} {name, setting, configured, find(configured), versionArgs, minVersion}
 */
function getPrograms() {
    const settings = getSettings();
    return [
        ...registry.getAll().map(adapter => ({
            name: adapter.name,
            setting: adapter.pathSetting,
            configured: settings.paths[adapter.id],
            find: configured => toolDetector.findAgent(adapter, configured),
            versionArgs: adapter.versionArgs,
            minVersion: adapter.minVersion
        })),
        {
            name: 'arduino-cli',
            setting: 'arduinoCliPath',
            configured: settings.arduinoCliPath,
            find: configured => toolDetector.findArduinoCli(configured, vscode.env.appRoot),
            versionArgs: ['version'],
            minVersion: null
        }
    ];
}

/**
 * Describe where a program was found
 * @param {string} configured - Path from the settings ('' = automatic)
 * @param {string|null} found - Path actually used
 * @returns {string} Menu description
 */
function describeProgramPath(configured, found) {
    if (configured) return found ? found : t('prefs.pathMissing', configured);
    return found ? t('prefs.pathAuto', found) : t('prefs.pathNone');
}

/**
 * Program paths: agents and arduino-cli, each with the path actually found
 */
async function showPathsMenu() {
    for (;;) {
        const items = await Promise.all(getPrograms().map(async program => ({
            label: program.name,
            description: describeProgramPath(program.configured, await program.find(program.configured)),
            program
        })));
        const selected = await vscode.window.showQuickPick(items, { placeHolder: t('prefs.pathsSelect') });
        if (!selected) return;
        await chooseProgramPath(selected.program);
    }
}

/**
 * Pick a program file or go back to automatic detection
 * @param {Object} program - Entry from getPrograms()
 */
async function chooseProgramPath(program) {
    const browse = { label: t('prefs.pathBrowse') };
    const auto = { label: t('prefs.pathAutoDetect') };
    const choice = await vscode.window.showQuickPick([browse, auto], { placeHolder: program.name });
    if (!choice) return;
    if (choice === auto) {
        await updateSetting(program.setting, '');
        return;
    }

    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        title: t('prefs.pathDialog', program.name),
        openLabel: t('prefs.pathOpen')
    });
    const file = uris?.[0]?.fsPath;
    if (!file) return;

    // Check right away, so a wrong file shows up now and not in the next chat
    const version = await toolDetector.getToolVersion(file, program.versionArgs);
    let problem = null;
    if (!version) {
        problem = t('prefs.pathNoVersion', program.name, path.basename(file));
    } else if (program.minVersion && !toolDetector.isVersionAtLeast(version, program.minVersion)) {
        problem = t('prefs.pathTooOld', program.name, version, program.minVersion);
    }
    if (problem) {
        const useAnyway = t('prefs.pathUseAnyway');
        const answer = await vscode.window.showWarningMessage(problem, { modal: true }, useAnyway);
        if (answer !== useAnyway) return;
    }
    await updateSetting(program.setting, file);
}

/**
 * Apply a changed language everywhere
 */
function applyLanguageChange() {
    loadLocale();
    updateStatusBar(false);
    ChatPanel.current?.updateTexts();
    vscode.window.showInformationMessage(t('language.changed', t('language.name')));
}

// ===== ACTIVATION =====

// Built into the Arduino IDE 2.x, reports board, port and sketch of this window
const ARDUINO_API_EXTENSION = 'dankeboy36.vscode-arduino-api';

/**
 * Get the Arduino IDE API (the IDE activates it before all other extensions)
 * @returns {Object|null} ArduinoContext or null (e.g. in VS Code)
 */
function getArduinoContext() {
    const api = vscode.extensions.getExtension(ARDUINO_API_EXTENSION)?.exports;
    return api && typeof api.onDidChange === 'function' ? api : null;
}

/**
 * Extension entry point
 * @param {vscode.ExtensionContext} context - Extension context
 */
function activate(context) {
    extensionPath = context.extensionPath;
    loadLocale();
    makeToolsExecutable();

    boardDetector = new BoardDetector({ arduinoContext: getArduinoContext() });
    boardDetector.on('change', handleBoardChange);
    boardDetector.start();

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, STATUS_BAR_PRIORITY);
    statusBarItem.command = 'agentuino.openChat';
    updateStatusBar(false);
    statusBarItem.show();

    updateTimer = setTimeout(() => {
        // One after the other, so two notices do not pop up at once
        checkForUpdates().catch(() => {}).then(() => checkForConfigUpdate()).catch(() => {});
    }, UPDATE_CHECK_DELAY_MS);

    context.subscriptions.push(
        statusBarItem,
        { dispose: () => boardDetector.dispose() },
        changesView.register(),
        vscode.commands.registerCommand('agentuino.openChat', () => openChat()),
        vscode.commands.registerCommand('agentuino.newChat', () => openChat().newChat()),
        vscode.commands.registerCommand('agentuino.addKnowledge', addKnowledge),
        vscode.commands.registerCommand('agentuino.openMemory', openMemory),
        vscode.commands.registerCommand('agentuino.settings', showSettingsMenu),
        vscode.commands.registerCommand('agentuino.about', showAbout),
        vscode.commands.registerCommand('agentuino.chooseAgent', chooseAgent),
        vscode.commands.registerCommand('agentuino.rules', showRules),
        vscode.commands.registerCommand('agentuino.uninstall', uninstall),
        vscode.commands.registerCommand('agentuino.setupProject', setupProject),
        vscode.commands.registerCommand('agentuino.openInstructions', openInstructions),
        vscode.commands.registerCommand('agentuino.switchLanguage', switchLanguage),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(`${CONFIG_SECTION}.language`)) applyLanguageChange();
            if (e.affectsConfiguration(`${CONFIG_SECTION}.agent`)) ChatPanel.current?.updateAgentName();
        }),
        vscode.window.onDidChangeActiveTextEditor(() => ChatPanel.current?.refreshSketch())
    );
}

/**
 * Extension cleanup
 */
function deactivate() {
    clearTimeout(updateTimer);
    ChatPanel.current?.runner.stop();
    boardDetector?.dispose();
}

module.exports = { activate, deactivate };
