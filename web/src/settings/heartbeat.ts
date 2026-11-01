// Heartbeat: what Trinity does on a schedule — one-time reminders ("remind me
// in ten minutes to stretch") and recurring tasks ("every morning at eight,
// brief me on the news"). Reminders are spoken in the live call when due (and
// shown in the transcript and the workspace); recurring tasks run as a turn of
// their own. Toggle, edit inline, delete, and add new ones.

import { api, type HeartbeatInput, type HeartbeatPatch, type HeartbeatTask } from "./api.js";
import { announce } from "./channel.js";
import { heartbeatRes } from "./store.js";
import {
  button,
  clockTime,
  confirmAction,
  emptyState,
  errorState,
  field,
  fmtInterval,
  fullDateTime,
  h,
  icon,
  plural,
  relTime,
  sectionHead,
  segmented,
  setChildren,
  skeletonLines,
  switchInput,
  toast,
  uid,
  whenInWords,
  withBusy,
  type Section,
} from "./ui.js";

const UNITS = [
  { id: "min", label: "minutes", sec: 60 },
  { id: "hour", label: "hours", sec: 3600 },
  { id: "day", label: "days", sec: 86400 },
] as const;
type UnitId = (typeof UNITS)[number]["id"];

const PRESETS: { label: string; sec: number }[] = [
  { label: "5 min", sec: 300 },
  { label: "15 min", sec: 900 },
  { label: "30 min", sec: 1800 },
  { label: "Hourly", sec: 3600 },
  { label: "Every 6 h", sec: 21600 },
  { label: "Daily", sec: 86400 },
];

const MIN_INTERVAL = 60;
/** The schedule tool's limit (server/src/tools/schedule.ts), so what's set by voice can be set here too. */
const MAX_INTERVAL = 31 * 86400;
const MAX_AHEAD_MS = 366 * 86400_000;
/** How far the engine's first run may drift from the time asked for before we set it explicitly. */
const RUN_AT_SLACK_MS = 60_000;

function bestUnit(sec: number): { n: number; unit: UnitId } {
  if (sec >= 86400 && sec % 86400 === 0) return { n: sec / 86400, unit: "day" };
  if (sec >= 3600 && sec % 3600 === 0) return { n: sec / 3600, unit: "hour" };
  return { n: Math.max(1, Math.round(sec / 60)), unit: "min" };
}

function unitSelect(label: string): HTMLSelectElement {
  return h("select", { class: "select", "aria-label": label }, UNITS.map((u) => h("option", { value: u.id }, u.label)));
}

function unitSec(sel: HTMLSelectElement): number {
  return (UNITS.find((x) => x.id === sel.value) ?? UNITS[0]).sec;
}

/** Number + unit + preset chips. `id` goes on the number input (for the field label). */
function intervalControl(initialSec: number, id: string, onChange?: () => void) {
  const { n, unit } = bestUnit(initialSec);
  const num = h("input", { class: "input", id, type: "number", min: "1", step: "1", value: String(n), inputMode: "numeric" });
  const sel = unitSelect("Interval unit");
  sel.value = unit;
  const presetButtons = PRESETS.map((p) =>
    h(
      "button",
      {
        type: "button",
        class: "preset",
        onclick: () => {
          set(p.sec);
          onChange?.();
        },
      },
      p.label,
    ),
  );
  const syncPresets = () => {
    const sec = get();
    presetButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(PRESETS[i]!.sec === sec)));
  };
  const get = (): number | null => {
    const v = Number(num.value);
    if (!Number.isFinite(v) || v <= 0) return null;
    return Math.round(v * unitSec(sel));
  };
  const set = (sec: number) => {
    const b = bestUnit(sec);
    num.value = String(b.n);
    sel.value = b.unit;
    syncPresets();
  };
  num.addEventListener("input", () => {
    syncPresets();
    onChange?.();
  });
  sel.addEventListener("change", () => {
    syncPresets();
    onChange?.();
  });
  syncPresets();
  const el = h(
    "div",
    { class: "interval" },
    h("div", { class: "interval-row" }, h("span", { class: "interval-every" }, "Every"), num, sel),
    h("div", { class: "presets", role: "group", "aria-label": "Interval presets" }, presetButtons),
  );
  return { el, get, set, focus: () => num.focus() };
}

