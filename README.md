# Todo Voice

**A voice-driven web interface for managing plain-text task lists from your phone.**

Todo Voice turns spoken or typed requests into structured `todo.txt` entries with priorities, projects, contexts, and due dates. A React and TypeScript frontend handles capture and review, while a lightweight Python HTTP service reads and writes task files on your computer. Tasks stay in ordinary text files that you can also use with your editor or other `todo.txt` tools.

For example, a request such as:

> Email the recruiter and update my portfolio, both due October 30, 2026. Make the first one urgent.

can produce:

```text
(A) email the recruiter due:2026-10-30
update my portfolio due:2026-10-30
```

Output depends on the selected model. In Gemini mode, you review the proposed tasks before saving them.

## Features

- **Voice and text capture:** Record a voice note in the browser or type a request containing multiple tasks.
- **Structured task extraction:** Extract task text, `(A)`–`(C)` priorities, `+project` and `@context` tags, and `due:YYYY-MM-DD` deadlines.
- **Review and voice corrections:** In Gemini mode, confirm or cancel a proposed list, or record a correction before committing it.
- **Task browsing:** View tasks grouped by priority, highlight overdue dates, and expand completed entries.
- **Multiple task files:** Create and switch between `.txt` files in the helper's task directory.
- **Manual entry:** Add tasks with explicit priority and date fields without invoking an AI model.
- **Cloud or local inference:** Use Gemini directly from the browser, or route requests through the helper to local transcription and language-model services.

## Technical design

The application separates interpreting a request from formatting and storing tasks:

```text
Browser: microphone / typed input
  |
  +-- Gemini API --> structured tasks --> review / voice correction
  |                                        |
  |                                        v
  |                                Python helper --> .txt file
  |
  +-- Python helper --> whisper.cpp (voice) --> Ollama / compatible LLM
                                                   |
                                                   v
                                             .txt file
```

- **Browser audio pipeline:** The Web Audio API captures microphone samples, resamples them to 16 kHz mono, and encodes a 16-bit PCM WAV file for transcription.
- **Schema-guided AI integration:** Gemini and the local-model path request structured JSON. Application code assembles the `todo.txt` lines, normalizes whitespace, and sanitizes project and context tags.
- **Relative-date handling:** The Gemini path supplies the browser's local time zone and a calendar table to the model, then normalizes returned dates in TypeScript. The local-model path uses the helper computer's date.
- **Model fallback and retry:** Gemini's automatic mode tries another configured model for selected availability and rate-limit errors. Failed Gemini requests retain the recording in memory so users can retry without speaking again.
- **File interoperability:** The Python helper uses only the standard library, exposes a small JSON HTTP API, and preserves creation-date conventions when appending to files that already use them.

### Stack

| Layer | Technologies |
| --- | --- |
| Web application | React 19, TypeScript, TanStack Start and Router |
| Styling and tooling | Tailwind CSS 4, Lucide icons, Vite, ESLint, Prettier |
| File service | Python 3, `ThreadingHTTPServer`, standard-library HTTP clients |
| Cloud inference | Gemini API with structured JSON responses |
| Local inference | Ollama or an OpenAI-compatible endpoint; whisper.cpp for speech transcription |

## Run locally

### 1. Start the web application

Install Node.js and npm, then run from the project directory:

```sh
npm install
npm run dev
```

Open the address printed by Vite. API credentials and connection settings are entered in the app; no `.env` file is required for these settings.

### 2. Try the Gemini workflow

1. Open the plug icon in the header.
2. Enter your Gemini API key. Use **Load list** to discover models available to your key, then select a model or **Auto**.
3. Leave **Helper address** blank to try capture and review without a file service, then click **Save & connect**.
4. Record or type a request, review the proposed tasks, and click **Confirm**. Use **Edit** to record a correction before confirming.

Without a helper, confirmed tasks exist only in the current page's memory and are lost on reload or file switch. Connection settings, the API key, and the selected filename are stored in browser `localStorage`.

### 3. Connect a task file

With Python 3 installed, run the included helper in a separate terminal:

```sh
python3 public/todo-helper.py --file /absolute/path/to/todo.txt
```

The parent directory must already exist. The helper defaults to port `8765`; enter `http://localhost:8765` as **Helper address** when using the browser on the same computer. The frontend initially selects `todo.txt`, so use the file dropdown if your target file has a different name.

With a Gemini key configured, the helper handles file operations without requiring a local AI service. For access from a phone, configure an HTTPS address that routes to the helper. Microphone capture requires a secure browser context, such as HTTPS or localhost.

### 4. Use local models instead of Gemini

Run an Ollama server with the desired model available. The helper defaults to `qwen3:8b` at `http://localhost:11434/v1/chat/completions`; override these with `--model` and `--llm-url` as needed.

For voice input, also run a whisper.cpp transcription server and point `--whisper-url` to its `/inference` endpoint. The default is `http://127.0.0.1:8080/inference`.

```sh
python3 public/todo-helper.py \
  --file /absolute/path/to/todo.txt \
  --model qwen3:8b \
  --whisper-url http://127.0.0.1:8080/inference
```

Configure the helper address in the app and leave the Gemini key empty. Typed requests use the local language model; voice requests first pass through whisper.cpp. This path writes extracted tasks directly to the file without the Gemini review step.

## Source layout

```text
src/routes/index.tsx       Capture, review, connection settings, and task browser
src/lib/gemini.ts          Gemini requests, model fallback, and task/date formatting
src/lib/wav-recorder.ts    Microphone capture, resampling, and WAV encoding
public/todo-helper.py      File API, local inference, and transcription integration
src/styles.css            Application styling
```

Development commands: `npm run build` creates a production build, `npm run preview` previews it, and `npm run lint` runs ESLint. `npm run format` formats the project with Prettier.

## Current scope

This is a personal task-management prototype. It supports adding and viewing tasks; the current UI does not mark tasks complete or edit existing file entries. Refreshing the list is manual, and file writes have no conflict detection for concurrent edits.

The helper binds to all network interfaces and allows cross-origin requests. It supports an optional `--token`, but the current connection form has no token input. Network access controls and a credential configuration flow need attention before exposing it as a shared service. In Gemini mode, submitted audio and text are sent to Google's API; browser-stored credentials are accessible to scripts running on the app's origin.

Originally scaffolded with [Lovable](https://lovable.dev); the repository supports continued local development.
