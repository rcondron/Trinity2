/*
 * Work in flight on the cards, keyed by a card's immutable id (never its number: a number can be handed to a new card
 * after a removal or a clear, an id never is).
 *
 *  - Live jobs. Every job that will write into a card later — a picture being painted, a card being written, a build
 *    streaming in — holds the card from start to finish. A card that says "pending" while nothing holds it has no job
 *    behind it any more (the engine restarted, or an undo brought an old loader back): board.settleBoard() turns it
 *    into a card that says it was interrupted instead of one that loads forever.
 *
 *  - One queue per card. The coder jobs on a card (build_ui, edit_html, a repair) run strictly one after another in
 *    the order they were asked for, so an edit never starts from another build's half-streamed page and never
 *    "restores" one when it fails. Jobs on different cards don't wait for each other here.
 */

const live = new Map<string, number>();

/** A job now holds this card. Call the returned function (once) when it is finished with it, however it ended. */
export function holdCard(id: string): () => void {
  live.set(id, (live.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (live.get(id) ?? 1) - 1;
    if (left > 0) live.set(id, left);
    else live.delete(id);
  };
}

/** Whether some job still means to write into this card. */
export function cardHeld(id: string): boolean {
  return (live.get(id) ?? 0) > 0;
}

interface Chain {
  tail: Promise<void>;
  /** Jobs asked for and not finished yet (the running one included). */
  waiting: number;
}

const chains = new Map<string, Chain>();

/**
 * Run `job` on the card's queue: after everything asked of that card before it, and before anything asked later.
 * The card counts as held from now until the job has finished, so it is never settled as "interrupted" while it
 * waits its turn. `queued` says whether it has to wait for an earlier job on the same card. A job that throws is
 * logged and does not stop the ones behind it.
 */
export function queueOnCard(id: string, job: () => Promise<void>): { queued: boolean; done: Promise<void> } {
  const chain = chains.get(id) ?? { tail: Promise.resolve(), waiting: 0 };
  const queued = chain.waiting > 0;
  chain.waiting++;
  const release = holdCard(id);
  const done = chain.tail
    .then(job)
    .catch((err: unknown) => {
      console.warn(`[cards] a job on card ${id} failed:`, err instanceof Error ? err.message : err);
    })
    .finally(() => {
      release();
      chain.waiting--;
      if (chain.waiting <= 0 && chains.get(id) === chain) chains.delete(id);
    });
  chain.tail = done;
  chains.set(id, chain);
  return { queued, done };
}

/** Coder jobs asked of this card and not finished yet. */
export function cardQueueLength(id: string): number {
  return chains.get(id)?.waiting ?? 0;
}

/** Resolves once every queued job on every card has finished (tests, and "is anything still building"). */
export async function cardJobsIdle(): Promise<void> {
  for (let i = 0; i < 50 && chains.size; i++) await Promise.all([...chains.values()].map((c) => c.tail));
}

/**
 * One at a time across the whole board, in the order asked: the coders' builds (a new page is the heavy job; two
 * at once would fight for the same model). Returns once it is this caller's turn; call the function it resolves to
 * when done.
 */
let buildTurn: Promise<void> = Promise.resolve();
let buildsWaiting = 0;

export function takeBuildTurn(): { busy: boolean; turn: Promise<() => void> } {
  const busy = buildsWaiting > 0;
  buildsWaiting++;
  let finish!: () => void;
  const finished = new Promise<void>((r) => (finish = r));
  const before = buildTurn;
  buildTurn = before.then(() => finished);
  let released = false;
  const turn = before.then(() => () => {
    if (released) return;
    released = true;
    buildsWaiting--;
    finish();
  });
  return { busy, turn };
}

/** Builds asked for and not finished (running or waiting for their turn). */
export function buildsInFlight(): number {
  return buildsWaiting;
}
