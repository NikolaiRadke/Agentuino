<img src="icons/agentuino-256.png" alt="Agentuino" width="128">

# Agentuino

Agentic coding for Arduino beginners. Describe in the chat what your Arduino should do;
the agent works directly in your sketch folder, compiles on its own and fixes errors.

## Requirements

- Arduino IDE 2.x
- One CLI agent, installed and logged in:
  [Claude Code](https://code.claude.com), [Codex CLI](https://github.com/openai/codex)
  or [Mistral Vibe](https://docs.mistral.ai/vibe) (version 3 or newer). Codex support is experimental.

## How it works

Every sketch becomes a project, similar to a project in Claude: several chats
share the project instructions, knowledge and memory, and the agent can look up
earlier chats when you refer to them.

```
MySketch/
├── MySketch.ino
└── agentuino/
    ├── AGENTS.md    # your instructions + an automatic section (board, compile command, rules)
    ├── knowledge/   # datasheets, pinouts, notes the agent may read
    ├── chats/       # one .json (data) and one .md (readable protocol) per chat
    ├── attachments/ # files attached to single chat messages
    ├── backups/     # one snapshot of the code files before the last agent run
    ├── memory.md    # what the agent learned about this project
    └── config.json  # project settings, last open chat
```

The folder is created automatically with the first chat message.

## Installation

Download `agentuino-<version>.zip` from the
[releases](https://github.com/NikolaiRadke/Agentuino/releases/latest), unpack it and run
the installer in it:

- Linux: `./install_agentuino_linux.sh`
- macOS: `./install_agentuino_macos.sh`
- Windows: `install_agentuino_windows.bat`

Then restart the Arduino IDE. If no agent is installed yet, the chat shows how to install one.
Agentuino checks for new versions at startup. To remove it, use ⚙ → Uninstall; your project
folders in the sketches are kept.

## Usage

- Click **Agentuino** in the status bar or press `Ctrl+Alt+A` to open the chat.
- The chat title at the top opens the list of all chats of this sketch; 🗑 deletes one.
- **+ New** starts a new chat. Earlier chats stay available. In a new chat, click the agent name to choose another agent.
- **↑ / ↓** in the input field recall your last five messages.
- **📎 Attach** sends a file with the next message (e.g. a photo of your breadboard).
- **↶** next to your last message resets the sketch to the state before that task.
- After every run that changed code the sketch is compiled: ✅ with flash and RAM usage,
  or ❌ with the errors. The agent then gets the compiler output and fixes it on its own
  (up to 3 runs per task); if that fails, a button starts another round.
- With [ArduDebug](https://github.com/NikolaiRadke/ArduDebug) installed, the agent can stop the program
  on the board at a line and read variables. It asks before uploading a debug build.
- **⚙** opens project instructions, semantic anchors, knowledge files, project memory, the language and the about info.
- **⚓ Semantic anchors** switch code rules on per sketch (e.g. no magic numbers, non-blocking code, save RAM);
  create your own anchors there too. New sketches start with your default selection.

## Settings

| Setting | Description |
|---|---|
| `agentuino.language` | UI language (`auto`, `de`, `en`, `es`, `fr`, `it`) |
| `agentuino.agent` | Agent for new chats: `auto`, `claudecode`, `codex`, `vibe` |
| `agentuino.compileCheck` | Compile after every run that changed code, show flash/RAM or errors (default on) |
| `agentuino.permissionMode` | `bypassPermissions` (default), `acceptEdits` or `auto` |
| `agentuino.claudePath` / `codexPath` / `vibePath` | Agent path, empty = auto-detect |
| `agentuino.claudeModel` / `codexModel` / `vibeModel` | Model, empty = agent default |
| `agentuino.checkForUpdates` | Check for new versions and agent configurations at startup; nothing is stored without asking (default on) |
| `agentuino.arduinoCliPath` | Path to arduino-cli, empty = the one bundled with the IDE |

## Agent configuration

Options, install commands and minimum versions of the agents live in
`extension/config/agentConfigs.json`. At startup Agentuino looks for a newer version
on GitHub and asks before storing it in `~/.agentuino/` (setting
`agentuino.checkForUpdates`). Before publishing a changed file, check it against
the installed CLIs (in the repository root):

```
node .github/scripts/check-agent-configs.js [--codex=<path>] [--vibe=<path>]
```

## License

Apache License 2.0
