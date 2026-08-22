import { useI18n, useStore } from "../app"

export function StatusBar() {
  const store = useStore()
  const { t } = useI18n()

  const state = store.reconciling
    ? "reconciling"
    : store.connectionState === "streaming"
      ? "streaming"
      : store.connectionState === "degraded"
        ? "degraded"
        : store.connectionState === "connecting"
          ? "degraded"
          : "offline"

  const label =
    state === "reconciling"
      ? t.statusReconciling
      : state === "streaming"
        ? t.statusStreaming
        : state === "degraded"
          ? t.statusDegraded
          : t.statusOffline

  const dotClass =
    state === "streaming" || state === "reconciling"
      ? "running"
      : state === "degraded"
        ? "pending"
        : "error"

  return (
    <footer className="status-bar">
      <button
        className="status-cluster"
        title={store.activeProfile ? `${store.activeProfile.name}\n${store.baseUrl ?? ""}` : ""}
        onClick={() => (store.openSettings())}
      >
        <span className={"status-dot " + dotClass + (state === "reconciling" ? " blink" : "")} />
        <span>{label}</span>
      </button>
      <div className="status-right">
        {store.connectionError && (
          <span className="status-error" title={store.connectionError}>
            ⚠
          </span>
        )}
        {store.health && (
          <span className="mono">
            {t.serverInfo}: v{store.health.version}
          </span>
        )}
      </div>
    </footer>
  )
}
