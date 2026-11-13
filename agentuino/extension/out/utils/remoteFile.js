/*
 * Agentuino - Remote File
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Reads a JSON file of the repository from raw.githubusercontent.com.
 * Only parsed, never stored or executed here. Pure Node.js.
 */

"use strict";

const https = require('https');
const links = require('./links');

// ===== CONSTANTS =====

const REQUEST_TIMEOUT_MS = 10000;
const MAX_DOWNLOAD_BYTES = 256 * 1024;
const HTTP_OK = 200;

/**
 * Download and parse a JSON file of the repository
 * @param {string} filePath - Path on raw.githubusercontent.com (see links.js)
 * @returns {Promise<*>} Parsed content, null on any error
 */
function fetchJson(filePath) {
    return new Promise(resolve => {
        const request = https.request({
            hostname: links.RAW_HOST,
            path: filePath,
            headers: { 'User-Agent': 'Agentuino-Extension' },
            timeout: REQUEST_TIMEOUT_MS
        }, response => {
            if (response.statusCode !== HTTP_OK) {
                response.resume();
                resolve(null);
                return;
            }
            let data = '';
            response.on('data', chunk => {
                data += chunk;
                // Far larger than any real file: stop instead of filling memory
                if (data.length > MAX_DOWNLOAD_BYTES) {
                    request.destroy();
                    resolve(null);
                }
            });
            response.on('end', () => {
                try {
                    resolve(JSON.parse(data));
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

module.exports = { fetchJson };
