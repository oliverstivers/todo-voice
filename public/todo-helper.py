#!/usr/bin/env python3
"""
Todo Voice helper - runs on your PC.

Receives spoken or typed text from the phone app, asks your local model
(Ollama) to turn it into structured tasks, formats them as todo.txt lines
itself (so the model can never break the syntax), and appends them to your
file. Also serves the whole file (/file) and saves edits (/save).

Usage:
  python todo-helper.py --file "C:/Users/me/todo.txt"

Optional:
  --token mysecret           (only needed if NOT using Tailscale/private network)
  --model qwen3:8b           (model name)
  --llm-url http://localhost:11434/v1/chat/completions
                             (Ollama default; LM Studio: http://localhost:1234/v1/chat/completions)
  --port 8765
  --whisper-url http://127.0.0.1:8080/inference
                             (whisper.cpp: whisper-server -m models/ggml-base.en.bin --port 8080)

Your phone needs an HTTPS address for this helper. Easiest:
  Tailscale:   tailscale funnel 8765
  Cloudflare:  cloudflared tunnel --url http://localhost:8765
Paste the https URL it prints into the app's settings.
"""
import argparse, json, os, urllib.parse, datetime, re, time, traceback, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

p = argparse.ArgumentParser()
p.add_argument("--file", required=True)
p.add_argument("--token", default="")
p.add_argument("--model", default="qwen3:8b")
p.add_argument("--llm-url", default="http://localhost:11434/v1/chat/completions")
p.add_argument("--port", type=int, default=8765)
p.add_argument("--whisper-url", default="http://127.0.0.1:8080/inference",
               help="whisper.cpp server (whisper-server) /inference endpoint")
args = p.parse_args()

SYSTEM = """You turn a person's spoken words into a list of tasks.
The input is a raw voice transcript: rambling, filler words, self-corrections,
and references back to things said earlier are all normal.

STEP 1 - Understand the WHOLE transcript before writing anything.
Figure out which distinct real-world tasks the person wants. Then figure out
which details (dates, priority, projects, contexts) belong to which task.

STEP 2 - Resolve references. This is the most important rule.
Phrases like "both of them", "those", "all of these", "that one", "the first
one", "it", "make them due Friday", "actually make that high priority" are NOT
new tasks. They MODIFY tasks already mentioned:
- "both" / "them" / "those" / "all of them" -> apply to every task it refers to.
- "it" / "that" / "that one" -> apply to the most recent task.
- "the first one" / "the second one" -> apply to that task by order.
Self-corrections replace earlier info: "due Monday, no wait, Tuesday" -> Tuesday.
"Never mind that one" / "scratch that" -> remove that task.

STEP 3 - Output each task as structured fields:
- text: short imperative phrase, lowercase start, no filler ("I need to",
  "remember to", "um", "like"). One task per real-world thing the person
  needs to do. Never split one request into multiple tasks, and never invent
  extra tasks.
- priority: only if urgency is stated: urgent/asap/important/high -> "A",
  medium/soon -> "B", low/whenever/someday -> "C". Otherwise null.
  Do not invent a priority.
- project: a named project or area (e.g. "cooking", "programming", "chore").
  One word, lowercase, no spaces, no "+" sign. Only when the person names or
  clearly implies one. Otherwise null.
- context: a place or situation (e.g. "home", "work", "to-buy" for shopping).
  One word, lowercase, no "@" sign. Only when the person names or clearly
  implies one. Otherwise null.
- due: only if a date or deadline is stated or clearly implied, as
  YYYY-MM-DD using the date table below. "this weekend" -> Saturday.
  "end of week" -> Friday. "next week" with no day -> next Monday.
  Never invent a due date. Otherwise null.

Today is {today} ({weekday}). Date table:
{dates}

EXAMPLES (assuming today is Monday 2026-01-05):

Input: i need to buy milk and pick up the dry cleaning and um both of those should be done by wednesday
Output: {{"tasks": [
  {{"text": "buy milk", "priority": null, "project": null, "context": "to-buy", "due": "2026-01-07"}},
  {{"text": "pick up dry cleaning", "priority": null, "project": null, "context": null, "due": "2026-01-07"}}
]}}

Input: call the dentist. also email sarah about the report. make the second one urgent
Output: {{"tasks": [
  {{"text": "call the dentist", "priority": null, "project": null, "context": null, "due": null}},
  {{"text": "email sarah about the report", "priority": "A", "project": null, "context": null, "due": null}}
]}}

Input: work on the recipe app tomorrow and fix the login bug, actually make them both due friday, they're for my programming project
Output: {{"tasks": [
  {{"text": "work on the recipe app", "priority": null, "project": "programming", "context": null, "due": "2026-01-09"}},
  {{"text": "fix the login bug", "priority": null, "project": "programming", "context": null, "due": "2026-01-09"}}
]}}

Input: vacuum, do laundry, and clean the bathroom this weekend. oh scratch the bathroom
Output: {{"tasks": [
  {{"text": "vacuum", "priority": null, "project": "chore", "context": null, "due": "2026-01-10"}},
  {{"text": "do laundry", "priority": null, "project": "chore", "context": null, "due": "2026-01-10"}}
]}}

Input: remind me to pay rent on the first, it's really important
Output: {{"tasks": [
  {{"text": "pay rent", "priority": "A", "project": null, "context": null, "due": "2026-02-01"}}
]}}

Input: get eggs and flour for the focaccia
Output: {{"tasks": [
  {{"text": "buy eggs", "priority": null, "project": "cooking", "context": "to-buy", "due": null}},
  {{"text": "buy flour", "priority": null, "project": "cooking", "context": "to-buy", "due": null}}
]}}"""

