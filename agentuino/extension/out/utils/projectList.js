/*
 * Agentuino - Project List
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Finds the sketches in the sketchbook that are Agentuino projects, for the
 * project list of the chat. Sketches may lie in subfolders (e.g. a project
 * with several variants), so the search goes a few levels deep. Pure Node.js.
 */

"use strict";

const fs = require('fs');
const path = require('path');

const projectManager = require('./projectManager');

// ===== CONSTANTS =====

const MAX_DEPTH = 4;
// Upper limit of folders looked at, so a huge sketchbook cannot block the IDE
const MAX_FOLDERS = 5000;
// Folders of the sketchbook that never hold sketches
const SKIP_FOLDERS = new Set(['libraries', 'hardware', 'tools', 'node_modules', 'build', projectManager.PROJECT_DIR_NAME]);

// ===== PUBLIC API =====

/**
 * List the Agentuino projects of a sketchbook, last used first
 * @param {string} sketchbook - Sketchbook folder
 * @returns {Array<{name: string, path: string, rel: string, chats: number, updated: number}>} Projects
 */
function listProjects(sketchbook) {
    const projects = [];
    let visited = 0;

    const walk = (dir, depth) => {
        if (depth > MAX_DEPTH || visited >= MAX_FOLDERS) return;
        visited++;
        if (projectManager.isSketchFolder(dir) && projectManager.isProject(dir)) {
            const chats = projectManager.listChatSummaries(dir);
            projects.push({
                name: path.basename(dir),
                path: dir,
                rel: path.relative(sketchbook, dir).split(path.sep).join('/'),
                chats: chats.length,
                updated: chats[0]?.updated || 0
            });
        }
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_FOLDERS.has(entry.name)) continue;
            walk(path.join(dir, entry.name), depth + 1);
        }
    };

    if (sketchbook && fs.existsSync(sketchbook)) walk(sketchbook, 0);
    return projects.sort((a, b) => b.updated - a.updated || a.name.localeCompare(b.name));
}

module.exports = { listProjects };