/** "YYYY-MM-DDTHH:MM" in local time, for <input type="datetime-local">. */
function localInputValue(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The next time the clock reads HH:MM (today, or tomorrow if that's already past). */
function nextAtClock(hhmm: string, now = Date.now()): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= now + 30_000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Tomorrow at 9:00 local time. */
function tomorrowAt(hour: number): number {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/** When a reminder fires: "in N minutes/hours/days" or "at <date & time>". */
function whenControl(initial: { inSec?: number; at?: number }, id: string, onChange: () => void) {
  const mode = segmented({
    label: "When",
    value: initial.at ? "at" : "in",
    options: [
      { value: "in", label: "In…" },
      { value: "at", label: "At a time" },
    ],
    onchange: () => {
      sync();
      onChange();
    },
  });
  const start = bestUnit(initial.inSec ?? 600);
  // The field's label names the whole control (a group), so the number needs a name of its own.
  const num = h("input", { class: "input", id, type: "number", min: "1", step: "1", value: String(start.n), inputMode: "numeric", "aria-label": "Remind me in (amount)" });
  const sel = unitSelect("Unit");
  sel.value = start.unit;
  const at = h("input", {
    class: "input",
    type: "datetime-local",
    "aria-label": "Date and time",
    value: localInputValue(initial.at ?? Date.now() + 3600_000),
  });
  const inRow = h("div", { class: "interval-row" }, h("span", { class: "interval-every" }, "In"), num, sel);
  const atRow = h("div", { class: "interval-row" }, at);
  const quick: { label: string; apply: () => void }[] = [
    { label: "In 10 min", apply: () => setIn(600) },
    { label: "In 30 min", apply: () => setIn(1800) },
    { label: "In 1 h", apply: () => setIn(3600) },
    { label: "Tomorrow 9 AM", apply: () => setAt(tomorrowAt(9)) },
  ];
  const presets = h(
    "div",
    { class: "presets", role: "group", "aria-label": "Quick picks" },
    quick.map((q) =>
      h(
        "button",
        {
          type: "button",
          class: "preset",
          onclick: () => {
            q.apply();
            onChange();
          },
        },
        q.label,
      ),
    ),
  );
  function setIn(sec: number): void {
    const b = bestUnit(sec);
    num.value = String(b.n);
    sel.value = b.unit;
    mode.set("in");
    sync();
  }
  function setAt(ts: number): void {
    at.value = localInputValue(ts);
    mode.set("at");
    sync();
  }
  function sync(): void {
    const isAt = mode.get() === "at";
    inRow.hidden = isAt;
    atRow.hidden = !isAt;
  }
  for (const c of [num, sel, at]) c.addEventListener("input", onChange);
  sel.addEventListener("change", onChange);
  sync();
  /** The run time (epoch ms), or null when it isn't filled in. */
  const get = (): number | null => {
    if (mode.get() === "at") {
      const t = at.value ? new Date(at.value).getTime() : NaN;
      return Number.isFinite(t) ? t : null;
    }
    const v = Number(num.value);
    if (!Number.isFinite(v) || v <= 0) return null;
    return Date.now() + Math.round(v * unitSec(sel)) * 1000;
  };
  const el = h("div", { class: "when" }, mode.el, inRow, atRow, presets);
  return { el, get, focus: () => (mode.get() === "at" ? at.focus() : num.focus()) };
}

/** When a recurring task runs first: after one interval (default), at a clock time — or, when editing, as scheduled. */
function firstRunControl(o: { editing: boolean; onChange: () => void }) {
  const mode = segmented({
    label: o.editing ? "Next run" : "First run",
    value: o.editing ? "keep" : "interval",
    options: [
      ...(o.editing ? [{ value: "keep", label: "As scheduled" }] : []),
      { value: "interval", label: o.editing ? "One interval from now" : "After one interval" },
      { value: "clock", label: "At a time" },
    ],
    onchange: () => {
      time.hidden = mode.get() !== "clock";
      o.onChange();
    },
  });
  const time = h("input", { class: "input input-time", type: "time", value: "08:00", "aria-label": "Time of day", hidden: true });
  time.addEventListener("input", o.onChange);
  const el = h("div", { class: "first-run" }, mode.el, time);
  return {
    el,
    mode: () => mode.get(),
    /** The first run (epoch ms) when set to a clock time; null otherwise. */
    runAt: (): number | null => (mode.get() === "clock" ? nextAtClock(time.value) : null),
  };
}

/** `stored`: the task's current interval, which saves unchanged even past the cap (the API allows up to a year). */
function validateInterval(sec: number | null, stored?: number): string | null {
  if (sec === null) return "Enter how often to run it.";
  if (sec < MIN_INTERVAL) return "Run it at most once a minute.";
  if (sec > MAX_INTERVAL && sec !== stored) return "Use an interval of 31 days or less.";
  return null;
}

function validateRunAt(ts: number | null): string | null {
  if (ts === null) return "Pick when Trinity should remind you.";
  if (ts < Date.now() + 15_000) return "Pick a time in the future.";
  if (ts > Date.now() + MAX_AHEAD_MS) return "Pick a time within the next year.";
  return null;
}

function defaultTitle(instruction: string, fallback: string): string {
  const words = instruction.trim().replace(/\s+/g, " ").split(" ").slice(0, 6).join(" ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1).replace(/[.,;:!?]+$/, "") : fallback;
}

// The heartbeat says "Remind me to/about/that …" instructions as plain reminders — instantly, with
// no model call (server/src/tools/schedule.ts isReminder). Anything else runs as an agent task, and
// so does "Remind me what's on my calendar": it asks to be told something.
const REMIND_LEAD = /^\s*remind me\b[\s,]*(to\b|that\b|about\b|of\b|:)?\s*/i;
const ASKS_TO_BE_TOLD = /^(what|who|when|where|which|why|how|if|whether)\b/i;
function isReminderText(s: string): boolean {
  const m = REMIND_LEAD.exec(s);
  return m !== null && (Boolean(m[1]) || !ASKS_TO_BE_TOLD.test(s.slice(m[0].length)));
}
/** After "Remind me to" comes a verb: "Take my pills" → "take my pills". Keeps "I", "NASA" and a name ("Ana's gift"). */
const lowerFirst = (s: string) => (/^[A-Z][a-z]+\b(?!['’]s\b)/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
/** "Stretch and drink water" → "Remind me to stretch and drink water". */
function asReminder(s: string): string {
  if (REMIND_LEAD.test(s)) return s;
  return `Remind me to ${lowerFirst(s)}`;
}
/** "Remind me to stretch." → "stretch." — what the "Remind me to…" box shows. */
const reminderWords = (s: string) => s.replace(REMIND_LEAD, "");

/** For "Trinity will remind you …": "in 20 min (9:47 PM)" or "tomorrow at 9:00 AM". */
function whenPhrase(ts: number): string {
  const words = whenInWords(ts);
  return words.startsWith("in ") ? `${words} (${clockTime(ts)})` : words;
}

/** "every day at 8:00 AM" for whole-day intervals, else "every 30 min". */
function cadence(t: HeartbeatTask): string {
  const base = fmtInterval(t.intervalSec);
  return t.intervalSec >= 86400 && t.intervalSec % 86400 === 0 && t.nextRunAt ? `${base} at ${clockTime(t.nextRunAt)}` : base;
}

/** A one-time task that ran when it was due — not one given a new time after it ran, then paused. */
const isFinished = (t: HeartbeatTask) => t.once && !t.enabled && t.lastRunAt !== null && t.lastRunAt >= t.nextRunAt - 60_000;

/** Re-rendering moves `within` to a new list, which blurs it: returns a function that puts focus (and caret) back. */
function keepFocus(within: HTMLElement | undefined): () => void {
  const el = document.activeElement;
  if (!within || !(el instanceof HTMLElement) || !within.contains(el)) return () => {};
  const text = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
  let start: number | null = null;
  let end: number | null = null;
  try {
    start = text?.selectionStart ?? null;
    end = text?.selectionEnd ?? null;
  } catch {
    /* number / time inputs have no selection */
  }
  const scroll = text?.scrollTop ?? 0;
  return () => {
    if (!el.isConnected || document.activeElement === el) return;
    el.focus({ preventScroll: true });
    try {
      if (text && start !== null && end !== null) text.setSelectionRange(start, end);
    } catch {
      /* see above */
    }
    if (text) text.scrollTop = scroll;
  };
}

interface EditForm {
  id: string;
  el: HTMLElement;
  /** Something in the form differs from what it opened with. */
  dirty(): boolean;
}

export function createHeartbeatSection(): Section {
  let tasks: HeartbeatTask[] | null = null;
  let loadFailed: string | null = null;
  let editing: string | null = null;
  /** The open edit form, reused by every re-render so what's typed in it survives list updates. */
  let editForm: EditForm | null = null;
  let addForm: { dirty(): boolean } | null = null;
  let started = false;
  let tick = 0;

  function stopEditing(): void {
    editing = null;
    editForm = null;
  }

  const remindersCard = h("div", { class: "card" });
  const recurringCard = h("div", { class: "card" });
  const formCard = h("div", { class: "card" });
  const el = h(
    "section",
    { class: "section", "aria-labelledby": "sec-heartbeat" },
    sectionHead({
      id: "sec-heartbeat",
      title: "Heartbeat",
      lede: "What Trinity does on a schedule — even when you're not talking. Reminders are spoken in a live call when they're due (and always shown in the transcript and the workspace); recurring tasks run on their own with her tools.",
    }),
    h("div", { class: "heartbeat-stack" }, remindersCard, recurringCard, formCard),
  );

  // ── Rows ──

  function nextLabel(t: HeartbeatTask, now: number): { text: string; cls: string } {
    if (isFinished(t)) return { text: `Done · ${relTime(t.lastRunAt, now)}`, cls: "is-done" };
    if (!t.enabled) return { text: "Paused", cls: "is-paused" };
    if (t.nextRunAt <= now + 30_000) return { text: "Due now", cls: "is-due" };
    const words = whenInWords(t.nextRunAt, now);
    // "in 8 min" reads better with the clock time beside it.
    return { text: words.startsWith("in ") ? `${words} · ${clockTime(t.nextRunAt)}` : words, cls: "" };
  }

  function taskRow(t: HeartbeatTask): HTMLElement {
    if (editing === t.id) {
      if (editForm?.id !== t.id) editForm = t.once ? editReminderRow(t) : editRecurringRow(t);
      return editForm.el;
    }
    const now = Date.now();
    const finished = isFinished(t);
    const next = nextLabel(t, now);
    const sw = finished
      ? h("span", { class: "task-done-icon", title: "Done" }, icon("check"))
      : switchInput({
          checked: t.enabled,
          label: t.enabled ? `Pause “${t.title}”` : `Resume “${t.title}”`,
          onchange: (on, input) => void toggle(t, on, input),
        }).el;
    const edit = button(null, {
      icon: "edit",
      size: "sm",
      variant: "ghost",
      title: finished ? "Edit and schedule again" : t.once ? "Edit reminder" : "Edit task",
      onclick: () => {
        editing = t.id;
        render();
      },
    });
    const del = button(null, {
      icon: "trash",
      size: "sm",
      variant: "danger",
      title: t.once ? "Delete reminder" : "Delete task",
      onclick: () => void remove(t),
    });
    const meta = t.once
      ? h(
          "div",
          { class: "task-meta" },
          h("span", { class: "task-interval" }, icon(finished ? "check" : "bell"), finished ? "Reminded you" : "Once"),
          h("span", { class: ["task-next", next.cls], title: t.nextRunAt ? fullDateTime(finished && t.lastRunAt ? t.lastRunAt : t.nextRunAt) : undefined }, next.text),
        )
      : h(
          "div",
          { class: "task-meta" },
          h("span", { class: "task-interval" }, icon("repeat"), cadence(t)),
          h(
            "span",
            { class: ["task-next", next.cls], title: t.enabled && t.nextRunAt ? fullDateTime(t.nextRunAt) : undefined },
            next.cls ? next.text : `Next ${next.text}`,
          ),
          h("span", { class: "task-last" }, t.lastRunAt ? `Last ran ${relTime(t.lastRunAt, now)}` : "Hasn't run yet"),
        );
    return h(
      "div",
      { class: ["task-row", (!t.enabled || finished) && "is-off", finished && "is-finished"], dataset: { task: t.id } },
      sw,
      h(
        "div",
        { class: "task-main" },
        h("div", { class: "task-title" }, t.title || (t.once ? "Reminder" : "Recurring task")),
        t.instruction ? h("div", { class: "task-instr" }, t.instruction) : null,
      ),
      meta,
      h("div", { class: "task-actions" }, edit, del),
    );
  }

  function editShell(t: HeartbeatTask, body: HTMLElement[], save: HTMLButtonElement): HTMLElement {
    const cancel = button("Cancel", {
      variant: "ghost",
      size: "sm",
      onclick: () => {
        stopEditing();
        render();
      },
    });
    const row = h(
      "div",
      { class: "task-row is-editing", dataset: { task: t.id } },
      h("div", { class: "task-edit" }, body, h("div", { class: "form-actions" }, cancel, save)),
    );
    row.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        stopEditing();
        render();
      }
    });
    return row;
  }

  function editReminderRow(t: HeartbeatTask): EditForm {
    // A spoken reminder is stored as "Remind me to/about/that …"; the box shows just the "…", and
    // saving keeps the lead it was stored with (the heartbeat words "about" and "to" differently).
    // A one-time task that isn't a reminder ("Check the weather.") is shown and saved as it is.
    const lead = isReminderText(t.instruction) ? REMIND_LEAD.exec(t.instruction) : null;
    const how = lead?.[1]?.toLowerCase();
    const shown = lead ? reminderWords(t.instruction) : t.instruction;
    const msg = h("textarea", { class: "textarea", rows: 2, value: shown });
    const title = h("input", { class: "input", value: t.title, maxLength: 80, placeholder: "Reminder" });
    const whenId = uid("hb-when");
    const future = t.nextRunAt > Date.now() + 60_000;
    const when = whenControl(future ? { at: t.nextRunAt } : { inSec: 600 }, whenId, () => fWhen.setError(null));
    const fMsg = field({ label: !lead ? "What should Trinity do?" : how && how !== ":" ? `Remind me ${how}…` : "Remind me…", control: msg });
    const fTitle = field({ label: "Title", control: title });
    const fWhen = field({ label: "When", control: when.el, id: whenId, group: true });
    const openedWith = [msg.value, title.value].join("\n");
    const save = button("Save", { variant: "primary", icon: "check", size: "sm" });
    save.addEventListener("click", () => {
      const typed = msg.value.trim();
      // The box as it opened (only the time or title changed) saves the instruction exactly as stored.
      // New words follow the stored lead: after "to" a verb, lowercased as in the Add form; after
      // "about", "that" or "of" they stay as typed (often a name).
      const words = how === "to" ? lowerFirst(typed) : typed;
      const instruction = typed === shown.trim() ? t.instruction : typed && lead && !REMIND_LEAD.test(typed) ? `${lead[0].trimEnd()} ${words}` : typed;
      // The time box shows whole minutes: the minute it opened with keeps the exact time stored (a title-only
      // edit mustn't move a reminder set by voice up to a minute earlier).
      const picked = when.get();
      const runAt = picked !== null && future && Math.floor(picked / 60_000) === Math.floor(t.nextRunAt / 60_000) ? t.nextRunAt : picked;
      fMsg.setError(instruction ? null : "Say what to remind you about.");
      const we = validateRunAt(runAt);
      fWhen.setError(we);
      if (!instruction || we || runAt === null) return;
      // runAt is the API's reschedule field; nextRunAt is what older engines read.
      const patch: HeartbeatPatch = {
        title: title.value.trim() || defaultTitle(typed, "Reminder"),
        instruction,
        once: true,
        runAt,
        nextRunAt: runAt,
        enabled: true,
      };
      void withBusy(save, async () => {
        try {
          const updated = await api.heartbeat.update(t.id, patch);
          stopEditing();
          heartbeatRes.update((list) => list.map((x) => (x.id === t.id ? updated : x)));
          announce("heartbeat");
          toast(`Trinity will remind you ${whenPhrase(updated.nextRunAt || runAt)}.`, "success");
        } catch {
          /* reported */
        }
      });
    });
    requestAnimationFrame(() => msg.focus());
    const row = editShell(t, [fMsg.el, h("div", { class: "form-grid" }, fWhen.el, fTitle.el)], save);
    return { id: t.id, el: row, dirty: () => [msg.value, title.value].join("\n") !== openedWith };
  }

  function editRecurringRow(t: HeartbeatTask): EditForm {
    const title = h("input", { class: "input", value: t.title, maxLength: 80, placeholder: "Recurring task" });
    const instr = h("textarea", { class: "textarea", rows: 3, value: t.instruction });
    const intervalId = uid("hb-interval");
    const interval = intervalControl(t.intervalSec, intervalId);
    const first = firstRunControl({ editing: true, onChange: () => fFirst.setError(null) });
    const openedWith = [title.value, instr.value, interval.get()].join("\n");
    const fTitle = field({ label: "Title", control: title });
    const fInstr = field({ label: "What should Trinity do?", control: instr });
    const fInterval = field({ label: "How often", control: interval.el, id: intervalId });
    const fFirst = field({ label: "Next run", control: first.el, group: true });
    const save = button("Save", { variant: "primary", icon: "check", size: "sm" });
    save.addEventListener("click", () => {
      const instruction = instr.value.trim();
      const sec = interval.get();
      fInstr.setError(instruction ? null : "Describe what Trinity should do.");
      const ie = validateInterval(sec, t.intervalSec);
      fInterval.setError(ie);
      if (!instruction || ie || sec === null) return;
      const mode = first.mode();
      const fe = mode === "clock" && first.runAt() === null ? "Pick a time of day." : null;
      fFirst.setError(fe);
      if (fe) return;
      const patch: HeartbeatPatch = {
        title: title.value.trim() || defaultTitle(instruction, "Recurring task"),
        instruction,
        intervalSec: sec,
      };
      const at = mode === "clock" ? first.runAt() : mode === "interval" || sec !== t.intervalSec ? Date.now() + sec * 1000 : null;
      // A new interval starts a fresh schedule unless a time was picked (older engines keep the old nextRunAt otherwise).
      if (at !== null) {
        patch.runAt = at;
        patch.nextRunAt = at;
      }
      void withBusy(save, async () => {
        try {
          const updated = await api.heartbeat.update(t.id, patch);
          stopEditing();
          heartbeatRes.update((list) => list.map((x) => (x.id === t.id ? updated : x)));
          announce("heartbeat");
          toast(`Updated “${updated.title}”`, "success");
        } catch {
          /* reported */
        }
      });
    });
    requestAnimationFrame(() => title.focus());
    const row = editShell(t, [h("div", { class: "form-grid" }, fTitle.el, fInterval.el), fInstr.el, fFirst.el], save);
    return { id: t.id, el: row, dirty: () => [title.value, instr.value, interval.get()].join("\n") !== openedWith };
  }

  async function toggle(t: HeartbeatTask, on: boolean, input: HTMLInputElement): Promise<void> {
    input.disabled = true;
    try {
      const updated = await api.heartbeat.update(t.id, { enabled: on });
      heartbeatRes.update((list) => list.map((x) => (x.id === t.id ? updated : x)));
      announce("heartbeat");
      toast(on ? `Resumed “${t.title}”` : `Paused “${t.title}”`, "info");
    } catch {
      input.checked = !on;
      input.disabled = false;
    }
  }

  async function remove(t: HeartbeatTask): Promise<void> {
    if (!isFinished(t)) {
      const ok = await confirmAction({
        title: `Delete “${t.title}”?`,
        message: t.once ? "Trinity won't remind you about this. This can't be undone." : "Trinity stops running this task. This can't be undone.",
        confirmLabel: t.once ? "Delete reminder" : "Delete task",
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await api.heartbeat.remove(t.id);
      heartbeatRes.update((list) => list.filter((x) => x.id !== t.id));
      announce("heartbeat");
      toast(`Deleted “${t.title}”`, "success");
    } catch {
      /* reported */
    }
  }

  async function clearFinished(btn: HTMLButtonElement): Promise<void> {
    const done = (tasks ?? []).filter(isFinished);
    if (!done.length) return;
    await withBusy(btn, async () => {
      const gone: string[] = [];
      for (const t of done) {
        try {
          await api.heartbeat.remove(t.id, { quiet: true });
          gone.push(t.id);
        } catch {
          /* keep it listed */
        }
      }
      heartbeatRes.update((list) => list.filter((x) => !gone.includes(x.id)));
      announce("heartbeat");
      toast(gone.length === done.length ? `Cleared ${plural(gone.length, "finished reminder")}` : "Couldn't clear every reminder.", gone.length === done.length ? "success" : "warn");
    });
  }

  // ── Lists ──

  function head(o: { icon: "bell" | "repeat"; title: string; sub: string; count: number | null; side?: HTMLElement | null }): HTMLElement {
    return h(
      "div",
      { class: "card-head" },
      h("span", { class: "card-icon" }, icon(o.icon)),
      h(
        "div",
        { class: "card-head-text" },
        h("h2", { class: "card-title" }, o.title, o.count ? h("span", { class: "count" }, String(o.count)) : null),
        h("p", { class: "card-sub" }, o.sub),
      ),
      o.side ? h("div", { class: "card-head-side" }, o.side) : null,
    );
  }

  const REMINDERS_SUB = "One-time. When one is due, Trinity says it in the live call; it also shows in the transcript and the workspace.";
  const RECURRING_SUB = "Each run is a turn of its own: Trinity follows the instruction with her tools and tells you what she found.";

  function render(): void {
    if (loadFailed) {
      setChildren(remindersCard, head({ icon: "bell", title: "Reminders", sub: REMINDERS_SUB, count: null }), errorState(loadFailed, () => void load(true), true));
      setChildren(recurringCard);
      recurringCard.hidden = true;
      return;
    }
    recurringCard.hidden = false;
    if (!tasks) {
      setChildren(remindersCard, head({ icon: "bell", title: "Reminders", sub: REMINDERS_SUB, count: null }), h("div", { class: "card-pad" }, skeletonLines(2)));
      setChildren(recurringCard, head({ icon: "repeat", title: "Recurring tasks", sub: RECURRING_SUB, count: null }), h("div", { class: "card-pad" }, skeletonLines(3)));
      return;
    }
    if (editing && !tasks.some((t) => t.id === editing)) stopEditing(); // deleted (e.g. in another tab)
    const restoreFocus = keepFocus(editForm?.el);

    const reminders = tasks.filter((t) => t.once);
    const upcoming = reminders.filter((t) => !isFinished(t)).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.nextRunAt - b.nextRunAt);
    const finished = reminders.filter(isFinished).sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0));
    const clearBtn = finished.length
      ? button(`Clear finished (${finished.length})`, { size: "sm", variant: "ghost", icon: "x", onclick: (e) => void clearFinished(e.currentTarget as HTMLButtonElement) })
      : null;
    setChildren(
      remindersCard,
      head({ icon: "bell", title: "Reminders", sub: REMINDERS_SUB, count: upcoming.length || null, side: clearBtn }),
      reminders.length
        ? h(
            "div",
            { class: "task-list" },
            upcoming.map(taskRow),
            finished.length ? h("div", { class: "task-divider" }, "Done") : null,
            finished.slice(0, 20).map(taskRow),
          )
        : emptyState({
            icon: "bell",
            compact: true,
            title: "No reminders",
            body: "Say “remind me in ten minutes to stretch” on a call, or add one below.",
          }),
    );

    const recurring = tasks.filter((t) => !t.once).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.nextRunAt - b.nextRunAt);
    setChildren(
      recurringCard,
      head({ icon: "repeat", title: "Recurring tasks", sub: RECURRING_SUB, count: recurring.length || null }),
      recurring.length
        ? h("div", { class: "task-list" }, recurring.map(taskRow))
        : emptyState({
            icon: "repeat",
            compact: true,
            title: "No recurring tasks",
            body: "Add one below — e.g. “Every morning at 8, brief me on the news and my day.”",
          }),
    );
    restoreFocus();
  }

  // ── Add form ──

  function buildForm(): void {
    const kind = segmented({
      label: "Kind of task",
      look: "cards",
      value: "once",
      options: [
        { value: "once", label: "Remind me once", icon: "bell", hint: "At a time, or after a while — spoken in the live call." },
        { value: "every", label: "Repeat on a schedule", icon: "repeat", hint: "Every few minutes, hours, or days." },
      ],
      onchange: () => sync(),
    });
    const text = h("textarea", { class: "textarea", rows: 2, maxLength: 1000 });
    const title = h("input", { class: "input", maxLength: 80 });
    const when = whenControl({ inSec: 600 }, "hb-new-when", () => {
      fWhen.setError(null);
      preview();
    });
    const interval = intervalControl(86400, "hb-new-interval", () => {
      fInterval.setError(null);
      preview();
    });
    const first = firstRunControl({
      editing: false,
      onChange: () => {
        fFirst.setError(null);
        preview();
      },
    });
    const enabled = switchInput({ checked: true, label: "Start enabled" });
    enabled.input.id = "hb-new-enabled";
    const fText = field({ label: "Remind me to…", control: text });
    const fTitle = field({ label: "Title", control: title, hint: "Optional — we'll name it from the text." });
    const fWhen = field({ label: "When", control: when.el, id: "hb-new-when", group: true });
    const fInterval = field({ label: "How often", control: interval.el, id: "hb-new-interval" });
    const fFirst = field({ label: "First run", control: first.el, group: true });
    const enabledRow = h("div", { class: "inline-switch" }, enabled.el, h("label", { for: "hb-new-enabled" }, "Start enabled"));
    const summary = h("div", { class: "hb-preview", "aria-live": "polite" });
    const add = button("Add reminder", { variant: "primary", icon: "plus" });

    const isOnce = () => kind.get() !== "every";

    function preview(): void {
      if (isOnce()) {
        const at = when.get();
        setChildren(summary, at && !validateRunAt(at) ? [icon("bell"), `Trinity will remind you ${whenPhrase(at)}.`] : null);
      } else {
        const sec = interval.get();
        if (sec === null || validateInterval(sec)) {
          setChildren(summary);
          return;
        }
        const at = first.runAt() ?? Date.now() + sec * 1000;
        setChildren(summary, icon("repeat"), `First run ${whenInWords(at)}, then ${fmtInterval(sec)}.`);
      }
    }

    function sync(): void {
      const once = isOnce();
      fWhen.el.hidden = !once;
      fInterval.el.hidden = once;
      fFirst.el.hidden = once;
      enabledRow.hidden = once;
      text.placeholder = once ? "e.g. Stretch and drink some water." : "e.g. Brief me on the news and anything on my calendar today.";
      title.placeholder = once ? "e.g. Stretch break" : "e.g. Morning briefing";
      fText.el.querySelector(".field-label")!.textContent = once ? "Remind me to…" : "What should Trinity do?";
      const label = add.querySelector(".btn-label");
      if (label) label.textContent = once ? "Add reminder" : "Add task";
      preview();
    }

    add.addEventListener("click", () => {
      const once = isOnce();
      const instruction = text.value.trim();
      fText.setError(instruction ? null : once ? "Say what to remind you about." : "Describe what Trinity should do.");
      let body: HeartbeatInput;
      if (once) {
        const runAt = when.get();
        const we = validateRunAt(runAt);
        fWhen.setError(we);
        if (!instruction || we || runAt === null) {
          (!instruction ? text : null)?.focus();
          return;
        }
        // Stored as "Remind me to …" so the heartbeat speaks it at once, without a model call.
        body = { title: title.value.trim() || defaultTitle(instruction, "Reminder"), instruction: asReminder(instruction), once: true, runAt };
      } else {
        const sec = interval.get();
        const ie = validateInterval(sec);
        fInterval.setError(ie);
        const fe = first.mode() === "clock" && first.runAt() === null ? "Pick a time of day." : null;
        fFirst.setError(fe);
        if (!instruction || ie || fe || sec === null) {
          (!instruction ? text : null)?.focus();
          return;
        }
        body = { title: title.value.trim() || defaultTitle(instruction, "Recurring task"), instruction, intervalSec: sec, enabled: enabled.input.checked };
        const at = first.runAt();
        if (at !== null) body.runAt = at;
      }
      void withBusy(add, () => createTask(body, () => {
        text.value = "";
        title.value = "";
        enabled.input.checked = true;
        preview();
      }), "Adding…");
    });
    text.addEventListener("input", () => fText.setError(null));
    text.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") add.click();
    });
    addForm = { dirty: () => Boolean(text.value.trim() || title.value.trim()) };

    setChildren(
      formCard,
      h(
        "div",
        { class: "card-head" },
        h("span", { class: "card-icon" }, icon("plus")),
        h(
          "div",
          { class: "card-head-text" },
          h("h2", { class: "card-title" }, "Add"),
          h("p", { class: "card-sub" }, "Plain language works — Trinity reads it like a request from you. You can also just ask on a call."),
        ),
      ),
      h(
        "div",
        { class: "card-pad form-stack" },
        kind.el,
        fText.el,
        h("div", { class: "form-grid" }, fWhen.el, fInterval.el, fTitle.el),
        fFirst.el,
        h("div", { class: "form-actions" }, enabledRow, summary, h("span", { class: "spacer" }), add),
      ),
    );
    sync();
  }

  /** POST, then cover for engines that ignore `once` / `runAt` (older builds). */
  async function createTask(body: HeartbeatInput, reset: () => void): Promise<void> {
    let created: HeartbeatTask;
    try {
      created = await api.heartbeat.create(body);
    } catch {
      return; // reported
    }
    if (body.once && !created.once) {
      // This engine made a recurring task out of it — take it back.
      await api.heartbeat.remove(created.id, { quiet: true }).catch(() => {});
      toast("One-time reminders need an engine update. Add it as a recurring task for now.", "warn");
      return;
    }
    if (body.runAt && Math.abs(created.nextRunAt - body.runAt) > RUN_AT_SLACK_MS) {
      created = await api.heartbeat.update(created.id, { runAt: body.runAt, nextRunAt: body.runAt }, { quiet: true }).catch(() => created);
    }
    heartbeatRes.update((list) => [...list, created]);
    if (!heartbeatRes.peek()) void heartbeatRes.refresh().catch(() => {});
    announce("heartbeat");
    toast(
      created.once
        ? `Trinity will remind you ${whenPhrase(created.nextRunAt)}.`
        : `Added “${created.title}” — ${fmtInterval(created.intervalSec)}, first run ${whenInWords(created.nextRunAt)}`,
      "success",
    );
    reset();
  }

  async function load(force = false): Promise<void> {
    loadFailed = null;
    render();
    try {
      tasks = force ? await heartbeatRes.refresh() : await heartbeatRes.get();
    } catch (err) {
      loadFailed = (err as Error).message || "The engine didn't answer.";
    }
    render();
  }

  heartbeatRes.subscribe((list) => {
    tasks = list;
    loadFailed = null;
    render();
  });

  return {
    el,
    show() {
      if (!started) {
        started = true;
        buildForm();
        void load();
      } else void heartbeatRes.refresh().catch(() => {});
      window.clearInterval(tick);
      // While the page is open: pick up reminders made by voice and ones that just fired, and keep
      // "in 8 min" honest (a refresh re-renders through the subscription).
      tick = window.setInterval(() => {
        if (!editing) void heartbeatRes.refresh().catch(() => {});
      }, 15_000);
    },
    hide() {
      window.clearInterval(tick);
    },
    isDirty: () => Boolean((editing && editForm?.dirty()) || addForm?.dirty()),
    refresh() {
      if (started && !editing) void heartbeatRes.refresh().catch(() => {});
    },
  };
}
