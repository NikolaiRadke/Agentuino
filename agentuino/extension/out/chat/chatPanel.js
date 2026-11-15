/*
 * Agentuino - Chat Panel
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Webview chat bound to the current sketch. A sketch works like a project:
 * several chats, each with its own agent session, plus shared instructions,
 * knowledge and memory. A new chat is created with its first message.
 */

"use strict";

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectManager = require('../utils/projectManager');
const toolDetector = require('../agents/toolDetector');
const chatStore = require('./chatStore');
const backupManager = require('../utils/backupManager');
const links = require('../utils/links');
const ruleBlocks = require('../utils/ruleBlocks');
const registry = require('../agents/registry');
const { AgentRunner } = require('../agents/agentRunner');
const { shorten, createError } = require('../agents/agentUtils');
const { CompileChecker } = require('../utils/compileChecker');

// ===== CONSTANTS =====

const VIEW_TYPE = 'agentuino.chat';
const NONCE_BYTES = 16;
const COST_DECIMALS = 2;
const COPIED_MESSAGE_MS = 2000;
const MAX_LISTED_FILES = 10;
const HASH_ALGORITHM = 'sha1';
const MIN_SHOWN_COST = 0.01;
// Agent runs per task including the first one (same as AI.duino's compile loop)
const MAX_COMPILE_ATTEMPTS = 3;
const OUTPUT_CHANNEL_NAME = 'Agentuino';
// Agentuino's own commands for the agent (agentuino-serial)
const TOOLS_DIR = 'bin';
// Command output shown under an activity line keeps its start and its end
const OUTPUT_HEAD_CHARS = 2000;
const OUTPUT_TAIL_CHARS = 6000;
// Colors and cursor moves of terminal output
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Format a cost in dollars; tiny amounts are shown as "< 0.01"
 * @param {number} cost - Cost in dollars
 * @returns {string} Formatted cost
 */
function formatCost(cost) {
    return cost > 0 && cost < MIN_SHOWN_COST ? `< ${MIN_SHOWN_COST}` : cost.toFixed(COST_DECIMALS);
}

/**
 * Prepare command output for the chat: no terminal codes, long output shortened
 * @param {string} output - Raw output
 * @param {Function} t - Translation function
 * @returns {string} Output to show
 */
function prepareOutput(output, t) {
    const text = String(output || '').replace(ANSI_ESCAPE, '').replace(/\r\n/g, '\n').trimEnd();
    if (!text.trim()) return t('chat.noOutput');
    if (text.length <= OUTPUT_HEAD_CHARS + OUTPUT_TAIL_CHARS) return text;
    const skipped = text.length - OUTPUT_HEAD_CHARS - OUTPUT_TAIL_CHARS;
    return `${text.slice(0, OUTPUT_HEAD_CHARS)}\n${t('chat.outputCut', skipped)}\n${text.slice(-OUTPUT_TAIL_CHARS)}`;
}

class ChatPanel {
    /**
     * Show the chat panel (create it if needed)
     * @param {Object} deps - Dependencies from extension.js
     * @returns {ChatPanel} Panel instance
     */
    static show(deps) {
        if (ChatPanel.current) {
            // Keep the column the panel is in (the user may have moved it)
            ChatPanel.current.panel.reveal();
            ChatPanel.current.refreshSketch();
            return ChatPanel.current;
        }
        ChatPanel.current = new ChatPanel(deps);
        return ChatPanel.current;
    }

