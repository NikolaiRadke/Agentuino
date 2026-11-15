/*
 * Agentuino tests - a minimal Arduino IDE: the part of the VS Code API the
 * extension uses, with a webview that records what the chat shows.
 */

"use strict";

const Module = require('module');
const path = require('path');
const env = require('./env');

const DEFAULT_SETTINGS = {
    language: 'en',
    agent: 'claudecode',
    permissionMode: 'bypassPermissions',
    compileCheck: true,
    checkForUpdates: false,
    claudePath: env.fake('claude'),
    codexPath: env.fake('codex'),
    vibePath: env.fake('vibe'),
    antigravityPath: env.fake('agy'),
    opencodePath: env.fake('opencode'),
    arduinoCliPath: env.fake('arduino-cli')
};

/**
 * Start the extension in a fake IDE
 * @param {Object} overrides - Settings
 * @returns {Object} IDE with chat helpers
 */
function startIde(overrides = {}) {
    const settings = { ...DEFAULT_SETTINGS, ...overrides };
    const posted = [];
    const output = [];
    const commands = {};
    const listeners = { editor: [] };

    const ide = {
        settings,
        posted,
        output,
        handler: null,
        // URLs given to openExternal
        opened: [],
        // Answer of modal questions: (message, ...buttons) => button
        answerWarning: (message, options, ...buttons) => buttons[0],
        answerQuickPick: items => items[0],

        vscode: {
            version: '1.96.0',
            ViewColumn: { One: 1, Two: 2 },
            StatusBarAlignment: { Left: 1, Right: 2 },
            ConfigurationTarget: { Global: 1 },
            Uri: { file: p => ({ fsPath: p, scheme: 'file' }), parse: url => ({ url }) },
            env: {
                language: 'en',
                appName: 'Arduino IDE',
                appRoot: path.join(env.TMP, 'no-ide'),
                clipboard: { writeText: async () => {}, readText: async () => '' },
                openExternal: async uri => { ide.opened.push(uri.url); return true; }
            },
            window: {
                activeTextEditor: null,
                createWebviewPanel: () => ({
                    webview: {
                        asWebviewUri: uri => uri,
                        cspSource: 'test',
                        set html(value) { /* not rendered */ },
                        onDidReceiveMessage: handler => { ide.handler = handler; return { dispose() {} }; },
                        postMessage: message => { posted.push(message); return Promise.resolve(true); }
                    },
                    onDidDispose: () => ({ dispose() {} }),
                    onDidChangeViewState: () => ({ dispose() {} }),
                    reveal() {},
                    set title(value) { /* ignored */ },
                    set iconPath(value) { /* ignored */ }
                }),
                createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
                createOutputChannel: () => ({ appendLine: line => output.push(line), show() {}, dispose() {} }),
                showQuickPick: async items => ide.answerQuickPick(items),
                showWarningMessage: async (...args) => ide.answerWarning(...args),
                showErrorMessage: async () => undefined,
                showInformationMessage: async () => undefined,
                showTextDocument: async () => undefined,
                showOpenDialog: async () => undefined,
                setStatusBarMessage: () => ({ dispose() {} }),
                onDidChangeActiveTextEditor: listener => { listeners.editor.push(listener); return { dispose() {} }; }
            },
            workspace: {
                workspaceFolders: [],
                saveAll: async () => true,
                getConfiguration: () => ({
                    get: (key, fallback) => (key in settings ? settings[key] : fallback),
                    update: async (key, value) => { settings[key] = value; }
                }),
                onDidChangeConfiguration: () => ({ dispose() {} })
            },
            commands: {
                registerCommand: (name, callback) => { commands[name] = callback; return { dispose() {} }; },
                executeCommand: async () => undefined
            }
        },

        /**
         * Make a sketch the active editor and open the chat for it
         * @param {string} sketchPath - Sketch folder
         */
        async openChat(sketchPath) {
            ide.vscode.window.activeTextEditor = {
                document: { uri: ide.vscode.Uri.file(path.join(sketchPath, `${path.basename(sketchPath)}.ino`)) }
            };
            listeners.editor.forEach(listener => listener());
            await commands['agentuino.openChat']();
            await ide.handler({ command: 'ready' });
        },

        /**
         * Send a webview message and return the chat entries it caused
         * @param {Object} message - e.g. {command: 'send', text}
         * @returns {Promise<Object[]>} Entries {role, text, data}
         */
        async message(message) {
            const start = posted.length;
            await ide.handler(message);
            return posted.slice(start).filter(m => m.command === 'entry');
        },

        send(text) {
            return ide.message({ command: 'send', text });
        },

        runCommand(name) {
            return commands[name]();
        },

        stop() {
            extension.deactivate();
        }
    };

    const load = Module._load;
    Module._load = function (request, ...rest) {
        return request === 'vscode' ? ide.vscode : load.call(this, request, ...rest);
    };
    const extension = env.ext('out/extension.js');
    extension.activate({ extensionPath: env.EXTENSION, subscriptions: [] });
    return ide;
}

module.exports = { startIde };
