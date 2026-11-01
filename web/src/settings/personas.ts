// Personas: a card list of every persona (active badge, voice, toolsets) beside
// the editor. Handles create / duplicate / save / activate / delete, guards
// unsaved edits when switching, and keeps #personas/<id> in the address bar.

import { api, type Persona, type PersonaFields, type Toolset, type VoiceLibrary } from "./api.js";
import { announce } from "./channel.js";
import { PersonaEditor, fieldsOf } from "./persona-editor.js";
import { endpointsRes, personasRes, statusRes, toolsetsRes, voiceLabel, voicesRes } from "./store.js";
import {
  avatar,
  badge,
  button,
  choose,
  confirmAction,
  emptyState,
  errorState,
  h,
  icon,
  sectionHead,
  setChildren,
  skeletonBlock,
  skeletonLines,
  toast,
  type Section,
} from "./ui.js";

const DRAFT = "new";

function sortKey(name: string): string {
  return name.replace(/^the\s+/i, "").toLowerCase();
}

function sortPersonas(list: Persona[]): Persona[] {
  return [...list].sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)));
}

/** "Natural Female 2"-style label, short toolset names, and a role line for a card. */
function roleLine(p: Persona): string {
  const role = p.traits?.role?.trim();
  if (role) return role.charAt(0).toUpperCase() + role.slice(1);
  const first = /^.*?[.!?](?=\s|$)/.exec(p.description.trim())?.[0] ?? p.description.trim();
  return first.length > 70 ? `${first.slice(0, 68).trimEnd()}…` : first || "No personality yet";
}

function toolsetName(id: string, toolsets: Toolset[]): string {
  const label = toolsets.find((t) => t.id === id)?.label ?? id;
  return label.replace(/\s+tools?$/i, "");
}

