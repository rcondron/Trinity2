// Browser-side speech using the Web Speech API. This is Trinity's voice in MOCK
// mode: SpeechRecognition turns your mic into text, speechSynthesis speaks her
// replies. When fal.ai/PersonaPlex is wired, this module is bypassed for real
// full-duplex audio streaming.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = any;

export class Speech {
  readonly recognitionSupported: boolean;
  readonly synthSupported: boolean;
  listening = false;
  onFinal?: (text: string) => void;
  onInterim?: (text: string) => void;
  onListeningChange?: (on: boolean) => void;
  onSpeakingChange?: (on: boolean) => void;
  onBargeIn?: () => void;

  private recog?: Rec;
  private wantListening = false;
  private speaking = false;

  constructor() {
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    this.recognitionSupported = Boolean(Ctor);
    this.synthSupported = "speechSynthesis" in window;

    if (Ctor) {
      const r: Rec = new Ctor();
      r.continuous = true;
      r.interimResults = true;
      r.lang = "en-US";
      r.onresult = (e: any) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          const text = res[0].transcript.trim();
          if (res.isFinal) {
            if (text) this.onFinal?.(text);
          } else {
            interim += text + " ";
            if (this.speaking) {
              this.cancelSpeech(); // barge-in: stop talking when the user talks
              this.onBargeIn?.();
            }
          }
        }
        this.onInterim?.(interim.trim());
      };
      r.onend = () => {
        if (this.wantListening) {
          try { r.start(); } catch { /* already starting */ }
        } else {
          this.listening = false;
          this.onListeningChange?.(false);
        }
      };
      r.onerror = () => { /* swallow; onend will restart if wanted */ };
      this.recog = r;
    }
  }

  startListening(): void {
    if (!this.recog) return;
    this.wantListening = true;
    try {
      this.recog.start();
      this.listening = true;
      this.onListeningChange?.(true);
    } catch { /* already started */ }
  }

  stopListening(): void {
    this.wantListening = false;
    this.listening = false;
    this.onListeningChange?.(false);
    try { this.recog?.stop(); } catch { /* ignore */ }
  }

  speak(text: string, voiceHint?: string): void {
    if (!this.synthSupported || !text) return;
    const u = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const pick =
      voices.find((v) => voiceHint && v.name.toLowerCase().includes(voiceHint.toLowerCase())) ||
      voices.find((v) => /female|samantha|zira|aria|jenny/i.test(v.name)) ||
      voices.find((v) => v.lang.startsWith("en"));
    if (pick) u.voice = pick;
    u.rate = 1.03;
    u.pitch = 1.05;
    u.onstart = () => { this.speaking = true; this.onSpeakingChange?.(true); };
    u.onend = () => { this.speaking = false; this.onSpeakingChange?.(false); };
    window.speechSynthesis.speak(u);
  }

  cancelSpeech(): void {
    if (this.synthSupported) window.speechSynthesis.cancel();
    this.speaking = false;
    this.onSpeakingChange?.(false);
  }
}
