/*
 * Agentuino - About Panel
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Separate page in the code column, modeled on AI.duino's about panel:
 * logo, quick start, agents, technical details for bug reports, license,
 * credits and support links. Links open via the extension, because link
 * clicks inside webviews are not reliable in the Arduino IDE.
 */

"use strict";

const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const links = require('../utils/links');

// ===== CONSTANTS =====

const VIEW_TYPE = 'agentuino.about';
const NONCE_BYTES = 16;
const COPIED_MESSAGE_MS = 2000;

/**
 * Escape HTML special characters
 * @param {*} text - Text
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

class AboutPanel {
    /**
     * Show the about page (create or refresh)
     * @param {Object} deps - {extensionPath, t}
     * @param {Object} info - Collected information (see extension.js collectAboutInfo)
     */
    static show(deps, info) {
        if (!AboutPanel.current) AboutPanel.current = new AboutPanel(deps);
        AboutPanel.current.deps = deps;
        AboutPanel.current.render(info);
        AboutPanel.current.panel.reveal(vscode.ViewColumn.One);
    }

    /**
     * @param {Object} deps - {extensionPath, t}
     */
    constructor(deps) {
        this.deps = deps;
        this.copyText = '';
        this.iconsDir = path.join(deps.extensionPath, 'icons');
        this.mediaDir = path.join(deps.extensionPath, 'media');

        this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, deps.t('about.pageTitle'), vscode.ViewColumn.One, {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(this.iconsDir), vscode.Uri.file(this.mediaDir)]
        });
        this.panel.iconPath = vscode.Uri.file(path.join(this.iconsDir, 'agentuino.png'));

        this.panel.webview.onDidReceiveMessage(async msg => {
            if (msg.command === 'openUrl' && links.isWebUrl(msg.url)) {
                await vscode.env.openExternal(vscode.Uri.parse(msg.url));
            } else if (msg.command === 'copy') {
                await vscode.env.clipboard.writeText(this.copyText);
                vscode.window.setStatusBarMessage(this.deps.t('chat.copied'), COPIED_MESSAGE_MS);
            }
        });
        this.panel.onDidDispose(() => { AboutPanel.current = null; });
    }

    /**
     * Render the page
     * @param {Object} info - {version, agents, details, copyText, links}
     */
    render(info) {
        const t = this.deps.t;
        const webview = this.panel.webview;
        const nonce = crypto.randomBytes(NONCE_BYTES).toString('hex');
        const logoUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.iconsDir, 'agentuino-256.png')));
        const cssUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.mediaDir, 'about.css')));
        const jsUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.mediaDir, 'about.js')));
        const csp = [
            "default-src 'none'",
            `style-src ${webview.cspSource}`,
            `img-src ${webview.cspSource} data:`,
            `script-src 'nonce-${nonce}'`
        ].join('; ');

        this.copyText = info.copyText;
        this.panel.title = t('about.pageTitle');

        const statusText = {
            ok: (agent) => `✓ ${t('agent.installed')} ${agent.version ? `(${escapeHtml(agent.version)})` : ''}`,
            missing: () => `✗ ${t('agent.notInstalled')}`,
            tooOld: (agent) => `⚠ ${t('agent.tooOld', escapeHtml(agent.version || '?'), escapeHtml(agent.minVersion))}`
        };
        const agentRows = info.agents.map(agent => `
            <div class="agent-row">
                <div class="agent-name">${escapeHtml(agent.name)}${agent.experimental
                    ? ` <span class="badge">${escapeHtml(t('agent.experimental'))}</span>` : ''}</div>
                <div class="agent-status status-${agent.status}">${statusText[agent.status](agent)}</div>
                <button class="link" data-url="${escapeHtml(agent.url)}">${escapeHtml(t('setup.guide'))}</button>
            </div>`).join('');
        const detailRows = info.details.map(([key, value]) => `
            <span class="key">${escapeHtml(key)}</span><span class="value">${escapeHtml(value)}</span>`).join('');

        webview.html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${cssUri}">
</head>
<body>
    <div class="page">
        <img class="logo" src="${logoUri}" width="96" height="96" alt="Agentuino Logo">
        <h1>Agentuino</h1>
        <div class="version">Version ${escapeHtml(info.version)}</div>
        <p class="tagline"><strong>${escapeHtml(t('about.subtitle'))}</strong></p>

        <div class="box">
            <h3>${escapeHtml(t('about.quickstart'))}</h3>
            <p>1. ${escapeHtml(t('about.step1'))} <span class="shortcut">Ctrl+Alt+A</span></p>
            <p>2. ${escapeHtml(t('about.step2'))}</p>
            <p>3. ${escapeHtml(t('about.step3'))}</p>
        </div>

        <div class="box">
            <h3>${escapeHtml(t('about.agents'))}</h3>
            <p class="hint">${escapeHtml(t('about.agentSetting'))}: ${escapeHtml(info.agentSetting)}</p>
            ${agentRows}
        </div>

        <div class="box">
            <h3>${escapeHtml(t('about.details'))}</h3>
            <div class="details">${detailRows}</div>
            <button class="secondary" id="copy">📋 ${escapeHtml(t('about.copy'))}</button>
        </div>

        <div class="license">
            <strong>${escapeHtml(t('about.license'))}:</strong> Apache License 2.0<br>
            Copyright © 2026 Monster Maker
        </div>

        <div class="credits">
            <p><strong>${escapeHtml(t('about.publisher'))}:</strong> Monster Maker</p>
            <p><strong>${escapeHtml(t('about.repository'))}:</strong>
                <button class="link" data-url="${escapeHtml(info.links.repo)}">GitHub</button></p>
            <p><strong>${escapeHtml(t('about.reportBugs'))}:</strong>
                <button class="link" data-url="${escapeHtml(info.links.issues)}">Issue Tracker</button></p>
        </div>

        <div class="box support">
            <h3>${escapeHtml(t('support.title'))}</h3>
            <p>${escapeHtml(t('support.description'))}</p>
            <div class="support-buttons">
                <button class="support kofi" data-url="${escapeHtml(info.links.kofi)}">${escapeHtml(t('support.coffee'))}</button>
                <button class="support sponsor" data-url="${escapeHtml(info.links.sponsors)}">${escapeHtml(t('support.sponsor'))}</button>
            </div>
        </div>
    </div>
    <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
    }
}

AboutPanel.current = null;

module.exports = { AboutPanel };
