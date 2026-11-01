// Memory: what Trinity remembers about you. "About you" holds the name she
// calls you by; below it, every memory — facts, preferences, events, notes —
// searchable, editable inline, and deletable, plus a form to add one yourself.
// Trinity saves memories when you ask her to remember something and curates
// them from your conversations; she uses them to personalize answers.

import { api, isNotAvailable, type Memory, type MemoryInput, type MemoryType, type Profile, type ProfileSaved } from "./api.js";
import { announce } from "./channel.js";
import { profileRes } from "./store.js";
import {
  autoGrow,
  badge,
  button,
  debounce,
  emptyState,
  errorState,
  field,
  fullDateTime,
  h,
  icon,
  relTime,
  sectionHead,
  setChildren,
  skeletonLines,
  toast,
  withBusy,
  type IconName,
  type Section,
} from "./ui.js";

const TYPES: { id: MemoryType; label: string; plural: string; icon: IconName }[] = [
  { id: "fact", label: "Fact", plural: "Facts", icon: "info" },
  { id: "preference", label: "Preference", plural: "Preferences", icon: "heart" },
  { id: "event", label: "Event", plural: "Events", icon: "calendar" },
  { id: "note", label: "Note", plural: "Notes", icon: "edit" },
  { id: "summary", label: "Summary", plural: "Summaries", icon: "sparkles" },
];

/** Importance levels shown for salience (0..1), which ranks what Trinity recalls first. */
const IMPORTANCE = [
  { label: "Low", value: 0.3 },
  { label: "Normal", value: 0.6 },
  { label: "High", value: 0.9 },
] as const;

const NAME_MAX = 40; // the engine's limit (PUT /api/profile)
const TEXT_MAX = 1000;
const LIST_LIMIT = 200;

function typeInfo(type: string): { label: string; icon: IconName } {
  const t = TYPES.find((x) => x.id === type);
  return t ?? { label: type ? type.charAt(0).toUpperCase() + type.slice(1) : "Note", icon: "edit" };
}

function importanceOf(salience: number): (typeof IMPORTANCE)[number] {
  return IMPORTANCE.reduce((best, x) => (Math.abs(x.value - salience) < Math.abs(best.value - salience) ? x : best));
}

