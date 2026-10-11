import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { subscribeFrames, FRAME_TICK_HZ } from './frameTicker';
import { appTime } from './appClock';

/**
 * The shared frame ticker behind every decorative canvas surface. The node
 * environment has neither requestAnimationFrame nor IntersectionObserver, so
 * both are faked here: `step(ts)` runs one frame, `report(el, visible)` is the
 * observer's callback.
 */
let queue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let nextId = 1;
let requested = 0;
let cancelled = 0;
function step(ts: number): void {
  const run = queue;
  queue = [];
  for (const { cb } of run) cb(ts);
}
/** Run frames every `dt` ms from `from` for `ms` ms. */
function run(from: number, dt: number, ms: number): void {
  for (let ts = from; ts < from + ms - 1e-6; ts += dt) step(ts);
}

class FakeIO {
  static last: FakeIO | null = null;
  static instances = 0;
  observed = new Set<Element>();
  disconnected = false;
  constructor(public cb: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {
    FakeIO.last = this;
    FakeIO.instances++;
  }
  observe(el: Element) { this.observed.add(el); }
  unobserve(el: Element) { this.observed.delete(el); }
  disconnect() { this.disconnected = true; this.observed.clear(); }
}
function report(el: Element, isIntersecting: boolean): void {
  FakeIO.last!.cb([{ target: el, isIntersecting }]);
}
const el = (name: string) => ({ name }) as unknown as Element;

let stops: Array<() => void> = [];
const sub = (...args: Parameters<typeof subscribeFrames>) => {
  const stop = subscribeFrames(...args);
  stops.push(stop);
  return stop;
};

beforeEach(() => {
  queue = [];
  requested = 0;
  cancelled = 0;
  FakeIO.last = null;
  FakeIO.instances = 0;
  stops = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    requested++;
    const id = nextId++;
    queue.push({ id, cb });
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    cancelled++;
    queue = queue.filter((q) => q.id !== id);
  });
  vi.stubGlobal('IntersectionObserver', FakeIO);
});

