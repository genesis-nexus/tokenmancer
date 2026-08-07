/**
 * AnalyticsView - Top-level view component that handles workspace selection and data loading.
 */

import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { AnalyticsDashboard } from '../components/Analytics/AnalyticsDashboard.js';
import { SettingsBanner } from '../components/SettingsBanner.js';
import { SetupGuide } from '../components/SetupGuide.js';
import { ThemeToggle } from '../components/ThemeToggle.js';
import {
  resetAnalytics,
  selectedTimeWindow,
  setAnalytics,
  setAnalyticsError,
  setAnalyticsLoading,
} from '../state/analytics-store.js';
import type { MeterTransport, SettingStatus, WorkspaceSummary } from '../transport.js';

export interface AnalyticsViewProps {
  transport: MeterTransport;
  /** Pre-selected workspace ID (for extension use). */
  defaultWorkspaceId?: string;
}

export function AnalyticsView({ transport, defaultWorkspaceId }: AnalyticsViewProps): JSX.Element {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [selectedWs, setSelectedWs] = useState<string>(defaultWorkspaceId ?? '');
  const [loading, setLoading] = useState(true);

  // Load workspaces on mount
  useEffect(() => {
    transport
      .listWorkspaces()
      .then((ws) => {
        setWorkspaces(ws);
        setLoading(false);
        // Auto-select first workspace if none selected
        const first = ws[0];
        if (first) {
          setSelectedWs((prev) => prev || first.id);
        }
      })
      .catch(() => {
        setLoading(false);
      });
  }, [transport]);

  const [settings, setSettings] = useState<SettingStatus[] | null>(null);
  useEffect(() => {
    if (!transport.checkSettings) return;
    const check = () =>
      transport
        .checkSettings?.()
        .then(setSettings)
        .catch(() => {});
    check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, [transport]);

  // Load analytics when workspace or time window changes
  const loadAnalytics = useCallback(
    async (wsId: string, days: number) => {
      if (!wsId || !transport.getWorkspaceAnalytics) return;

      setAnalyticsLoading();
      try {
        const result = await transport.getWorkspaceAnalytics(wsId, days);
        setAnalytics(result.analytics, result.insights);
      } catch (e) {
        setAnalyticsError(e instanceof Error ? e.message : 'Failed to load analytics');
      }
    },
    [transport],
  );

  useEffect(() => {
    if (selectedWs) {
      loadAnalytics(selectedWs, selectedTimeWindow.value);
    } else {
      resetAnalytics();
    }
  }, [selectedWs, loadAnalytics]);

  const handleWorkspaceChange = (e: Event) => {
    const wsId = (e.target as HTMLSelectElement).value;
    setSelectedWs(wsId);
  };

  const handleTimeWindowChange = (days: number) => {
    if (selectedWs) {
      loadAnalytics(selectedWs, days);
    }
  };

  const handleRefresh = () => {
    if (selectedWs) {
      loadAnalytics(selectedWs, selectedTimeWindow.value);
    }
  };

  const selectedWorkspace = workspaces.find((w) => w.id === selectedWs);

  return (
    <div class="analytics-view">
      {/* Header Bar */}
      <header class="analytics-view-header">
        <div class="analytics-view-title">
          <h1>Workspace Analytics</h1>
          <span class="analytics-view-subtitle">Understand your Copilot usage patterns</span>
        </div>
        <div class="workspace-selector">
          <label for="ws-select">Workspace:</label>
          {loading ? (
            <span class="loading-text">Loading...</span>
          ) : (
            <select
              id="ws-select"
              value={selectedWs}
              onChange={handleWorkspaceChange}
              disabled={workspaces.length === 0}
            >
              {workspaces.length === 0 && <option value="">No workspaces found</option>}
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>
                  {ws.folderName} ({ws.channel} · {ws.sessionCount} sessions)
                </option>
              ))}
            </select>
          )}
        </div>
        <ThemeToggle />
      </header>

      {settings || !transport.checkSettings ? (
        <div class="analytics-view-notice">
          {settings ? (
            <SettingsBanner
              settings={settings}
              onOpenSetting={(key) => transport.openSetting?.(key)}
            />
          ) : (
            <SetupGuide />
          )}
        </div>
      ) : null}

      {/* Main Content */}
      <main class="analytics-view-main">
        {!transport.getWorkspaceAnalytics ? (
          <div class="analytics-unsupported">
            <div class="unsupported-icon">⚠</div>
            <div class="unsupported-text">Analytics are not supported in this transport mode.</div>
          </div>
        ) : (
          <AnalyticsDashboard
            workspaceName={selectedWorkspace?.folderName ?? 'Unknown'}
            onTimeWindowChange={handleTimeWindowChange}
            onRefresh={handleRefresh}
          />
        )}
      </main>
    </div>
  );
}