    /**
     * @param {Object} deps - {extensionPath, getT, getLocale, findSketch, collectContext,
     *                          getSettings, onBusyChange, showSettingsMenu}
     */
    constructor(deps) {
        this.deps = deps;
        this.runner = new AgentRunner();
        this.compiler = new CompileChecker();
        // True from sending a message until the agent run and the compile check are done
        this.working = false;
        this.agentName = '';
        this.sketchPath = null;
        this.chat = null;
        this.pendingAttachments = [];

        const mediaDir = path.join(deps.extensionPath, 'media');
        this.panel = vscode.window.createWebviewPanel(
            VIEW_TYPE,
            deps.getT()('chat.title'),
            vscode.ViewColumn.Two,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(mediaDir)]
            }
        );
        this.panel.iconPath = vscode.Uri.file(path.join(deps.extensionPath, 'icons', 'agentuino.png'));
        this.panel.webview.html = this.getHtml(mediaDir);

        this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg));
        this.panel.onDidDispose(() => {
            this.runner.stop();
            this.compiler.stop();
            ChatPanel.current = null;
        });
    }

    // ===== WEBVIEW COMMUNICATION =====

    /**
     * Post a message to the webview
     * @param {Object} message - Message object
     */
    post(message) {
        this.panel.webview.postMessage(message);
    }

    /**
     * Add a chat entry: show it and store it in the current chat
     * @param {string} role - 'user' | 'agent' | 'activity' | 'info' | 'error' | 'compile'
     * @param {string} text - Text
     * @param {Object} [data] - Extra data for the webview (compile result)
     * @param {Object} [live] - Extra fields for the webview only, not stored (toolId)
     */
    addEntry(role, text, data, live) {
        const time = Date.now();
        this.post({ command: 'entry', role, text, time, data, ...live });
        if (this.chat && this.sketchPath) {
            try {
                chatStore.appendMessage(this.sketchPath, this.chat, role, text, time, data);
            } catch {
                // Storage is a convenience, never block the chat
            }
        }
        return time;
    }

    /**
     * Tell the webview which message can be reset (only the last run, if in this chat)
     */
    postSnapshot() {
        const snapshot = this.sketchPath ? backupManager.getSnapshot(this.sketchPath) : null;
        const time = snapshot && this.chat && snapshot.chatId === this.chat.id ? snapshot.messageTime : null;
        this.post({ command: 'snapshot', time });
    }

    /**
     * Build the chat list for the header dropdown
     * @returns {Array} Chat summaries
     */
    getChatList() {
        return this.sketchPath && projectManager.isProject(this.sketchPath)
            ? chatStore.listChats(this.sketchPath)
            : [];
    }

    /**
     * Send the header data (title, chat list, cost)
     */
    postHeader() {
        const t = this.deps.getT();
        const cost = this.chat?.costUsd;
        this.post({
            command: 'header',
            title: this.chat ? this.chat.title : t('chat.untitled'),
            currentId: this.chat?.id || null,
            chats: this.getChatList(),
            cost: typeof cost === 'number' ? t('chat.cost', formatCost(cost)) : ''
        });
    }

    /**
     * Send texts, sketch, current chat and state to the webview
     */
    sendInit() {
        const t = this.deps.getT();
        this.post({
            command: 'init',
            texts: t.strings.chat,
            locale: this.deps.getLocale(),
            sketch: this.sketchPath ? path.basename(this.sketchPath) : null,
            agent: this.agentName,
            messages: this.chat ? this.chat.messages : [],
            busy: this.working,
            attachments: this.pendingAttachments.map(a => a.name)
        });
        this.postHeader();
        this.postSnapshot();
        this.updateAgentName();
    }

    /**
     * Show which agent this chat uses (or a new chat would use).
     * Only a new, empty chat lets the user choose another agent.
     */
    async updateAgentName() {
        let name = this.chat ? registry.getName(this.chat.agent) : '';
        if (!this.chat) {
            try {
                name = (await this.resolveAgent()).adapter.name;
            } catch (err) {
                name = '';
                if (err.code === 'NO_AGENT') this.showSetup();
            }
        }
        this.agentName = name;
        this.post({ command: 'agent', name, selectable: !this.chat });
    }

    /**
     * Show the setup card: how to install and log in to an agent
     */
    showSetup() {
        const t = this.deps.getT();
        const platform = process.platform === 'win32' ? 'windows' : 'unix';
        this.post({
            command: 'setup',
            setup: {
                title: t('setup.title'),
                intro: t('setup.intro', t(`setup.terminal.${platform}`)),
                agents: registry.getAll().map(adapter => ({
                    name: adapter.experimental ? `${adapter.name} (${t('agent.experimental')})` : adapter.name,
                    note: t(`setup.notes.${adapter.id}`),
                    install: adapter.install[platform],
                    login: adapter.setupCommand,
                    url: adapter.installUrl
                })),
                labels: {
                    install: t('setup.install'),
                    login: t('setup.login'),
                    guide: t('setup.guide'),
                    copy: t('chat.copy'),
                    recheck: t('setup.recheck'),
                    after: t('setup.afterInstall')
                }
            }
        });
    }

    /**
     * Look for agents again after the user installed one
     */
    async recheckAgents() {
        const t = this.deps.getT();
        await this.updateAgentName();
        if (this.agentName) {
            this.post({ command: 'setupDone' });
            this.addEntry('info', t('setup.found', this.agentName));
        } else {
            this.post({ command: 'entry', role: 'info', text: t('setup.stillMissing') });
        }
    }

    /**
     * Find the agent for the current chat, or for a new chat from the settings
     * @returns {Promise<{adapter: Object, toolPath: string}>} Agent
     * @throws {Error} AGENT_NOT_FOUND, NO_AGENT
     */
    async resolveAgent() {
        const settings = this.deps.getSettings();
        const wanted = this.chat ? this.chat.agent : settings.agent;
        const adapters = wanted === registry.AUTO ? registry.getAll() : [registry.get(wanted)].filter(Boolean);

        let tooOld = null;
        for (const adapter of adapters) {
            const toolPath = await toolDetector.findAgent(adapter, settings.paths[adapter.id]);
            if (!toolPath) continue;
            const check = await toolDetector.checkAgentVersion(adapter, toolPath);
            if (!check.tooOld) return { adapter, toolPath };
            // In automatic mode an outdated agent is skipped, the next one may work
            tooOld = tooOld || { adapter, version: check.version };
        }
        // Nothing usable, but an outdated agent exists: tell the user how to update
        if (tooOld) {
            throw createError('AGENT_TOO_OLD', `${tooOld.adapter.id} too old`, { adapter: tooOld.adapter, version: tooOld.version });
        }
        if (wanted !== registry.AUTO) {
            const adapter = registry.get(wanted);
            throw createError('AGENT_NOT_FOUND', `${wanted} not found`, { adapter, agentId: wanted });
        }
        throw createError('NO_AGENT', 'No agent found');
    }

    /**
     * Load the sketch and its last chat, then refresh the webview
     */
    loadSketch() {
        this.sketchPath = this.deps.findSketch();
        this.chat = this.sketchPath
            ? chatStore.loadChat(this.sketchPath, projectManager.getLastChatId(this.sketchPath))
            : null;
        this.pendingAttachments = [];
        this.sendInit();
    }

    /**
     * Reload if the active sketch has changed (not while busy)
     */
    refreshSketch() {
        if (this.working) return;
        const sketch = this.deps.findSketch();
        if (sketch && sketch !== this.sketchPath) this.loadSketch();
    }

    /**
     * Re-send texts after a language switch
     */
    updateTexts() {
        this.panel.title = this.deps.getT()('chat.title');
        this.sendInit();
    }

    /**
     * Set busy state in webview and status bar
     * @param {boolean} busy - Busy flag
     */
    setBusy(busy) {
        this.post({ command: 'busy', busy });
        this.deps.onBusyChange(busy);
    }

    /**
     * Handle messages from the webview
     * @param {Object} msg - Message
     */
    async handleMessage(msg) {
        try {
            switch (msg.command) {
                case 'ready': this.loadSketch(); break;
                case 'send': await this.send(msg.text); break;
                case 'stop':
                    this.runner.stop();
                    this.compiler.stop();
                    break;
                case 'fixErrors': await this.fixErrors(msg.time); break;
                case 'newChat': this.newChat(); break;
                case 'selectChat': this.selectChat(msg.id); break;
                case 'deleteChat': await this.deleteChat(msg.id); break;
                case 'settings': await this.deps.showSettingsMenu(); break;
                case 'recheckAgents': await this.recheckAgents(); break;
                case 'chooseAgent':
                    // The agent of an existing chat is fixed, its session cannot move
                    if (!this.chat && !this.working) await this.deps.chooseAgent();
                    break;
                case 'attach': await this.attachFiles(); break;
                case 'restore': await this.restore(); break;
                case 'openUrl':
                    if (links.isWebUrl(msg.url)) await vscode.env.openExternal(vscode.Uri.parse(msg.url));
                    break;
                case 'copy': await this.copyToClipboard(msg.text); break;
                case 'requestPaste':
                    this.post({ command: 'paste', text: await vscode.env.clipboard.readText() });
                    break;
                case 'removeAttachment':
                    this.pendingAttachments.splice(msg.index, 1);
                    this.post({ command: 'attachments', list: this.pendingAttachments.map(a => a.name) });
                    break;
                default: break;
            }
        } catch (err) {
            if (err.code === 'NO_AGENT') {
                this.showSetup();
            } else {
                this.addEntry('error', this.describeError(err));
            }
            this.setBusy(false);
        }
    }

    /**
     * Copy text to the clipboard. The webview cannot reach the clipboard
     * in the Arduino IDE (Theia), so copying goes through the extension.
     * @param {string} text - Text to copy
     */
    async copyToClipboard(text) {
        if (!text) return;
        await vscode.env.clipboard.writeText(text);
        vscode.window.setStatusBarMessage(this.deps.getT()('chat.copied'), COPIED_MESSAGE_MS);
    }

    // ===== PROJECT HELPERS =====

    /**
     * Make sure a sketch is open and its project folder exists
     * @returns {Promise<string>} Sketch path
     * @throws {Error} NOT_A_SKETCH
     */
    async prepareProject() {
        const sketchPath = this.deps.findSketch();
        if (!sketchPath) {
            throw createError('NOT_A_SKETCH', 'No sketch');
        }
        if (sketchPath !== this.sketchPath) {
            this.sketchPath = sketchPath;
            this.chat = null;
            this.sendInit();
        }

        const context = await this.deps.collectContext(sketchPath);
        const { created } = projectManager.ensureProject(sketchPath, {
            language: this.deps.getLocale(),
            context
        });
        if (created) {
            this.post({ command: 'entry', role: 'info', text: this.deps.getT()('chat.projectCreated') });
        }
        return sketchPath;
    }

    // ===== CHATS =====

    /**
     * Start a fresh chat; it is stored with its first message
     */
    newChat() {
        if (this.working) {
            this.addEntry('error', this.deps.getT()('errors.busy'));
            return;
        }
        this.chat = null;
        this.pendingAttachments = [];
        if (this.sketchPath && projectManager.isProject(this.sketchPath)) {
            projectManager.setLastChatId(this.sketchPath, null);
        }
        this.sendInit();
    }

    /**
     * Open an existing chat of the current sketch
     * @param {string} id - Chat ID
     */
    selectChat(id) {
        if (this.working || !this.sketchPath) return;
        const chat = chatStore.loadChat(this.sketchPath, id);
        if (!chat) return;
        this.chat = chat;
        this.pendingAttachments = [];
        projectManager.setLastChatId(this.sketchPath, id);
        this.sendInit();
    }

    /**
     * Delete a chat after confirmation
     * @param {string} id - Chat ID
     */
    async deleteChat(id) {
        const t = this.deps.getT();
        if (this.working || !this.sketchPath) return;
        const chat = chatStore.loadChat(this.sketchPath, id);
        if (!chat) return;

        const answer = await vscode.window.showWarningMessage(
            t('chat.deleteConfirm', chat.title), { modal: true }, t('chat.delete'));
        if (answer !== t('chat.delete')) return;

        chatStore.deleteChat(this.sketchPath, id);
        projectManager.refreshAutoSection(this.sketchPath);
        if (this.chat?.id === id) {
            this.newChat();
        } else {
            this.postHeader();
        }
    }

    /**
     * Create the chat with its first message and request a real title
     * @param {string} sketchPath - Sketch folder
     * @param {string} firstText - First user message
     * @param {Object} agent - {adapter, toolPath}
     */
    startChat(sketchPath, firstText, agent) {
        const t = this.deps.getT();
        this.chat = chatStore.createChat(sketchPath, agent.adapter.id, firstText);
        projectManager.setLastChatId(sketchPath, this.chat.id);
        projectManager.refreshAutoSection(sketchPath);
        this.postHeader();

        // Runs in parallel to the answer; without title support or on failure
        // the provisional title stays
        if (!agent.adapter.generateTitle) return;
        const chat = this.chat;
        agent.adapter.generateTitle(agent.toolPath, t('prompt.title', firstText)).then(title => {
            if (!title) return;
            chat.title = title;
            chat.titleFinal = true;
            try {
                chatStore.saveChat(sketchPath, chat);
                projectManager.refreshAutoSection(sketchPath);
            } catch {
                // Title is cosmetic
            }
            if (this.sketchPath === sketchPath) this.postHeader();
        });
    }

    // ===== ACTIONS =====

    /**
     * Send a user message to the agent
     * @param {string} text - User text, shown in the chat
     * @param {string} [agentText] - Text for the agent instead of the shown one
     */
    async send(text, agentText) {
        const t = this.deps.getT();
        if (!text || !text.trim()) return;
        if (this.working) {
            this.addEntry('error', t('errors.busy'));
            return;
        }
        this.working = true;
        try {
            await this.sendToAgent(text, agentText);
        } finally {
            this.working = false;
        }
    }

    /**
     * Run the agent for a message, then check that the sketch compiles
     * @param {string} text - User text, shown in the chat
     * @param {string} [agentText] - Text for the agent instead of the shown one
     */
    async sendToAgent(text, agentText) {
        const t = this.deps.getT();
        const sketchPath = await this.prepareProject();
        const settings = this.deps.getSettings();
        const agent = await this.resolveAgent();

        // Agent works on disk, so unsaved editor changes must be written first
        await vscode.workspace.saveAll(false);

        if (!this.chat) {
            this.startChat(sketchPath, text, agent);
            this.updateAgentName();
        }

        const attachments = this.pendingAttachments.splice(0);
        this.post({ command: 'attachments', list: [] });

        let shownText = text.trim();
        let prompt = agentText || shownText;
        // What happened since the agent's last answer: a reset, the result of the compile check
        const notices = [this.chat.pendingNotice, this.chat.checkNotice].filter(Boolean);
        if (notices.length > 0) {
            prompt = `${notices.join('\n\n')}\n\n${prompt}`;
            delete this.chat.pendingNotice;
            delete this.chat.checkNotice;
        }
        if (attachments.length > 0) {
            const list = attachments.map(a => `- ${a.rel}`).join('\n');
            prompt += `\n\n${t('prompt.attachments')}\n${list}`;
            shownText += '\n\n📎 ' + attachments.map(a => a.name).join(', ');
        }
        const messageTime = this.addEntry('user', shownText);

        // Exactly one snapshot per sketch: the state before this run
        try {
            backupManager.createSnapshot(sketchPath, { chatId: this.chat.id, messageTime });
        } catch {
            // Without snapshot the run still works, only reset is unavailable
        }
        this.postSnapshot();

        // The IDE opens changed sketch files in the active column, keep that the code column
        // (same approach as AI.duino's agenticClient)
        await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
        const focusGuard = this.panel.onDidChangeViewState(e => {
            if (e.webviewPanel.active) {
                vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
            }
        });

        this.setBusy(true);
        try {
            const result = await this.runAgent(sketchPath, agent, prompt, settings, true);
            if (settings.compileCheck) await this.compileLoop(sketchPath, agent, settings, result);
        } finally {
            focusGuard.dispose();
            // A run without code changes keeps the reset of the last real change
            try {
                backupManager.settleSnapshot(sketchPath);
            } catch {
                // Reset is a convenience, never block the chat
            }
            this.postSnapshot();
            this.setBusy(false);
            this.panel.reveal(undefined, false);
        }
    }

    /**
     * Folder of arduino-cli for the agent's PATH (AGENTS.md uses the plain command name)
     * @param {string} sketchPath - Sketch folder
     * @returns {string[]} Folders
     */
    getCliDirs(sketchPath) {
        try {
            const cliPath = projectManager.readConfig(sketchPath).context.cliPath;
            return cliPath ? [path.dirname(cliPath)] : [];
        } catch {
            return [];
        }
    }

    /**
     * Environment for Agentuino's own tools in the agent's shell (agentuino-serial, agentuino-debug):
     * the IDE's Node runtime and the arduino-cli setup of this sketch
     * @param {string} sketchPath - Sketch folder
     * @returns {Object} Variables
     */
    getToolEnv(sketchPath) {
        const env = { AGENTUINO_NODE: process.execPath, AGENTUINO_SKETCH: sketchPath };
        try {
            const { cliPath, configFile, port, fqbn } = projectManager.readConfig(sketchPath).context;
            if (cliPath) env.AGENTUINO_CLI = cliPath;
            if (configFile) env.AGENTUINO_CLI_CONFIG = configFile;
            if (port) env.AGENTUINO_PORT = port;
            if (fqbn) env.AGENTUINO_FQBN = fqbn;
        } catch {
            // Without config the tool detects arduino-cli and the port itself
        }
        return env;
    }

    /**
     * Put AGENTS.md into the prompt for agents without an instructions file option:
     * at the start of a session and whenever the instructions have changed
     * @param {string} sketchPath - Sketch folder
     * @param {Object} adapter - Agent adapter
     * @param {Object} chat - Chat object
     * @param {string} prompt - Prompt
     * @returns {{prompt: string, hash: string|null}} Prompt and instructions hash
     */
    addInstructions(sketchPath, adapter, chat, prompt) {
        if (adapter.supportsInstructionsFile) return { prompt, hash: null };
        let content;
        try {
            content = fs.readFileSync(projectManager.getProjectPaths(sketchPath).agents, 'utf8');
        } catch {
            return { prompt, hash: null };
        }
        const hash = crypto.createHash(HASH_ALGORITHM).update(content).digest('hex');
        if (chat.sessionId && chat.instructionsHash === hash) return { prompt, hash };
        const t = this.deps.getT();
        return { prompt: `${t('prompt.instructions', projectManager.AGENTS_FILE_REL)}\n\n${content}\n\n---\n\n${prompt}`, hash };
    }

    /**
     * Run the agent once; retries without session if the old one is gone
     * @param {string} sketchPath - Sketch folder (cwd)
     * @param {Object} agent - {adapter, toolPath}
     * @param {string} basePrompt - Prompt without project instructions
     * @param {Object} settings - Extension settings
     * @param {boolean} allowRetry - Retry once on lost session
     * @returns {Promise<Object>} Run result
     */
    async runAgent(sketchPath, agent, basePrompt, settings, allowRetry) {
        const t = this.deps.getT();
        const chat = this.chat;
        const { adapter, toolPath } = agent;
        const { prompt, hash } = this.addInstructions(sketchPath, adapter, chat, basePrompt);

        try {
            const result = await this.runner.run({
                adapter,
                toolPath,
                prompt,
                cwd: sketchPath,
                sessionId: chat.sessionId,
                model: settings.models[adapter.id],
                permissionMode: settings.permissionMode,
                instructionsFile: projectManager.AGENTS_FILE_REL,
                pathDirs: [...this.getCliDirs(sketchPath), path.join(this.deps.extensionPath, TOOLS_DIR)],
                env: this.getToolEnv(sketchPath),
                onEvent: (event) => {
                    if (event.type === 'init' && event.sessionId && event.sessionId !== chat.sessionId) {
                        chat.sessionId = event.sessionId;
                        chatStore.saveChat(sketchPath, chat);
                    } else if (event.type === 'text') {
                        this.addEntry('agent', event.text);
                    } else if (event.type === 'tool') {
                        const label = t.strings.tools[event.name] ? `tools.${event.name}` : 'tools.default';
                        this.addEntry('activity', t(label, event.detail || event.name), undefined,
                            event.id ? { toolId: event.id } : undefined);
                    } else if (event.type === 'toolOutput') {
                        // Shown live only: the stored chat stays small and agents do not read old output
                        this.post({ command: 'toolOutput', toolId: event.id, output: prepareOutput(event.output, t), failed: event.failed });
                    }
                }
            });

            if (result.sessionId) chat.sessionId = result.sessionId;
            if (result.costUsd !== null) chat.costUsd = result.costUsd;
            if (hash && result.sessionId && !result.isError) chat.instructionsHash = hash;
            chatStore.saveChat(sketchPath, chat);
            this.postHeader();

            if (result.stopped) {
                this.addEntry('info', t('chat.stopped'));
            } else if (result.isError) {
                const message = result.errorType === 'auth'
                    ? t('errors.notLoggedIn', adapter.name, adapter.loginHint)
                    : t('errors.agentError', result.result);
                this.addEntry('error', message);
            }
            return result;
        } catch (err) {
            if (err.code === 'SESSION_NOT_FOUND' && allowRetry) {
                chat.sessionId = null;
                chatStore.saveChat(sketchPath, chat);
                this.addEntry('info', t('chat.sessionLost'));
                return this.runAgent(sketchPath, agent, basePrompt, settings, false);
            }
            if (!err.adapter) err.adapter = adapter;
            throw err;
        }
    }

    /**
     * Agentic loop: compile after the run; on errors the agent gets the compiler
     * output and tries again, up to MAX_COMPILE_ATTEMPTS runs in total. Ends early
     * when a run changes no code. Afterwards the user can still ask for a fix.
     * @param {string} sketchPath - Sketch folder
     * @param {Object} agent - {adapter, toolPath}
     * @param {Object} settings - Extension settings
     * @param {Object} result - Result of the first run
     */
    async compileLoop(sketchPath, agent, settings, result) {
        const t = this.deps.getT();
        for (let attempt = 1; ; attempt++) {
            if (!result || result.stopped || result.isError) return;
            const check = await this.checkCompile(sketchPath, attempt > 1 || this.lastCheckFailed());
            // Installing a library needs the user's ok, a repair round would not help
            if (!check || check.ok || check.missingLibraries || attempt >= MAX_COMPILE_ATTEMPTS) return;

            this.addEntry('info', t('compile.autoFix', attempt + 1, MAX_COMPILE_ATTEMPTS));
            const before = backupManager.getCodeFingerprint(sketchPath);
            result = await this.runAgent(sketchPath, agent, this.fixPrompt(sketchPath, check.errorText), settings, true);
            if (result && !result.stopped && !result.isError
                && backupManager.getCodeFingerprint(sketchPath) === before) {
                this.addEntry('info', t('compile.noChange'));
                return;
            }
        }
    }

    /**
     * Whether the last compile check in this chat failed. Then the next run is
     * checked even without code changes (e.g. after installing a missing library).
     * @returns {boolean} Last check failed
     */
    lastCheckFailed() {
        const messages = this.chat?.messages || [];
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'compile') return !messages[i].data?.ok;
        }
        return false;
    }

    /**
     * Compile the sketch after an agent run that changed code and show the result
     * @param {string} sketchPath - Sketch folder
     * @param {boolean} force - Compile even if the code equals the state before the task
     * @returns {Promise<Object|null>} Compile data (see describeCompile), null if skipped or stopped
     */
    async checkCompile(sketchPath, force) {
        const t = this.deps.getT();
        // Nothing changed (e.g. only a question answered): no check needed
        const plan = backupManager.planRestore(sketchPath);
        if (!force && plan && plan.restore.length === 0 && plan.remove.length === 0) return null;

        let context;
        try {
            context = projectManager.readConfig(sketchPath).context || {};
        } catch {
            return null;
        }
        if (!context.cliPath) {
            this.addEntry('info', t('compile.noCli'));
            return null;
        }
        if (!context.fqbn) {
            this.addEntry('info', t('compile.noBoard'));
            return null;
        }

        const board = context.boardName || context.fqbn;
        this.post({ command: 'working', text: t('compile.running', board) });
        let result;
        try {
            result = await this.compiler.compile({
                cliPath: context.cliPath,
                configFile: context.configFile,
                fqbn: context.fqbn,
                sketchPath
            });
        } catch (err) {
            this.addEntry('error', t('compile.failed', err.message));
            return null;
        }
        if (result.stopped) {
            this.addEntry('info', t('chat.stopped'));
            return null;
        }
        this.writeOutput(sketchPath, board, context.fqbn, result.output);
        const data = this.describeCompile(result, board);
        this.addEntry('compile', data.compact ? data.line : [data.title, ...data.sizes.map(s => `${s.label}: ${s.text}`),
            data.warning, ...data.errors, data.more, data.hint].filter(Boolean).join('\n'), data);

        // The agent did not see this check, it learns the result with the next message
        if (this.chat) {
            this.chat.checkNotice = data.ok
                ? t('prompt.checkOk', board, data.sizes.map(s => `${s.label} ${s.text}`).join(', '))
                : t('prompt.checkFailed', board, [...data.errors, data.more].filter(Boolean).join('\n'));
            chatStore.saveChat(sketchPath, this.chat);
        }
        return data;
    }

    /**
     * Write the compiler output to the "Agentuino" channel of the output panel
     * @param {string} sketchPath - Sketch folder
     * @param {string} board - Board name
     * @param {string} fqbn - FQBN
     * @param {string} output - Compiler output
     */
    writeOutput(sketchPath, board, fqbn, output) {
        const t = this.deps.getT();
        if (!ChatPanel.output) ChatPanel.output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
        const time = new Date().toLocaleTimeString(this.deps.getLocale());
        ChatPanel.output.appendLine(t('compile.outputHeader', path.basename(sketchPath), board, fqbn, time));
        ChatPanel.output.appendLine(output || '');
        ChatPanel.output.appendLine('');
        ChatPanel.output.show(true);
    }

    /**
     * Texts for a compile result, stored with the chat entry
     * @param {Object} result - Result from CompileChecker
     * @param {string} board - Board name
     * @returns {Object} {ok, title, sizes, warning, errors, more, errorText}
     */
    describeCompile(result, board) {
        const t = this.deps.getT();
        const size = (label, section) => section && {
            label,
            percent: section.percent,
            text: section.percent === null
                ? t('compile.sizeNoMax', section.used)
                : t('compile.size', section.percent, section.used, section.max)
        };
        if (result.ok) {
            const sizes = [size(t('compile.flash'), result.flash), size(t('compile.ram'), result.ram)].filter(Boolean);
            const short = sizes.map(s => s.percent === null ? `${s.label} ${s.text}` : t('compile.sizeShort', s.label, s.percent));
            return {
                ok: true,
                // Without a warning a single activity line is enough, details are in the output panel
                compact: !result.ramWarning,
                line: [t('compile.ok', board), ...short].join(' · '),
                title: t('compile.ok', board),
                sizes,
                warning: result.ramWarning ? t('compile.ramWarning') : '',
                errors: []
            };
        }
        const missing = result.missingLibraries;
        return {
            ok: false,
            title: t('compile.error', board),
            sizes: [],
            errors: result.errors,
            more: result.moreErrors > 0 ? t('compile.moreErrors', result.moreErrors) : '',
            hint: missing ? t(missing.length > 1 ? 'compile.missingLibraries' : 'compile.missingLibrary', missing.join(', ')) : '',
            missingLibraries: missing,
            fixable: !missing,
            errorText: result.errorText
        };
    }

    /**
     * Let the agent fix the errors of a failed compile check
     * @param {number} time - Time of the compile entry
     */
    /**
     * Repair prompt; with "Upload automatically" the agent uploads once the code compiles
     * @param {string} sketchPath - Sketch folder
     * @param {string} errorText - Compiler errors
     * @returns {string} Prompt
     */
    fixPrompt(sketchPath, errorText) {
        const autoUpload = ruleBlocks.isAutoUpload(projectManager.readConfig(sketchPath));
        return this.deps.getT()(autoUpload ? 'prompt.fixErrorsAutoUpload' : 'prompt.fixErrors', errorText);
    }

    async fixErrors(time) {
        const t = this.deps.getT();
        const entry = this.chat?.messages.find(m => m.time === time && m.role === 'compile');
        if (!entry || !entry.data || entry.data.ok) return;
        await this.send(t('compile.fixRequest'), this.fixPrompt(this.sketchPath, entry.data.errorText || entry.data.errors.join('\n')));
    }

    /**
     * Reset the sketch to the state before the last agent run
     */
    async restore() {
        const t = this.deps.getT();
        if (this.working || !this.sketchPath) return;
        const plan = backupManager.planRestore(this.sketchPath);
        if (!plan) return;
        // The task the reset goes back to is not necessarily the last one
        const snapshot = backupManager.getSnapshot(this.sketchPath);
        const task = this.chat?.messages.find(m => m.role === 'user' && m.time === snapshot?.messageTime);

        if (plan.restore.length === 0 && plan.remove.length === 0) {
            backupManager.deleteSnapshot(this.sketchPath);
            this.postSnapshot();
            this.addEntry('info', t('chat.restoreNothing'));
            return;
        }

        const all = [...plan.restore, ...plan.remove];
        const files = all.slice(0, MAX_LISTED_FILES).join(', ') + (all.length > MAX_LISTED_FILES ? ', …' : '');
        const question = t('chat.restoreConfirm', plan.restore.length, plan.remove.length, files);
        const answer = await vscode.window.showWarningMessage(question, { modal: true }, t('chat.restore'));
        if (answer !== t('chat.restore')) return;

        await vscode.workspace.saveAll(false);
        backupManager.restoreSnapshot(this.sketchPath);
        this.postSnapshot();
        this.addEntry('info', t('chat.restored'));

        // The agent must know, otherwise it assumes its changes still exist
        if (this.chat) {
            this.chat.pendingNotice = t('prompt.restored', task ? shorten(task.text) : '');
            chatStore.saveChat(this.sketchPath, this.chat);
        }
    }

    /**
     * Pick files and attach them to the next message
     */
    async attachFiles() {
        const uris = await this.pickFiles();
        if (!uris) return;
        const sketchPath = await this.prepareProject();
        for (const uri of uris) {
            const rel = projectManager.addAttachment(sketchPath, uri.fsPath);
            this.pendingAttachments.push({ name: path.basename(uri.fsPath), rel });
        }
        this.post({ command: 'attachments', list: this.pendingAttachments.map(a => a.name) });
    }

    /**
     * Pick files and add them permanently to the project knowledge
     */
    async addKnowledge() {
        const uris = await this.pickFiles();
        if (!uris) return;
        const sketchPath = await this.prepareProject();
        const t = this.deps.getT();
        for (const uri of uris) {
            const rel = projectManager.addKnowledgeFile(sketchPath, uri.fsPath);
            this.post({ command: 'entry', role: 'info', text: t('chat.knowledgeAdded', rel) });
        }
    }

    /**
     * Show a file dialog
     * @returns {Promise<vscode.Uri[]|undefined>} Selected files
     */
    pickFiles() {
        return vscode.window.showOpenDialog({
            canSelectMany: true,
            canSelectFiles: true,
            canSelectFolders: false,
            openLabel: this.deps.getT()('chat.selectFiles')
        });
    }

    // ===== ERRORS =====

    /**
     * Turn an error into a localized message
     * @param {Error} err - Error
     * @returns {string} Message
     */
    describeError(err) {
        const t = this.deps.getT();
        switch (err.code) {
            case 'NOT_A_SKETCH': return t('errors.notASketch');
            case 'CONFIG_INVALID': return t('errors.configInvalid', err.message);
            case 'FILE_NOT_FOUND': return t('errors.fileNotFound', err.message);
            case 'AGENT_NOT_FOUND': {
                const adapter = err.adapter;
                return adapter
                    ? t('errors.agentNotFound', adapter.name, adapter.installUrl, `agentuino.${adapter.pathSetting}`)
                    : t('errors.agentUnknown', err.agentId || '?');
            }
            case 'NO_AGENT': return t('errors.noAgent');
            case 'TIMEOUT': return t('errors.timeout', err.minutes);
            case 'BUSY': return t('errors.busy');
            case 'PROCESS_FAILED':
                return t('errors.processFailed', err.adapter?.name || t('errors.anAgent'), err.exitCode ?? '?', err.message);
            case 'AGENT_TOO_OLD':
                return t('errors.agentTooOld', err.adapter.name, err.version || '?',
                    err.adapter.minVersion, err.adapter.updateHint);
            default: return t('errors.unknown', err.message);
        }
    }

    // ===== HTML =====

    /**
     * Build the webview HTML
     * @param {string} mediaDir - Media folder
     * @returns {string} HTML
     */
    getHtml(mediaDir) {
        const webview = this.panel.webview;
        const nonce = crypto.randomBytes(NONCE_BYTES).toString('hex');
        const cssUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaDir, 'chat.css')));
        const jsUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaDir, 'chat.js')));
        const csp = [
            "default-src 'none'",
            `style-src ${webview.cspSource}`,
            `img-src ${webview.cspSource} data:`,
            `script-src 'nonce-${nonce}'`
        ].join('; ');

        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${cssUri}">
</head>
<body>
    <header>
        <div class="topline">
            <div class="chat-select">
                <button id="chatTitle" class="title-btn"></button>
                <div id="chatList" class="dropdown" hidden></div>
            </div>
            <button id="newChat" class="secondary"></button>
            <button id="settings" class="icon-btn">⚙</button>
        </div>
        <div class="subline">
            <span id="sketch"></span>
            <button id="agentBtn" class="link-btn"></button>
            <span class="spacer"></span>
            <span id="cost"></span>
        </div>
    </header>
    <main id="messages"></main>
    <div id="working" hidden><span class="spinner"></span><span id="workingText"></span></div>
    <footer>
        <div id="attachments"></div>
        <textarea id="input" rows="3"></textarea>
        <div class="buttons">
            <button id="attach" class="secondary"></button>
            <span class="spacer"></span>
            <button id="stop" class="danger" hidden></button>
            <button id="send"></button>
        </div>
    </footer>
    <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
    }
}

ChatPanel.current = null;

module.exports = { ChatPanel };
