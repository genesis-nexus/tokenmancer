/**
 * Analytics loader - Computes workspace-level analytics from all sessions.
 */

import * as path from 'node:path';
import {
  type AnalyticsInsight,
  type SessionMetrics,
  type WorkspaceAnalytics,
  computeSessionMetrics,
  computeWorkspaceAnalytics,
  generateInsights,
} from '@cte/core';
import { type SessionInfo, type WorkspaceInfo, discoverSessionsIn } from './discover.js';
import { loadLogFile } from './load.js';

export interface LoadAnalyticsOptions {
  /** Time window in days to include (default: 30). */
  timeWindowDays?: number;
  /** Default model for pricing when not specified in log. */
  defaultModel?: string;
  /** Error callback. */
  onError?: (e: unknown) => void;
  /** Progress callback (sessionIndex, totalSessions). */
  onProgress?: (current: number, total: number) => void;
}

/**
 * Load all sessions from a workspace and compute aggregated analytics.
 */
export function loadWorkspaceAnalytics(
  workspace: WorkspaceInfo,
  options: LoadAnalyticsOptions = {},
): WorkspaceAnalytics {
  const { timeWindowDays = 30, defaultModel, onError, onProgress } = options;

  // Discover all sessions in the workspace
  const sessionInfos = discoverSessionsIn(workspace.debugLogsDir);

  if (sessionInfos.length === 0) {
    return computeWorkspaceAnalytics(workspace.id, workspace.folderName, [], timeWindowDays);
  }

  // Load and compute metrics for each session
  const sessionMetrics: SessionMetrics[] = [];

  for (let i = 0; i < sessionInfos.length; i++) {
    const info = sessionInfos[i];
    if (!info) continue;
    onProgress?.(i + 1, sessionInfos.length);

    try {
      const metrics = loadSessionMetrics(info, { defaultModel, onError });
      if (metrics.stepCount > 0) {
        sessionMetrics.push(metrics);
      }
    } catch (e) {
      onError?.(e);
    }
  }

  return computeWorkspaceAnalytics(
    workspace.id,
    workspace.folderName,
    sessionMetrics,
    timeWindowDays,
  );
}

/**
 * Load metrics for a single session.
 */
export function loadSessionMetrics(
  session: SessionInfo,
  options: Pick<LoadAnalyticsOptions, 'defaultModel' | 'onError'> = {},
): SessionMetrics {
  const { defaultModel, onError } = options;

  // Load all log files for this session
  const allEvents = [];
  for (const logFile of session.logFiles) {
    const absPath = path.join(session.logDir, logFile);
    const events = loadLogFile(absPath, {
      sessionId: session.id,
      defaultModel,
      onError,
    });
    allEvents.push(...events);
  }

  return computeSessionMetrics(session.id, allEvents);
}

/**
 * Get analytics with generated insights.
 */
export function getWorkspaceAnalyticsWithInsights(
  workspace: WorkspaceInfo,
  options: LoadAnalyticsOptions = {},
): { analytics: WorkspaceAnalytics; insights: AnalyticsInsight[] } {
  const analytics = loadWorkspaceAnalytics(workspace, options);
  const insights = generateInsights(analytics);
  return { analytics, insights };
}

export type { AnalyticsInsight };
