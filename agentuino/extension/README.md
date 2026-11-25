![Agentuino](https://www.nikolairadke.de/aiduino/agentuino_banner.png)

# Agentuino

Agentic coding for Arduino beginners. Describe in the chat what your Arduino should do;
the agent works directly in your sketch folder, compiles on its own and fixes errors.

## Requirements

- Arduino IDE 2.x
- One CLI agent, installed and logged in:
  [Claude Code](https://code.claude.com), [Codex CLI](https://github.com/openai/codex),
  [Mistral Vibe](https://docs.mistral.ai/vibe) (version 3 or newer), [Antigravity CLI](https://antigravity.google/docs/cli/)
  or [OpenCode](https://opencode.ai/docs/) (1.18 or newer, also with local models via Ollama).
  Codex support is experimental.

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
    ├── config.json  # project settings, last open chat
    └── .gitignore   # keeps the folder out of Git (setting agentuino.gitignoreAll)
```

The folder is created automatically with the first chat message. The automatic section of
`AGENTS.md` also lists the installed libraries the sketch includes, so the agent reads their
headers and examples instead of guessing.

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
- The chat title at the top opens the list of all chats of this sketch; ✎ renames one, 🗑 deletes one.
- **📁** lists the Agentuino projects of your sketchbook: a click opens one in a new window,
  **@** mentions it in your message. The agent may read sketches you refer to, but changes only this one.
- **+ New** starts a new chat. Earlier chats stay available. In a new chat, click the agent name to choose another agent.
- **↑ / ↓** in the input field recall your last five messages.
- **📎 Attach** sends a file with the next message (e.g. a photo of your breadboard).
- **↶** next to your last message resets the sketch to the state before that task.
- After a task that changed code, a line lists the changed files; a click on a name opens
  the diff editor: before the task and now.
- The chat follows new entries only while you are at the end; **↓** brings you back.
  The agent's steps fold into one line, the running time shows it is still at work.
- After every run that changed code the sketch is compiled: ✅ with flash and RAM usage,
  or ❌ with the errors. The agent then gets the compiler output and fixes it on its own
  (up to 3 runs per task); if that fails, a button starts another round.
- With [ArduDebug](https://github.com/NikolaiRadke/ArduDebug) installed, the agent can stop the program
  on the board at a line and read variables. It asks before uploading a debug build.
- **⚙** opens project instructions, semantic anchors, knowledge files, project memory, the agent selection,
  the settings (language, compile check, permissions, Git, update check, program paths) and the about info.
- **⚓ Semantic anchors** switch code rules on per sketch (e.g. no magic numbers, non-blocking code, save RAM);
  create your own anchors there too. New sketches start with your default selection.

## Settings

All settings except the models can be changed in ⚙ → Settings.

| Setting | Description |
|---|---|
| `agentuino.language` | UI language (`auto`, `de`, `en`, `es`, `fr`, `it`) |
| `agentuino.agent` | Agent for new chats: `auto`, `claudecode`, `codex`, `vibe`, `antigravity`, `opencode` |
| `agentuino.compileCheck` | Compile after every run that changed code, show flash/RAM or errors (default on) |
| `agentuino.permissionMode` | `bypassPermissions` (default), `acceptEdits` or `auto` |
| `agentuino.gitignoreAll` | Keep the `agentuino/` folder out of Git (default on); off = only backups and attachments are ignored |
| `agentuino.claudePath` / `codexPath` / `vibePath` / `antigravityPath` / `opencodePath` | Agent path, empty = auto-detect |
| `agentuino.claudeModel` / `codexModel` / `vibeModel` / `antigravityModel` / `opencodeModel` | Model for new chats, empty = agent default. Each chat can choose its own model and effort below the input field |
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
