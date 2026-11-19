# Newsblog

## 2026

* **19.11.2026** **V1.2.0**: every chat has its own model and effort, chosen below the input field. The model field takes any name and suggests the models the agent lists itself (Codex, OpenCode, Antigravity CLI) or the usual ones (Claude Code). The effort levels fit the chosen model. A new chat starts with the choice of the last one.
* **15.11.2026** **V1.1.0**: adjusted to [ArduDebug](https://github.com/NikolaiRadke/ArduDebug) 1.8.8-5: Serial output arrives with the Serial Monitor open, `agentuino-serial` reads during a debug session, and the agent can send input to `Serial.read()` while debugging. The output of every command folds out in the chat. If an agent needs a new login, a button opens it in a terminal. Antigravity CLI is no longer experimental. New fifth agent: OpenCode, which works with many providers, local models via Ollama included.
* **14.11.2026** **V1.0.0**: the first stable version. Tested on Linux and Windows. New semantic anchor *Upload automatically*: the agent uploads after every change that compiles. The [Extension Manager](https://github.com/NikolaiRadke/Extension-Manager) can uninstall Agentuino completely.
* **13.11.2026** **V0.9.0**: Antigravity CLI as fourth agent (experimental), free with a Google account. Agentuino now speaks French, Spanish and Italian too.
* **13.11.2026** **V0.8.0**: debugging by the agent with [ArduDebug](https://github.com/NikolaiRadke/ArduDebug): it stops the sketch on the board at a line and reads variables. Rule blocks are now called semantic anchors.
* **13.11.2026** **V0.7.0**: rule blocks. Switch code rules on per sketch with a click and create your own.
* **12.11.2026** First public beta **V0.6.0**: chat with Claude Code, Mistral Vibe and Codex CLI, sketch projects with several chats, compile check with automatic fixing, undo, serial output for the agent.