afterEach(() => {
  // Stop whatever a failed test left subscribed (module state survives into
  // the next file under isolate: false), then restore the globals.
  try {
    for (const stop of stops) stop();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe('frameTicker — one loop, only while subscribed', () => {
  it('requests no frame until something subscribes, and cancels when the last one stops', () => {
    expect(requested).toBe(0);
    const a = sub(null, () => {});
    const b = sub(null, () => {});
    expect(queue.length).toBe(1); // ONE loop for both
    a();
    expect(queue.length).toBe(1);
    b();
    expect(queue.length).toBe(0);
    expect(cancelled).toBe(1);
  });

  it('ticks on the first frame after the loop starts', () => {
    const calls: number[] = [];
    sub(null, (t) => calls.push(t));
    step(1000);
    expect(calls).toEqual([appTime(1000)]);
  });
});

describe('frameTicker — every subscriber on the SAME frames at 15 Hz', () => {
  it('a 60 Hz panel: 15 ticks a second, identical t for every subscriber, t from the app clock', () => {
    const a: number[] = [];
    const b: number[] = [];
    sub(null, (t) => a.push(t));
    sub(null, (t) => b.push(t));
    run(5000, 1000 / 60, 1000);
    expect(FRAME_TICK_HZ).toBe(15);
    expect(a.length).toBe(15);
    expect(b).toEqual(a);
    // Every 4th frame of the 60 Hz run.
    expect(a[1] - a[0]).toBeCloseTo(4 / 60, 6);
    expect(a[0]).toBe(appTime(5000));
  });

  it('a subscriber that joins a running loop lands on the shared frames, not its own', () => {
    const a: number[] = [];
    const b: number[] = [];
    sub(null, (t) => a.push(t));
    run(0, 1000 / 60, 100); // a ticks at 0 and 66.7
    sub(null, (t) => b.push(t));
    run(100, 1000 / 60, 500);
    expect(b.length).toBeGreaterThan(5);
    for (const t of b) expect(a).toContain(t);
  });

  it('a 144 Hz panel still ticks about 15 times a second', () => {
    const a: number[] = [];
    sub(null, (t) => a.push(t));
    run(0, 1000 / 144, 2000);
    expect(a.length).toBeGreaterThanOrEqual(28);
    expect(a.length).toBeLessThanOrEqual(30);
  });

  it('a saturated CPU (45 ms frames) ticks every other frame — never two frames in a row', () => {
    const a: number[] = [];
    sub(null, (t) => a.push(t));
    run(0, 45, 900); // 20 frames
    expect(a.length).toBe(10);
    for (let i = 1; i < a.length; i++) expect(a[i] - a[i - 1]).toBeCloseTo(0.09, 6);
  });
});

describe('frameTicker — off-screen and hidden subscribers are skipped', () => {
  it('skips the tick (calling onHidden instead) while the observer reports the element off-screen', () => {
    const card = el('card');
    const ticks: number[] = [];
    const hidden: number[] = [];
    sub(card, (t) => ticks.push(t), { onHidden: (t) => hidden.push(t) });
    expect(FakeIO.last!.observed.has(card)).toBe(true);
    // Visible until the observer's first report.
    step(0);
    expect(ticks.length).toBe(1);
    report(card, false);
    step(100);
    step(200);
    expect(ticks.length).toBe(1);
    expect(hidden).toEqual([appTime(100), appTime(200)]);
    report(card, true);
    step(300);
    expect(ticks).toEqual([appTime(0), appTime(300)]);
  });

  it('one element hidden does not stop another', () => {
    const a = el('a');
    const b = el('b');
    const ta: number[] = [];
    const tb: number[] = [];
    sub(a, (t) => ta.push(t));
    sub(b, (t) => tb.push(t));
    report(a, false);
    step(0);
    expect(ta).toEqual([]);
    expect(tb).toEqual([appTime(0)]);
  });

  it('a null element always ticks, and so does every element where IntersectionObserver is missing', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const ticks: string[] = [];
    sub(null, () => ticks.push('null'));
    sub(el('x'), () => ticks.push('x'));
    step(0);
    expect(ticks).toEqual(['null', 'x']);
  });

  it('observes a shared element once and lets it go with its last subscriber; the observer goes with the last element', () => {
    const shared = el('shared');
    const s1 = sub(shared, () => {});
    const s2 = sub(shared, () => {});
    const io = FakeIO.last!;
    expect(io.observed.size).toBe(1);
    report(shared, false);
    s1();
    expect(io.observed.has(shared)).toBe(true);
    s2();
    expect(io.observed.has(shared)).toBe(false);
    expect(io.disconnected).toBe(true);
    // A fresh subscription starts visible on a fresh observer — no stale
    // off-screen mark survives the element's release.
    const ticks: number[] = [];
    sub(shared, (t) => ticks.push(t));
    expect(FakeIO.instances).toBe(2);
    step(0);
    expect(ticks.length).toBe(1);
  });
});

describe('frameTicker — stopping and failures', () => {
  it('onStop runs once, with the element, and a second stop is a no-op', () => {
    const meter = el('meter');
    const onStop = vi.fn();
    const stop = sub(meter, () => {}, { onStop });
    stop();
    stop();
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith(meter);
  });

  it('a throwing subscriber neither stops the loop nor starves the others', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const ticks: number[] = [];
      sub(null, () => { throw new Error('broken surface'); });
      sub(null, (t) => ticks.push(t));
      step(0);
      step(100);
      expect(ticks.length).toBe(2);
      expect(errorSpy).toHaveBeenCalledTimes(2);
      expect(queue.length).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a subscriber may stop itself (or another) from inside a tick', () => {
    const order: string[] = [];
    let stopB = () => {};
    const stopA = sub(null, () => { order.push('a'); stopA(); stopB(); });
    stopB = sub(null, () => order.push('b'));
    sub(null, () => order.push('c'));
    step(0);
    step(100);
    expect(order).toEqual(['a', 'c', 'c']);
  });
});
