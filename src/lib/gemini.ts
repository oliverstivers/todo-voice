// Direct browser -> Google Gemini (free AI Studio key, stored on this device).
// Gemini transcribes audio and returns structured tasks; we build the todo.txt lines.

export const DEFAULT_MODELS = ["gemini-3.8-flash", "gemini-3.8-flash-lite", "gemini-3-flash", "gemini-3-pro"];
const API = "https://generativelanguage.googleapis.com/v1beta";

// Ask Google which models this key can use for generateContent.
export async function listModels(key: string): Promise<string[]> {
  const r = await fetch(`${API}/models?pageSize=200&key=${encodeURIComponent(key)}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `Gemini error ${r.status}`);
  return (d.models || [])
    .filter((m: any) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m: any) => String(m.name).replace(/^models\//, ""))
    .filter((n: string) => /^gemini-/.test(n) && !/(image|tts|embedding|live|audio)/.test(n))
    .sort((a: string, b: string) => b.localeCompare(a, undefined, { numeric: true }));
}

type Task = { text: string; priority: string | null; project: string | null; context: string | null; when?: string | null; due: string | null };

// The user's own clock + time zone, so "today" means their today, not UTC's.
export function localNow() {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  const time = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return { now, tz, text: `${wd(now)}, ${iso(now)}, ${time} (time zone ${tz})` };
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const wd = (d: Date) => d.toLocaleDateString("en-US", { weekday: "long" });

function dateTable(today: Date) {
  const rows = [`today = ${iso(today)} (${wd(today)})`];
  for (let i = 1; i <= 21; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    rows.push(`${iso(d)} = ${wd(d)}, in ${i} day${i > 1 ? "s" : ""}${i === 1 ? " (tomorrow)" : ""}`);
  }
  return rows.join("\n");
}

function system(today: Date) {
  return `You turn a person's spoken or typed words into todo.txt tasks.
The input is a raw transcript: rambling, filler, self-corrections and references back to earlier things are normal.

1. Understand the WHOLE input first. Find the distinct real-world tasks, then which details belong to which task.
2. Resolve references: "both", "them", "those", "all of them" apply to every task referred to; "it", "that one" to the most recent; "the first/second one" by order. These are NEVER new tasks. Self-corrections replace earlier info. "Scratch that"/"never mind" removes that task.
3. Fields:
- text: short imperative phrase, lowercase start, no filler. One task per real-world thing. Never invent tasks.
- priority: "A" for urgent/asap/important/high, "B" medium/soon, "C" low/whenever. Otherwise null.
- project: one lowercase word, no "+", only if named or clearly implied (e.g. chore, cooking). Otherwise null.
- context: one lowercase word, no "@", only if named or clearly implied (home, work, to-buy). Otherwise null.
- when: the exact date words that apply to this task, copied from the input ("today", "friday", "next week", "the 12th"). If a date is said for a group ("those all should be due today", "both by friday"), copy it onto EVERY task in that group. null if no date applies.
- due: the "when" converted to YYYY-MM-DD using the date table, whenever ANY date or day is mentioned for the task (including "today", "tomorrow", a weekday). If the date applies to "all"/"both"/"those", set it on EVERY one of those tasks. Otherwise null.

DATES - read carefully, copy the date from the table, never compute it yourself:
- A bare weekday ("friday", "on friday", "this friday", "by friday") = the FIRST upcoming row with that weekday (never today).
- "next <weekday>" = the same as a bare weekday, UNLESS that day is within 2 days, then use the following week's one.
- "<weekday> next week" or "a week from <weekday>" = the first upcoming weekday plus 7 days.
- "today"/"tonight"/"by end of day" = ${iso(today)}. "tomorrow" = 1 day; "in N days" = N days; "next week" with no day = next Monday; "this weekend" = upcoming Saturday; "end of the week" = upcoming Friday.

Today is ${localNow().text}. All dates are in this time zone. Date table:
${dateTable(today)}

Also return "heard": the exact transcript of what the person said (or the typed text).`;
}

const SCHEMA = {
  type: "OBJECT",
  properties: {
    heard: { type: "STRING" },
    tasks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          text: { type: "STRING" },
          priority: { type: "STRING", enum: ["A", "B", "C"], nullable: true },
          project: { type: "STRING", nullable: true },
          context: { type: "STRING", nullable: true },
          when: { type: "STRING", nullable: true },
          due: { type: "STRING", nullable: true },
        },
        required: ["text", "when", "due"],
        propertyOrdering: ["text", "priority", "project", "context", "when", "due"],
      },
    },
  },
  required: ["heard", "tasks"],
};

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// Turn whatever the model gave (ISO date or spoken words) into YYYY-MM-DD in the user's local time.
export function normDue(v: unknown): string | null {
  const s = String(v || "").trim().toLowerCase();
  if (!s || s === "null") return null;
  const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  const d = new Date();
  const add = (n: number) => (d.setDate(d.getDate() + n), iso(d));
  if (/\b(today|tonight|end of (the )?day|eod|this (morning|afternoon|evening))\b/.test(s)) return iso(d);
  if (/\btomorrow\b/.test(s)) return add(1);
  const inN = s.match(/\bin (\d+) days?\b/);
  if (inN) return add(Number(inN[1]));
  if (/\bend of (the )?week\b/.test(s)) return add(((5 - d.getDay() + 7) % 7) || 7);
  if (/\b(this )?weekend\b/.test(s)) return add(((6 - d.getDay() + 7) % 7) || 7);
  const day = DAYS.findIndex((n) => s.includes(n));
  if (day >= 0) {
    let n = ((day - d.getDay() + 7) % 7) || 7;
    if (/\bnext week\b/.test(s) || (/\bnext\b/.test(s) && n <= 2)) n += 7;
    return add(n);
  }
  if (/\bnext week\b/.test(s)) return add(((1 - d.getDay() + 7) % 7) || 7);
  return null;
}

function toLine(t: Task) {
  const text = String(t.text || "").replace(/\s+/g, " ").trim().replace(/^[("'`]+|[)"'`]+$/g, "");
  if (!text) return null;
  const parts: string[] = [];
  if (t.priority && /^[ABC]$/.test(t.priority)) parts.push(`(${t.priority})`);
  parts.push(text);
  const proj = String(t.project || "").replace(/^\+/, "").toLowerCase().replace(/[^\w-]/g, "");
  if (proj) parts.push(`+${proj}`);
  const ctx = String(t.context || "").replace(/^@/, "").toLowerCase().replace(/[^\w-]/g, "");
  if (ctx) parts.push(`@${ctx}`);
  const due = normDue(t.due) || normDue(t.when);
  if (due) parts.push(`due:${due}`);
  return parts.join(" ");
}

