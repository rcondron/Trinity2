/**
 * Pace without pitch: a streaming time stretcher for mono speech (WSOLA — waveform-similarity overlap-add).
 *
 * Playing samples faster or slower by resampling moves the pitch with the pace. This leaves the waveform
 * alone and changes how much of it is played. The output is made of 15 ms frames copied straight from the
 * input; every so often the place they are copied from jumps — back, to say a stretch again (slower), or
 * ahead, to leave one out (faster) — and the frame at a jump crossfades from the old place into the new.
 * A jump lands where the waveform looks most like what would have come next (normalized cross-correlation
 * over a frame, searched 10 ms either side of where the pace says playback should be), so a voiced sound
 * repeats or drops whole pitch periods and its pitch stays where it was.
 *
 * What makes it speech-shaped rather than textbook:
 *   - Between jumps the output IS the input, sample for sample. At rate 1 nothing else ever happens: an
 *     exact passthrough with no delay.
 *   - A jump waits for a good place. The start of a word or a plosive has nothing like it nearby, and
 *     jumping there says it twice (slower) or swallows it (faster); so while nothing matches, playback
 *     carries straight on and drifts from the ideal position — up to 15 ms beyond the search range — and
 *     jumps once a vowel, a hiss or a pause comes along. Only when the drift runs out does it jump anyway.
 *   - Good places: alike in waveform (voiced speech); or two stretches of one steady sound, level even
 *     across both (hiss, breath — their waveforms never match); or both too quiet to hear (pauses).
 *   - Where the two sides of a crossfade are unalike their sum dips, so the gain holds the level on the
 *     straight line between theirs: noise keeps its level through a join.
 *   - Look-ahead: one frame (15 ms) at a slower pace, up to 50 ms at a faster one.
 *
 * pull() runs on the audio thread: it allocates nothing, and push() only when its buffer has to grow.
 *
 * SELF-CONTAINED ON PURPOSE. The speaker worklet (call.ts) embeds this class's source text —
 * `const TimeStretcher = ${TimeStretcher.toString()};` — so everything it uses must be inside the class:
 * no imports, no module-level helpers or constants, no closures, and no syntax a build could turn into a
 * call to a helper outside it (parameter properties, #private, initialised fields, enums). The fields are
 * `declare`d, which compiles to nothing. scripts/test-time-stretch.mts checks all of the above.
 */
export class TimeStretcher {
  /**
   * Its own name, so builds that keep names leave the source alone: esbuild's keepNames (tsx runs with it)
   * adds `static { __name(this, "TimeStretcher") }` to a class that has none — a call to a helper that
   * does not exist inside the worklet. It also keeps the name through a minifier's renaming.
   */
  static get name(): string {
    return "TimeStretcher";
  }

  /** Playback pace, 0.5–2; exactly 1 is the passthrough. */
  private declare rate: number;
  /** Samples per frame: the output made at a time, the crossfade, and the length compared in a search (15 ms). */
  private declare hop: number;
  /** How far either side of the ideal position a place to jump to is looked for (10 ms)… */
  private declare seek: number;
  /** …but only this far past it at a faster pace, where every sample further is look-ahead (5 ms). */
  private declare ahead: number;
  /** How much further playback may drift while a jump waits for a good place (15 ms). */
  private declare hold: number;
  /** The most look-ahead a frame may ask for (50 ms): it shortens `hold` at the fastest paces. */
  private declare reach: number;
  /** The shortest jump (2 ms): nearer than that is the same waveform a few samples off, not a period. */
  private declare skip: number;
  /** Similarity (−1…1) from which two frames are alike enough to join. */
  private declare match: number;
  /** Frame energy under which there is nothing to hear (about −70 dBFS)… */
  private declare quiet: number;
  /** …or this fraction of the loudest frame lately, if that is more (35 dB under it). */
  private declare rel: number;
  /** Ranking: how much a place away from the ideal position loses (at the edge of the search)… */
  private declare lean: number;
  /** …and a place at a different level (at the extreme). Both in units of similarity. */
  private declare level: number;
  /** Two unlike frames are one steady sound when their level, taken in thirds, stays within this ratio (6 dB). */
  private declare steady: number;
  /** Raised-cosine fade-in over one frame. */
  private declare fade: Float32Array;

