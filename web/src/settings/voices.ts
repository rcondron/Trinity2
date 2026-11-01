// Voices: create a custom voice from a sample, manage your custom voices (play,
// re-sync to the GPU pod, delete), and browse the built-in PersonaPlex presets
// (with which personas use each one).

import { api, type BuiltinVoice, type CustomVoice, type VoiceLibrary } from "./api.js";
import { announce } from "./channel.js";
import { player } from "./player.js";
import { endpointsRes, personasRes, personasUsingVoice, voicesRes } from "./store.js";
import { CreateVoicePanel } from "./voice-create.js";
import {
  badge,
  button,
  confirmAction,
  emptyState,
  errorState,
  fmtSeconds,
  h,
  icon,
  relTime,
  sectionHead,
  setChildren,
  setIcon,
  skeletonLines,
  toast,
  withBusy,
  type IconName,
  type Section,
} from "./ui.js";

function shortName(name: string): string {
  return (name.split(/\s+[—–-]\s+/)[0] ?? name).trim();
}

function groupOf(id: string): string {
  const m = /^(NAT|VAR)([FM])\d+$/i.exec(id);
  if (!m) return "Other";
  return `${m[1]!.toUpperCase() === "NAT" ? "Natural" : "Varied"} · ${m[2]!.toUpperCase() === "F" ? "Female" : "Male"}`;
}

const GROUP_ORDER = ["Natural · Female", "Natural · Male", "Varied · Female", "Varied · Male", "Other"];