export function createPersonasSection(): Section {
  const listEl = h("ul", { class: "persona-list", "aria-label": "Personas" });
  const editorCol = h("div", { class: "persona-editor-col" });
  const newBtn = button("New persona", { icon: "plus", variant: "primary", onclick: () => void startDraft() });

  const el = h(
    "section",
    { class: "section", "aria-labelledby": "sec-personas" },
    sectionHead({
      id: "sec-personas",
      title: "Personas",
      lede: "Who Trinity becomes on a call — personality, voice, and abilities. The active persona answers new calls.",
      actions: newBtn,
    }),
    h("div", { class: "persona-wrap" }, h("div", { class: "persona-layout" }, h("div", { class: "persona-list-col" }, listEl), editorCol)),
  );

  let personas: Persona[] = [];
  let activeId: string | null = null;
  let voices: VoiceLibrary | null = null;
  let toolsets: Toolset[] = [];
  let selected: string | null = null; // persona id, or DRAFT
  let draft: Persona | null = null;
  let draftStartDirty = false;
  /** Where to go back to when a draft is discarded. */
  let returnTo: string | null = null;
  let editor: PersonaEditor | null = null;
  let editorDirty = false;
  /** Live editor values for the selected card (name, voice, toolsets update as you type). */
  let editorLive: PersonaFields | null = null;
  let loaded = false;
  let loading: Promise<void> | null = null;
  let pendingSub: string | null = null;
  let visible = false;

  // ── Loading ──

  function showSkeleton(): void {
    setChildren(
      listEl,
      Array.from({ length: 4 }, () => h("li", null, h("div", { class: "pcard pcard-skeleton" }, skeletonLines(3)))),
    );
    setChildren(editorCol, h("div", { class: "card editor editor-skeleton" }, skeletonBlock(88), h("div", { class: "editor-body" }, skeletonLines(6))));
  }

  async function load(): Promise<void> {
    showSkeleton();
    try {
      const [list, status, lib, sets] = await Promise.all([
        personasRes.get(),
        statusRes.get(),
        voicesRes.get().catch(() => null),
        toolsetsRes.get(),
      ]);
      personas = sortPersonas(list);
      activeId = status.persona?.id ?? null;
      voices = lib ?? { builtin: [], custom: [], pod: null, customAvailable: false };
      toolsets = sets;
      loaded = true;
      const sub = pendingSub;
      pendingSub = null;
      if (sub === DRAFT) {
        openPersona(activeId);
        startDraftNow();
      } else {
        openPersona(sub && personas.some((p) => p.id === sub) ? sub : activeId);
      }
    } catch (err) {
      setChildren(listEl);
      setChildren(
        editorCol,
        errorState((err as Error).message || "The engine didn't answer.", () => {
          loading = load();
        }),
      );
    } finally {
      loading = null;
    }
  }

  // ── Rendering ──

  function renderList(): void {
    if (!loaded) return;
    const items: HTMLElement[] = [];
    if (draft) items.push(card(draft, true));
    for (const p of personas) items.push(card(p, false));
    if (!items.length) {
      setChildren(
        listEl,
        h("li", null, emptyState({ icon: "users", title: "No personas yet", body: "Create one to start talking.", compact: true })),
      );
      return;
    }
    setChildren(listEl, items);
  }

  function card(p: Persona, isDraft: boolean): HTMLElement {
    const id = isDraft ? DRAFT : p.id;
    const isSelected = selected === id;
    const isActive = !isDraft && p.id === activeId;
    // While editing, the card mirrors the live name, voice, and toolsets.
    const live = isSelected ? editorLive : null;
    const name = (live?.name.trim() || p.name || "New persona").trim();
    const voice = live?.voice ?? p.voice;
    const sets = live?.toolsets ?? p.toolsets;
    const dirty = isSelected && editorDirty;
    return h(
      "li",
      null,
      h(
        "button",
        {
          type: "button",
          class: ["pcard", isSelected && "is-selected", isDraft && "is-draft", isActive && "is-active"],
          "aria-current": isSelected ? "true" : undefined,
          onclick: () => void select(id),
        },
        avatar(name, isDraft ? "draft" : p.id, "md"),
        h(
          "span",
          { class: "pcard-body" },
          h(
            "span",
            { class: "pcard-top" },
            h("span", { class: "pcard-name" }, name),
            dirty ? h("span", { class: "dirty-dot", title: "Unsaved changes" }) : null,
            isActive ? badge("Active", "ok") : null,
            isDraft ? badge("Draft", "accent") : null,
          ),
          h("span", { class: "pcard-role" }, isDraft ? "Not saved yet" : roleLine(p)),
          h(
            "span",
            { class: "pcard-tags" },
            h("span", { class: "tag" }, icon("waveform"), voiceLabel(voice, voices ?? undefined)),
            sets.map((t) => h("span", { class: "tag tag-accent" }, icon(t === "game" ? "dice" : "sparkles"), toolsetName(t, toolsets))),
          ),
        ),
      ),
    );
  }

  /** Scroll the list (phone strip or sticky desktop column) so the selected card is visible — never the page. */
  function revealSelected(): void {
    const item = listEl.querySelector<HTMLElement>(".pcard.is-selected")?.parentElement;
    if (!item) return;
    const ir = item.getBoundingClientRect();
    if (listEl.scrollWidth > listEl.clientWidth + 1) {
      const lr = listEl.getBoundingClientRect();
      if (ir.left < lr.left || ir.right > lr.right) listEl.scrollBy({ left: ir.left - lr.left - 2, behavior: "smooth" });
      return;
    }
    const col = listEl.parentElement;
    if (col && col.scrollHeight > col.clientHeight + 1) {
      const cr = col.getBoundingClientRect();
      if (ir.top < cr.top || ir.bottom > cr.bottom) col.scrollBy({ top: ir.top - cr.top - 8, behavior: "smooth" });
    }
  }

  function syncHash(): void {
    if (!visible) return;
    const want = selected === DRAFT ? `#personas/${DRAFT}` : selected ? `#personas/${encodeURIComponent(selected)}` : "#personas";
    if (location.hash !== want) history.replaceState(null, "", want);
  }

  function openPersona(id: string | null): void {
    editor?.destroy();
    editor = null;
    editorDirty = false;
    editorLive = null;
    let target: Persona | undefined;
    let isNew = false;
    if (id === DRAFT && draft) {
      target = draft;
      isNew = true;
    } else {
      target = personas.find((p) => p.id === id) ?? personas.find((p) => p.id === activeId) ?? personas[0];
    }
    if (!target) {
      selected = null;
      setChildren(
        editorCol,
        emptyState({
          icon: "users",
          title: "No personas",
          body: "Create a persona to give Trinity a personality and a voice.",
          action: button("New persona", { icon: "plus", variant: "primary", onclick: () => void startDraft() }),
        }),
      );
      renderList();
      syncHash();
      return;
    }
    selected = isNew ? DRAFT : target.id;
    editor = makeEditor(target, isNew);
    setChildren(editorCol, editor.el);
    renderList();
    syncHash();
    requestAnimationFrame(revealSelected);
  }

  function makeEditor(p: Persona, isNew: boolean): PersonaEditor {
    return new PersonaEditor(
      p,
      {
        voices: voices ?? { builtin: [], custom: [], pod: null, customAvailable: false },
        toolsets,
        isActive: !isNew && p.id === activeId,
        canDelete: personas.length > 1,
        isNew,
        startDirty: isNew && draftStartDirty,
      },
      {
        save: (fields, id) => savePersona(fields, id),
        activate: () => void activate(),
        remove: () => void remove(),
        duplicate: () => void duplicate(),
        discardDraft: () => {
          draft = null;
          openPersona(returnTo && personas.some((x) => x.id === returnTo) ? returnTo : activeId);
        },
        changed: (dirty, live) => {
          editorDirty = dirty;
          editorLive = live;
          renderList();
        },
      },
    );
  }

  // ── Actions ──

  /** Ask before throwing away unsaved edits. Resolves true when it's OK to move on. */
  async function guard(): Promise<boolean> {
    if (!editor || !editor.isDirty()) return true;
    const name = editor.values().name.trim() || "this persona";
    const choice = await choose({
      title: "Save your changes?",
      message: `You have unsaved edits to “${name}”.`,
      tone: "warn",
      icon: "edit",
      buttons: [
        { label: "Keep editing", value: "cancel" },
        { label: "Discard", value: "discard" },
        { label: "Save", value: "save", tone: "primary" },
      ],
    });
    if (choice === "save") return editor.save();
    if (choice === "discard") {
      editor.revert();
      return true;
    }
    return false;
  }

  async function select(id: string): Promise<void> {
    if (id === selected) return;
    if (!(await guard())) return;
    if (selected === DRAFT && id !== DRAFT) draft = null;
    openPersona(id);
  }

  function blankDraft(): Persona {
    return {
      id: "",
      name: "",
      description: "",
      voicePrompt: "",
      voice: endpointsRes.peek()?.personaplexVoice || voices?.builtin[0]?.id || "NATF2",
      toolsets: [],
      traits: {},
      updatedAt: 0,
    };
  }

  function startDraftNow(): void {
    if (selected !== DRAFT) returnTo = selected;
    draft = blankDraft();
    draftStartDirty = false;
    openPersona(DRAFT);
    editor?.focusName();
  }

  async function startDraft(): Promise<void> {
    if (!loaded) return;
    if (selected === DRAFT && draft) {
      editor?.focusName();
      return;
    }
    if (!(await guard())) return;
    startDraftNow();
  }

  async function duplicate(): Promise<void> {
    const source = personas.find((p) => p.id === selected);
    if (!source) return;
    if (!(await guard())) return;
    returnTo = source.id;
    const f: PersonaFields = fieldsOf(source);
    draft = { ...blankDraft(), ...f, name: `${f.name} (copy)` };
    draftStartDirty = true;
    openPersona(DRAFT);
    editor?.focusName();
  }

  async function savePersona(fields: PersonaFields, id: string | null): Promise<Persona | null> {
    try {
      const saved = id ? await api.personas.update(id, fields) : await api.personas.create(fields);
      const exists = personas.some((p) => p.id === saved.id);
      personas = sortPersonas(exists ? personas.map((p) => (p.id === saved.id ? saved : p)) : [...personas, saved]);
      if (!id) {
        draft = null;
        draftStartDirty = false;
        selected = saved.id;
        syncHash();
      }
      editorLive = fieldsOf(saved);
      editorDirty = false;
      personasRes.set(personas);
      if (saved.id === activeId) statusRes.update((s) => ({ ...s, persona: saved }));
      editor?.setCanDelete(personas.length > 1);
      announce("personas");
      toast(id ? `Saved “${saved.name}”` : `Created “${saved.name}”`, "success");
      renderList();
      return saved;
    } catch {
      return null; // the API helper already explained what went wrong
    }
  }

  async function activate(): Promise<void> {
    const id = selected;
    if (!id || id === DRAFT || !editor) return;
    if (editor.isDirty() && !(await editor.save())) return;
    try {
      const r = await api.personas.activate(id);
      const p = r.persona ?? personas.find((x) => x.id === id);
      activeId = id;
      if (p) statusRes.update((s) => ({ ...s, persona: p }));
      editor?.setActive(true);
      renderList();
      announce("personas");
      toast(`“${p?.name ?? "Persona"}” is now active — new calls will use it.`, "success");
    } catch {
      /* reported */
    }
  }

  async function remove(): Promise<void> {
    const p = personas.find((x) => x.id === selected);
    if (!p) return;
    if (personas.length <= 1) {
      toast("You need at least one persona.", "warn");
      return;
    }
    const wasActive = p.id === activeId;
    const ok = await confirmAction({
      title: `Delete “${p.name}”?`,
      message: wasActive
        ? "This is the active persona — Trinity will switch to another one for new calls. This can't be undone."
        : "Its personality, voice settings, and traits are removed. This can't be undone.",
      confirmLabel: "Delete persona",
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.personas.remove(p.id);
      personas = personas.filter((x) => x.id !== p.id);
      if (r.active) activeId = r.active;
      personasRes.set(personas);
      if (wasActive) void statusRes.refresh().catch(() => {});
      announce("personas");
      toast(`Deleted “${p.name}”`, "success");
      openPersona(activeId);
    } catch {
      /* reported */
    }
  }

  // ── Live updates from other sections / tabs ──

  personasRes.subscribe((list) => {
    if (!loaded) return;
    personas = sortPersonas(list);
    if (selected && selected !== DRAFT && editor) {
      const fresh = personas.find((p) => p.id === selected);
      if (!fresh) {
        if (!editor.isDirty()) openPersona(activeId);
      } else {
        editor.adopt(fresh);
        editor.setCanDelete(personas.length > 1);
      }
    }
    renderList();
  });

  statusRes.subscribe((s) => {
    if (!loaded) return;
    activeId = s.persona?.id ?? activeId;
    editor?.setActive(Boolean(selected && selected === activeId));
    renderList();
  });

  voicesRes.subscribe((lib) => {
    voices = lib;
    editor?.setVoices(lib);
    renderList();
  });

  toolsetsRes.subscribe((sets) => {
    toolsets = sets;
    editor?.setToolsets(sets);
    renderList();
  });

  return {
    el,
    show(sub) {
      visible = true;
      if (!loaded) {
        pendingSub = sub;
        if (!loading) loading = load();
        return;
      }
      // If the user cancels the unsaved-changes prompt, put the hash back.
      if (sub === DRAFT) void startDraft().then(syncHash);
      else if (sub && sub !== selected && personas.some((p) => p.id === sub)) void select(sub).then(syncHash);
      else syncHash();
    },
    hide() {
      visible = false;
    },
    isDirty: () => Boolean(editor?.isDirty()),
    refresh() {
      if (!loaded) return;
      void personasRes.refresh().catch(() => {});
      void statusRes.refresh().catch(() => {});
      void voicesRes.refresh().catch(() => {});
    },
  };
}