  /** Input held: buf[0 .. len). What is before `rp` has been played but may be jumped back to. */
  private declare buf: Float32Array;
  private declare len: number;
  /** The next input sample of the stretch being played. */
  private declare rp: number;
  /** Where the pace says playback should be by now: whole samples, and the fraction carried over. */
  private declare ip: number;
  private declare frac: number;
  /** Energy of the loudest frame lately (it fades by half in about a second). */
  private declare loud: number;

  /** The frame last made: out[given .. made) is still to be handed out. */
  private declare out: Float32Array;
  private declare made: number;
  private declare given: number;

  constructor(sampleRate: number) {
    const sr = sampleRate > 0 ? sampleRate : 24000;
    const hop = Math.max(12, Math.round(sr * 0.015));
    this.rate = 1;
    this.hop = hop;
    this.seek = Math.max(4, Math.round(sr * 0.01));
    this.ahead = Math.max(2, Math.round(sr * 0.005));
    this.hold = Math.round(sr * 0.015);
    this.reach = Math.round(sr * 0.05);
    this.skip = Math.max(1, Math.round(sr * 0.002));
    this.match = 0.5;
    this.quiet = hop * 1e-7;
    this.rel = 0.000316;
    this.lean = 0.2;
    this.level = 0.5;
    this.steady = 4;
    this.fade = new Float32Array(hop);
    for (let i = 0; i < hop; i++) this.fade[i] = 0.5 - 0.5 * Math.cos((Math.PI * i) / hop);
    this.out = new Float32Array(hop);
    this.buf = new Float32Array(Math.max(4096, Math.round(sr * 1.5)));
    this.len = 0;
    this.rp = 0;
    this.ip = 0;
    this.frac = 0;
    this.loud = 0;
    this.made = 0;
    this.given = 0;
  }

  /** Set the pace (1 = as it came), kept within 0.5–2. Takes effect at the next frame, without a click. */
  setRate(rate: number): void {
    let r = Number(rate);
    if (r !== r) return; // not a number: keep the pace there is
    r = r < 0.5 ? 0.5 : r > 2 ? 2 : r;
    if (Math.abs(r - 1) < 0.001) r = 1;
    this.rate = r;
  }

  /** Add input: the whole chunk, or chunk[start .. end). It is copied; any length will do. */
  push(chunk: Float32Array, start?: number, end?: number): void {
    const from = start !== undefined && start > 0 ? start : 0;
    const to = end !== undefined && end < chunk.length ? end : chunk.length;
    const n = to - from;
    if (n <= 0) return;
    if (this.len + n > this.buf.length) {
      // Make room: let go of what no jump can reach back to any more, and grow only if that is not enough.
      const dead = Math.min(this.rp, this.ip - this.seek);
      if (dead > 0) {
        this.buf.copyWithin(0, dead, this.len);
        this.len -= dead;
        this.rp -= dead;
        this.ip -= dead;
      }
      if (this.len + n > this.buf.length) {
        const bigger = new Float32Array(Math.max(this.buf.length * 2, this.len + n));
        bigger.set(this.buf.subarray(0, this.len));
        this.buf = bigger;
      }
    }
    if (n === chunk.length) this.buf.set(chunk, this.len);
    else {
      const x = this.buf;
      const at = this.len;
      for (let i = 0; i < n; i++) x[at + i] = chunk[from + i]!;
    }
    this.len += n;
  }

  /** Fill `out` with as much output as can be made now; returns how many samples were written. */
  pull(out: Float32Array): number {
    const want = out.length;
    let n = 0;
    while (n < want) {
      if (this.given < this.made) n += this.hand(out, n);
      else if (this.rate === 1) {
        const k = this.copy(out, n);
        if (k === 0) break;
        n += k;
      } else if (!this.frame()) break;
    }
    return n;
  }