# JSON schema the model is forced to follow (Ollama "format" parameter).
# The model can only fill in these fields - it can never write a raw line,
# so parentheses/formatting bugs are impossible.
TASK_SCHEMA = {
    "type": "object",
    "properties": {
        "tasks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "priority": {"type": ["string", "null"], "enum": ["A", "B", "C", None]},
                    "project": {"type": ["string", "null"]},
                    "context": {"type": ["string", "null"]},
                    "due": {"type": ["string", "null"]},
                },
                "required": ["text", "priority", "project", "context", "due"],
            },
        }
    },
    "required": ["tasks"],
}


def date_table(today):
    rows = [f"today = {today.isoformat()} ({today.strftime('%A')})"]
    for i in range(1, 15):
        d = today + datetime.timedelta(days=i)
        label = "tomorrow" if i == 1 else ("this " if i < 7 else "next ") + d.strftime("%A")
        rows.append(f"{label} = {d.isoformat()}")
    return "\n".join(rows)


def to_line(task):
    """Assemble one todo.txt line from structured fields. The model never
    writes the line itself, so the syntax is always valid."""
    text = re.sub(r"\s+", " ", str(task.get("text") or "").strip()).strip("`'\"")
    if not text:
        return None
    parts = []
    pri = task.get("priority")
    if pri in ("A", "B", "C"):
        parts.append(f"({pri})")
    parts.append(text)
    proj = re.sub(r"[^\w-]", "", str(task.get("project") or "").lstrip("+").lower())
    if proj:
        parts.append(f"+{proj}")
    ctx = re.sub(r"[^\w-]", "", str(task.get("context") or "").lstrip("@").lower())
    if ctx:
        parts.append(f"@{ctx}")
    due = str(task.get("due") or "").strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", due):
        parts.append(f"due:{due}")
    return " ".join(parts)


