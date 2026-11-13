/*
 * Agentuino - Semantic Anchors Panel
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Page in the code column to switch semantic anchors on and off for the current
 * sketch, to manage custom blocks and the defaults for new sketches. Without
 * an open sketch the page edits the defaults. Every change rewrites the
 * automatic section of AGENTS.md, so it applies from the next message on.
 */

"use strict";

const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const ruleBlocks = require('../utils/ruleBlocks');
const projectManager = require('../utils/projectManager');

// ===== CONSTANTS =====

const VIEW_TYPE = 'agentuino.rules';
const NONCE_BYTES = 16;
const STATUS_MESSAGE_MS = 2000;
// Collapsed unless one of its blocks is active
const COLLAPSIBLE_GROUP = 'pro';

class RulesPanel {
    /**
     * Show the page for a sketch (or for the defaults when sketchPath is null)
     * @param {Object} deps - {extensionPath, getT, ensureProject}
     * @param {string|null} sketchPath - Sketch folder
     */
    static show(deps, sketchPath) {
        if (!RulesPanel.current) RulesPanel.current = new RulesPanel(deps);
        const panel = RulesPanel.current;
        panel.deps = deps;
        panel.sketchPath = sketchPath;
        panel.panel.title = deps.getT()('rules.pageTitle');
        panel.postState();
        panel.panel.reveal(vscode.ViewColumn.One);
    }