  /**
   * The end of a stream: hand out what is held just as it is, into `out` from `offset`. pull() keeps the
   * last few milliseconds back for look-ahead; when no more input is coming (the queue ran dry, the phrase
   * is over) this plays them, so nothing is cut off or left to turn up in front of the next phrase.
   * Returns the count. More input may follow: playback carries on from where this stopped.
   */
  drain(out: Float32Array, offset?: number): number {
    const start = offset !== undefined && offset > 0 ? offset : 0;
    let n = start;
    if (this.given < this.made && n < out.length) n += this.hand(out, n);
    if (n < out.length) n += this.copy(out, n);
    return n - start;
  }

  /** Output samples pull() is sure to deliver now. (It may deliver more: where later frames come from depends on the audio.) */
  available(): number {
    let n = this.made - this.given;
    if (this.rate === 1) return n + this.len - this.rp;
    if (this.len < this.needs()) return n;
    n += this.hop;
    // Frames after the next one: count those that have their input whichever way the search goes.
    const step = this.rate * this.hop;
    const drift = this.rate < 1 ? this.seek + this.hold + Math.ceil((1 - this.rate) * this.hop) : Math.max(this.seek, this.rp - this.ip);
    const spare = this.len - (this.ip + drift + this.hop + 2);
    if (spare >= step) n += Math.floor(spare / step) * this.hop;
    return n;
  }

  /** Input samples held that have not been played yet. */
  pending(): number {
    return this.len - this.rp;
  }

  /** Drop everything held and start afresh (the pace stays). */
  flush(): void {
    this.len = 0;
    this.rp = 0;
    this.ip = 0;
    this.frac = 0;
    this.loud = 0;
    this.made = 0;
    this.given = 0;
  }

  /** Hand out what is left of the frame last made, into `out` from `at`. */
  private hand(out: Float32Array, at: number): number {
    const o = this.out;
    const from = this.given;
    const k = Math.min(out.length - at, this.made - from);
    for (let i = 0; i < k; i++) out[at + i] = o[from + i]!;
    this.given = from + k;
    return k;
  }

  /** Copy input straight into `out` from `at`: the passthrough. The pace starts again from where it stops. */
  private copy(out: Float32Array, at: number): number {
    const x = this.buf;
    const from = this.rp;
    const k = Math.min(out.length - at, this.len - from);
    if (k <= 0) return 0;
    for (let i = 0; i < k; i++) out[at + i] = x[from + i]!;
    this.rp = from + k;
    this.ip = this.rp;
    this.frac = 0;
    return k;
  }

  /** True when playback is out of reach of the ideal position and getting further from it. */
  private far(): boolean {
    const d = this.rp - this.ip;
    return (d > this.seek && this.rate < 1) || (d < -this.seek && this.rate > 1);
  }

  /** How much input must be held before the next frame can be made. */
  private needs(): number {
    return (this.far() ? Math.max(this.rp, this.ip + this.ahead) : this.rp) + this.hop;
  }

  /** Make one frame of output; false when the input for it has not all arrived. */
  private frame(): boolean {
    if (this.len < this.needs()) return false;
    const x = this.buf;
    const o = this.out;
    const hop = this.hop;
    const rp = this.rp;
    let ea = 0;
    for (let i = 0; i < hop; i++) {
      const a = x[rp + i]!;
      ea += a * a;
    }
    this.loud = Math.max(this.loud * 0.99, ea);
    const at = this.far() ? this.place(ea) : rp;
    if (at === rp) {
      // Straight on: the input as it is.
      for (let i = 0; i < hop; i++) o[i] = x[rp + i]!;
    } else {
      // A jump: crossfade from what was playing into the new place. For like waveforms the two weights
      // add up to 1 and that is all; for unlike ones the sum dips in the middle, so the gain holds the
      // level on the straight line between the two (at most +3 dB: unrelated sounds of one level).
      let eb = 0;
      let dot = 0;
      for (let i = 0; i < hop; i++) {
        const b = x[at + i]!;
        eb += b * b;
        dot += x[rp + i]! * b;
      }
      const fade = this.fade;
      const la = Math.sqrt(ea);
      const lb = Math.sqrt(eb);
      const both = dot > 0 ? 2 * dot : 0;
      for (let i = 0; i < hop; i++) {
        const w = fade[i]!;
        const u = 1 - w;
        const mixed = u * x[rp + i]! + w * x[at + i]!;
        const power = u * u * ea + w * w * eb + u * w * both;
        o[i] = power > 1e-12 ? (mixed * (u * la + w * lb)) / Math.sqrt(power) : mixed;
      }
    }
    this.rp = at + hop;
    this.frac += this.rate * hop;
    const whole = Math.floor(this.frac);
    this.ip += whole;
    this.frac -= whole;
    this.made = hop;
    this.given = 0;
    return true;
  }

