// Voices: create a custom voice from a sample, manage your custom voices (play,
// re-sync to the GPU pod, delete), and browse the built-in PersonaPlex presets
// (with which personas use each one) — each with a ▶ that plays a sample of the
// voice, made by the pod on first request and kept by the engine.

import { api, type BuiltinVoice, type CustomVoice, type MakeSampleResult, type VoiceLibrary, type VoiceSamples } from "./api.js";
import { announce } from "./channel.js";
import { player } from "./player.js";
import { clarityPreferred, rememberClarity } from "../voice-chain.js";
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
  switchInput,
  toast,
  withBusy,
  type Child,
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

const VOICE_IN_USE = "Voice in use — samples wait for the call to end";

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

  // The live call's voice through the browser's clean-up chain (web/src/voice-chain.ts), per browser; the main app
  // picks a change up at once through the storage event.
  const clarity = switchInput({
    checked: clarityPreferred(),
    label: "Clean up the live voice in this browser",
    onchange: (on) => {
      rememberClarity(on);
      toast(on ? "Live voice clean-up is on in this browser" : "Live voice clean-up is off in this browser", "info");
    },
  });
  const clarityCard = h(
    "div",
    { class: "card voices-card" },
    h(
      "div",
      { class: "card-head" },
      h("span", { class: "card-icon card-icon-muted" }, icon("sliders")),
      h(
        "div",
        { class: "card-head-text" },
        h("h2", { class: "card-title" }, "Live voice clean-up"),
        h(
          "p",
          { class: "card-sub" },
          "PersonaPlex speaks through a 1.1 kbps codec, which sounds distant. In this browser the call's voice goes through a presence chain — less rumble and box, more presence and air, an even level. Off plays it as the model made it.",
        ),
      ),
      h("div", { class: "card-head-side" }, clarity.el),
    ),
  );

  const el = h(
    "section",
    { class: "section", "aria-labelledby": "sec-voices" },
    sectionHead({
      id: "sec-voices",
      title: "Voices",
      lede: "Built-in PersonaPlex voices, plus your own — cloned from a few seconds of speech and assigned to any persona.",
    }),
    h("div", { class: "voices-stack" }, create.el, clarityCard, customCard, builtinCard),
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

  // Samples being made right now — from a chip's ▶ (`pending`) or the "Make all" run (`batch`). Kept
  // here rather than on the buttons because the chips are re-drawn whenever the library changes,
  // e.g. the moment a sample lands.
  const pending = new Set<string>();
  let batch: { done: number; total: number; current: string; stopping: boolean } | null = null;
  let shown = false;
  /** While the voice is in a call, the library is re-read every few seconds, so the in-use chip clears when the call ends. */
  let checkAgain: ReturnType<typeof setTimeout> | null = null;
  const checkAgainSoon = () => {
    if (checkAgain) return;
    checkAgain = setTimeout(() => {
      checkAgain = null;
      if (shown) void voicesRes.refresh().catch(() => {});
    }, 5000);
  };
  // For the same reason the player talks to whichever ▶ is on screen for a voice now, not the one clicked.
  const chipPlaying = new Map<string, (on: boolean) => void>();
  const onChipPlaying = (id: string) => (on: boolean) => chipPlaying.get(id)?.(on);

  /** A sample that just landed goes into the cached library (the chips re-draw with it). */
  function addSample(id: string, r: MakeSampleResult): void {
    voicesRes.update((l) =>
      l.samples
        ? { ...l, samples: { ...l.samples, items: { ...l.samples.items, [id]: { durationSec: r.durationSec, createdAt: r.createdAt } } } }
        : l,
    );
  }

  /** Make (or, `force`, remake) one voice's sample from its chip, then play it. */
  async function makeSample(b: BuiltinVoice, btn: HTMLButtonElement, force: boolean): Promise<void> {
    const url = api.voices.sampleUrl(b.id);
    if (force && player.isPlaying(url)) player.stop();
    pending.add(b.id);
    let made: MakeSampleResult | null = null;
    try {
      made = await withBusy(btn, () => api.voices.makeSample(b.id, { force }));
    } catch {
      /* reported */
    }
    pending.delete(b.id);
    if (!made) {
      if (!btn.isConnected) renderBuiltin(); // re-drawn while busy: that copy still spins
      return;
    }
    addSample(b.id, made);
    if (shown) void player.play(url, onChipPlaying(b.id)); // not from off screen: the section may have been left meanwhile
  }

  /**
   * Make every missing sample, one after another (the pod renders one at a time). Stops at the first
   * error — the voice is in a call, or one sample failed — which the request helper has already toasted.
   */
  async function makeAll(voices: BuiltinVoice[]): Promise<void> {
    if (batch) return;
    const run = { done: 0, total: voices.length, current: "", stopping: false };
    batch = run;
    try {
      for (const b of voices) {
        if (run.stopping) break;
        run.current = b.id;
        renderBuiltin();
        const made = await api.voices.makeSample(b.id);
        run.done++;
        addSample(b.id, made);
      }
      if (run.done === run.total) toast(`Made ${run.total} voice samples`, "success");
    } catch {
      /* reported */
    } finally {
      batch = null;
      renderBuiltin();
      void voicesRes.refresh().catch(() => {});
    }
  }

  /** The chip's ▶: plays the voice's sample, or — outlined, until there is one — makes it first. */
  function sampleButton(b: BuiltinVoice, s: VoiceSamples): HTMLButtonElement {
    const url = api.voices.sampleUrl(b.id);
    const has = Boolean(s.items[b.id]);
    const btn = h("button", { class: ["play-btn", "play-btn-sm", !has && "is-missing"], type: "button", dataset: { voice: b.id } }, icon("play"));
    const setPlaying = (on: boolean) => {
      btn.classList.toggle("is-playing", on);
      setIcon(btn, on ? "stop" : "play");
      btn.setAttribute("aria-label", `${on ? "Stop" : "Play"} ${b.label}`);
    };
    if (has) {
      btn.title = "Play sample · shift-click to make it again";
      chipPlaying.set(b.id, setPlaying);
      setPlaying(player.isPlaying(url));
    } else {
      btn.title = "Make a sample and play it (about 10 seconds; borrows the voice briefly)";
      btn.setAttribute("aria-label", `Make a sample of ${b.label} and play it`);
    }
    if (pending.has(b.id) || batch?.current === b.id) {
      btn.disabled = true;
      btn.classList.add("is-busy");
      btn.setAttribute("aria-busy", "true");
    } else if (!has && batch) {
      btn.disabled = true;
      btn.title = "Making samples…";
    } else if (!has && s.use === "call") {
      btn.disabled = true;
      btn.title = VOICE_IN_USE;
    }
    btn.addEventListener("click", (ev) => {
      if (!has || ev.shiftKey) void makeSample(b, btn, has);
      else player.toggle(url, onChipPlaying(b.id));
    });
    return btn;
  }

  function vchip(b: BuiltinVoice, defaultVoice: string | undefined, samples: VoiceSamples | null): HTMLElement {
    const users = personasUsingVoice(b.id);
    const id = h("code", { class: "vchip-id" }, b.id);
    return h(
      "div",
      { class: ["vchip", users.length > 0 && "is-used"] },
      h(
        "div",
        { class: "vchip-top" },
        h("span", { class: "vchip-label" }, b.label),
        defaultVoice === b.id ? badge("Default", "info") : null,
      ),
      samples ? h("div", { class: "vchip-foot" }, id, sampleButton(b, samples)) : id,
      users.length ? h("div", { class: "vchip-users" }, icon("users"), users.map((u) => shortName(u.name)).join(", ")) : null,
    );
  }

  /** Header side: "Make all samples (N)" — progress and Stop while it runs — and the in-use chip during a call. */
  function samplesSide(l: VoiceLibrary, s: VoiceSamples): Child[] {
    const missing = l.builtin.filter((b) => !s.items[b.id]);
    const inCall = s.use === "call";
    if (inCall) checkAgainSoon(); // the call ends without a word to this page: look again until it has
    const side: Child[] = [];
    if (batch) {
      const run = batch;
      side.push(
        h("span", { class: "samples-progress", role: "status" }, h("span", { class: "spin", "aria-hidden": "true" }), `Making samples… ${run.done + 1} of ${run.total}`),
        button(run.stopping ? "Stopping…" : "Stop", {
          size: "sm",
          cls: "samples-stop-btn",
          disabled: run.stopping,
          title: "Finish the one being made, then stop",
          onclick: () => {
            run.stopping = true;
            renderBuiltin();
          },
        }),
      );
    } else if (missing.length) {
      side.push(
        button(`Make all samples (${missing.length})`, {
          icon: "waveform",
          size: "sm",
          cls: "make-all-btn",
          disabled: inCall,
          title: inCall ? VOICE_IN_USE : `About ${missing.length * 10} seconds in all; borrows the voice while it runs`,
          onclick: () => void makeAll(missing),
        }),
      );
    }
    if (inCall)
      side.push(
        h(
          "span",
          { class: "pod-chip voice-busy", title: "Samples are made from a free voice session, never taken from a live call" },
          h("span", { class: "pod-dot" }),
          icon("mic"),
          VOICE_IN_USE,
        ),
      );
    return side;
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
    const samples = lib.samples;
    const side = samples ? samplesSide(lib, samples) : [];
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
          samples?.text ? h("p", { class: "card-sub sample-text" }, `Each sample says: “${samples.text}”`) : null,
        ),
        side.length ? h("div", { class: "card-head-side" }, side) : null,
      ),
      h(
        "div",
        { class: "builtin-groups" },
        ordered.map(([name, list]) =>
          h(
            "div",
            { class: "builtin-group" },
            h("h3", { class: "mini-title" }, name),
            h("div", { class: "builtin-grid" }, list.map((b) => vchip(b, def, samples))),
          ),
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
      shown = true;
      if (!started) {
        started = true;
        void load();
      }
      create.onShown();
    },
    hide() {
      shown = false;
      if (checkAgain) clearTimeout(checkAgain);
      checkAgain = null;
      create.stopAll();
      player.stop();
    },
    isDirty: () => create.hasUnsavedSample(),
    refresh() {
      if (started) void voicesRes.refresh().catch(() => {});
    },
  };
}