def ask_model(text):
    today = datetime.date.today()
    messages = [
        {"role": "system", "content": SYSTEM.format(
            today=today.isoformat(), weekday=today.strftime("%A"), dates=date_table(today))},
        {"role": "user", "content": "Input: " + text + "\nOutput (JSON only, nothing else):"},
    ]
    t0 = time.time()
    print(f"  -> asking {args.model}: {text!r}", flush=True)
    if ":11434" in args.llm_url:
        # Ollama native API: lets us switch off Qwen's slow "thinking" mode
        # and force the output to match TASK_SCHEMA.
        url = args.llm_url.split("/v1/")[0].rstrip("/") + "/api/chat"
        body = {"model": args.model, "messages": messages, "stream": False, "think": False,
                "format": TASK_SCHEMA, "keep_alive": "30m",
                "options": {"temperature": 0, "num_ctx": 8192, "num_predict": 800}}
        req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                out = json.load(r)["message"].get("content") or ""
        except urllib.error.HTTPError as e:
            msg = e.read().decode(errors="replace")
            if "think" not in msg:
                raise RuntimeError(f"Ollama said: {msg[:200]}")
            # model doesn't support the think switch — retry without it
            body.pop("think")
            req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=90) as r:
                out = json.load(r)["message"].get("content") or ""
    else:
        # LM Studio / other OpenAI-compatible servers
        body = {"model": args.model, "temperature": 0, "messages": messages,
                "response_format": {"type": "json_schema",
                                    "json_schema": {"name": "tasks", "schema": TASK_SCHEMA}}}
        req = urllib.request.Request(args.llm_url, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                out = json.load(r)["choices"][0]["message"]["content"] or ""
        except urllib.error.HTTPError:
            # server doesn't support json_schema — retry with plain json mode
            body["response_format"] = {"type": "json_object"}
            req = urllib.request.Request(args.llm_url, data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=90) as r:
                out = json.load(r)["choices"][0]["message"]["content"] or ""
    print(f"  <- model answered in {time.time() - t0:.1f}s:\n{out}", flush=True)
    # drop reasoning and anything after a leaked chat-template token
    out = re.sub(r"<think>.*?</think>", "", out, flags=re.S)
    if "</think>" in out:
        out = out.rsplit("</think>", 1)[1]
    out = re.split(r"<\|[a-z_]+\|>", out)[0].strip()
    try:
        tasks = json.loads(out).get("tasks", [])
    except json.JSONDecodeError:
        # last resort: grab the first {...} block
        m = re.search(r"\{.*\}", out, flags=re.S)
        tasks = json.loads(m.group(0)).get("tasks", []) if m else []
    lines = []
    for t in tasks:
        line = to_line(t)
        if line:
            lines.append(line)
    return lines


def fpath(name):
    """Resolve a .txt file name inside the todo.txt folder (no paths allowed)."""
    folder = os.path.dirname(os.path.abspath(args.file))
    if not name: return os.path.abspath(args.file)
    name = os.path.basename(str(name).strip())
    if not name.endswith(".txt"): name += ".txt"
    if not re.fullmatch(r"[\w .-]+\.txt", name): raise ValueError("Bad file name")
    return os.path.join(folder, name)


def list_files():
    folder = os.path.dirname(os.path.abspath(args.file))
    return sorted(f for f in os.listdir(folder) if f.endswith(".txt"))


def file_uses_dates(path=None):
    """True if existing lines consistently start with a creation date."""
    try:
        with open(path or args.file, encoding="utf-8") as f:
            lines = [l for l in f if l.strip()]
    except FileNotFoundError:
        return False
    if not lines:
        return False
    pat = re.compile(r"^(\([A-Z]\) )?\d{4}-\d{2}-\d{2} ")
    return sum(1 for l in lines if pat.match(l)) >= len(lines) / 2


def add_date(line, path=None):
    # Only prepend a creation date when the file already uses them.
    if not file_uses_dates(path):
        return line
    d = datetime.date.today().isoformat()
    m = re.match(r"^(\([A-Z]\) )(.*)$", line)
    return f"{m.group(1)}{d} {m.group(2)}" if m else f"{d} {line}"


def transcribe(wav):
    """Send 16 kHz mono 16-bit WAV to whisper.cpp server, return text."""
    bnd = "----todohelper" + str(datetime.datetime.now().timestamp()).replace(".", "")
    parts = []
    for k, v in (("response_format", "json"), ("temperature", "0.0")):
        parts.append(f'--{bnd}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f'--{bnd}\r\nContent-Disposition: form-data; name="file"; filename="voice.wav"\r\n'
                 f'Content-Type: audio/wav\r\n\r\n'.encode() + wav + b"\r\n")
    parts.append(f"--{bnd}--\r\n".encode())
    req = urllib.request.Request(args.whisper_url, data=b"".join(parts),
                                 headers={"Content-Type": f"multipart/form-data; boundary={bnd}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r).get("text", "").strip()


class H(BaseHTTPRequestHandler):
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def reply(self, code, data):
        b = json.dumps(data).encode()
        self.send_response(code); self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)

    def authed(self):
        if not args.token:
            return True
        return self.headers.get("Authorization") == f"Bearer {args.token}"

    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.end_headers()

    def do_GET(self):
        if not self.authed(): return self.reply(401, {"error": "Wrong token"})
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        self.path = u.path
        if self.path == "/health": return self.reply(200, {"ok": True, "model": args.model})
        if self.path == "/files":
            return self.reply(200, {"files": list_files(), "default": os.path.basename(args.file)})
        if self.path in ("/file", "/recent"):
            try:
                path = fpath(q.get("name", [""])[0])
            except ValueError as e:
                return self.reply(400, {"error": str(e)})
            try:
                with open(path, encoding="utf-8") as f:
                    lines = [l.rstrip("\n") for l in f if l.strip()]
            except FileNotFoundError:
                lines = []
            if self.path == "/recent":
                return self.reply(200, {"lines": lines[-10:][::-1]})
            return self.reply(200, {"lines": lines})
        self.reply(404, {"error": "Not found"})

    def do_POST(self):
        if not self.authed(): return self.reply(401, {"error": "Wrong token"})
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        self.path = u.path
        if self.path not in ("/add", "/save", "/voice", "/new"): return self.reply(404, {"error": "Not found"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            path = fpath(q.get("name", [""])[0])
            if self.path == "/voice":
                text = transcribe(self.rfile.read(n))
                if not text: return self.reply(400, {"error": "Didn't catch that"})
                lines = [add_date(l, path) for l in ask_model(text)]
                with open(path, "a", encoding="utf-8") as f:
                    for l in lines: f.write(l + "\n")
                return self.reply(200, {"heard": text, "added": lines})
            data = json.loads(self.rfile.read(n) or b"{}")
            if self.path == "/new":
                newp = fpath(data.get("name", ""))
                if not data.get("name") or os.path.exists(newp):
                    return self.reply(400, {"error": "That file already exists" if data.get("name") else "Give it a name"})
                open(newp, "w", encoding="utf-8").close()
                return self.reply(200, {"name": os.path.basename(newp), "files": list_files()})
            if self.path == "/save":
                text = str(data.get("text", ""))
                lines = [l.rstrip("\n") for l in text.split("\n")]
                while lines and not lines[-1].strip(): lines.pop()
                with open(path, "w", encoding="utf-8") as f:
                    for l in lines: f.write(l + "\n")
                return self.reply(200, {"lines": [l for l in lines if l.strip()]})
            text = str(data.get("text", "")).strip()
            if not text: return self.reply(400, {"error": "Nothing to add"})
            lines = [text] if data.get("raw") else ask_model(text)
            lines = [add_date(l, path) for l in lines]
            with open(path, "a", encoding="utf-8") as f:
                for l in lines: f.write(l + "\n")
            self.reply(200, {"added": lines})
        except Exception as e:
            traceback.print_exc()
            msg = str(e)
            if "timed out" in msg:
                msg = "The model took too long to answer (over 90s). Is Ollama running on the GPU?"
            elif "10061" in msg or "refused" in msg:
                msg = "Couldn't reach Ollama or whisper on the PC. Is it running?"
            try:
                self.reply(500, {"error": f"Helper error: {msg}"})
            except Exception:
                pass


print(f"Todo helper on port {args.port} -> {args.file} (model {args.model})")
ThreadingHTTPServer(("0.0.0.0", args.port), H).serve_forever()
