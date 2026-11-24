/*
 * Agentuino - Project Links
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Placeholders: the repository does not exist yet. All links live here,
 * so they only need to be changed in one place.
 */

"use strict";

const REPO_OWNER = 'NikolaiRadke';
const REPO_NAME = 'Agentuino';
const REPO_BRANCH = 'main';

/**
 * Only web pages may be opened from a webview, no file: or other schemes
 * @param {*} url - URL from a webview message
 * @returns {boolean} True for https URLs
 */
function isWebUrl(url) {
    return typeof url === 'string' && url.startsWith('https://');
}

module.exports = {
    isWebUrl,
    REPO_URL: `https://github.com/${REPO_OWNER}/${REPO_NAME}`,
    RELEASES_URL: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
    ISSUES_URL: `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues`,
    KOFI_URL: 'https://ko-fi.com/nikolairadke',
    SPONSORS_URL: `https://github.com/sponsors/${REPO_OWNER}`,
    RAW_HOST: 'raw.githubusercontent.com',
    // Written by .github/scripts/package.sh, so only a release announces a new version
    RAW_RELEASE_PATH: `/${REPO_OWNER}/${REPO_NAME}/refs/heads/${REPO_BRANCH}/installer/version.json`,
    RAW_AGENT_CONFIG_PATH: `/${REPO_OWNER}/${REPO_NAME}/refs/heads/${REPO_BRANCH}/agentuino/extension/config/agentConfigs.json`
};
