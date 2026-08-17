import { alerts, dismissAlert } from '../state/budget-store.js';

/**
 * Budget alerts, newest last. The producer has already applied dedupe, cooldown
 * and the hourly cap, so anything that reaches here is worth showing — the only
 * job left is to let the user dismiss it for good.
 */
export function AlertBanner({ onAction }: { onAction?: (kind: string, arg?: string) => void }) {
  const list = alerts.value;
  if (!list.length) return null;

  return (
    <output class="alert-stack" aria-live="polite">
      {list.map((a) => (
        <div key={a.id} class={`alert alert-${a.severity}`}>
          <div class="alert-body">
            <strong>{a.title}</strong>
            <span>{a.body}</span>
          </div>
          {a.action && onAction ? (
            <button
              type="button"
              class="btn alert-act"
              onClick={() => onAction(a.action?.kind ?? '', a.action?.arg)}
            >
              Budget settings
            </button>
          ) : null}
          <button
            type="button"
            class="alert-x"
            aria-label="Dismiss alert"
            onClick={() => dismissAlert(a.id)}
          >
            ×
          </button>
        </div>
      ))}
    </output>
  );
}
