/*
 * Agentuino - Chat Store Module
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Every chat of a sketch is stored in agentuino/chats/ as two files:
 *   <id>.json  data for the UI: agent, session, cost, messages
 *   <id>.md    readable protocol; agents search it with Grep to look up
 *              earlier conversations (like past-chat search in Claude)
 * Pure Node.js (no vscode dependency).
 */

"use strict";

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const i18n = require('../utils/i18n');
const projectManager = require('../utils/projectManager');
const registry = require('../agents/registry');

// ===== CONSTANTS =====

const DATA_EXT = '.json';
const PROTOCOL_EXT = '.md';
const JSON_INDENT = 2;
const ID_RANDOM_BYTES = 2;
const MAX_PROVISIONAL_TITLE = 50;
const ACTIVITY_PREFIX = '› ';

// ===== HELPERS =====

/**
 * Pad a number to two digits
 * @param {number} n - Number
 * @returns {string} Padded number
 */
function pad(n) {
    return String(n).padStart(2, '0');
}

/**
 * Create a sortable, readable chat ID (local time + random suffix)
 * @param {Date} date - Creation date
 * @returns {string} ID like 2026-11-12_1243_a3f9
 */
function createChatId(date) {
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const time = `${pad(date.getHours())}${pad(date.getMinutes())}`;
    return `${day}_${time}_${crypto.randomBytes(ID_RANDOM_BYTES).toString('hex')}`;
}

/**
 * Build a provisional title from the first message
 * @param {string} text - First user message
 * @returns {string} Title
 */
function provisionalTitle(text) {
    const firstLine = String(text).trim().split('\n')[0];
    const firstSentence = firstLine.split(/(?<=[.!?])\s/)[0];
    return firstSentence.length > MAX_PROVISIONAL_TITLE
        ? firstSentence.slice(0, MAX_PROVISIONAL_TITLE - 1).trimEnd() + '…'
        : firstSentence;
}

/**
 * Write a file atomically
 * @param {string} file - Target path
 * @param {string} content - Content
 */
function writeAtomic(file, content) {
    const tempFile = file + '.tmp';
    fs.writeFileSync(tempFile, content, 'utf8');
    fs.renameSync(tempFile, file);
}

/**
 * Get both file paths of a chat
 * @param {string} sketchPath - Sketch folder
 * @param {string} id - Chat ID
 * @returns {{data: string, protocol: string}} Paths
 */
function getChatFiles(sketchPath, id) {
    const dir = projectManager.getProjectPaths(sketchPath).chats;
    return {
        data: path.join(dir, id + DATA_EXT),
        protocol: path.join(dir, id + PROTOCOL_EXT)
    };
}

// ===== PROTOCOL =====

/**
 * Render the readable Markdown protocol of a chat
 * @param {Object} chat - Chat object
 * @param {Function} t - Translator (project language)
 * @returns {string} Markdown
 */
function renderProtocol(chat, t) {
    const created = new Date(chat.created);
    const date = `${pad(created.getDate())}.${pad(created.getMonth() + 1)}.${created.getFullYear()}`
        + ` ${pad(created.getHours())}:${pad(created.getMinutes())}`;
    const lines = [`# ${chat.title}`, `${date} · ${registry.getName(chat.agent)}`];
    let section = null;

    for (const message of chat.messages) {
        if (message.role === 'user') {
            lines.push('', `## ${t('chat.you')}`, message.text);
            section = 'user';
        } else if (message.role === 'agent' || message.role === 'activity') {
            if (section !== 'agent') lines.push('', `## ${t('chat.agent')}`);
            lines.push(message.role === 'activity' ? ACTIVITY_PREFIX + message.text : message.text);
            section = 'agent';
        }
        // info and error entries are UI notes, not part of the conversation
    }
    return lines.join('\n') + '\n';
}

// ===== PUBLIC API =====

/**
 * Save a chat (data and protocol)
 * @param {string} sketchPath - Sketch folder
 * @param {Object} chat - Chat object
 */
function saveChat(sketchPath, chat) {
    const files = getChatFiles(sketchPath, chat.id);
    fs.mkdirSync(path.dirname(files.data), { recursive: true });
    const language = projectManager.readConfig(sketchPath).language || i18n.FALLBACK_LOCALE;
    writeAtomic(files.data, JSON.stringify(chat, null, JSON_INDENT) + '\n');
    writeAtomic(files.protocol, renderProtocol(chat, i18n.createTranslator(language)));
}

/**
 * Create and save a new chat
 * @param {string} sketchPath - Sketch folder
 * @param {string} agentId - Agent identifier (e.g. 'claudecode')
 * @param {string} firstText - First user message (for the provisional title)
 * @returns {Object} Chat object
 */
function createChat(sketchPath, agentId, firstText) {
    const now = new Date();
    const chat = {
        id: createChatId(now),
        title: provisionalTitle(firstText),
        titleFinal: false,
        created: now.getTime(),
        updated: now.getTime(),
        agent: agentId,
        sessionId: null,
        costUsd: null,
        messages: []
    };
    saveChat(sketchPath, chat);
    return chat;
}

/**
 * Load a chat
 * @param {string} sketchPath - Sketch folder
 * @param {string} id - Chat ID
 * @returns {Object|null} Chat object or null
 */
function loadChat(sketchPath, id) {
    if (!id) return null;
    try {
        return JSON.parse(fs.readFileSync(getChatFiles(sketchPath, id).data, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Append a message and save
 * @param {string} sketchPath - Sketch folder
 * @param {Object} chat - Chat object (modified)
 * @param {string} role - 'user' | 'agent' | 'activity' | 'info' | 'error' | 'compile'
 * @param {string} text - Message text
 * @param {number} time - Timestamp (also identifies the message in the UI)
 * @param {Object} [data] - Extra data (compile result)
 */
function appendMessage(sketchPath, chat, role, text, time = Date.now(), data = undefined) {
    chat.messages.push(data ? { role, text, time, data } : { role, text, time });
    chat.updated = time;
    saveChat(sketchPath, chat);
}

/**
 * Delete a chat (both files)
 * @param {string} sketchPath - Sketch folder
 * @param {string} id - Chat ID
 */
function deleteChat(sketchPath, id) {
    const files = getChatFiles(sketchPath, id);
    for (const file of [files.data, files.protocol]) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
    }
}

module.exports = {
    createChat,
    loadChat,
    saveChat,
    appendMessage,
    deleteChat,
    listChats: projectManager.listChatSummaries
};