  /**
   * Playback has drifted out of reach: where should the next frame come from? Returns a place near the
   * ideal position to jump to, or `rp` to carry straight on for now. `ea` is the energy of the frame at `rp`.
   */
  private place(ea: number): number {
    const x = this.buf;
    const hop = this.hop;
    const seek = this.seek;
    const rate = this.rate;
    const rp = this.rp;
    const ip = this.ip;
    // The places to try: around the ideal position, but not the nearest few samples either side of here.
    let lo = ip - seek;
    let hi = ip + (rate < 1 ? seek : this.ahead);
    if (lo < 0) lo = 0;
    if (rate < 1) {
      if (hi > rp - this.skip) hi = rp - this.skip;
    } else if (lo < rp + this.skip) lo = rp + this.skip;
    if (lo > hi) return rp;
    const quiet = Math.max(this.quiet, this.loud * this.rel);
    const lean = this.lean;
    const level = this.level;
    let ec = 0;
    for (let i = 0; i < hop; i++) {
      const b = x[lo + i]!;
      ec += b * b;
    }
    let best = -9;
    let like = -2;
    let at = lo;
    for (let c = lo; c <= hi; c++) {
      let sum = 0;
      for (let i = 0; i < hop; i++) sum += x[rp + i]! * x[c + i]!;
      // Similarity: the cross-correlation of the frame here and the frame there, over the mean of their
      // energies — 1 only for the same waveform at the same level, so a loud place is no match for a soft
      // one. `quiet` on both sides makes two frames with nothing to hear in them count as alike.
      const s = (2 * sum + quiet) / (ea + ec + quiet);
      // Among places much alike, the one nearer the ideal position, and nearer in level, is the better.
      const off = (c - ip) / seek;
      const uneven = (ea - ec) / (ea + ec + quiet);
      const score = s - lean * off * off - level * uneven * uneven;
      if (score > best) {
        best = score;
        like = s;
        at = c;
      }
      if (c < hi) {
        const gone = x[c]!;
        const come = x[c + hop]!;
        ec += come * come - gone * gone;
        if (ec < 0) ec = 0;
      }
    }
    if (like >= this.match) return at; // alike in waveform: voiced speech, a pitch period or a few away
    if (this.even(rp, at)) return at; // unalike, but one steady sound: hiss, breath
    // Nothing good here — a word starting, a plosive, a change of sound. Carry on and try again, while
    // there is drift left for it (less at a faster pace, where drift costs look-ahead).
    const drift = rp > ip ? rp - ip : ip - rp;
    const hold = rate < 1 ? this.hold : Math.max(0, Math.min(this.hold, this.reach - seek - this.ahead - rate * hop));
    return drift <= seek + hold ? rp : at;
  }

  /** True when the frames at `a` and `b` are one steady sound: their level, taken in thirds, is even. */
  private even(a: number, b: number): boolean {
    const x = this.buf;
    const third = Math.floor(this.hop / 3);
    let min = Infinity;
    let max = 0;
    for (let k = 0; k < 3; k++) {
      const from = k * third;
      let pa = 0;
      let pb = 0;
      for (let i = from; i < from + third; i++) {
        const p = x[a + i]!;
        const q = x[b + i]!;
        pa += p * p;
        pb += q * q;
      }
      if (pa < min) min = pa;
      if (pb < min) min = pb;
      if (pa > max) max = pa;
      if (pb > max) max = pb;
    }
    return max <= min * this.steady;
  }
}
