// Lightweight, sampling-based profiler for background/service-worker code.
// Zero (or near-zero) cost when disabled; small constant cost when enabled.
//
// Usage:
//   const stop = Profiler.tic('persist');
//   ...work...
//   stop();
//
// or
//   const wrapped = Profiler.wrap('onBeforeRequest', handler);
//   chrome.webRequest.onBeforeRequest.addListener(wrapped, filter, ['blocking']);
//
export interface ProfilerOptions {
  enabled?: boolean;
  sampleEvery?: number; // profile 1 in N calls
  reportEveryMs?: number; // min interval between printed reports per label
}

interface Bucket {
  n: number; // total counted calls (including non-profiled)
  k: number; // profiled calls (1 in N)
  totalMs: number; // sum of profiled durations
  maxMs: number; // worst-profiling sample
  lastReport: number; // last report timestamp (ms)
}

const NOOP: () => void = () => {
  return;
};

class _Profiler {
  private enabled = true;
  private sampleEvery = 200;
  private reportEveryMs = 5_000;
  private buckets = new Map<string, Bucket>();

  configure(opts: ProfilerOptions = {}) {
    if (typeof opts.enabled === 'boolean') {
      this.enabled = opts.enabled;
    }
    if (typeof opts.sampleEvery === 'number' && opts.sampleEvery > 0) {
      this.sampleEvery = Math.floor(opts.sampleEvery);
    }
    if (typeof opts.reportEveryMs === 'number' && opts.reportEveryMs > 0) {
      this.reportEveryMs = Math.floor(opts.reportEveryMs);
    }
  }

  tic(label: string): () => void {
    if (!this.enabled) {
      return NOOP;
    }
    const b = this.get(label);
    b.n++;
    // Only time every Nth call
    if (b.n % this.sampleEvery !== 0) {
      return NOOP;
    }
    const t0 = performance.now();
    return () => {
      const dt = performance.now() - t0;
      b.k++;
      b.totalMs += dt;
      if (dt > b.maxMs) {
        b.maxMs = dt;
      }
      this.maybeReport(label, b);
    };
  }

  wrap<T extends (...args: any[]) => any>(label: string, fn: T): T {
    // Bind the instance method instead of aliasing `this`
    const tic = this.tic.bind(this);

    return function (this: any, ...args: Parameters<T>): ReturnType<T> {
      const stop = tic(label);
      try {
        // Preserve the caller's dynamic `this`
        return fn.apply(this, args);
      } finally {
        stop();
      }
    } as T;
  }

  private get(label: string): Bucket {
    let b = this.buckets.get(label);
    if (!b) {
      b = { n: 0, k: 0, totalMs: 0, maxMs: 0, lastReport: 0 };
      this.buckets.set(label, b);
    }
    return b;
  }

  private maybeReport(label: string, b: Bucket) {
    const now = performance.now();
    if (now - b.lastReport < this.reportEveryMs) {
      return;
    }
    b.lastReport = now;
    const avg = b.k ? b.totalMs / b.k : 0;
    // Effective avg per call (including non-profiled) ~ avg / sampleEvery
    const estPerCall = avg / this.sampleEvery;
    // Print a single, greppable line
    // PROf tag keeps it skimmable in noisy logs
    console.log(
      `PROf ${label} n=${b.n} k=${b.k} sampleEvery=${this.sampleEvery} avgMs(sampled)=${avg.toFixed(
        3,
      )} maxMs=${b.maxMs.toFixed(3)} estPerCallMs≈${estPerCall.toFixed(4)}`,
    );
    // keep max but decay totals so spikes remain visible over time
    b.totalMs *= 0.25;
    b.k = Math.max(1, Math.floor(b.k * 0.25));
  }
}

export const Profiler = new _Profiler();
Profiler.configure({ enabled: true, sampleEvery: 1, reportEveryMs: 2000 });
