# Changelog

## 0.9.0

- Antigravity CLI (agy) as fourth agent, experimental: free with a Google account
  (weekly limits). Prompt via streaming JSON input, AGENTS.md goes into the prompt.
- Install locations in agentConfigs.json may use {localAppData} (Windows)
- check-agent-configs.js also reads help texts printed to stderr
- French, Spanish and Italian
- Timeout message names the agent in general (was always "Claude Code")
- Antigravity: file names in the tool activity (read_file uses {Path})
- Windows: arguments are quoted when an agent runs through the shell
  (paths with spaces, e.g. in the user name, no longer fall apart)
- Webview messages: chat IDs are checked, only https links are opened
- agentConfigs.json: command and install locations must name the agent itself
- Uninstalling also removes the own semantic anchors and the debug builds
- Cleanup: one helper each for downloads, atomic files, errors and versions;
  unused exports and texts removed

## 0.8.0

- agentuino-debug: with ArduDebug installed, the agent stops the program on the board at a
  line and reads variables (`--break`, `--print`, `--locals`, `--hits`, `--pause`), including
  the Serial output during the run. It builds the debug build itself with the ArduDebug
  variant of the selected board, so "Arduino AVR Boards" sketches work too. Uploads only
  after the user agreed (`--upload`); `--restore` brings the normal build back.
  Uses bridge and avr-gdb from the ArduDebug package; nothing to install, builds go to the
  temp folder (not into synced sketchbooks)
- AGENTS.md explains it when ArduDebug is installed, with rules for uploads, hardware that
  stops at a breakpoint and cleaning up afterwards
- Rule blocks renamed to semantic anchors, the better known term (as in AI.duino)

## 0.7.0

- Rule blocks (⚙ → ⚓ Rule blocks): code rules switched on per sketch with a click,
  written into the automatic section of AGENTS.md. Basics, advanced (collapsed),
  way of working and custom blocks you create, edit and delete yourself.
  New sketches start with the default selection; "Save as default for new sketches"
  and "Apply defaults" on the page. Without an open sketch the page edits the defaults.
- Custom blocks and defaults are stored in ~/.agentuino/rules.json
  (removed by Uninstall like the rest of ~/.agentuino)

## 0.6.0

- First public beta on GitHub (github.com/NikolaiRadke/Agentuino)
- Releases with VSIX and installer zip; the update notice opens the latest release

## 0.5.2

- Test command for IDE serial monitor commands removed (the IDE only offers a toggle,
  closing the monitor automatically is not reliable)
- agentuino-serial: long output keeps start and end; no more claim that the board was
  reset (the sketch keeps running, the first line may be incomplete); hint that the
  IDE's Serial Monitor can hold the port after an upload
- AGENTS.md: read the serial output only with agentuino-serial (Claude used cat,
  stty and pyserial instead)

## 0.5.1

- agentuino-serial: the agent reads the serial output of the board for a fixed time
  (`agentuino-serial --seconds 10 --baud 9600`, optional `--port`, `--send`).
  Runs with the IDE's own Node runtime, nothing to install. Clear messages for a busy
  port (Serial Monitor or debug session), no port and unreadable output.
- AGENTS.md explains it, including that a debug build (ArduDebug) only shows garbage

## 0.5.0

- Agent configuration in config/agentConfigs.json: command line options, install
  commands, minimum versions, install locations and error patterns of all agents.
  A newer version on GitHub is offered at startup and stored only after the user
  agreed ("Apply", "Later", "Skip this version"); pure JSON, strictly validated,
  applies from the next task on without restart. The about page shows its version.
- scripts/check-agent-configs.js checks the file against the installed CLIs
  (every option must appear in their help) before it is published
- Uninstall also removes the downloaded configuration (~/.agentuino)

## 0.4.5

- Successful compile check: one grey line in the chat (✅ · Flash · RAM), the full
  compiler output goes to the "Agentuino" channel of the output panel
- Errors and RAM warnings stay a card, now headed "Check by Agentuino"
- The agent learns the result of the check with the next message, so it does not
  compile again for nothing
- After a reset the agent is asked to check its entries in memory.md

## 0.4.4

- ↶ stays at the last message that changed code: questions in between no longer
  replace the saved state
