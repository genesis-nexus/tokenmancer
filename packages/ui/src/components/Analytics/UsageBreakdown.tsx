/**
 * UsageBreakdown - Visualizations for tool/model usage distributions.
 */

import type { ModelUsageStats, StepKindStats, ToolUsageStats } from '@cte/core';
import type { JSX } from 'preact';
import { fmtCr } from '../../format.js';
import { STEP_META } from '../../pricing-ui.js';

export interface ModelBreakdownProps {
  stats: ModelUsageStats[];
}

export function ModelBreakdown({ stats }: ModelBreakdownProps): JSX.Element {
  if (!stats.length) {
    return (
      <div class="usage-breakdown">
        <div class="breakdown-title">Model usage</div>
        <div class="breakdown-empty">No model data</div>
      </div>
    );
  }

  const totalCalls = stats.reduce((a, s) => a + s.callCount, 0);

  return (
    <div class="usage-breakdown">
      <div class="breakdown-title">Model usage</div>
      <div class="breakdown-caption">Share of LLM calls, by model</div>
      <div class="breakdown-bars">
        {stats.map((s) => (
          <div key={s.model} class="breakdown-item">
            <div class="breakdown-item-header">
              <span class="breakdown-item-name" title={s.model}>
                {shortModel(s.model)}
              </span>
              <span class="breakdown-item-value">
                {s.callCount} calls · {fmtCr(s.totalAic)} cr
              </span>
            </div>
            <div class="breakdown-bar-track">
              <div
                class="breakdown-bar series-1"
                style={{ width: `${s.percentOfCalls}%` }}
                title={`${s.percentOfCalls.toFixed(1)}% of calls`}
              />
            </div>
          </div>
        ))}
      </div>
      <div class="breakdown-footer">{totalCalls} total calls</div>
    </div>
  );
}

export interface ToolBreakdownProps {
  stats: ToolUsageStats[];
  totalSessions: number;
}

export function ToolBreakdown({ stats, totalSessions }: ToolBreakdownProps): JSX.Element {
  if (!stats.length) {
    return (
      <div class="usage-breakdown">
        <div class="breakdown-title">Top tools</div>
        <div class="breakdown-empty">No tool calls recorded</div>
      </div>
    );
  }

  // Show top 10 tools
  const topTools = stats.slice(0, 10);

  return (
    <div class="usage-breakdown">
      <div class="breakdown-title">Top tools</div>
      <div class="breakdown-caption">Share of sessions that used each tool</div>
      <div class="breakdown-bars">
        {topTools.map((s) => (
          <div key={s.toolName} class="breakdown-item">
            <div class="breakdown-item-header">
              <span class="breakdown-item-name" title={s.toolName}>
                {shortToolName(s.toolName)}
              </span>
              <span class="breakdown-item-value">
                {s.sessionCount}/{totalSessions} sessions
              </span>
            </div>
            <div class="breakdown-bar-track">
              <div
                class="breakdown-bar series-1"
                style={{ width: `${s.percentOfSessions}%` }}
                title={`Used in ${s.percentOfSessions.toFixed(1)}% of sessions`}
              />
            </div>
          </div>
        ))}
      </div>
      {stats.length > 10 && <div class="breakdown-footer">+{stats.length - 10} more tools</div>}
    </div>
  );
}

export interface StepKindBreakdownProps {
  stats: StepKindStats[];
}

export function StepKindBreakdown({ stats }: StepKindBreakdownProps): JSX.Element {
  if (!stats.length) {
    return (
      <div class="usage-breakdown">
        <div class="breakdown-title">Workflow pattern</div>
        <div class="breakdown-empty">No step data</div>
      </div>
    );
  }

  return (
    <div class="usage-breakdown">
      <div class="breakdown-title">Workflow pattern</div>
      <div class="breakdown-caption">Share of steps, by kind of work</div>
      <div class="breakdown-bars">
        {stats.map((s) => {
          const meta = STEP_META[s.kind] ?? { label: s.kind, icon: '·' };
          return (
            <div key={s.kind} class="breakdown-item">
              <div class="breakdown-item-header">
                <span class="breakdown-item-name">
                  <span class="step-icon">{meta.icon}</span> {meta.label}
                </span>
                <span class="breakdown-item-value">
                  {s.count} · {s.percent.toFixed(0)}%
                </span>
              </div>
              <div class="breakdown-bar-track">
                <div
                  class={`breakdown-bar step-bar step-${s.kind}`}
                  style={{ width: `${s.percent}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function shortModel(m: string): string {
  return String(m || '')
    .replace(/^(claude-|gpt-|gemini-)/, '')
    .slice(0, 20);
}

function shortToolName(t: string): string {
  return String(t || '')
    .replace(/^(vscode_|github_|mcp_)/, '')
    .slice(0, 24);
}
