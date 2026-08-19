/**
 * AnalyticsView - Top-level view component that handles workspace selection and data loading.
 */

import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { AnalyticsDashboard } from '../components/Analytics/AnalyticsDashboard.js';
import { AppNav, type NavLink } from '../components/AppNav.js';
import { ProviderFilter } from '../components/ProviderFilter.js';
import { SettingsBanner } from '../components/SettingsBanner.js';
import { SetupGuide } from '../components/SetupGuide.js';
import {
  resetAnalytics,
  selectedTimeWindow,
  setAnalytics,
  setAnalyticsError,
  setAnalyticsLoading,
} from '../state/analytics-store.js';
import { setConfig } from '../state/budget-store.js';
import {
  PROVIDER_LABEL,
  filterWorkspaces,
  matchesProvider,
  providerFilter,
  workspaceLabel,
} from '../state/provider-store.js';
import { applyConfigDefault } from '../state/skill-store.js';
import type { MeterTransport, SettingStatus, WorkspaceSummary } from '../transport.js';

export interface AnalyticsViewProps {
  transport: MeterTransport;
  /** Pre-selected workspace ID (for extension use). */
  defaultWorkspaceId?: string;
  /** Header destinations; `[]` inside the VS Code webview. */
  navLinks?: readonly NavLink[];
}

export function AnalyticsView({
  transport,
  defaultWorkspaceId,
  navLinks,
}: AnalyticsViewProps): JSX.Element {
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
        // Auto-select the newest workspace the current filter actually shows.
        const first = filterWorkspaces(ws, providerFilter.peek())[0];
        if (first) {
          setSelectedWs((prev) => prev || first.id);
        }
      })
      .catch(() => {
        setLoading(false);
      });
  }, [transport]);

  // Analytics has no live stream, so config is fetched once rather than polled.
  // It is what the settings dialog and the detail default both read.
  useEffect(() => {
    if (!transport.getConfig) return;
    let alive = true;
    transport
      .getConfig()
      .then((c) => {
        if (!alive) return;
        setConfig(c);
        applyConfigDefault(c.ui?.defaultDetail);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
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

  const filter = providerFilter.value;
  const shown = filterWorkspaces(workspaces, filter);

  // Narrowing the filter must move the dashboard, not leave it showing numbers
  // for a workspace the picker no longer lists. Fall through to the newest
  // remaining one so the surface is never blank when there is data to show.
  useEffect(() => {
    if (!workspaces.length) return;
    const current = workspaces.find((w) => w.id === selectedWs);
    if (current && matchesProvider(current, filter)) return;
    setSelectedWs(shown[0]?.id ?? '');
  }, [filter, workspaces, selectedWs, shown[0]?.id]);

  const selectedWorkspace = workspaces.find((w) => w.id === selectedWs);

  return (
    <>
      <AppNav links={navLinks} current="/analytics" transport={transport} />

      <div class="analytics-view">
        {/* View-scoped head: the title, and the two pickers that decide which
            numbers the dashboard below is showing. */}
        <div class="analytics-view-head">
          <div class="pageHead">
            <div class="pageTitle">
              <h1>Workspace Analytics</h1>
              <p class="sub">
                Understand your{' '}
                {selectedWorkspace ? PROVIDER_LABEL[selectedWorkspace.provider] : 'agent'} usage
                patterns
              </p>
            </div>
            <div class="pageActions workspace-selector">
              <ProviderFilter workspaces={workspaces} />
              <label for="ws-select">Workspace:</label>
              {loading ? (
                <span class="loading-text">Loading...</span>
              ) : (
                <select
                  id="ws-select"
                  value={selectedWs}
                  onChange={handleWorkspaceChange}
                  disabled={shown.length === 0}
                >
                  {shown.length === 0 && (
                    <option value="">
                      {workspaces.length ? 'No workspaces for this agent' : 'No workspaces found'}
                    </option>
                  )}
                  {shown.map((ws) => (
                    <option key={ws.id} value={ws.id}>
                      {workspaceLabel(ws)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        </div>

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
              <div class="unsupported-text">
                Analytics are not supported in this transport mode.
              </div>
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
    </>
  );
}
