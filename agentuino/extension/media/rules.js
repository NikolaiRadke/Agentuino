/*
 * Agentuino - Semantic Anchors Page Script
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Renders the blocks from the state the extension sends. All changes go to the
 * extension, which stores them and sends the new state back. Clipboard access
 * goes through the extension, the Arduino IDE blocks it inside webviews.
 */

(function () {
    "use strict";

    const vscode = acquireVsCodeApi();
    const elements = {
        title: document.getElementById('title'),
        subtitle: document.getElementById('subtitle'),
        intro: document.getElementById('intro'),
        groups: document.getElementById('groups'),
        footer: document.getElementById('footer'),
        notice: document.getElementById('notice')
    };

    const NOTICE_MS = 2000;
    let state = null;
    // Key of the custom block being edited, '' for a new one, null when the form is closed
    let editing = null;
    let noticeTimer = null;
    // Which collapsible groups the user opened or closed
    const openGroups = {};

    /**
     * Create an element with class and text
     * @param {string} tag - Tag name
     * @param {string} [className] - CSS class
     * @param {string} [text] - Text content
     * @returns {HTMLElement} Element
     */
    function create(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    /**
     * Rule text with `code` parts in code font (the texts are Markdown for AGENTS.md)
     * @param {string} text - Rule text
     * @returns {HTMLElement} Text element
     */
    function renderRuleText(text) {
        const element = create('div', 'block-text');
        text.split('`').forEach((part, index) => {
            element.appendChild(index % 2 ? create('code', '', part) : document.createTextNode(part));
        });
        return element;
    }

    /**
     * One block with checkbox, label and rule text
     * @param {Object} block - {key, label, text, enabled, custom}
     * @returns {HTMLElement} Row
     */
    function renderBlock(block) {
        const row = create('div', 'block');
        const head = create('label', 'block-head');
        const box = create('input');
        box.type = 'checkbox';
        box.checked = block.enabled;
        box.addEventListener('change', () => vscode.postMessage({ command: 'toggle', key: block.key, enabled: box.checked }));
        head.appendChild(box);
        head.appendChild(create('span', 'block-label', block.label));
        row.appendChild(head);
        row.appendChild(renderRuleText(block.text));

        if (block.custom) {
            const actions = create('div', 'block-actions');
            const edit = create('button', 'link', state.texts.edit);
            edit.addEventListener('click', () => {
                editing = block.key;
                render();
            });
            const remove = create('button', 'link danger', state.texts.delete);
            remove.addEventListener('click', () => vscode.postMessage({ command: 'deleteCustom', key: block.key }));
            actions.appendChild(edit);
            actions.appendChild(remove);
            row.appendChild(actions);
        }
        return row;
    }

    /**
     * Form for a new or an existing custom block
     * @param {Object|null} block - Block being edited or null for a new one
     * @returns {HTMLElement} Form
     */
    function renderForm(block) {
        const form = create('div', 'form');
        const label = create('input', 'field');
        label.placeholder = state.texts.labelField;
        label.maxLength = state.limits.label;
        label.value = block ? block.label : '';
        const text = create('textarea', 'field');
        text.placeholder = state.texts.textField;
        text.maxLength = state.limits.text;
        text.rows = 3;
        text.value = block ? block.text : '';

        const buttons = create('div', 'form-buttons');
        const save = create('button', '', state.texts.save);
        save.addEventListener('click', () => {
            if (!label.value.trim() || !text.value.trim()) {
                showNotice(state.texts.missing, NOTICE_MS);
                return;
            }
            vscode.postMessage({ command: 'saveCustom', key: block ? block.key : null, label: label.value, text: text.value });
            editing = null;
        });
        const cancel = create('button', 'secondary', state.texts.cancel);
        cancel.addEventListener('click', () => {
            editing = null;
            render();
        });
        buttons.appendChild(save);
        buttons.appendChild(cancel);

        form.appendChild(label);
        form.appendChild(text);
        form.appendChild(buttons);
        setTimeout(() => label.focus(), 0);
        return form;
    }

    /**
     * One group as a box; the advanced group can be collapsed
     * @param {Object} group - {id, title, collapsed, blocks}
     * @returns {HTMLElement} Box
     */
    function renderGroup(group) {
        const box = create(group.id === 'pro' ? 'details' : 'div', 'group');
        const title = create(group.id === 'pro' ? 'summary' : 'h3', 'group-title', group.title);
        box.appendChild(title);
        if (group.id === 'pro') {
            box.open = openGroups[group.id] ?? !group.collapsed;
            box.addEventListener('toggle', () => { openGroups[group.id] = box.open; });
        }

        if (group.id === 'custom') {
            box.appendChild(create('p', 'hint', state.texts.customHint));
            if (group.blocks.length === 0 && editing === null) box.appendChild(create('p', 'hint', state.texts.noCustom));
        }
        group.blocks.forEach(block => {
            box.appendChild(editing === block.key ? renderForm(block) : renderBlock(block));
        });

        if (group.id === 'custom') {
            if (editing === '') {
                box.appendChild(renderForm(null));
            } else {
                const add = create('button', 'secondary', state.texts.add);
                add.addEventListener('click', () => {
                    editing = '';
                    render();
                });
                box.appendChild(add);
            }
        }
        return box;
    }

    /**
     * Draw the whole page from the state
     */
    function render() {
        if (!state) return;
        elements.title.textContent = state.texts.title;
        elements.subtitle.textContent = state.subtitle;
        elements.intro.textContent = state.texts.intro;
        elements.groups.replaceChildren(...state.groups.map(renderGroup));

        elements.footer.replaceChildren();
        if (state.sketchMode) {
            const saveDefaults = create('button', 'secondary', state.texts.saveDefaults);
            saveDefaults.addEventListener('click', () => vscode.postMessage({ command: 'saveDefaults' }));
            const applyDefaults = create('button', 'secondary', state.texts.applyDefaults);
            applyDefaults.addEventListener('click', () => vscode.postMessage({ command: 'applyDefaults' }));
            elements.footer.appendChild(saveDefaults);
            elements.footer.appendChild(applyDefaults);
        }
    }

    /**
     * Show a short message at the bottom
     * @param {string} text - Message
     * @param {number} duration - Milliseconds
     */
    function showNotice(text, duration) {
        elements.notice.textContent = text;
        elements.notice.hidden = false;
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => { elements.notice.hidden = true; }, duration);
    }

    /**
     * Insert pasted text into the focused field
     * @param {string} text - Text
     */
    function insertText(text) {
        const field = document.activeElement;
        if (!field || !field.classList.contains('field')) return;
        const start = field.selectionStart;
        const end = field.selectionEnd;
        const value = field.value.slice(0, start) + text + field.value.slice(end);
        field.value = value.slice(0, field.maxLength > 0 ? field.maxLength : value.length);
        field.selectionStart = field.selectionEnd = Math.min(start + text.length, field.value.length);
    }

    // Copy, cut and paste via the extension
    document.addEventListener('keydown', (event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        const key = event.key.toLowerCase();
        const field = event.target.classList?.contains('field') ? event.target : null;
        const selected = field
            ? field.value.slice(field.selectionStart, field.selectionEnd)
            : String(window.getSelection() || '');

        if (key === 'c' && selected) {
            event.preventDefault();
            vscode.postMessage({ command: 'copy', text: selected });
        } else if (key === 'x' && field && selected) {
            event.preventDefault();
            vscode.postMessage({ command: 'copy', text: selected });
            insertText('');
        } else if (key === 'v' && field) {
            event.preventDefault();
            vscode.postMessage({ command: 'requestPaste' });
        }
    });

    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.command) {
            case 'state':
                state = msg;
                render();
                break;
            case 'notice':
                showNotice(msg.text, msg.duration);
                break;
            case 'paste':
                insertText(msg.text);
                break;
            default:
                break;
        }
    });

    vscode.postMessage({ command: 'ready' });
}());
