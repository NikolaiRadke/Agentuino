# Security Policy

Agentuino starts an AI agent (Claude Code, Mistral Vibe or Codex CLI) on your computer. This document explains what the agent may do and how to report a problem.

## What the agent can do

- By default the agent runs with full permissions (`agentuino.permissionMode` = `bypassPermissions`). It can read and write files and run commands in your user account without asking. Compiling with arduino-cli needs this.
- The rules Agentuino writes into `agentuino/AGENTS.md` tell the agent to stay inside the sketch folder, never to upload on its own and to install libraries only after asking. These rules are instructions to the agent, **not a sandbox**.
- `acceptEdits` only allows file edits, `auto` lets the agent's own safety check decide. With these modes compiling may fail or ask for permission the chat cannot answer.
- Files you attach and the chat protocols stay in the sketch folder. What the agent sends to its provider is governed by that provider's terms.

## What Agentuino stores

- In the sketch: the folder `agentuino/` (instructions, memory, knowledge, chats, attachments, one code backup).
- In your home folder: `~/.agentuino/agentConfigs.json`, only after you accepted a new agent configuration.
- Agentuino stores no API keys. Logins are handled by the agents themselves.

## Network access

At startup Agentuino reads two files from this repository on raw.githubusercontent.com: `package.json` (new version?) and `agentConfigs.json` (new agent options?). Nothing is downloaded and stored without asking. Switch both checks off with `agentuino.checkForUpdates`.

Downloaded agent configurations are pure JSON data, never executed, and strictly validated before use.

## Reporting a vulnerability

Please open an issue at https://github.com/NikolaiRadke/Agentuino/issues with a description, the steps to reproduce and the possible impact.
