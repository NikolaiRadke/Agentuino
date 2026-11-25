/*
 * Agentuino - Changes View
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Opens the diff editor of the IDE: a code file before the last task
 * (from the snapshot) against its current state. The old side comes from
 * a read-only document, so the snapshot cannot be edited by accident.
 */

"use strict";

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const backupManager = require('../utils/backupManager');

// ===== CONSTANTS =====

const SCHEME = 'agentuino-before';
// Query of the empty side for added or deleted files
const EMPTY = 'empty';

// ===== PROVIDER =====

/**
 * Read-only content of the old side
 */
const provider = {
    provideTextDocumentContent(uri) {
        if (uri.query === EMPTY) return '';
        try {
            const { sketch } = JSON.parse(uri.query);
            const file = backupManager.getSnapshotFile(sketch, uri.path.slice(1));
            return file ? fs.readFileSync(file, 'utf8') : '';
        } catch {
            return '';
        }
    }
};

/**
 * Register the document provider for the old side
 * @returns {vscode.Disposable} Registration
 */
function register() {
    return vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider);
}

// ===== PUBLIC API =====

/**
 * Show one change in the diff editor
 * @param {string} sketchPath - Sketch folder
 * @param {{rel: string, kind: string}} change - Entry from backupManager.listChanges()
 * @param {string} title - Editor title
 */
async function showChange(sketchPath, change, title) {
    const snapshot = backupManager.getSnapshot(sketchPath);
    if (!snapshot) return;
    // The path keeps the file name, so the editor picks the right highlighting
    const empty = vscode.Uri.from({ scheme: SCHEME, path: `/${change.rel}`, query: EMPTY });
    // The creation time keeps an older snapshot of the same file out of the editor's cache
    const before = change.kind === 'added'
        ? empty
        : vscode.Uri.from({
            scheme: SCHEME,
            path: `/${change.rel}`,
            query: JSON.stringify({ sketch: sketchPath, created: snapshot.created })
        });
    const after = change.kind === 'deleted'
        ? empty
        : vscode.Uri.file(path.join(sketchPath, ...change.rel.split('/')));
    await vscode.commands.executeCommand('vscode.diff', before, after, title,
        { preview: true, viewColumn: vscode.ViewColumn.One });
}

module.exports = { register, showChange };