async function toBase64(b: Blob) {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

// model "auto" walks through the list, skipping models that are busy or unavailable.
export async function geminiParse(
  key: string,
  input: { text?: string; wav?: Blob; edit?: string[] },
  model = "auto",
  models: string[] = DEFAULT_MODELS,
) {
  const order = model === "auto" ? models : [model];
  let last: Error = new Error("No Gemini model available");
  for (const m of order) {
    try {
      return await callModel(key, input, m);
    } catch (e: any) {
      last = e;
      if (model !== "auto" || !e.retry) throw e;
    }
  }
  throw last;
}

async function callModel(key: string, input: { text?: string; wav?: Blob; edit?: string[] }, MODEL: string) {
  const local = localNow();
  const today = local.now;
  const parts: any[] = [{ text: `Right now for this person it is ${local.text}. "Today" = ${iso(today)}. Use this for every relative date.` }];
  if (input.edit) {
    parts.push({
      text:
        "EDIT MODE. Here is a proposed list of todo.txt tasks, one per line:\n" +
        input.edit.join("\n") +
        "\n\nThe voice note (or text) below says what is wrong. Return this SAME list of tasks exactly as-is, " +
        "changing ONLY what the correction asks for (fix wording, priority, project, context, due date, remove or add a task only if asked). " +
        "Keep every other task and field identical. Put the correction's transcript in \"heard\".",
    });
    if (input.wav) parts.push({ inline_data: { mime_type: "audio/wav", data: await toBase64(input.wav) } });
    else parts.push({ text: "Correction: " + input.text });
  } else if (input.wav) {
    parts.push({ inline_data: { mime_type: "audio/wav", data: await toBase64(input.wav) } });
    parts.push({ text: "Transcribe this voice note, then extract the tasks." });
  } else {
    parts.push({ text: "Input: " + input.text });
  }
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system(today) }] },
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
          ...(/flash/.test(MODEL) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      }),
    },
  );
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = d?.error?.message || "";
    const busy = r.status === 429 || r.status === 503 || r.status === 500 || r.status === 404 || /no longer available|not found/i.test(msg);
    const err: any = new Error(
      r.status === 429
        ? `${MODEL}: free limit hit — wait a minute or pick another model`
        : r.status === 503
          ? `${MODEL} is busy right now — try another model`
          : r.status === 403
            ? "Gemini key rejected — check it in settings"
            : `${MODEL}: ${msg || `error ${r.status}`}`,
    );
    err.retry = busy;
    throw err;
  }
  const raw = d?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "{}";
  let out: { heard?: string; tasks?: Task[] } = {};
  try {
    out = JSON.parse(raw);
  } catch {}
  console.debug("[gemini]", MODEL, local.text, out);
  const lines = (out.tasks || []).map(toLine).filter(Boolean) as string[];
  return { heard: out.heard || input.text || "", lines, model: MODEL };
}