function parseTags(raw: string): string[] {
  return [...new Set(raw.split(/[,#\n]/).map((t) => t.trim().replace(/\s+/g, " ")).filter(Boolean))].slice(0, 12);
}

/** Search words read like the engine's topicWords ("Ana's," → "ana"), 3+ letters; or the whole query when it has none. */
function searchTerms(q: string): string[] {
  const words = q.toLowerCase().replace(/['’]s\b/g, "").split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2);
  return words.length ? words : q.trim() ? [q.trim().toLowerCase()] : [];
}

/** How many search words a memory contains (plural/-ing/-ed endings forgiven). */
function matchCount(m: Memory, terms: string[]): number {
  const hay = `${m.text} ${m.tags.join(" ")} ${m.type}`.toLowerCase();
  const stem = (t: string) => (t.length > 4 ? t.replace(/(ies|es|s|ing|ed)$/, "") : t);
  return terms.filter((t) => hay.includes(t) || hay.includes(stem(t))).length;
}

/** The text with search words wrapped in <mark> — built from text nodes, never HTML. */
function highlighted(text: string, terms: string[]): (string | HTMLElement)[] {
  if (!terms.length) return [text];
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  return text.split(re).map((part, i) => (i % 2 ? h("mark", null, part) : part));
}

interface MemoryForm {
  el: HTMLElement;
  focus(): void;
  dirty(): boolean;
}

export function createMemorySection(): Section {
  let memories: Memory[] | null = null;
  let loadFailed: string | null = null;
  let query = "";
  /** The search `memories` was loaded for: those are the engine's ranked results, shown as they are. */
  let listQuery = "";
  let typeFilter = "";
  /** False once the engine says it can't add / edit / delete memories (an older build). */
  let writable = true;
  let editing: string | null = null;
  let editForm: (MemoryForm & { id: string }) | null = null;
  let adding: MemoryForm | null = null;
  /** A reload put off while a form was open, run when it closes (see loadWhenFree). */
  let reloadPending = false;
  let seq = 0;
  let started = false;

  // ── About you ──

  const nameInput = h("input", {
    class: "input input-lg",
    id: "profile-name",
    maxLength: NAME_MAX,
    autocomplete: "given-name",
    placeholder: "What should Trinity call you?",
    spellcheck: false,
  });
  const nameSave = button("Save", { variant: "primary", icon: "check", disabled: true });
  const nameState = h("span", { class: "field-state" });
  const fName = field({
    label: "Your name",
    control: h("div", { class: "input-row" }, nameInput, nameSave),
    id: "profile-name",
    extra: nameState,
    hint: "Trinity uses it in conversation, and the voice model hears it at the start of each call. She also learns it when you tell her.",
  });
  let savedName = "";
  let profileAvailable = true;

  const profileCard = h(
    "div",
    { class: "card profile-card" },
    h(
      "div",
      { class: "card-head" },
      h("span", { class: "card-icon" }, icon("user")),
      h(
        "div",
        { class: "card-head-text" },
        h("h2", { class: "card-title" }, "About you"),
        h("p", { class: "card-sub" }, "What Trinity knows about you directly."),
      ),
    ),
    h("div", { class: "card-pad" }, fName.el),
  );

  function renderProfile(p: Profile | undefined): void {
    profileAvailable = p?.available ?? true;
    nameInput.disabled = !p || !profileAvailable;
    if (p) {
      // A refresh shows a newly stored name, but never over one that's typed and not saved yet.
      const unsaved = nameInput.value.trim().replace(/\s+/g, " ") !== savedName.trim();
      if (!unsaved && p.name !== savedName) nameInput.value = p.name;
      savedName = p.name;
    }
    setChildren(nameState, p && !profileAvailable ? badge("Needs engine update", "info") : null);
    syncNameSave();
  }

  function syncNameSave(): void {
    const v = nameInput.value.trim().replace(/\s+/g, " ");
    nameSave.disabled = !profileAvailable || nameInput.disabled || v === savedName.trim();
  }

  async function saveName(): Promise<void> {
    const name = nameInput.value.trim().replace(/\s+/g, " ");
    if (name.length > NAME_MAX) {
      fName.setError(`Keep it under ${NAME_MAX} characters.`);
      return;
    }
    fName.setError(null);
    try {
      const p = await withBusy(nameSave, () => api.profile.set(name), "Saving…");
      savedName = p.name;
      nameInput.value = p.name;
      profileRes.set({ name: p.name, available: p.available });
      // The engine also rewrote (or removed) the memory that holds the name: show it.
      nameMemoryChanged(p);
      loadWhenFree();
      announce("memory");
      toast(p.name ? `Trinity will call you ${p.name}.` : "Trinity won't use a name for you.", "success");
    } catch (err) {
      if (isNotAvailable(err)) renderProfile({ name: nameInput.value, available: false });
    } finally {
      syncNameSave();
    }
  }

  /**
   * The name memory as the engine left it after a name save, shown at once — and an edit form of it, which
   * opened with the old name, is closed so its Save can't put that name back.
   */
  function nameMemoryChanged(p: ProfileSaved): void {
    const id = p.memory?.id ?? p.removed;
    if (!id) return;
    if (editForm?.id === id) {
      editing = null;
      editForm = null;
    }
    if (memories) memories = p.memory ? memories.map((m) => (m.id === id ? p.memory! : m)) : memories.filter((m) => m.id !== id);
    renderList();
  }

  /** Reload the list now — or, while a form is open (the list waits for it), as soon as it closes. */
  function loadWhenFree(): void {
    if (editing || adding) reloadPending = true;
    else void load();
  }

  /** A form closed: run the reload it held up, if any. */
  function formClosed(): void {
    if (!reloadPending || editing || adding) return;
    reloadPending = false;
    void load();
  }

  nameInput.addEventListener("input", () => {
    fName.setError(null);
    syncNameSave();
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !nameSave.disabled) {
      e.preventDefault();
      void saveName();
    } else if (e.key === "Escape") {
      nameInput.value = savedName;
      syncNameSave();
    }
  });
  nameSave.addEventListener("click", () => void saveName());

  // ── Memories ──

  const search = h("input", {
    class: "input input-search",
    type: "search",
    placeholder: "Search memories…",
    "aria-label": "Search memories",
    autocomplete: "off",
  });
  const typeSelect = h(
    "select",
    { class: "select select-sm", "aria-label": "Show memory type" },
    h("option", { value: "" }, "All types"),
    TYPES.map((t) => h("option", { value: t.id }, t.plural)),
  );
  const addBtn = button("Add memory", { icon: "plus", size: "sm", variant: "subtle" });
  const listCount = h("span", { class: "count", hidden: true });
  const readOnlyNote = h("div", { class: "card-pad mem-readonly", hidden: true });
  const addSlot = h("div", { class: "mem-add-slot" });
  const listBody = h("div", { class: "mem-body" });

  const listCard = h(
    "div",
    { class: "card mem-card" },
    h(
      "div",
      { class: "card-head" },
      h("span", { class: "card-icon" }, icon("brain")),
      h(
        "div",
        { class: "card-head-text" },
        h("h2", { class: "card-title" }, "Memories", listCount),
        h("p", { class: "card-sub" }, "Saved when you ask Trinity to remember something, and curated from your conversations. She recalls the most relevant ones when she answers."),
      ),
    ),
    h("div", { class: "mem-toolbar" }, search, typeSelect, h("span", { class: "spacer" }), addBtn),
    readOnlyNote,
    addSlot,
    listBody,
  );

  const el = h(
    "section",
    { class: "section", "aria-labelledby": "sec-memory" },
    sectionHead({
      id: "sec-memory",
      title: "Memory",
      lede: "What Trinity remembers about you — your name, preferences, people, plans, and facts — so every persona can personalize what it says and does. Edit or delete anything here.",
    }),
    h("div", { class: "memory-stack" }, profileCard, listCard),
  );

  function setReadOnly(): void {
    writable = false;
    adding = null;
    editing = null;
    editForm = null;
    setChildren(addSlot);
    addBtn.hidden = true;
    readOnlyNote.hidden = false;
    setChildren(
      readOnlyNote,
      h("div", { class: "notice notice-info notice-compact" }, icon("info"), h("span", null, "Adding, editing, and deleting memories needs an engine update — this list is read-only for now.")),
    );
    renderList();
  }

  /** One form for adding and editing: text, type, tags, importance. */
  function memoryForm(o: { initial: Memory | null; submitLabel: string; onSubmit: (input: MemoryInput, btn: HTMLButtonElement) => void; onCancel: () => void }): MemoryForm {
    const m = o.initial;
    const text = h("textarea", {
      class: "textarea",
      rows: 2,
      maxLength: TEXT_MAX,
      value: m?.text ?? "",
      placeholder: "e.g. My sister Ana lives in Lisbon and her birthday is May 3.",
    });
    autoGrow(text, 240);
    const type = h("select", { class: "select" }, TYPES.map((t) => h("option", { value: t.id }, t.label)));
    type.value = m?.type && TYPES.some((t) => t.id === m.type) ? m.type : "fact";
    if (m?.type && !TYPES.some((t) => t.id === m.type)) {
      type.append(h("option", { value: m.type }, typeInfo(m.type).label));
      type.value = m.type;
    }
    const tags = h("input", { class: "input", value: (m?.tags ?? []).join(", "), placeholder: "family, birthdays", autocomplete: "off" });
    const startLevel = importanceOf(m?.salience ?? 0.6);
    const importance = h("select", { class: "select" }, IMPORTANCE.map((x) => h("option", { value: String(x.value) }, x.label)));
    importance.value = String(startLevel.value);
    const fText = field({ label: "Memory", control: text });
    const fType = field({ label: "Type", control: type });
    const fTags = field({ label: "Tags", control: tags, hint: "Comma-separated, optional." });
    const fImp = field({ label: "Importance", control: importance, hint: "Higher comes to mind first." });
    const submit = button(o.submitLabel, { variant: "primary", icon: "check", size: "sm" });
    const cancel = button("Cancel", { variant: "ghost", size: "sm", onclick: o.onCancel });
    const opened = () => [text.value, type.value, tags.value, importance.value].join("\n");
    const openedWith = opened();
    const go = () => {
      const t = text.value.trim();
      if (!t) {
        fText.setError("Write what Trinity should remember.");
        text.focus();
        return;
      }
      const level = Number(importance.value);
      o.onSubmit(
        {
          text: t,
          type: type.value,
          tags: parseTags(tags.value),
          // Unchanged importance keeps the exact salience the engine gave it.
          salience: m && level === startLevel.value ? m.salience : level,
        },
        submit,
      );
    };
    submit.addEventListener("click", go);
    text.addEventListener("input", () => fText.setError(null));
    const formEl = h(
      "div",
      { class: "mem-form" },
      fText.el,
      h("div", { class: "mem-form-grid" }, fType.el, fTags.el, fImp.el),
      h("div", { class: "form-actions" }, h("span", { class: "muted small mem-kbd" }, "Ctrl+Enter to save · Esc to cancel"), h("span", { class: "spacer" }), cancel, submit),
    );
    formEl.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        go();
      } else if (e.key === "Escape") {
        e.preventDefault();
        o.onCancel();
      }
    });
    return { el: formEl, focus: () => text.focus(), dirty: () => opened() !== openedWith };
  }

  function openAdd(): void {
    if (!writable) return;
    if (adding) {
      adding.focus();
      return;
    }
    const form = memoryForm({
      initial: null,
      submitLabel: "Save memory",
      onCancel: closeAdd,
      onSubmit: (input, btn) => void create(input, btn),
    });
    adding = form;
    setChildren(addSlot, h("div", { class: "mem-row is-editing is-adding" }, form.el));
    form.focus();
  }

  function closeAdd(): void {
    adding = null;
    setChildren(addSlot);
    addBtn.focus();
    formClosed();
  }

  async function create(input: MemoryInput, btn: HTMLButtonElement): Promise<void> {
    try {
      const saved = await withBusy(btn, () => api.memory.create(input, { quiet: (e) => e.notAvailable }), "Saving…");
      adding = null;
      setChildren(addSlot);
      announce("memory");
      toast("Saved — Trinity will remember that.", "success");
      if (saved && memories && !query) memories = [saved, ...memories.filter((x) => x.id !== saved.id)];
      if (saved && !query) renderList();
      else void load();
      formClosed();
    } catch (err) {
      if (isNotAvailable(err)) setReadOnly();
    }
  }

  async function update(m: Memory, input: MemoryInput, btn: HTMLButtonElement): Promise<void> {
    try {
      const saved = await withBusy(btn, () => api.memory.update(m.id, input, { quiet: (e) => e.notAvailable }), "Saving…");
      const next: Memory = saved ?? { ...m, text: input.text, type: input.type ?? m.type, tags: input.tags ?? m.tags, salience: input.salience ?? m.salience };
      memories = (memories ?? []).map((x) => (x.id === m.id ? next : x));
      editing = null;
      editForm = null;
      announce("memory");
      toast("Memory updated", "success");
      renderList();
      // The memory that holds the name, edited: the engine takes the name it states as theirs now.
      if (next.tags.includes("name")) void profileRes.refresh().catch(() => {});
      formClosed();
    } catch (err) {
      if (isNotAvailable(err)) setReadOnly();
    }
  }

  async function remove(m: Memory): Promise<void> {
    try {
      await api.memory.remove(m.id, { quiet: (e) => e.notAvailable });
      memories = (memories ?? []).filter((x) => x.id !== m.id);
      if (editing === m.id) {
        editing = null;
        editForm = null;
      }
      renderList();
      formClosed();
      announce("memory");
      toast("Memory deleted", "success", {
        timeoutMs: 7000,
        action: {
          label: "Undo",
          run: () => {
            void api.memory
              .create({ text: m.text, type: m.type, tags: m.tags, salience: m.salience })
              .then(() => {
                announce("memory");
                void load();
              })
              .catch(() => {});
          },
        },
      });
    } catch (err) {
      if (isNotAvailable(err)) setReadOnly();
    }
  }

  function memoryRow(m: Memory, terms: string[]): HTMLElement {
    if (editing === m.id) {
      if (editForm?.id !== m.id) {
        const form = memoryForm({
          initial: m,
          submitLabel: "Save",
          onCancel: () => {
            editing = null;
            editForm = null;
            renderList();
            formClosed();
          },
          onSubmit: (input, btn) => void update(m, input, btn),
        });
        editForm = { ...form, id: m.id, el: h("div", { class: "mem-row is-editing", dataset: { memory: m.id } }, form.el) };
        requestAnimationFrame(() => form.focus());
      }
      return editForm.el;
    }
    const t = typeInfo(m.type);
    const imp = importanceOf(m.salience);
    const actions = writable
      ? h(
          "div",
          { class: "mem-actions" },
          button(null, {
            icon: "edit",
            size: "sm",
            variant: "ghost",
            title: "Edit memory",
            onclick: () => {
              editing = m.id;
              editForm = null;
              renderList();
            },
          }),
          button(null, { icon: "trash", size: "sm", variant: "danger", title: "Delete memory", onclick: () => void remove(m) }),
        )
      : null;
    return h(
      "div",
      { class: "mem-row", dataset: { memory: m.id } },
      h("span", { class: `mem-type mem-type-${TYPES.some((x) => x.id === m.type) ? m.type : "note"}`, title: t.label }, icon(t.icon)),
      h(
        "div",
        { class: "mem-main" },
        h("div", { class: "mem-text" }, highlighted(m.text, terms)),
        h(
          "div",
          { class: "mem-meta" },
          h("span", { class: "mem-kind" }, t.label),
          m.tags.map((tag) => h("span", { class: "tag" }, icon("tag"), tag)),
          m.ts ? h("span", { class: "mem-date", title: fullDateTime(m.ts) }, relTime(m.ts)) : null,
          h(
            "span",
            { class: `mem-imp mem-imp-${imp.label.toLowerCase()}`, title: `Importance: ${imp.label} (${m.salience.toFixed(2)})` },
            IMPORTANCE.map((x) => h("span", { class: ["mem-dot", x.value <= imp.value && "is-on"] })),
          ),
        ),
      ),
      actions,
    );
  }

  function renderList(): void {
    if (loadFailed) {
      listCount.hidden = true;
      setChildren(listBody, errorState(loadFailed, () => void load(), true));
      return;
    }
    if (!memories) {
      setChildren(listBody, h("div", { class: "card-pad" }, skeletonLines(4)));
      return;
    }
    const terms = searchTerms(query);
    let shown = memories.filter((m) => !typeFilter || m.type === typeFilter);
    // The engine's results for this search are ranked already and shown as they are (its word
    // matching isn't a substring test); until they arrive, what's loaded is filtered here as a preview.
    if (terms.length && query !== listQuery) {
      const scored = shown.map((m, i) => ({ m, i, n: matchCount(m, terms) })).filter((x) => x.n > 0);
      scored.sort((a, b) => b.n - a.n || a.i - b.i);
      shown = scored.map((x) => x.m);
    }
    if (editing && !memories.some((m) => m.id === editing)) {
      editing = null;
      editForm = null;
    }
    // The engine filters too (by type, and maybe by search), so the loaded list isn't a reliable "of N" total.
    listCount.hidden = !shown.length;
    listCount.textContent = String(shown.length);
    if (!memories.length && !query && !typeFilter) {
      setChildren(
        listBody,
        emptyState({
          icon: "brain",
          compact: true,
          title: "Nothing saved yet",
          body: "Ask Trinity to remember something on a call — “remember that my sister's name is Ana” — or add a memory here.",
        }),
      );
      return;
    }
    if (!shown.length) {
      const what = query ? `“${query}”` : "this filter";
      setChildren(
        listBody,
        h(
          "div",
          { class: "card-pad muted mem-none" },
          `Nothing matches ${what}${typeFilter ? ` in ${TYPES.find((t) => t.id === typeFilter)?.plural.toLowerCase() ?? typeFilter}` : ""}.`,
        ),
      );
      return;
    }
    setChildren(listBody, h("div", { class: "mem-list" }, shown.map((m) => memoryRow(m, terms))));
  }

  async function load(): Promise<void> {
    const mine = ++seq;
    const q = query;
    loadFailed = null;
    if (!memories) renderList();
    try {
      const list = await api.memory.list({ q: q || undefined, type: typeFilter || undefined, limit: LIST_LIMIT }, { quiet: true });
      if (mine !== seq) return;
      memories = q ? list : [...list].sort((a, b) => b.ts - a.ts);
      listQuery = q;
    } catch (err) {
      if (mine !== seq) return;
      loadFailed = (err as Error).message || "The engine didn't answer.";
    }
    renderList();
  }

  const searchSoon = debounce(() => void load(), 250);
  search.addEventListener("input", () => {
    query = search.value.trim();
    // Filter what's loaded right away; the engine's ranked results follow.
    renderList();
    searchSoon();
  });
  typeSelect.addEventListener("change", () => {
    typeFilter = typeSelect.value;
    renderList();
    void load();
  });
  addBtn.addEventListener("click", openAdd);

  profileRes.subscribe((p) => renderProfile(p));

  /** The name and memories as stored now (e.g. saved by voice since) — the list waits while a form is open. */
  function reload(): void {
    void profileRes.refresh().catch(() => {});
    loadWhenFree();
  }

  return {
    el,
    show() {
      if (!started) {
        started = true;
        renderProfile(profileRes.peek());
        // A cached profile resolves without notifying subscribers — render from the result.
        profileRes.get().then(
          (p) => renderProfile(p),
          () => setChildren(nameState, badge("Couldn't load", "warn")),
        );
        void load();
      } else reload();
    },
    isDirty: () => Boolean(adding?.dirty() || (editing && editForm?.dirty()) || !nameSave.disabled),
    refresh() {
      if (started) reload();
    },
  };
}