export function createVoicesSection(): Section {
  let lib: VoiceLibrary | null = null;
  let highlight: string | null = null;
  let loadFailed: string | null = null;

  const create = new CreateVoicePanel({
    saved: (r) => {
      highlight = r.voice.slug;
      voicesRes.update((l) => ({ ...l, custom: [r.voice, ...l.custom.filter((c) => c.slug !== r.voice.slug)] }));
      void voicesRes.refresh().catch(() => {});
      announce("voices");
      toast(r.synced ? `Saved “${r.voice.name}” and synced it to the GPU pod` : `Saved “${r.voice.name}” (not synced yet)`, r.synced ? "success" : "warn");
    },
    synced: () => {
      void voicesRes.refresh().catch(() => {});
      announce("voices");
    },
  });

  const customCard = h("div", { class: "card voices-card" });
  const builtinCard = h("div", { class: "card voices-card" });

  const el = h(
    "section",
    { class: "section", "aria-labelledby": "sec-voices" },
    sectionHead({
      id: "sec-voices",
      title: "Voices",
      lede: "Built-in PersonaPlex voices, plus your own — cloned from a few seconds of speech and assigned to any persona.",
    }),
    h("div", { class: "voices-stack" }, create.el, customCard, builtinCard),
  );

  // ── Custom voices ──

  function podChip(l: VoiceLibrary): HTMLElement | null {
    if (!l.customAvailable || !l.pod) return null;
    const p = l.pod;
    const chip = (tone: "ok" | "warn" | "muted", ic: IconName, text: string, title: string, link = false) =>
      h(
        link ? "a" : "span",
        { class: `pod-chip pod-${tone}`, title, href: link ? "#models" : undefined },
        h("span", { class: "pod-dot" }),
        icon(ic),
        text,
      );
    if (!p.configured) return chip("muted", "server", "GPU pod not set up", "Set the PersonaPlex URL in Models & API keys", true);
    if (p.reachable === false) return chip("warn", "server", "GPU pod unreachable", "Voices are saved locally and uploaded when the pod is back");
    if (p.uploads === false)
      return chip("warn", "key", "Pod uploads off", "Set the PersonaPlex admin token in Models & API keys to upload voices", true);
    if (p.reachable && p.uploads) return chip("ok", "server", "GPU pod connected", "New voices upload to the GPU pod");
    return chip("muted", "server", "GPU pod status unknown", "");
  }

  function syncBadge(v: CustomVoice): HTMLElement {
    if (v.synced === true) return badge("Synced", "ok", "check");
    if (v.synced === false) return badge("Not synced", "warn", "alert");
    return badge("– Unknown", "default");
  }

  function voiceRow(v: CustomVoice): HTMLElement {
    const url = api.voices.audioUrl(v.slug);
    const play = h("button", { class: "play-btn", type: "button", title: "Play sample", "aria-label": `Play ${v.name}` }, icon("play"));
    const setPlaying = (on: boolean) => {
      play.classList.toggle("is-playing", on);
      setIcon(play, on ? "stop" : "play");
      play.setAttribute("aria-label", `${on ? "Stop" : "Play"} ${v.name}`);
    };
    play.addEventListener("click", () => player.toggle(url, setPlaying));
    if (player.isPlaying(url)) setPlaying(true);

    const users = personasUsingVoice(v.id);
    const meta: (string | HTMLElement)[] = [h("code", null, v.id)];
    if (v.durationSec) meta.push(fmtSeconds(v.durationSec));
    if (v.createdAt) meta.push(`added ${relTime(v.createdAt)}`);
    const resync = button(null, { icon: "refresh", size: "sm", title: "Upload to the GPU pod again" });
    resync.addEventListener("click", () => void resyncVoice(v, resync));
    const del = button(null, { icon: "trash", size: "sm", variant: "danger", title: "Delete voice" });
    del.addEventListener("click", () => void deleteVoice(v));

    return h(
      "div",
      { class: ["voice-row", highlight === v.slug && "is-new"] },
      play,
      h(
        "div",
        { class: "voice-main" },
        h("div", { class: "voice-name" }, v.name),
        h(
          "div",
          { class: "voice-meta" },
          meta.flatMap((m, i) => (i ? [h("span", { class: "meta-sep", "aria-hidden": "true" }, "·"), m] : [m])),
        ),
        users.length
          ? h("div", { class: "voice-users" }, icon("users"), `Used by ${users.map((u) => shortName(u.name)).join(", ")}`)
          : null,
      ),
      h("div", { class: "voice-side" }, syncBadge(v), resync, del),
    );
  }

  async function resyncVoice(v: CustomVoice, btn: HTMLButtonElement): Promise<void> {
    try {
      const r = await withBusy(btn, () => api.voices.sync(v.slug));
      if (r.synced) toast(`“${v.name}” is on the GPU pod`, "success");
      else toast(`Couldn't sync “${v.name}”${r.error ? `: ${r.error}` : ""}`, "warn");
      voicesRes.update((l) => ({ ...l, custom: l.custom.map((c) => (c.slug === v.slug ? { ...c, synced: r.synced } : c)) }));
      void voicesRes.refresh().catch(() => {});
      announce("voices");
    } catch {
      /* reported */
    }
  }

  async function deleteVoice(v: CustomVoice): Promise<void> {
    const users = personasUsingVoice(v.id);
    const ok = await confirmAction({
      title: `Delete “${v.name}”?`,
      message: users.length
        ? h(
            "div",
            null,
            h("p", null, "These personas use this voice:"),
            h("ul", { class: "dialog-list" }, users.map((u) => h("li", null, u.name))),
            h("p", null, "Give them another voice in Personas afterwards. This can't be undone."),
          )
        : "The sample is removed from the voice library. This can't be undone.",
      confirmLabel: "Delete voice",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.voices.remove(v.slug);
      if (player.isPlaying(api.voices.audioUrl(v.slug))) player.stop();
      voicesRes.update((l) => ({ ...l, custom: l.custom.filter((c) => c.slug !== v.slug) }));
      void voicesRes.refresh().catch(() => {});
      announce("voices");
      toast(`Deleted “${v.name}”`, "success");
    } catch {
      /* reported */
    }
  }

  function renderCustom(): void {
    if (!lib) {
      setChildren(customCard, loadFailed ? errorState(loadFailed, () => void load(), true) : h("div", { class: "card-pad" }, skeletonLines(3)));
      return;
    }
    const l = lib;
    const sorted = [...l.custom].sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name));
    let body: HTMLElement;
    if (!l.customAvailable) {
      body = emptyState({
        icon: "waveform",
        tone: "soon",
        compact: true,
        title: "Custom voices are on their way",
        body: "This engine doesn't have the voice library yet. Once it does, voices you create here appear in this list — ready to assign to any persona.",
      });
    } else if (!sorted.length) {
      body = emptyState({
        icon: "mic",
        compact: true,
        title: "No custom voices yet",
        body: "Record or upload a short sample above to create your first one.",
      });
    } else {
      body = h("div", { class: "voice-list" }, sorted.map(voiceRow));
    }
    setChildren(
      customCard,
      h(
        "div",
        { class: "card-head" },
        h("span", { class: "card-icon" }, icon("waveform")),
        h(
          "div",
          { class: "card-head-text" },
          h("h2", { class: "card-title" }, "Your voices", sorted.length ? h("span", { class: "count" }, String(sorted.length)) : null),
          h("p", { class: "card-sub" }, "Stored in the engine's voice library and uploaded to the GPU pod when a call needs them."),
        ),
        h("div", { class: "card-head-side" }, podChip(l)),
      ),
      body,
    );
  }

  // ── Built-in voices ──

  function vchip(b: BuiltinVoice, defaultVoice: string | undefined): HTMLElement {
    const users = personasUsingVoice(b.id);
    return h(
      "div",
      { class: ["vchip", users.length > 0 && "is-used"] },
      h(
        "div",
        { class: "vchip-top" },
        h("span", { class: "vchip-label" }, b.label),
        defaultVoice === b.id ? badge("Default", "info") : null,
      ),
      h("code", { class: "vchip-id" }, b.id),
      users.length ? h("div", { class: "vchip-users" }, icon("users"), users.map((u) => shortName(u.name)).join(", ")) : null,
    );
  }

  function renderBuiltin(): void {
    if (!lib) {
      setChildren(builtinCard, loadFailed ? null : h("div", { class: "card-pad" }, skeletonLines(4)));
      builtinCard.hidden = Boolean(loadFailed);
      return;
    }
    builtinCard.hidden = false;
    const groups = new Map<string, BuiltinVoice[]>();
    for (const b of lib.builtin) {
      const g = groupOf(b.id);
      groups.set(g, [...(groups.get(g) ?? []), b]);
    }
    const def = endpointsRes.peek()?.personaplexVoice;
    const ordered = [...groups.entries()].sort(([a], [b]) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b));
    setChildren(
      builtinCard,
      h(
        "div",
        { class: "card-head" },
        h("span", { class: "card-icon card-icon-muted" }, icon("users")),
        h(
          "div",
          { class: "card-head-text" },
          h("h2", { class: "card-title" }, "Built-in voices", h("span", { class: "count" }, String(lib.builtin.length))),
          h("p", { class: "card-sub" }, "PersonaPlex presets — fast to connect. Pick one for a persona in Personas."),
        ),
      ),
      h(
        "div",
        { class: "builtin-groups" },
        ordered.map(([name, list]) =>
          h("div", { class: "builtin-group" }, h("h3", { class: "mini-title" }, name), h("div", { class: "builtin-grid" }, list.map((b) => vchip(b, def)))),
        ),
      ),
    );
  }

  function render(): void {
    renderCustom();
    renderBuiltin();
  }

  async function load(): Promise<void> {
    loadFailed = null;
    if (!lib) render();
    try {
      lib = await voicesRes.get();
      create.setAvailable(lib.customAvailable, lib.pod);
      void personasRes.get().catch(() => {});
      void endpointsRes.get().catch(() => {});
    } catch (err) {
      loadFailed = (err as Error).message || "The engine didn't answer.";
    }
    render();
  }

  voicesRes.subscribe((l) => {
    lib = l;
    loadFailed = null;
    create.setAvailable(l.customAvailable, l.pod);
    render();
  });
  personasRes.subscribe(() => render());
  endpointsRes.subscribe(() => renderBuiltin());

  let started = false;
  return {
    el,
    show() {
      if (!started) {
        started = true;
        void load();
      }
      create.onShown();
    },
    hide() {
      create.stopAll();
      player.stop();
    },
    isDirty: () => create.hasUnsavedSample(),
    refresh() {
      if (started) void voicesRes.refresh().catch(() => {});
    },
  };
}
