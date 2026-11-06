export type LiveMetricName =
  | "signing"
  | "signatureVerification"
  | "packetChainValidation"
  | "indexedDbCommit"
  | "queueWait"
  | "packetDelivery"
  | "connectionQueueWait"
  | "missingInputWait"
  | "simulationAdvancement"
  | "schedulerLateness"
  | "frameGap";

export type MetricSummary = {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
};

export type FramePause = {
  frame: number;
  gapMs: number;
  visibility: string;
  windowMaxMs: Partial<Record<LiveMetricName, number>>;
};

export type LivePerformanceReport = {
  slot: 1 | 2;
  visibility: string;
  metrics: Partial<Record<LiveMetricName, MetricSummary>>;
  queueWaitByOperation: Record<string, MetricSummary>;
  pauses: FramePause[];
};

const metricNames: LiveMetricName[] = [
  "signing", "signatureVerification", "packetChainValidation", "indexedDbCommit", "queueWait",
  "packetDelivery", "connectionQueueWait", "missingInputWait",
  "simulationAdvancement", "schedulerLateness", "frameGap",
];

const rounded = (value: number) => Math.round(value * 1000) / 1000;

export class LivePerformanceMetrics {
  private samples = new Map<LiveMetricName, number[]>();
  private queueSamples = new Map<string, number[]>();
  private windowMax: Partial<Record<LiveMetricName, number>> = {};
  private pauses: FramePause[] = [];
  private waitingFrame = 0;
  private waitingSince = 0;
  private lastAdvanceAt = 0;
  private visibility = "unknown";
  private slot: 1 | 2;
  private now: () => number;

  constructor(slot: 1 | 2, now = () => performance.now()) { this.slot = slot; this.now = now; }

  record(name: LiveMetricName, durationMs: number) {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const values = this.samples.get(name) ?? [];
    if (values.length < 4096) values.push(durationMs);
    this.samples.set(name, values);
    this.windowMax[name] = Math.max(this.windowMax[name] ?? 0, durationMs);
  }

  recordQueue(operation: string, durationMs: number) {
    this.record("queueWait", durationMs);
    const values = this.queueSamples.get(operation) ?? [];
    if (values.length < 4096) values.push(durationMs);
    this.queueSamples.set(operation, values);
  }

  async measure<T>(name: LiveMetricName, task: () => Promise<T>): Promise<T> {
    const startedAt = this.now();
    try { return await task(); }
    finally { this.record(name, this.now() - startedAt); }
  }

  setVisibility(visibility: string) { this.visibility = visibility; }

  waitForFrame(frame: number) {
    if (this.waitingFrame === frame) return;
    this.waitingFrame = frame;
    this.waitingSince = this.now();
    if (!this.lastAdvanceAt) this.lastAdvanceAt = this.waitingSince;
  }

  advanced(frame: number, simulationMs: number, roundOver: boolean) {
    const now = this.now();
    this.record("simulationAdvancement", simulationMs);
    if (this.waitingFrame === frame) this.record("missingInputWait", now - this.waitingSince);
    if (this.lastAdvanceAt) {
      const gapMs = now - this.lastAdvanceAt;
      this.record("frameGap", gapMs);
      if (gapMs >= 75 && this.pauses.length < 256) {
        this.pauses.push({ frame, gapMs: rounded(gapMs), visibility: this.visibility, windowMaxMs: { ...this.windowMax } });
      }
    }
    this.lastAdvanceAt = now;
    this.windowMax = {};
    this.waitingFrame = 0;
    if (!roundOver) this.waitForFrame(frame + 1);
  }

  report(): LivePerformanceReport {
    const metrics: Partial<Record<LiveMetricName, MetricSummary>> = {};
    const summarize = (values: number[]): MetricSummary => {
      const sorted = [...values].sort((a, b) => a - b);
      const at = (percentile: number) => sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)];
      return { count: sorted.length, p50: rounded(at(0.5)), p95: rounded(at(0.95)), p99: rounded(at(0.99)), max: rounded(sorted[sorted.length - 1]) };
    };
    for (const name of metricNames) {
      const values = this.samples.get(name);
      if (!values?.length) continue;
      metrics[name] = summarize(values);
    }
    const queueWaitByOperation = Object.fromEntries([...this.queueSamples].map(([name, values]) => [name, summarize(values)]));
    return structuredClone({ slot: this.slot, visibility: this.visibility, metrics, queueWaitByOperation, pauses: this.pauses });
  }
}
