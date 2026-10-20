/**
 * Time-weighted availability for a service over a bounded window.
 *
 * Only completed intervals between real observations count. A sample covers
 * the time until the next sample, but only when that gap is at most
 * 2× the configured check interval. Anything else — before the first sample,
 * after the newest sample, across an agent outage, while paused — is unknown
 * and is excluded from the percentage rather than counted as healthy. In
 * particular, a silent tail after the last probe is never credited as uptime.
 *
 * At least two samples are required before a percentage is reported; with a
 * single sample the result is `null` (never a fabricated 100%).
 */

export interface AvailabilitySample {
  observedAt: Date;
  ok: boolean;
}

export interface Availability {
  /** Percentage of observed (covered) time that was healthy, or null. */
  percent: number | null;
  /** Seconds covered by completed sample intervals (up + down). */
  observedSeconds: number;
  /** Seconds in the window without usable coverage (gaps/trailing silence). */
  unknownSeconds: number;
}

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export function computeAvailability(
  samples: AvailabilitySample[],
  windowStart: Date,
  now: Date,
  intervalSeconds: number,
): Availability {
  const windowSeconds = Math.max(0, (now.getTime() - windowStart.getTime()) / 1000);
  const maxGapSeconds = Math.max(0, intervalSeconds) * 2;

  if (samples.length < 2) {
    return { percent: null, observedSeconds: 0, unknownSeconds: round(windowSeconds, 3) };
  }

  let observed = 0;
  let up = 0;
  for (let i = 0; i < samples.length - 1; i += 1) {
    const current = samples[i];
    const next = samples[i + 1];
    if (!current || !next) continue;
    const gap = (next.observedAt.getTime() - current.observedAt.getTime()) / 1000;
    if (gap <= 0 || gap > maxGapSeconds) continue;
    const covered = Math.max(0, (Math.min(next.observedAt.getTime(), now.getTime()) -
      Math.max(current.observedAt.getTime(), windowStart.getTime())) / 1000);
    // Future observations provide no evidence about completed intervals.
    if (next.observedAt.getTime() > now.getTime()) continue;
    observed += covered;
    if (current.ok) up += covered;
  }

  observed = Math.min(observed, windowSeconds);
  const unknown = Math.max(0, windowSeconds - observed);
  return {
    percent: observed > 0 ? round((up / observed) * 100, 2) : null,
    observedSeconds: round(observed, 3),
    unknownSeconds: round(unknown, 3),
  };
}