- Missing library: no automatic repair round (installing needs the user's ok), a hint says
  how to let the agent install it instead
- After a failed check the next run is always checked, even without code changes
  (e.g. after installing a library)
- Fatal compiler errors are shown (a missing library showed only "compilation terminated.")
- Flash and RAM percentages are truncated like in the IDE output (832 of 32256 bytes = 2 %, not 3 %)

## 0.4.3

- Compile check after every agent run that changed code: ✅ with flash and RAM bars
  (warning above 75 % RAM) or ❌ with the first errors
- Agentic loop like AI.duino: on errors the agent gets the compiler output and tries again,
  up to 3 runs per task; stops early when a run changes no code. Afterwards
  "Let the agent fix it" starts another round by hand
- Setting agentuino.compileCheck (default on); Stop also ends a running compile

## 0.4.2

- Separate About page (⚙ menu) with logo, quick start, agent status with guides,
  technical details with "Copy info", license, links and support (Ko-fi, GitHub Sponsors)
- The about card in the chat is gone

## 0.4.1

- Uninstall confirmation explains how to remove the project folders by hand
- New logo; chat accent color matches it; unused sidebar icon removed

## 0.4.0

- Welcome card when no agent is installed: install and login commands per agent, "Check again"
- Update check at startup (setting agentuino.checkForUpdates), "Skip this version"
- Uninstall from the ⚙ menu; project folders in the sketches are kept
- Installer scripts for Linux, macOS and Windows
- Input history: ↑/↓ recalls the last 5 messages
- arduino-cli is put into the agent's PATH, AGENTS.md uses the plain command name:
  works the same in Bash, PowerShell and CMD
- Shorter command lines in the chat (no long paths or --config-file)
- Rule: install libraries or board packages only after asking
- Codex CLI marked as experimental

## 0.3.1

- Error messages name the agent that failed (was always "Claude Code")
- Mistral Vibe older than 3.0 is detected: clear update hint instead of a usage error;
  in automatic mode an outdated agent is skipped
- Agent selection shows outdated agents as "too old"

## 0.3.0

- Agent adapters: Claude Code, Codex CLI and Mistral Vibe behind one interface
- New setting "agentuino.agent" (auto, claudecode, codex, vibe); each chat keeps its agent
- Agents without an instructions file option get AGENTS.md in the prompt
  (at session start and when it changed)
- About card lists all agents with version; versions shortened to the number
- Clear messages when an agent is missing or not logged in
- Choose the agent in the ⚙ menu or by clicking the agent name in a new chat
- Agents installed via npm with nvm or Volta are found; their folder is put in front of
  PATH, so they start even when the IDE was launched from the desktop

## 0.2.1

- One snapshot per sketch before every agent run; ↶ at the last task restores it,
  including files the agent created or deleted. The agent is told about the reset.
- About card (⚙ menu) with version, detected tools and "Copy info" for bug reports

## 0.2.0

- Several chats per sketch, each with its own agent session; nothing is deleted by "New"
- Readable chat protocols in agentuino/chats/, agents search them for earlier conversations
- Chat titles generated with the smallest model, first sentence as provisional title
- Chat header with chat list, new chat and settings menu; sidebar removed
- Agent runs keep the code column focused (approach from AI.duino), no stray editor columns

## 0.1.3

- Chat opens in a fixed second column and stays where the user puts it
- Sketch root stays clean: AGENTS.md moved to agentuino/, CLAUDE.md removed
- Claude Code receives AGENTS.md via --append-system-prompt-file
- Project instructions open next to the code, not in the chat column

## 0.1.2

- The agent never uploads on its own: the rule is now always part of AGENTS.md
- Serial port detected via `arduino-cli board list` (exactly one USB port), otherwise the agent looks it up
- arduino-cli runs with the IDE's config file (same sketchbook, libraries and cores)
- arduino-cli update notice disabled for the agent

## 0.1.1

- Copy and paste in the chat: context menu, Ctrl+C/X/V, copy buttons for answers and code blocks
- Board detection scans all IDE logs and keeps the newest entry
- Clear message when Claude Code is not logged in

## 0.1.0

- Initial skeleton
- Chat panel driving Claude Code (`claude -p`, stream-json) in the sketch folder
- Session resume per sketch, automatic retry when a session is gone
- Stop button ends the whole process tree
- Project folder per sketch: AGENTS.md, CLAUDE.md, knowledge, attachments, memory
- Board detection from IDE logs and sketch.yaml, bundled arduino-cli detection
- German and English locales
