import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Mic, Send, Check, Plug, X, Plus, ChevronDown, ChevronRight } from "lucide-react";
import { startWavRecording, type Recorder } from "@/lib/wav-recorder";
import { geminiParse, listModels, DEFAULT_MODELS } from "@/lib/gemini";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "todo.txt hub — speak, view and edit" },
      { name: "description", content: "Speak, view and edit todo.txt on your PC from your phone." },
      { property: "og:title", content: "todo.txt hub" },
      { property: "og:description", content: "Speak, view and edit todo.txt on your PC from your phone." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

const CFG_KEY = "todo-voice-cfg";
// Paste your cloudflared tunnel URL here so demo visitors connect automatically
// (run on your PC: cloudflared tunnel --url http://localhost:8765)
const DEFAULT_URL = "";
type Cfg = { url: string; token: string; gemini: string; model?: string; models?: string[] | undefined };
let cfg: Cfg = { url: "", token: "", gemini: "", model: "auto" };
const gm = () => cfg.models?.length ? cfg.models : DEFAULT_MODELS;
const FILE_KEY = "todo-voice-file";
let currentFile = "todo.txt";
const q = () => `?name=${encodeURIComponent(currentFile)}`;
const base = () => cfg.url.trim().replace(/\/+$/, "");
const headers = () => ({
  ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
  "Content-Type": "application/json",
});

function Index() {
  const [listening, setListening] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const [pending, setPending] = useState<string[]>([]);

  // file view state
  const [fileLines, setFileLines] = useState<string[] | null>(null);
  const [fileName, setFileName] = useState("todo.txt");
  const [files, setFiles] = useState<string[]>(["todo.txt"]);
  const [fileMenu, setFileMenu] = useState(false);
  const [newName, setNewName] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [newTask, setNewTask] = useState({ text: "", pri: "", due: "" });
  const [showDone, setShowDone] = useState(false);
  const groups = useMemo(() => {
    const all = (fileLines || []).map(parseTask);
    const open = all.filter((t) => !t.done);
    return {
      open,
      pri: open.filter((t) => t.pri).sort((a, b) => a.pri.localeCompare(b.pri)),
      rest: open.filter((t) => !t.pri),
      done: all.filter((t) => t.done),
    };
  }, [fileLines]);
  const recRef = useRef<Recorder | null>(null);
  const editRef = useRef<Recorder | null>(null);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<{ wav: Blob; edit?: string[] | undefined } | null>(null);
  const [connOpen, setConnOpen] = useState(false);
  const [form, setForm] = useState<Cfg>({ url: "", token: "", gemini: "" });
  const [conn, setConn] = useState<"unknown" | "ok" | "bad">("unknown");
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    try {
      cfg = { ...cfg, ...JSON.parse(localStorage.getItem(CFG_KEY) || "{}") };
    } catch {}
    if (!cfg.url && DEFAULT_URL) {
      cfg.url = DEFAULT_URL;
      localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    }
    setForm(cfg);
    currentFile = localStorage.getItem(FILE_KEY) || "todo.txt";
    setFileName(currentFile);
    if (!cfg.url) {
      if (!cfg.gemini) setConnOpen(true);
      setFileLines([]);
      return;
    }
    testConn(cfg);
    loadFile();
  }, []);

  async function testConn(c: Cfg) {
    setTesting(true);
    try {
      const r = await fetch(`${c.url.trim().replace(/\/+$/, "")}/health`, {
        headers: c.token ? { Authorization: `Bearer ${c.token}` } : {},
      });
      setConn(r.ok ? "ok" : "bad");
      return r.ok;
    } catch {
      setConn("bad");
      return false;
    } finally {
      setTesting(false);
    }
  }

  async function saveConn() {
    cfg = { url: form.url.trim(), token: form.token, gemini: form.gemini.trim(), model: form.model || "auto", models: form.models };
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    if (!cfg.url) {
      setConn("unknown");
      setConnOpen(false);
      return;
    }
    if (await testConn(cfg)) {
      setConnOpen(false);
      loadFile();
    }
  }

  // Write already-parsed lines to the PC (raw mode). Without a PC, keep them on screen only.
  async function commit(lines: string[]) {
    if (base()) {
      for (const l of lines) {
        const r = await fetch(`${base()}/add${q()}`, { method: "POST", headers: headers(), body: JSON.stringify({ text: l, raw: true }) });
        if (!r.ok) throw new Error("Parsed, but couldn't write to your PC");
      }
      loadFile();
    } else {
      setFileLines((f) => [...(f || []), ...lines]);
    }
    setAdded((a) => [...lines, ...a].slice(0, 12));
    setStatus({ ok: true, msg: lines.length ? `Added ${lines.length}` : "No tasks found" });
  }

  async function send(t: string) {
    if (!t.trim()) return;
    setBusy(true);
    setStatus(null);
    try {
      if (cfg.gemini) {
        const { lines } = await geminiParse(cfg.gemini, { text: t }, cfg.model || "auto", gm());
        setStatus({ ok: true, msg: lines.length ? "Check the list, then confirm" : "No tasks found" });
        setPending(lines);
        setText("");
        return;
      }
      const r = await fetch(`${base()}/add${q()}`, { method: "POST", headers: headers(), body: JSON.stringify({ text: t }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
      setAdded((a) => [...d.added, ...a].slice(0, 12));
      setStatus({ ok: true, msg: `Added ${d.added.length}` });
      setText("");
      loadFile();
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message === "Failed to fetch" ? "Can't reach your PC" : e.message });
    } finally {
      setBusy(false);
    }
  }

  async function loadFile() {
    if (!base()) return;
    try {
      const r = await fetch(`${base()}/file${q()}`, { headers: headers() });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
      setConn("ok");
      setFileLines(d.lines || []);
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message === "Failed to fetch" ? "Can't reach your PC" : e.message });
    }
  }

  async function loadFiles() {
    if (!base()) {
      setFiles((f) => (f.includes(currentFile) ? f : [currentFile, ...f]));
      return;
    }
    try {
      const r = await fetch(`${base()}/files`, { headers: headers() });
      const d = await r.json();
      if (r.ok) setFiles(d.files || []);
    } catch {}
  }

  function switchFile(f: string) {
    currentFile = f;
    localStorage.setItem(FILE_KEY, f);
    setFileName(f);
    setFileMenu(false);
    setAdded([]);
    setPending([]);
    if (base()) {
      setFileLines(null);
      loadFile();
    } else setFileLines([]);
  }

  async function createFile() {
    let name = newName.trim();
    if (!name) return;
    if (!name.endsWith(".txt")) name += ".txt";
    if (base()) {
      try {
        const r = await fetch(`${base()}/new`, { method: "POST", headers: headers(), body: JSON.stringify({ name }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
        setFiles(d.files || []);
        name = d.name;
      } catch (e: any) {
        setStatus({ ok: false, msg: e.message === "Failed to fetch" ? "Can't reach your PC" : e.message });
        return;
      }
    } else setFiles((f) => [...f, name]);
    setNewName("");
    switchFile(name);
  }

  async function toggleEdit() {
    if (editing && editRef.current) {
      const rec = editRef.current;
      editRef.current = null;
      setEditing(false);
      const wav = await rec.stop();
      setBusy(true);
      setStatus(null);
      try {
        await sendVoice(wav, pending);
      } catch (e: any) {
        setStatus({ ok: false, msg: e.message });
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      setStatus(null);
      editRef.current = await startWavRecording();
      setEditing(true);
    } catch {
      setStatus({ ok: false, msg: "Mic blocked — allow microphone access" });
    }
  }

  // The recording is kept until Gemini answers, so a busy model doesn't mean re-speaking.
  async function sendVoice(wav: Blob, edit?: string[]) {
    setSaved({ wav, edit });
    const { heard, lines } = await geminiParse(cfg.gemini, edit ? { wav, edit } : { wav }, cfg.model || "auto", gm());
    setSaved(null);
    if (edit) {
      setPending(lines);
      setStatus({ ok: true, msg: lines.length ? "Edited — check the list, then confirm" : "No tasks left" });
    } else {
      setText(heard);
      setPending(lines);
      setStatus({ ok: true, msg: lines.length ? "Check the list, then confirm" : "No tasks found" });
    }
  }

  async function resend() {
    if (!saved) return;
    setBusy(true);
    setStatus(null);
    try {
      await sendVoice(saved.wav, saved.edit);
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function toggleMic() {
    if (listening && recRef.current) {
      const rec = recRef.current;
      recRef.current = null;
      setListening(false);
      const wav = await rec.stop();
      setBusy(true);
      setStatus(null);
      try {
        if (cfg.gemini) {
          await sendVoice(wav);
          return;
        }
        const r = await fetch(`${base()}/voice${q()}`, {
          method: "POST",
          headers: {
            ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
            "Content-Type": "audio/wav",
          },
          body: wav,
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
        setText(d.heard || "");
        setAdded((a) => [...d.added, ...a].slice(0, 12));
        setStatus({ ok: true, msg: `Added ${d.added.length}` });
        loadFile();
      } catch (e: any) {
        setStatus({ ok: false, msg: e.message === "Failed to fetch" ? "Can't reach your PC" : e.message });
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      setStatus(null);
      setText("");
      recRef.current = await startWavRecording();
      setListening(true);
    } catch {
      setStatus({ ok: false, msg: "Mic blocked — allow microphone access" });
    }
  }

  return (
    <main className="mx-auto min-h-[100dvh] max-w-md px-4 pb-8 pt-4">
      <header className="border-b-2 border-foreground pb-2">
        <div className="relative flex items-center justify-between">
          <button
            onClick={() => {
              setFileMenu((o) => !o);
              loadFiles();
            }}
            aria-label="Switch file"
            className="flex items-center gap-1 border border-transparent px-1 py-0.5 font-mono text-sm font-bold hover:border-foreground"
          >
            {fileName}
            <ChevronDown size={14} className={fileMenu ? "rotate-180" : ""} />
          </button>
          {fileMenu && (
            <div className="absolute left-0 top-full z-10 mt-1 w-60 border border-foreground bg-card text-sm">
              <ul className="max-h-60 overflow-auto">
                {files.map((f) => (
                  <li key={f}>
                    <button
                      onClick={() => switchFile(f)}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-xs hover:bg-secondary ${f === fileName ? "font-bold" : ""}`}
                    >
                      <span className="w-3">{f === fileName && <Check size={12} />}</span>
                      {f}
                    </button>
                  </li>
                ))}
              </ul>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  createFile();
                }}
                className="flex gap-1 border-t border-foreground p-2"
              >
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="new-file.txt"
                  autoCapitalize="off"
                  className="min-w-0 flex-1 border border-foreground bg-background px-2 py-1 font-mono text-xs outline-none"
                />
                <button
                  type="submit"
                  disabled={!newName.trim()}
                  aria-label="Create file"
                  className="flex items-center border border-foreground bg-primary px-2 text-primary-foreground disabled:opacity-40"
                >
                  <Plus size={14} />
                </button>
              </form>
            </div>
          )}
          <button
            onClick={() => setConnOpen((o) => !o)}
            aria-label="Connect to PC"
            className="flex items-center gap-1.5 border border-foreground px-2 py-1 text-xs"
          >
            <span
              className={`h-2 w-2 ${conn === "ok" ? "bg-success" : conn === "bad" ? "bg-destructive" : "bg-muted-foreground"}`}
            />
            <Plug size={14} />
          </button>
        </div>
        {connOpen && (
          <div className="mt-2 border border-foreground bg-card p-3 text-sm">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-bold">Connect to PC</span>
              <button onClick={() => setConnOpen(false)} aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <label className="mb-1 block text-xs text-muted-foreground">Helper address</label>
            <input
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://mypc.tailnet.ts.net"
              autoCapitalize="off"
              className="mb-2 w-full border border-foreground bg-background px-2 py-1.5 font-mono text-xs outline-none focus:border-ring"
            />
            <label className="mb-1 block text-xs text-muted-foreground">
              Gemini key (free at aistudio.google.com) — parses voice in the cloud
            </label>
            <input
              value={form.gemini}
              onChange={(e) => setForm({ ...form, gemini: e.target.value })}
              placeholder="AIza…"
              type="password"
              autoCapitalize="off"
              className="mb-2 w-full border border-foreground bg-background px-2 py-1.5 font-mono text-xs outline-none focus:border-ring"
            />
            {form.gemini && (
              <>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Model — "Auto" switches to the next one when Google is busy
                </label>
                <div className="mb-2 flex gap-1">
                  <select
                    value={form.model || "auto"}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    className="min-w-0 flex-1 border border-foreground bg-background px-2 py-1.5 font-mono text-xs outline-none"
                  >
                    <option value="auto">Auto (fallback)</option>
                    {(form.models?.length ? form.models : DEFAULT_MODELS).map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const models = await listModels(form.gemini.trim());
                        setForm((f) => ({ ...f, models }));
                        setStatus({ ok: true, msg: `Found ${models.length} models` });
                      } catch (e: any) {
                        setStatus({ ok: false, msg: e.message });
                      }
                    }}
                    className="border border-foreground px-2 text-xs"
                  >
                    Load list
                  </button>
                </div>
              </>
            )}

            <div className="flex items-center justify-between">
              <span className={`text-xs ${conn === "ok" ? "text-success" : "text-destructive"}`}>
                {conn === "ok" ? "Connected" : conn === "bad" ? "Can't connect" : ""}
              </span>
              <button
                onClick={saveConn}
                disabled={testing || (!form.url && !form.gemini)}
                className="border border-foreground bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
              >
                {testing ? "Testing…" : "Save & connect"}
              </button>
            </div>
          </div>
        )}
      </header>

      <div className="flex flex-col items-center gap-4 py-8">
        <button
          onClick={toggleMic}
          disabled={busy}
          aria-label={listening ? "Stop listening" : "Start speaking"}
          className="relative flex h-28 w-28 items-center justify-center border-2 border-foreground bg-primary text-primary-foreground transition-transform active:translate-y-0.5 disabled:opacity-60"
        >
          {listening && <span className="mic-pulse absolute inset-0 bg-primary" />}
          <Mic size={40} className="relative" />
        </button>
        <p className="h-5 text-sm text-muted-foreground">
          {busy ? "Working…" : listening ? "Recording — tap to send" : "Tap and say a task"}
        </p>
      </div>

      {status && (
        <p className={`mb-3 text-center text-sm ${status.ok ? "text-success" : "text-destructive"}`}>
          {status.msg}
        </p>
      )}

      {saved && !busy && !listening && cfg.gemini && (
        <div className="mb-3 flex flex-wrap items-center justify-center gap-2 border border-foreground p-2 text-sm">
          <span>Recording saved.</span>
          <select
            value={cfg.model || "auto"}
            onChange={(e) => {
              const next = { ...cfg, model: e.target.value };
              cfg = next;
              setForm(next);
              localStorage.setItem(CFG_KEY, JSON.stringify(next));
            }}
            className="border border-foreground bg-background px-2 py-1"
            aria-label="Model"
          >
            <option value="auto">Auto</option>
            {gm().map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <button onClick={resend} className="border border-foreground bg-primary px-3 py-1 text-primary-foreground">
            Resend
          </button>
          <button onClick={() => setSaved(null)} className="border border-foreground px-3 py-1">
            Discard
          </button>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
        className="flex gap-2"
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="…or type it"
          className="flex-1 border border-foreground bg-card px-3 py-2.5 text-sm outline-none focus:border-ring"
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          aria-label="Add"
          className="border border-foreground bg-foreground px-4 text-background disabled:opacity-30"
        >
          <Send size={16} />
        </button>
      </form>

      {added.length > 0 && (
        <ul className="mt-4">
          {added.map((l, i) => (
            <li key={i} className="flex gap-2 py-1 font-mono text-xs text-muted-foreground">
              <Check size={13} className="mt-0.5 shrink-0 text-success" />
              <span className="break-words">{l}</span>
            </li>
          ))}
        </ul>
      )}

      {pending.length > 0 && (
        <div className="mt-4 border border-foreground bg-card p-3">
          <p className="mb-2 text-sm font-bold">Add these {pending.length} task{pending.length === 1 ? "" : "s"}?</p>
          <ul className="mb-3">
            {pending.map((l, i) => (
              <li key={i} className="flex gap-2 py-1 font-mono text-xs">
                <span className="mt-0.5 shrink-0">›</span>
                <span className="break-words">{l}</span>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button
              onClick={async () => {
                const lines = pending;
                setPending([]);
                setBusy(true);
                try {
                  await commit(lines);
                } catch (e: any) {
                  setStatus({ ok: false, msg: e.message === "Failed to fetch" ? "Can't reach your PC" : e.message });
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
              className="border border-foreground bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
            >
              {busy ? "Adding…" : "Confirm"}
            </button>
            <button
              onClick={() => {
                setPending([]);
                setStatus(null);
              }}
              disabled={busy}
              className="border border-foreground px-4 py-1.5 text-sm disabled:opacity-40"
            >
              Cancel
            </button>
            {cfg.gemini && (
              <button
                onClick={toggleEdit}
                disabled={busy && !editing}
                className={`border border-foreground px-4 py-1.5 text-sm disabled:opacity-40 ${editing ? "bg-destructive text-destructive-foreground" : ""}`}
              >
                {editing ? "Done — fix it" : "Edit"}
              </button>
            )}
          </div>
          {editing && <p className="mt-2 text-xs text-muted-foreground">Listening… say what to change, then tap “Done — fix it”.</p>}
        </div>
      )}

      <section className="mt-8 border-t-2 border-foreground pt-3">
        <div className="mb-2 flex items-center justify-between text-xs">
          <span className="text-muted-foreground">
            {fileLines === null ? "" : `${groups.open.length} open · ${groups.done.length} done`}
          </span>
          <div className="flex gap-2">
            <button onClick={loadFile} className="border border-foreground px-2 py-1">
              Refresh
            </button>
            <button
              onClick={() => setAddOpen((o) => !o)}
              aria-label="Add task"
              className="flex items-center border border-foreground bg-primary px-2 py-1 text-primary-foreground"
            >
              {addOpen ? <X size={14} /> : <Plus size={14} />}
            </button>
          </div>
        </div>

        {addOpen && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const t = newTask.text.trim();
              if (!t) return;
              const line = [
                newTask.pri ? `(${newTask.pri})` : "",
                t,
                newTask.due ? `due:${newTask.due}` : "",
              ]
                .filter(Boolean)
                .join(" ");
              setBusy(true);
              try {
                await commit([line]);
                setNewTask({ text: "", pri: "", due: "" });
                setAddOpen(false);
              } catch (err: any) {
                setStatus({ ok: false, msg: err.message });
              } finally {
                setBusy(false);
              }
            }}
            className="mb-3 border border-foreground bg-card p-3 text-sm"
          >
            <input
              autoFocus
              value={newTask.text}
              onChange={(e) => setNewTask({ ...newTask, text: e.target.value })}
              placeholder="Task  (+project @context ok)"
              className="mb-2 w-full border border-foreground bg-background px-2 py-1.5 text-sm outline-none focus:border-ring"
            />
            <div className="flex items-center gap-2">
              <div className="flex">
                {["", "A", "B", "C"].map((p) => (
                  <button
                    key={p || "none"}
                    type="button"
                    onClick={() => setNewTask({ ...newTask, pri: p })}
                    className={`-ml-px border border-foreground px-2 py-1 text-xs first:ml-0 ${newTask.pri === p ? "bg-foreground text-background" : ""}`}
                  >
                    {p || "–"}
                  </button>
                ))}
              </div>
              <input
                type="date"
                value={newTask.due}
                onChange={(e) => setNewTask({ ...newTask, due: e.target.value })}
                aria-label="Due date"
                className="min-w-0 flex-1 border border-foreground bg-background px-2 py-1 text-xs outline-none"
              />
              <button
                type="submit"
                disabled={busy || !newTask.text.trim()}
                className="border border-foreground bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-40"
              >
                Add
              </button>
            </div>
          </form>
        )}

        {fileLines === null ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading file…</p>
        ) : (
          <div className="space-y-4">
            {fileLines.length === 0 && (
              <p className="border border-foreground p-3 font-mono text-xs text-muted-foreground">empty file</p>
            )}
            {groups.pri.length > 0 && <TaskGroup title="Priority" items={groups.pri} />}
            {groups.rest.length > 0 && <TaskGroup title="Tasks" items={groups.rest} />}
            {groups.done.length > 0 && (
              <div>
                <button
                  onClick={() => setShowDone((s) => !s)}
                  className="mb-1 flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-muted-foreground"
                >
                  {showDone ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  Done ({groups.done.length})
                </button>
                {showDone && <TaskGroup items={groups.done} />}
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

type Task = { raw: string; done: boolean; pri: string; text: string; due: string; tags: string[] };

function parseTask(raw: string): Task {
  let s = raw.trim();
  const done = /^x\s/.test(s);
  if (done) s = s.replace(/^x\s+(\d{4}-\d{2}-\d{2}\s+)?/, "");
  const pm = s.match(/^\(([A-Z])\)\s+/);
  const pri = pm?.[1] ?? "";
  if (pm) s = s.slice(pm[0].length);
  s = s.replace(/^\d{4}-\d{2}-\d{2}\s+/, "");
  const dm = s.match(/(?:^|\s)due:(\S+)/);
  const due = dm?.[1] ?? "";
  if (dm) s = s.replace(dm[0], "");
  const tags = s.match(/(?:^|\s)[+@]\S+/g)?.map((t) => t.trim()) || [];
  for (const t of tags) s = s.replace(t, "");
  return { raw, done, pri, due, tags, text: s.replace(/\s+/g, " ").trim() };
}

function TaskGroup({ title, items }: { title?: string; items: Task[] }) {
  return (
    <div>
      {title && (
        <div className="mb-1 text-xs font-bold uppercase tracking-wide text-muted-foreground">
          {title} ({items.length})
        </div>
      )}
      <ul className="divide-y divide-border border border-foreground bg-card">
        {items.map((t, i) => (
          <li key={i} className="flex gap-2 px-2 py-2 text-sm">
            {t.pri ? (
              <span
                className={`h-5 w-5 shrink-0 border border-foreground text-center font-mono text-xs leading-[18px] ${t.pri === "A" ? "bg-destructive text-destructive-foreground" : t.pri === "B" ? "bg-primary text-primary-foreground" : "bg-secondary"}`}
              >
                {t.pri}
              </span>
            ) : (
              <span className="w-5 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className={`break-words ${t.done ? "text-muted-foreground line-through" : ""}`}>{t.text || t.raw}</div>
              {(t.tags.length > 0 || t.due) && (
                <div className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-[11px] text-muted-foreground">
                  {t.tags.map((g) => (
                    <span key={g} className={g.startsWith("+") ? "text-primary" : ""}>{g}</span>
                  ))}
                  {t.due && <span className={!t.done && t.due < today() ? "text-destructive" : ""}>due {t.due}</span>}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const today = () => new Date().toLocaleDateString("en-CA");
