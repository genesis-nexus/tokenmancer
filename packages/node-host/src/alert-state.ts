// Alert memory. The evaluator is stateless and will re-draft the same crossing
// on every step; this is the layer that decides a crossing is *new*.
//
// Five mechanisms, each covering a failure the others do not:
//   1. Crossing, not level — identity is (ruleId, periodKey, threshold).
//   2. Monotonic — once 80% has fired in a period, 50% never can.
//   3. Period keys reset naturally — a new day is a new key, so no cleanup job.
//   4. Cooldown — suppresses everything but `critical`.
//   5. Rate cap — a hard ceiling per hour; the excess is counted, not shown.

import * as path from 'node:path';
import type { AlertDraft, AlertsConfig } from '@cte/core';
import { atomicWriteJson, readJsonSafe, stateDir } from './paths.js';

export const ALERT_STATE_SCHEMA = 1;

interface FiredRecord {
  /** Highest threshold fired for this (ruleId, periodKey). Drives monotonicity. */
  maxThreshold: number;
  ts: number;
}

export interface AlertState {
  schema: number;
  /** Keyed `${ruleId}:${periodKey}`. */
  fired: Record<string, FiredRecord>;
  /** Timestamps of every recently delivered alert, for the hourly rate cap. */
  recent: number[];
}

export function alertStatePath(): string {
  return path.join(stateDir(), 'alerts.json');
}

export function emptyAlertState(): AlertState {
  return { schema: ALERT_STATE_SCHEMA, fired: {}, recent: [] };
}

export function loadAlertState(): AlertState {
  const s = readJsonSafe<AlertState>(alertStatePath(), emptyAlertState());
  if (!s || s.schema !== ALERT_STATE_SCHEMA || typeof s.fired !== 'object') {
    return emptyAlertState();
  }
  return {
    schema: s.schema,
    fired: s.fired ?? {},
    recent: Array.isArray(s.recent) ? s.recent : [],
  };
}

export function saveAlertState(state: AlertState): void {
  atomicWriteJson(alertStatePath(), state);
}

const HOUR_MS = 3_600_000;

export interface FilterResult {
  /** Drafts that should be delivered, in evaluation order. */
  deliver: AlertDraft[];
  /** How many were withheld by the rate cap — surfaced as a "N more" line. */
  suppressed: number;
}

/**
 * Decide which drafts are genuinely new, mutating `state` to record what was
 * delivered. The caller persists the state; keeping the write out of here makes
 * the whole thing unit-testable without touching disk.
 */
export function filterSuppressed(
  drafts: readonly AlertDraft[],
  state: AlertState,
  cfg: AlertsConfig,
  now: number,
): FilterResult {
  if (!cfg.enabled) return { deliver: [], suppressed: 0 };

  // Trim the sliding window before measuring against it.
  state.recent = state.recent.filter((t) => now - t < HOUR_MS);

  const cooldownMs = Math.max(0, cfg.cooldownMinutes) * 60_000;

  const deliver: AlertDraft[] = [];
  let suppressed = 0;

  for (const d of drafts) {
    const key = `${d.ruleId}:${d.periodKey}`;
    const prior = state.fired[key];

    // (1) + (2): never re-fire a threshold at or below the high-water mark.
    if (prior && d.threshold <= prior.maxThreshold) continue;

    // (4) Cooldown, scoped to this **period instance** — the same key as `fired`.
    // Monotonicity already blocks a repeat of the same threshold, so all this
    // has left to do is stop 50% and 80% arriving back to back. Scoping it any
    // wider would let a monthly-pool warning mute the Cost Radar's per-loop
    // alerts, and each loop is a genuinely new event. A suppressed crossing is
    // only deferred: it is not recorded, so it re-drafts once the window passes.
    // Cross-rule spam is the rate cap's job.
    if (d.severity !== 'critical' && prior && now - prior.ts < cooldownMs) continue;

    // (5) Rate cap. `recent` now grows as we deliver, so it counts this batch too.
    if (cfg.maxPerHour > 0 && state.recent.length >= cfg.maxPerHour) {
      suppressed++;
      continue;
    }

    state.fired[key] = { maxThreshold: d.threshold, ts: now };
    state.recent.push(now);
    deliver.push(d);
  }

  return { deliver, suppressed };
}

/**
 * Drop `fired` entries for period keys that can no longer recur, so the file
 * does not grow without bound. Loop and session keys are opaque ids that never
 * come back, and they are by far the most numerous.
 */
export function pruneAlertState(state: AlertState, keepCurrentKeys: readonly string[]): void {
  const keep = new Set(keepCurrentKeys);
  const cutoff = Date.now() - 90 * 24 * HOUR_MS;
  for (const [key, rec] of Object.entries(state.fired)) {
    const periodKey = key.slice(key.indexOf(':') + 1);
    if (keep.has(periodKey)) continue;
    // Date-shaped keys are cheap to keep and useful for history; opaque ids are not.
    const dated = /^\d{4}-(\d{2}|W\d{2})(-\d{2})?$/.test(periodKey);
    if (!dated || rec.ts < cutoff) delete state.fired[key];
  }
}
