// Serialized lifecycle for the single system-audio capture the helper owns.
//
// Capture is a shared, refcounted resource: every connected `/ws/audio` socket
// wants it running, the last one out wants it stopped, and a REST caller must
// not stop it out from under those listeners. The naive "start when size===1,
// stop when size===0" has three races this controller removes:
//
//   (a) A failed FIRST start left a second, already-connected socket waiting on
//       silence forever — nothing retried. Here every acquire reconciles, so a
//       later waiter re-drives the start rather than being stranded, and a start
//       that keeps failing rejects its waiter (which then closes with an error)
//       instead of hanging.
//   (b) A last-close stop and a near-simultaneous new-socket start could
//       interleave (stop landing after the new start). All transitions run on a
//       single promise chain, so start/stop can never overlap, and because each
//       step reconciles against the CURRENT refcount a close-then-reopen simply
//       collapses to "stay running" with no stop/start churn.
//   (c) A REST stop could kill capture while listeners remained. `listeners`
//       exposes the live refcount so the route refuses that stop.
//
// The counters are mutated in place — a refcount is inherently stateful — but
// all mutation happens on one owner behind the serialized chain, so there are
// no interleaved reads of a half-updated state.

/** The two capture verbs this controller drives. Injected so the lifecycle is
 *  testable without the native helper. */
export interface CaptureBackend {
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
}

export class AudioCaptureController {
  private refs = 0;
  private capturing = false;
  /** All start/stop transitions run here, one at a time, in enqueue order. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly backend: CaptureBackend) {}

  /** Live count of sockets holding capture — the REST stop guard reads this. */
  get listeners(): number {
    return this.refs;
  }

  /** Controller's own view of whether the backend is currently capturing. */
  get capturingNow(): boolean {
    return this.capturing;
  }

  /**
   * One socket declares it wants capture running. Resolves once capture is
   * running; REJECTS if the (re)start it drove failed, so the caller can report
   * the failure and close rather than sit on silence. Always balance with one
   * `release()`.
   */
  acquire(): Promise<void> {
    this.refs += 1;
    return this.enqueue();
  }

  /** One socket releases its hold; stops capture when it was the last. */
  release(): Promise<void> {
    if (this.refs > 0) this.refs -= 1;
    return this.enqueue();
  }

  /**
   * A REST caller asks to stop capture. Refused while any listener holds it —
   * stopping there would strand live sockets with no restart. With no listeners
   * it reconciles toward stopped (a no-op when already idle).
   */
  requestExternalStop(): Promise<{ readonly stopped: boolean; readonly listeners: number }> {
    if (this.refs > 0) {
      return Promise.resolve({ stopped: false, listeners: this.refs });
    }
    return this.enqueue().then(() => ({ stopped: true, listeners: this.refs }));
  }

  private enqueue(): Promise<void> {
    const next = this.chain.then(() => this.reconcile());
    // The chain must survive a failed reconcile so later transitions still run;
    // the rejection is still delivered to THIS caller via `next`.
    this.chain = next.catch(() => { /* swallowed for the chain only */ });
    return next;
  }

  /** Bring the backend in line with demand. Runs alone on the chain, so it sees
   *  a coherent refcount and never overlaps another start/stop. */
  private async reconcile(): Promise<void> {
    if (this.refs > 0 && !this.capturing) {
      await this.backend.start();
      this.capturing = true;
    } else if (this.refs === 0 && this.capturing) {
      await this.backend.stop();
      this.capturing = false;
    }
  }
}
