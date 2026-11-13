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

const links = require('./links');
const { fetchJson } = require('./remoteFile');
const { compareVersions } = require('../agents/agentUtils');

/**
 * Get a newer version if there is one that was not skipped
 * @param {string} currentVersion - Installed version
 * @param {string} skippedVersion - Version the user chose to skip
 * @returns {Promise<string|null>} Newer version or null
 */
async function findUpdate(currentVersion, skippedVersion) {
    const latest = (await fetchJson(links.RAW_PACKAGE_PATH))?.version || null;
    if (!latest || latest === skippedVersion) return null;
    return compareVersions(latest, currentVersion) > 0 ? latest : null;
}

module.exports = { findUpdate };
