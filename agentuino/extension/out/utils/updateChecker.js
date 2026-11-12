/*
 * Agentuino - Update Checker
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * The Arduino IDE has no extension marketplace, users install the VSIX by
 * hand. So Agentuino looks up the version in the repository's package.json
 * (same approach as AI.duino). Pure Node.js; network errors are silent.
 */

"use strict";

const https = require('https');
const links = require('./links');

// ===== CONSTANTS =====

const REQUEST_TIMEOUT_MS = 10000;
const HTTP_OK = 200;
const VERSION_PARTS = 3;

/**
 * Check whether a version is newer than another
 * @param {string} latest - Remote version
 * @param {string} current - Installed version
 * @returns {boolean} True if latest is newer
 */
function isNewerVersion(latest, current) {
    if (!latest || !current) return false;
    const l = latest.split('.').map(n => parseInt(n, 10) || 0);
    const c = current.split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < VERSION_PARTS; i++) {
        if ((l[i] || 0) !== (c[i] || 0)) return (l[i] || 0) > (c[i] || 0);
    }
    return false;
}

/**
 * Fetch the latest version from the repository
 * @returns {Promise<string|null>} Version or null on any error
 */
function fetchLatestVersion() {
    return new Promise(resolve => {
        const request = https.request({
            hostname: links.RAW_HOST,
            path: links.RAW_PACKAGE_PATH,
            headers: { 'User-Agent': 'Agentuino-Extension' },
            timeout: REQUEST_TIMEOUT_MS
        }, response => {
            if (response.statusCode !== HTTP_OK) {
                response.resume();
                resolve(null);
                return;
            }
            let data = '';
            response.on('data', chunk => { data += chunk; });
            response.on('end', () => {
                try {
                    resolve(JSON.parse(data).version || null);
                } catch {
                    resolve(null);
                }
            });
        });
        request.on('error', () => resolve(null));
        request.on('timeout', () => {
            request.destroy();
            resolve(null);
        });
        request.end();
    });
}

/**
 * Get a newer version if there is one that was not skipped
 * @param {string} currentVersion - Installed version
 * @param {string} skippedVersion - Version the user chose to skip
 * @returns {Promise<string|null>} Newer version or null
 */
async function findUpdate(currentVersion, skippedVersion) {
    const latest = await fetchLatestVersion();
    if (!latest || latest === skippedVersion) return null;
    return isNewerVersion(latest, currentVersion) ? latest : null;
}

module.exports = { findUpdate, isNewerVersion };