    /**
     * @param {Object} deps - {extensionPath, getT, ensureProject}
     */
    constructor(deps) {
        this.deps = deps;
        this.sketchPath = null;
        const mediaDir = path.join(deps.extensionPath, 'media');
        const iconsDir = path.join(deps.extensionPath, 'icons');

        this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, deps.getT()('rules.pageTitle'), vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(mediaDir)]
        });
        this.panel.iconPath = vscode.Uri.file(path.join(iconsDir, 'agentuino.png'));
        this.panel.webview.html = this.getHtml(mediaDir);

        this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg).catch(err => {
            vscode.window.showErrorMessage(this.deps.getT()('errors.unknown', err.message));
        }));
        this.panel.onDidDispose(() => { RulesPanel.current = null; });
    }

    /**
     * Handle a message from the page
     * @param {Object} msg - Message
     */
    async handleMessage(msg) {
        const t = this.deps.getT();
        switch (msg.command) {
            case 'ready':
                this.postState();
                break;
            case 'toggle':
                await this.setActive(msg.key, msg.enabled === true);
                break;
            case 'saveCustom':
                await this.saveCustom(msg.key || null, msg.label, msg.text);
                break;
            case 'deleteCustom':
                await this.deleteCustom(msg.key);
                break;
            case 'saveDefaults':
                ruleBlocks.setDefaults(this.getActiveKeys());
                this.notify(t('rules.defaultsSaved'));
                break;
            case 'applyDefaults':
                await this.writeSketchRules(ruleBlocks.getDefaults());
                this.notify(t('rules.defaultsApplied'));
                break;
            case 'copy':
                if (msg.text) await vscode.env.clipboard.writeText(msg.text);
                break;
            case 'requestPaste':
                this.panel.webview.postMessage({ command: 'paste', text: await vscode.env.clipboard.readText() });
                break;
            default:
                break;
        }
    }

    // ===== STATE =====

    /**
     * Active blocks: those of the sketch, or the defaults without a sketch or project
     * @returns {string[]} Block keys
     */
    getActiveKeys() {
        if (this.sketchPath && projectManager.isProject(this.sketchPath)) {
            return ruleBlocks.getActiveKeys(projectManager.readConfig(this.sketchPath));
        }
        return ruleBlocks.getDefaults();
    }

    /**
     * Send the complete state to the page
     */
    postState() {
        const t = this.deps.getT();
        const active = new Set(this.getActiveKeys());
        const blocks = ruleBlocks.listBlocks(t).map(block => ({ ...block, enabled: active.has(block.key) }));
        const groups = ruleBlocks.GROUPS.map(id => {
            const members = blocks.filter(block => block.group === id);
            return {
                id,
                title: t(`rules.groups.${id}`),
                collapsed: id === COLLAPSIBLE_GROUP && !members.some(block => block.enabled),
                blocks: members
            };
        });
        this.panel.webview.postMessage({
            command: 'state',
            subtitle: this.sketchPath ? t('rules.forSketch', path.basename(this.sketchPath)) : t('rules.noSketch'),
            sketchMode: Boolean(this.sketchPath),
            groups,
            limits: { label: ruleBlocks.MAX_LABEL_LENGTH, text: ruleBlocks.MAX_TEXT_LENGTH },
            texts: t.strings.rules
        });
    }

    /**
     * Show a short confirmation on the page
     * @param {string} text - Message
     */
    notify(text) {
        this.panel.webview.postMessage({ command: 'notice', text, duration: STATUS_MESSAGE_MS });
    }

    // ===== CHANGES =====

    /**
     * Store the selection of the sketch and rewrite AGENTS.md
     * @param {string[]} keys - Active block keys
     */
    async writeSketchRules(keys) {
        if (!this.sketchPath) {
            ruleBlocks.setDefaults(keys);
        } else {
            // The project folder is created on the first change, like with the first message
            if (!projectManager.isProject(this.sketchPath) && !(await this.deps.ensureProject(this.sketchPath))) return;
            const config = projectManager.readConfig(this.sketchPath);
            config.rules = keys;
            projectManager.writeConfig(this.sketchPath, config);
            projectManager.refreshAutoSection(this.sketchPath);
        }
        this.postState();
    }

    /**
     * Switch one block on or off
     * @param {string} key - Block key
     * @param {boolean} enabled - New state
     */
    async setActive(key, enabled) {
        const keys = this.getActiveKeys().filter(k => k !== key);
        if (enabled) keys.push(key);
        await this.writeSketchRules(keys);
        this.notify(this.deps.getT()('rules.saved'));
    }

    /**
     * Create or change a custom block; a new one is switched on right away
     * @param {string|null} key - Existing key or null
     * @param {string} label - Name
     * @param {string} text - Rule text
     */
    async saveCustom(key, label, text) {
        const t = this.deps.getT();
        let savedKey;
        try {
            savedKey = ruleBlocks.saveCustom(key, label, text);
        } catch {
            this.notify(t('rules.missing'));
            return;
        }
        const keys = this.getActiveKeys();
        if (!key && !keys.includes(savedKey)) keys.push(savedKey);
        await this.writeSketchRules(keys);
        this.notify(t('rules.saved'));
    }

    /**
     * Delete a custom block after asking
     * @param {string} key - Block key
     */
    async deleteCustom(key) {
        const t = this.deps.getT();
        const block = ruleBlocks.listBlocks(t).find(b => b.key === key && b.custom);
        if (!block) return;
        const confirm = t('rules.delete');
        const choice = await vscode.window.showWarningMessage(t('rules.deleteConfirm', block.label), { modal: true }, confirm);
        if (choice !== confirm) return;

        ruleBlocks.deleteCustom(key);
        if (this.sketchPath && projectManager.isProject(this.sketchPath)) {
            projectManager.refreshAutoSection(this.sketchPath);
        }
        this.postState();
    }

    // ===== HTML =====

    /**
     * Static page; the content is rendered by media/rules.js from the state
     * @param {string} mediaDir - Media folder
     * @returns {string} HTML
     */
    getHtml(mediaDir) {
        const webview = this.panel.webview;
        const nonce = crypto.randomBytes(NONCE_BYTES).toString('hex');
        const cssUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaDir, 'rules.css')));
        const jsUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaDir, 'rules.js')));
        const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'`;
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${cssUri}">
</head>
<body>
    <div class="page">
        <h1 id="title"></h1>
        <div id="subtitle" class="subtitle"></div>
        <p id="intro" class="intro"></p>
        <div id="groups"></div>
        <div id="footer" class="footer"></div>
        <div id="notice" class="notice" hidden></div>
    </div>
    <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
    }
}

RulesPanel.current = null;

module.exports = { RulesPanel };
