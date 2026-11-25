/*
 * Agentuino - Chat Webview Script
 * Copyright 2026 Monster Maker
 *
 * Licensed under the Apache License, Version 2.0
 *
 * Clipboard access is routed through the extension (vscode.env.clipboard),
 * because the webview cannot reach the clipboard inside the Arduino IDE.
 */

(function () {
    "use strict";

    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);

    const CODE_BLOCK_PATTERN = /```[\w+-]*\n?([\s\S]*?)```/g;
    const HISTORY_SIZE = 5;
    const PERCENT_MAX = 100;
    // Same limit as the IDE's low memory warning
    const BAR_WARNING_PERCENT = 75;
    // More suggestions than this are cut, typing narrows them down
    const MAX_SUGGESTIONS = 100;
    // Closer to the end than this counts as "at the end", so new entries scroll along
    const SCROLL_SLACK_PX = 40;
    const SECOND_MS = 1000;
    const SECONDS_PER_MINUTE = 60;

    const elements = {
        messages: $('messages'),
        input: $('input'),
        send: $('send'),
        stop: $('stop'),
        attach: $('attach'),
        newChat: $('newChat'),
        settings: $('settings'),
        chatTitle: $('chatTitle'),
        chatList: $('chatList'),
        sketch: $('sketch'),
        agentBtn: $('agentBtn'),
        cost: $('cost'),
        working: $('working'),
        workingText: $('workingText'),
        workingTime: $('workingTime'),
        scrollDown: $('scrollDown'),
        attachments: $('attachments'),
        modelChoice: $('modelChoice'),
        model: $('model'),
        modelList: $('modelList'),
        modelArrow: $('modelArrow'),
        effort: $('effort'),
        effortList: $('effortList')
    };

    let texts = {};
    let locale = 'en';
    let busy = false;
    // Follow new entries only while the user is at the end of the chat
    let followEnd = true;
    let busyTimer = null;
    let chats = [];
    let currentChatId = null;
    let snapshotTime = null;
    let sketchName = null;
    let lastAgentName = '';
    // Last state from the extension: {available, model, effort, models, efforts}
    let modelState = { available: false };

    // ===== CLIPBOARD =====

    /**
     * Copy text via the extension
     * @param {string} text - Text to copy
     */
    function copyText(text) {
        if (text) vscode.postMessage({ command: 'copy', text });
    }

    /**
     * Ask the extension for the clipboard content (answer: 'paste' message)
     */
    function requestPaste() {
        vscode.postMessage({ command: 'requestPaste' });
    }

    /**
     * Insert text at the cursor position of the input field
     * @param {string} text - Text to insert
     */
    function insertIntoInput(text) {
        if (!text) return;
        const input = elements.input;
        const start = input.selectionStart;
        const end = input.selectionEnd;
        input.value = input.value.slice(0, start) + text + input.value.slice(end);
        input.selectionStart = input.selectionEnd = start + text.length;
        input.focus();
    }

    /**
     * Get the currently selected text (input field or chat)
     * @param {Element} target - Element the action refers to
     * @returns {string} Selected text
     */
    function getSelectedText(target) {
        if (target === elements.input) {
            return elements.input.value.substring(elements.input.selectionStart, elements.input.selectionEnd);
        }
        return window.getSelection().toString();
    }

    // ===== CONTEXT MENU =====

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.hidden = true;
    const menuCopy = document.createElement('div');
    menuCopy.className = 'context-menu-item';
    const menuPaste = document.createElement('div');
    menuPaste.className = 'context-menu-item';
    menu.append(menuCopy, menuPaste);
    document.body.appendChild(menu);

    let menuSelection = '';

    /**
     * Hide the context menu
     */
    function hideMenu() {
        menu.hidden = true;
    }

    document.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        menuSelection = getSelectedText(event.target);
        menuCopy.textContent = '📋 ' + (texts.copy || 'Copy');
        menuPaste.textContent = '📝 ' + (texts.paste || 'Paste');
        menuCopy.classList.toggle('disabled', !menuSelection);
        menuPaste.classList.toggle('disabled', busy);

        menu.hidden = false;
        const x = Math.min(event.clientX, window.innerWidth - menu.offsetWidth);
        const y = Math.min(event.clientY, window.innerHeight - menu.offsetHeight);
        menu.style.left = `${Math.max(0, x)}px`;
        menu.style.top = `${Math.max(0, y)}px`;
    });

    menuCopy.addEventListener('mousedown', (event) => event.preventDefault());
    menuCopy.addEventListener('click', () => {
        if (!menuCopy.classList.contains('disabled')) copyText(menuSelection);
        hideMenu();
    });
    menuPaste.addEventListener('mousedown', (event) => event.preventDefault());
    menuPaste.addEventListener('click', () => {
        if (!menuPaste.classList.contains('disabled')) requestPaste();
        hideMenu();
    });

    document.addEventListener('click', (event) => {
        if (!menu.contains(event.target)) hideMenu();
        if (!elements.chatList.contains(event.target) && event.target !== elements.chatTitle) hideChatList();
        if (!elements.effortList.contains(event.target)) elements.effortList.hidden = true;
    });
    window.addEventListener('blur', hideMenu);
    elements.messages.addEventListener('scroll', hideMenu);

    // Keyboard shortcuts: copy, cut and paste via the extension
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            hideMenu();
            hideChatList();
            hideChoiceLists();
            return;
        }
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        const key = event.key.toLowerCase();
        const inInput = event.target === elements.input;

        if (key === 'c') {
            const selected = getSelectedText(event.target);
            if (selected) {
                event.preventDefault();
                copyText(selected);
            }
        } else if (key === 'x' && inInput) {
            const selected = getSelectedText(elements.input);
            if (selected) {
                event.preventDefault();
                copyText(selected);
                insertIntoInput('');
            }
        } else if (key === 'v' && inInput) {
            event.preventDefault();
            requestPaste();
        }
    });

    // ===== RENDERING =====

    /**
     * Escape HTML special characters
     * @param {string} text - Raw text
     * @returns {string} Escaped text
     */
    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * Minimal inline Markdown: inline code, bold, headings, line breaks
     * @param {string} text - Text without code blocks
     * @returns {string} HTML
     */
    function renderInline(text) {
        return escapeHtml(text)
            .replace(/`([^`\n]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
            .replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>')
            .replace(/\n/g, '<br>');
    }

    /**
     * Create a small copy button
     * @param {string} title - Tooltip
     * @param {Function} getText - Returns the text to copy
     * @returns {HTMLButtonElement} Button
     */
    function createCopyButton(title, getText) {
        const button = document.createElement('button');
        button.className = 'copy-btn';
        button.textContent = '📋';
        button.title = title;
        button.addEventListener('click', () => copyText(getText()));
        return button;
    }

    /**
     * Render Markdown into a container; code blocks get their own copy button
     * @param {HTMLElement} container - Target element
     * @param {string} text - Markdown text
     */
    function renderMarkdown(container, text) {
        let last = 0;
        let match;
        CODE_BLOCK_PATTERN.lastIndex = 0;

        while ((match = CODE_BLOCK_PATTERN.exec(text)) !== null) {
            const before = document.createElement('span');
            before.innerHTML = renderInline(text.slice(last, match.index));
            container.appendChild(before);

            const code = match[1].replace(/\n$/, '');
            const block = document.createElement('div');
            block.className = 'code-block';
            const pre = document.createElement('pre');
            const codeElement = document.createElement('code');
            codeElement.textContent = code;
            pre.appendChild(codeElement);
            block.append(createCopyButton(texts.copyCode, () => code), pre);
            container.appendChild(block);

            last = match.index + match[0].length;
        }

        const rest = document.createElement('span');
        rest.innerHTML = renderInline(text.slice(last));
        container.appendChild(rest);
    }

    /**
     * Append one entry to the message list
     * @param {string} role - 'user' | 'agent' | 'activity' | 'info' | 'error'
     * @param {string} text - Entry text
     * @param {number} time - Message timestamp (identifies the reset point)
     * @param {Object} [data] - Compile result
     * @param {string} [toolId] - Shell call whose output may follow (live only)
     * @param {string} [loginAgent] - Agent to log in to, adds a button (live only)
     */
    function addEntry(role, text, time, data, toolId, loginAgent) {
        const entry = document.createElement('div');
        entry.className = `entry ${role}`;

        if (role === 'compile' && data) {
            renderCompile(entry, data, time);
            elements.messages.appendChild(entry);
            keepScroll();
            return;
        }

        if (role === 'changes' && data) {
            renderChanges(entry, data);
            elements.messages.appendChild(entry);
            keepScroll();
            return;
        }

        if (role === 'user' || role === 'agent') {
            const header = document.createElement('div');
            header.className = 'label';
            const label = document.createElement('span');
            label.textContent = role === 'user' ? texts.you : texts.agent;
            header.appendChild(label);
            if (role === 'agent') {
                header.appendChild(createCopyButton(texts.copyMessage, () => text));
            } else {
                const restore = document.createElement('button');
                restore.className = 'copy-btn restore-btn';
                restore.textContent = '↶';
                restore.title = texts.restore;
                restore.dataset.time = String(time);
                restore.hidden = true;
                restore.addEventListener('click', () => vscode.postMessage({ command: 'restore' }));
                header.appendChild(restore);
            }
            entry.appendChild(header);

            const body = document.createElement('div');
            body.className = 'body';
            renderMarkdown(body, text);
            entry.appendChild(body);
        } else {
            entry.textContent = role === 'activity' ? `› ${text}` : text;
            if (toolId) entry.dataset.toolId = toolId;
            if (loginAgent) entry.append(' ', createLoginButton(texts.loginButton, loginAgent));
        }

        if (role === 'activity') {
            addActivity(entry, text);
        } else {
            elements.messages.appendChild(entry);
        }
        keepScroll();
    }

    /**
     * Add an activity line; consecutive ones are folded into one line
     * with the latest step and the number of steps, like other chats do
     * @param {HTMLElement} entry - Activity entry
     * @param {string} text - Activity text
     */
    function addActivity(entry, text) {
        const last = elements.messages.lastElementChild;
        let group = last?.classList.contains('activity-group') ? last : null;
        if (!group && last?.classList.contains('activity')) {
            group = document.createElement('details');
            group.className = 'activity-group';
            // Open while the agent works, folded when the run ends
            if (busy) {
                group.open = true;
                group.dataset.live = '1';
            }
            group.appendChild(document.createElement('summary'));
            last.replaceWith(group);
            group.appendChild(last);
        }
        if (!group) {
            elements.messages.appendChild(entry);
            return;
        }
        group.appendChild(entry);
        const count = group.querySelectorAll(':scope > .entry.activity').length;
        group.firstElementChild.textContent = `› ${text} · ${texts.steps.replace('{0}', count)}`;
    }

    /**
     * After new content: stay at the end if the user was there, otherwise offer the jump button
     */
    function keepScroll() {
        if (followEnd) {
            elements.messages.scrollTop = elements.messages.scrollHeight;
        } else {
            elements.scrollDown.hidden = false;
        }
    }

    /**
     * Jump to the end and follow new entries again
     */
    function scrollToEnd() {
        followEnd = true;
        elements.scrollDown.hidden = true;
        elements.messages.scrollTop = elements.messages.scrollHeight;
    }

    elements.messages.addEventListener('scroll', () => {
        const m = elements.messages;
        followEnd = m.scrollHeight - m.scrollTop - m.clientHeight < SCROLL_SLACK_PX;
        // Like other chats: the button is there whenever the end is out of sight
        elements.scrollDown.hidden = followEnd;
    });
    elements.scrollDown.addEventListener('click', scrollToEnd);

    /**
     * Button that opens the login of an agent in the system terminal
     * @param {string} label - Button text
     * @param {string} agent - Agent ID
     * @returns {HTMLButtonElement} Button
     */
    function createLoginButton(label, agent) {
        const button = document.createElement('button');
        button.className = 'link-btn';
        button.textContent = label;
        button.addEventListener('click', () => vscode.postMessage({ command: 'openLogin', agent }));
        return button;
    }

    /**
     * Turn an activity line into a collapsible block with the command's output
     * @param {string} toolId - Shell call
     * @param {string} output - Prepared output
     * @param {boolean} failed - Command failed
     */
    function attachToolOutput(toolId, output, failed) {
        // The latest line wins: some agents count their steps anew in every run
        const entry = [...elements.messages.querySelectorAll('.entry.activity')].reverse().find(e => e.dataset.toolId === toolId);
        if (!entry || entry.querySelector('details')) return;
        const details = document.createElement('details');
        details.className = 'tool-output';
        const summary = document.createElement('summary');
        summary.textContent = entry.textContent.replace(/^› /, '');
        summary.classList.toggle('failed', !!failed);
        const pre = document.createElement('pre');
        pre.textContent = output;
        details.append(summary, pre);
        entry.textContent = '';
        entry.appendChild(details);
    }

    /**
     * Render a compile result: status, flash/RAM bars or the first errors
     * @param {HTMLElement} entry - Entry element
     * @param {Object} data - {ok, compact, line, title, sizes, warning, errors, more, hint, fixable}
     * @param {number} time - Entry time (identifies it for "fix errors")
     */
    function renderCompile(entry, data, time) {
        if (data.compact) {
            entry.classList.add('activity', 'compact');
            entry.textContent = `› ${data.line}`;
            return;
        }
        entry.classList.add(data.ok ? 'ok' : 'failed');
        // The check comes from Agentuino, not from the agent
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = texts.checkLabel;
        entry.appendChild(label);

        const title = document.createElement('div');
        title.className = 'compile-title';
        title.textContent = data.title;
        entry.appendChild(title);

        (data.sizes || []).forEach(size => {
            const row = document.createElement('div');
            row.className = 'compile-size';
            const label = document.createElement('span');
            label.className = 'compile-label';
            label.textContent = size.label;
            row.appendChild(label);
            if (size.percent !== null) {
                const bar = document.createElement('span');
                bar.className = 'compile-bar';
                const fill = document.createElement('span');
                fill.style.width = `${Math.min(size.percent, PERCENT_MAX)}%`;
                if (size.percent > BAR_WARNING_PERCENT) fill.className = 'high';
                bar.appendChild(fill);
                row.appendChild(bar);
            }
            const value = document.createElement('span');
            value.textContent = size.text;
            row.appendChild(value);
            entry.appendChild(row);
        });

        const notes = [data.warning, ...(data.errors || []), data.more].filter(Boolean);
        if (notes.length > 0) {
            const list = document.createElement('div');
            list.className = data.ok ? 'compile-warning' : 'compile-errors';
            list.textContent = notes.join('\n');
            entry.appendChild(list);
        }

        if (data.hint) {
            const hint = document.createElement('div');
            hint.className = 'compile-hint';
            hint.textContent = data.hint;
            entry.appendChild(hint);
        }

        // A missing library is installed only after the user's ok, so no fix button
        if (!data.ok && data.fixable !== false) {
            const fix = document.createElement('button');
            fix.className = 'fix-btn';
            fix.textContent = texts.fixErrors;
            fix.dataset.time = String(time);
            fix.hidden = true;
            fix.addEventListener('click', () => vscode.postMessage({ command: 'fixErrors', time }));
            entry.appendChild(fix);
        }
    }

    /**
     * Line with the files a task changed, each one opens the diff editor
     * @param {HTMLElement} entry - Entry element
     * @param {Object} data - {task, files: [{rel, kind}]}
     */
    function renderChanges(entry, data) {
        entry.dataset.task = String(data.task);
        entry.append('✏️ ');
        const groups = [
            ['changed', texts.changesChanged],
            ['added', texts.changesAdded],
            ['deleted', texts.changesDeleted]
        ];
        let first = true;
        groups.forEach(([kind, label]) => {
            const files = (data.files || []).filter(file => file.kind === kind);
            if (files.length === 0) return;
            if (!first) entry.append(' · ');
            first = false;
            entry.append(`${label} `);
            files.forEach((file, index) => {
                if (index > 0) entry.append(', ');
                const link = document.createElement('button');
                link.className = 'link-btn change-link';
                link.textContent = file.rel;
                link.disabled = true;
                link.addEventListener('click', () => vscode.postMessage({ command: 'showChange', rel: file.rel }));
                entry.appendChild(link);
            });
        });
    }

    /**
     * Offer "fix errors" only at a failed check that is the last compile
     * result and was not followed by a new message
     */
    function updateFixButtons() {
        const entries = Array.from(elements.messages.querySelectorAll('.entry.compile, .entry.user'));
        const last = entries[entries.length - 1];
        elements.messages.querySelectorAll('.fix-btn').forEach(button => {
            button.hidden = busy || !last || !last.contains(button);
        });
    }

    /**
     * Show the reset button only at the message of the last agent run
     */
    function updateRestoreButtons() {
        elements.messages.querySelectorAll('.restore-btn').forEach(button => {
            button.hidden = busy || Number(button.dataset.time) !== snapshotTime;
        });
        // The diff needs the snapshot, so only the changes of the last run are clickable
        elements.messages.querySelectorAll('.entry.changes').forEach(entry => {
            const active = !busy && Number(entry.dataset.task) === snapshotTime;
            entry.querySelectorAll('.change-link').forEach(link => {
                link.disabled = !active;
                link.title = active ? texts.changesOpen : '';
            });
        });
        updateFixButtons();
    }

    /**
     * Show the setup card (no agent installed). Replaces an earlier one.
     * @param {Object} setup - Texts and agents from the extension
     */
    function showSetup(setup) {
        removeSetup();
        elements.messages.querySelector('.welcome')?.remove();
        const labels = setup.labels;
        const card = document.createElement('div');
        card.className = 'entry about setup';
        card.id = 'setupCard';

        const title = document.createElement('div');
        title.className = 'about-title';
        title.textContent = setup.title;
        const intro = document.createElement('div');
        intro.className = 'about-subtitle';
        intro.textContent = setup.intro;
        card.append(title, intro);

        const commandLine = (label, command, agent) => {
            const row = document.createElement('div');
            row.className = 'setup-row';
            const key = document.createElement('span');
            key.className = 'about-key';
            key.textContent = label;
            const code = document.createElement('code');
            code.textContent = command;
            row.append(key, code, createCopyButton(labels.copy, () => command));
            if (agent) row.append(createLoginButton(labels.openLogin, agent));
            return row;
        };

        setup.agents.forEach(agent => {
            const block = document.createElement('div');
            block.className = 'setup-agent';
            const name = document.createElement('strong');
            name.textContent = agent.name;
            const note = document.createElement('div');
            note.className = 'setup-note';
            note.textContent = agent.note;
            const guide = document.createElement('button');
            guide.className = 'link-btn';
            guide.textContent = labels.guide;
            guide.addEventListener('click', () => vscode.postMessage({ command: 'openUrl', url: agent.url }));
            block.append(name, note, commandLine(labels.install, agent.install), commandLine(labels.login, agent.login, agent.id), guide);
            card.appendChild(block);
        });

        const after = document.createElement('div');
        after.className = 'setup-note';
        after.textContent = labels.after;
        const recheck = document.createElement('button');
        recheck.textContent = labels.recheck;
        recheck.addEventListener('click', () => vscode.postMessage({ command: 'recheckAgents' }));
        const buttons = document.createElement('div');
        buttons.className = 'buttons';
        buttons.appendChild(recheck);
        card.append(after, buttons);

        elements.messages.appendChild(card);
        keepScroll();
    }

    /**
     * Remove the setup card
     */
    function removeSetup() {
        document.getElementById('setupCard')?.remove();
    }

    /**
     * Show the welcome text when the chat is empty
     */
    function showWelcome() {
        const welcome = document.createElement('div');
        welcome.className = 'entry welcome';
        welcome.textContent = texts.welcome;
        elements.messages.appendChild(welcome);
    }

    /**
     * Show how long the agent has been working, so a long run visibly lives
     */
    function updateBusyTimer() {
        if (!busy) {
            clearInterval(busyTimer);
            busyTimer = null;
            elements.workingTime.textContent = '';
            return;
        }
        if (busyTimer) return;
        const start = Date.now();
        const show = () => {
            const seconds = Math.floor((Date.now() - start) / SECOND_MS);
            const rest = String(seconds % SECONDS_PER_MINUTE).padStart(2, '0');
            elements.workingTime.textContent = `${Math.floor(seconds / SECONDS_PER_MINUTE)}:${rest}`;
        };
        show();
        busyTimer = setInterval(show, SECOND_MS);
    }

    /**
     * Update busy state of all controls
     * @param {boolean} value - Busy flag
     */
    function setBusy(value) {
        busy = value;
        elements.send.hidden = busy;
        elements.stop.hidden = !busy;
        elements.working.hidden = !busy;
        if (busy) elements.workingText.textContent = texts.working;
        updateBusyTimer();
        if (!busy) {
            elements.messages.querySelectorAll('.activity-group[data-live]').forEach(group => {
                group.open = false;
                delete group.dataset.live;
            });
        }
        elements.attach.disabled = busy;
        elements.newChat.disabled = busy;
        elements.chatTitle.disabled = busy;
        elements.model.disabled = busy;
        elements.effort.disabled = busy;
        if (busy) {
            hideChatList();
            hideChoiceLists();
        }
        updateRestoreButtons();
        showSubline(lastAgentName);
        if (!busy) elements.input.focus();
    }

    /**
     * Render pending attachments as removable chips
     * @param {string[]} list - File names
     */
    function renderAttachments(list) {
        elements.attachments.innerHTML = '';
        list.forEach((name, index) => {
            const chip = document.createElement('span');
            chip.className = 'chip';
            chip.textContent = `📎 ${name} `;
            const remove = document.createElement('button');
            remove.textContent = '×';
            remove.title = texts.remove;
            remove.addEventListener('click', () => vscode.postMessage({ command: 'removeAttachment', index }));
            chip.appendChild(remove);
            elements.attachments.appendChild(chip);
        });
    }

    /**
     * Apply localized texts to static elements
     */
    function applyTexts() {
        elements.send.textContent = texts.send;
        elements.stop.textContent = texts.stop;
        elements.attach.textContent = '📎 ' + texts.attach;
        elements.newChat.textContent = texts.newChat;
        elements.settings.title = texts.settings;
        elements.input.placeholder = texts.placeholder;
        elements.workingText.textContent = texts.working;
        elements.model.placeholder = texts.modelDefault;
        elements.model.title = texts.modelTitle;
        elements.effort.title = texts.effortTitle;
        elements.scrollDown.title = texts.scrollDown;
    }

    // ===== MODEL AND EFFORT =====

    let modelActive = -1;
    // Only typing filters the suggestions, on focus all of them are shown
    let modelFiltering = false;

    /**
     * Hide both lists of the model choice
     */
    function hideChoiceLists() {
        elements.modelList.hidden = true;
        elements.effortList.hidden = true;
    }

    /**
     * Show model, suggestions and effort levels of the chat
     * @param {Object} state - {available, model, effort, models, efforts}
     */
    function showModel(state) {
        modelState = state;
        elements.modelChoice.hidden = !state.available;
        if (!state.available) return;
        // Do not overwrite what the user is typing
        if (document.activeElement !== elements.model) elements.model.value = state.model;
        elements.effort.textContent = (state.effort || texts.effortDefault) + ' ▾';
        elements.effort.hidden = state.efforts.length === 0;
        if (!elements.modelList.hidden) renderModelList();
        if (!elements.effortList.hidden) renderEffortList();
    }

    /**
     * Send the chosen model and effort to the extension (only if changed)
     * @param {string} [effort] - New effort level, otherwise the current one
     */
    function sendModel(effort = modelState.effort) {
        const model = elements.model.value.trim();
        if (model === modelState.model && effort === modelState.effort) return;
        // Taken over at once, so blur after a click does not send it twice
        modelState = { ...modelState, model, effort };
        elements.effort.textContent = (effort || texts.effortDefault) + ' ▾';
        vscode.postMessage({ command: 'setModel', model, effort });
    }

    /**
     * Create one entry of a choice list
     * @param {string} label - Text
     * @param {Function} pick - Called on click
     * @returns {HTMLElement} Entry
     */
    function createChoiceItem(label, pick) {
        const item = document.createElement('div');
        item.className = 'choice-item';
        item.textContent = label;
        // Keep the focus in the field until the click is done
        item.addEventListener('mousedown', (event) => event.preventDefault());
        item.addEventListener('click', pick);
        return item;
    }

    /**
     * Suggestions that contain the typed text
     * @returns {string[]} Models
     */
    function matchingModels() {
        const typed = modelFiltering ? elements.model.value.trim().toLowerCase() : '';
        return (modelState.models || [])
            .filter(name => !typed || name.toLowerCase().includes(typed))
            .slice(0, MAX_SUGGESTIONS);
    }

    /**
     * Render the model suggestions, hidden if none match
     */
    function renderModelList() {
        const names = matchingModels();
        elements.modelList.innerHTML = '';
        modelActive = Math.min(modelActive, names.length - 1);
        names.forEach((name, index) => {
            const item = createChoiceItem(name, () => pickModel(name));
            if (index === modelActive) item.classList.add('active');
            elements.modelList.appendChild(item);
        });
        elements.modelList.hidden = names.length === 0;
        elements.modelList.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    }

    /**
     * Take a suggestion
     * @param {string} name - Model
     */
    function pickModel(name) {
        elements.model.value = name;
        elements.modelList.hidden = true;
        sendModel();
    }

    /**
     * Render the effort levels, the current one marked
     */
    function renderEffortList() {
        elements.effortList.innerHTML = '';
        for (const level of ['', ...modelState.efforts]) {
            const item = createChoiceItem(level || texts.effortDefault, () => {
                elements.effortList.hidden = true;
                sendModel(level);
            });
            if (level === modelState.effort) item.classList.add('active');
            elements.effortList.appendChild(item);
        }
    }

    elements.model.addEventListener('focus', () => {
        elements.effortList.hidden = true;
        modelActive = -1;
        modelFiltering = false;
        renderModelList();
    });
    elements.model.addEventListener('input', () => {
        modelActive = -1;
        modelFiltering = true;
        renderModelList();
    });
    elements.model.addEventListener('blur', () => {
        elements.modelList.hidden = true;
        sendModel();
    });
    elements.model.addEventListener('keydown', (event) => {
        const count = elements.modelList.hidden ? 0 : elements.modelList.children.length;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (elements.modelList.hidden) {
                renderModelList();
                return;
            }
            const step = event.key === 'ArrowDown' ? 1 : -1;
            modelActive = count ? (modelActive + step + count) % count : -1;
            renderModelList();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            const names = matchingModels();
            if (!elements.modelList.hidden && modelActive >= 0 && names[modelActive]) {
                pickModel(names[modelActive]);
            } else {
                elements.modelList.hidden = true;
                sendModel();
            }
        } else if (event.key === 'Escape') {
            elements.model.value = modelState.model;
            elements.modelList.hidden = true;
            elements.input.focus();
        }
    });

    // The arrow opens and closes the suggestions without leaving the field
    elements.modelArrow.addEventListener('mousedown', (event) => {
        event.preventDefault();
        if (busy) return;
        if (document.activeElement !== elements.model) {
            elements.model.focus();
        } else if (elements.modelList.hidden) {
            modelFiltering = false;
            renderModelList();
        } else {
            elements.modelList.hidden = true;
        }
    });

    elements.effort.addEventListener('click', (event) => {
        event.stopPropagation();
        if (busy) return;
        elements.modelList.hidden = true;
        if (elements.effortList.hidden) renderEffortList();
        elements.effortList.hidden = !elements.effortList.hidden;
    });

    let agentSelectable = false;

    /**
     * Show sketch and agent below the chat title. In a new chat the agent
     * name is a button to choose another agent.
     * @param {string} agent - Agent name (may be empty)
     */
    function showSubline(agent) {
        elements.sketch.textContent = (sketchName ? texts.sketch.replace('{0}', sketchName) : texts.noSketch) + ' ·';
        const selectable = agentSelectable && !busy;
        elements.agentBtn.textContent = (agent || texts.noAgent) + (selectable ? ' ▾' : '');
        elements.agentBtn.disabled = !selectable;
        elements.agentBtn.title = selectable ? texts.chooseAgent : '';
    }

    elements.agentBtn.addEventListener('click', () => vscode.postMessage({ command: 'chooseAgent' }));

    // ===== CHAT LIST =====

    /**
     * Hide the chat dropdown
     */
    function hideChatList() {
        elements.chatList.hidden = true;
    }

    /**
     * Format a timestamp for the chat list
     * @param {number} time - Milliseconds since epoch
     * @returns {string} Localized date and time
     */
    function formatTime(time) {
        try {
            return new Date(time).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
        } catch {
            return new Date(time).toLocaleString();
        }
    }

    /**
     * Render the chat dropdown
     */
    function renderChatList() {
        elements.chatList.innerHTML = '';
        const heading = document.createElement('div');
        heading.className = 'dropdown-heading';
        heading.textContent = texts.chatList;
        elements.chatList.appendChild(heading);

        if (chats.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'dropdown-empty';
            empty.textContent = texts.noChats;
            elements.chatList.appendChild(empty);
            return;
        }

        chats.forEach(chat => {
            const item = document.createElement('div');
            item.className = 'chat-item' + (chat.id === currentChatId ? ' current' : '');

            const info = document.createElement('div');
            info.className = 'chat-info';
            const title = document.createElement('div');
            title.className = 'chat-name';
            title.textContent = chat.title;
            const date = document.createElement('div');
            date.className = 'chat-date';
            date.textContent = formatTime(chat.updated);
            info.append(title, date);

            const rename = document.createElement('button');
            rename.className = 'copy-btn';
            rename.textContent = '✎';
            rename.title = texts.rename;
            rename.addEventListener('click', (event) => {
                event.stopPropagation();
                hideChatList();
                vscode.postMessage({ command: 'renameChat', id: chat.id });
            });

            const remove = document.createElement('button');
            remove.className = 'copy-btn';
            remove.textContent = '🗑';
            remove.title = texts.delete;
            remove.addEventListener('click', (event) => {
                event.stopPropagation();
                hideChatList();
                vscode.postMessage({ command: 'deleteChat', id: chat.id });
            });

            item.append(info, rename, remove);
            item.addEventListener('click', () => {
                hideChatList();
                if (chat.id !== currentChatId) vscode.postMessage({ command: 'selectChat', id: chat.id });
            });
            elements.chatList.appendChild(item);
        });
    }

    elements.chatTitle.addEventListener('click', () => {
        if (busy) return;
        renderChatList();
        elements.chatList.hidden = !elements.chatList.hidden;
    });

    // ===== INPUT HISTORY =====

    // Kept in the webview state, so it survives hiding and reloading the panel
    let history = Array.isArray(vscode.getState()?.history) ? vscode.getState().history : [];
    let historyIndex = -1;
    let draft = '';

    /**
     * Remember a sent message (newest first, no duplicates)
     * @param {string} text - Sent text
     */
    function rememberInput(text) {
        history = [text, ...history.filter(entry => entry !== text)].slice(0, HISTORY_SIZE);
        vscode.setState({ ...(vscode.getState() || {}), history });
        historyIndex = -1;
    }

    /**
     * Show a history entry in the input field
     * @param {number} index - History index, -1 for the unsent draft
     */
    function showHistoryEntry(index) {
        historyIndex = index;
        const input = elements.input;
        input.value = index === -1 ? draft : history[index];
        input.selectionStart = input.selectionEnd = input.value.length;
    }

    elements.input.addEventListener('keydown', (event) => {
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) return;
        const input = elements.input;
        const beforeCursor = input.value.slice(0, input.selectionStart);
        const afterCursor = input.value.slice(input.selectionEnd);

        // Only on the first or last line, so multi-line editing keeps working
        if (event.key === 'ArrowUp' && !beforeCursor.includes('\n') && historyIndex < history.length - 1) {
            event.preventDefault();
            if (historyIndex === -1) draft = input.value;
            showHistoryEntry(historyIndex + 1);
        } else if (event.key === 'ArrowDown' && !afterCursor.includes('\n') && historyIndex > -1) {
            event.preventDefault();
            showHistoryEntry(historyIndex - 1);
        }
    });

    // Editing a recalled entry turns it into the new draft
    elements.input.addEventListener('input', () => { historyIndex = -1; });

    // ===== ACTIONS =====

    /**
     * Send the input text
     */
    function send() {
        const text = elements.input.value.trim();
        if (!text || busy) return;
        rememberInput(text);
        elements.input.value = '';
        draft = '';
        vscode.postMessage({ command: 'send', text });
    }

    elements.send.addEventListener('click', send);
    elements.stop.addEventListener('click', () => vscode.postMessage({ command: 'stop' }));
    elements.attach.addEventListener('click', () => vscode.postMessage({ command: 'attach' }));
    elements.settings.addEventListener('click', () => vscode.postMessage({ command: 'settings' }));
    elements.newChat.addEventListener('click', () => vscode.postMessage({ command: 'newChat' }));

    elements.input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            send();
        }
    });

    // ===== MESSAGES FROM EXTENSION =====

    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.command) {
            case 'init':
                texts = msg.texts || {};
                locale = msg.locale || locale;
                applyTexts();
                sketchName = msg.sketch;
                lastAgentName = msg.agent;
                showSubline(msg.agent);
                elements.messages.innerHTML = '';
                followEnd = true;
                elements.scrollDown.hidden = true;
                if (msg.messages.length === 0) showWelcome();
                msg.messages.forEach(m => addEntry(m.role, m.text, m.time, m.data));
                renderAttachments(msg.attachments || []);
                setBusy(msg.busy);
                break;
            case 'entry':
                elements.messages.querySelector('.welcome')?.remove();
                // An own message always brings the chat back to the end
                if (msg.role === 'user') scrollToEnd();
                addEntry(msg.role, msg.text, msg.time, msg.data, msg.toolId, msg.loginAgent);
                updateRestoreButtons();
                break;
            case 'toolOutput':
                attachToolOutput(msg.toolId, msg.output, msg.failed);
                break;
            case 'working':
                elements.workingText.textContent = msg.text;
                break;
            case 'agent':
                agentSelectable = !!msg.selectable;
                lastAgentName = msg.name;
                showSubline(msg.name);
                break;
            case 'snapshot':
                snapshotTime = msg.time;
                updateRestoreButtons();
                break;
            case 'setup':
                showSetup(msg.setup);
                break;
            case 'setupDone':
                removeSetup();
                break;
            case 'busy':
                setBusy(msg.busy);
                break;
            case 'attachments':
                renderAttachments(msg.list);
                break;
            case 'header':
                chats = msg.chats || [];
                currentChatId = msg.currentId;
                elements.chatTitle.textContent = msg.title + ' ▾';
                elements.chatTitle.title = msg.title;
                elements.cost.textContent = msg.cost;
                if (!elements.chatList.hidden) renderChatList();
                break;
            case 'paste':
                insertIntoInput(msg.text);
                break;
            case 'model':
                showModel(msg);
                break;
            default:
                break;
        }
    });

    vscode.postMessage({ command: 'ready' });
}());
