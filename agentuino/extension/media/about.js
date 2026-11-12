/*
 * Agentuino - About Page Script
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 */

(function () {
    "use strict";

    const vscode = acquireVsCodeApi();

    // Links and the copy button are handled by the extension
    document.addEventListener('click', (event) => {
        const target = event.target.closest('[data-url]');
        if (target) {
            vscode.postMessage({ command: 'openUrl', url: target.dataset.url });
        } else if (event.target.closest('#copy')) {
            vscode.postMessage({ command: 'copy' });
        }
    });
}());
