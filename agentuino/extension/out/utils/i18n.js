/*
 * Agentuino - Localization Module
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Pure Node.js (no vscode dependency). Every locale is merged on top of
 * English, so missing keys fall back to English instead of showing raw keys.
 */

"use strict";

const fs = require('fs');
const path = require('path');

// ===== CONSTANTS =====

const LOCALES_DIR = path.join(__dirname, '..', '..', 'locales');
const FALLBACK_LOCALE = 'en';
const LOCALE_CODE_LENGTH = 2;
const AUTO = 'auto';

const cache = new Map();

// ===== HELPERS =====

/**
 * Check whether a value is a plain object (not an array)
 * @param {*} value - Value to check
 * @returns {boolean} True for plain objects
 */
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep merge two locale objects, overlay wins
 * @param {Object} base - Base object (English)
 * @param {Object} overlay - Overlay object (selected locale)
 * @returns {Object} Merged object
 */
function deepMerge(base, overlay) {
    const result = { ...base };
    for (const [key, value] of Object.entries(overlay || {})) {
        result[key] = isPlainObject(value) && isPlainObject(base[key])
            ? deepMerge(base[key], value)
            : value;
    }
    return result;
}

/**
 * Read a locale file
 * @param {string} code - Locale code
 * @returns {Object} Parsed locale or empty object
 */
function readLocaleFile(code) {
    const file = path.join(LOCALES_DIR, `${code}.json`);
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ===== PUBLIC API =====

/**
 * Get all available locale codes (English first)
 * @returns {string[]} Locale codes
 */
function getAvailableLocales() {
    if (!fs.existsSync(LOCALES_DIR)) return [FALLBACK_LOCALE];
    const codes = fs.readdirSync(LOCALES_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -'.json'.length));
    return [FALLBACK_LOCALE, ...codes.filter(c => c !== FALLBACK_LOCALE).sort()];
}

/**
 * Resolve the effective locale from the user setting and the IDE language
 * @param {string} setting - 'auto' or a locale code
 * @param {string} ideLanguage - IDE language (e.g. 'de', 'en-US')
 * @returns {string} Available locale code
 */
function resolveLocale(setting, ideLanguage) {
    const available = getAvailableLocales();
    const wanted = (!setting || setting === AUTO)
        ? (ideLanguage || FALLBACK_LOCALE).substring(0, LOCALE_CODE_LENGTH).toLowerCase()
        : setting;
    return available.includes(wanted) ? wanted : FALLBACK_LOCALE;
}

/**
 * Load a locale merged on top of English (cached)
 * @param {string} code - Locale code
 * @returns {Object} Locale strings
 */
function loadLocale(code) {
    const key = code || FALLBACK_LOCALE;
    if (!cache.has(key)) {
        const base = readLocaleFile(FALLBACK_LOCALE);
        cache.set(key, key === FALLBACK_LOCALE ? base : deepMerge(base, readLocaleFile(key)));
    }
    return cache.get(key);
}

/**
 * Replace {0}, {1}, ... placeholders
 * @param {string} text - Text with placeholders
 * @param {Array} args - Replacement values
 * @returns {string} Formatted text
 */
function format(text, args) {
    if (typeof text !== 'string' || args.length === 0) return text;
    return text.replace(/\{(\d+)\}/g, (match, index) => {
        const value = args[Number(index)];
        return value === undefined || value === null ? match : String(value);
    });
}

/**
 * Look up a dotted key in a strings object
 * @param {Object} strings - Locale strings
 * @param {string} key - Dotted key (e.g. 'chat.send')
 * @returns {*} Value or undefined
 */
function lookup(strings, key) {
    return key.split('.').reduce((node, part) => (isPlainObject(node) ? node[part] : undefined), strings);
}

/**
 * Create a translation function for a locale
 * @param {string} code - Locale code
 * @returns {Function} t(key, ...args); returns the key if not found
 */
function createTranslator(code) {
    const strings = loadLocale(code);
    const t = (key, ...args) => {
        const value = lookup(strings, key);
        return value === undefined ? key : format(value, args);
    };
    t.locale = code;
    t.strings = strings;
    return t;
}

module.exports = {
    AUTO,
    FALLBACK_LOCALE,
    getAvailableLocales,
    resolveLocale,
    loadLocale,
    createTranslator,
    format
};
