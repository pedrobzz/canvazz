import { useSyncExternalStore } from 'react'
import { Cable } from 'lucide-react'
import { editorStore } from '../store/editorStore'
import { useDocVersion } from '../store/hooks'
import { getSaveState, subscribeSaveState } from '../store/persistence'
import { bridgeStatusStore } from '../ai/bridgeClient'
import { TextField } from './fields'

export function TopBar() {
  useDocVersion()
  const saveState = useSyncExternalStore(subscribeSaveState, getSaveState, () => 'idle' as const)
  const bridge = useSyncExternalStore(
    bridgeStatusStore.subscribe,
    bridgeStatusStore.get,
    () => 'disconnected' as const,
  )

  return (
    <div
      data-cz-ui
      className="cz-panel flex h-10 shrink-0 items-center gap-3 border-b border-[var(--cz-panel-border)] px-3"
    >
      <span className="text-[13px] font-bold tracking-tight text-white">canvazz</span>
      <div className="h-4 w-px bg-[var(--cz-panel-border)]" />
      <div className="w-48">
        <TextField
          value={editorStore.doc.name}
          onCommit={(name) => {
            editorStore.doc = { ...editorStore.doc, name }
            editorStore.setUi({})
          }}
        />
      </div>
      <span className="text-[10px] text-[var(--cz-panel-muted)]" data-testid="save-state">
        {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved locally' : saveState === 'error' ? 'Save failed' : ''}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <span
          className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${
            bridge === 'connected'
              ? 'bg-[var(--cz-ai)]/20 text-[var(--cz-ai)]'
              : 'bg-[var(--cz-panel-hover)] text-[var(--cz-panel-muted)]'
          }`}
          title={
            bridge === 'connected'
              ? 'An MCP client is bridged to this editor'
              : 'Connect an MCP client: claude mcp add --transport http canvazz http://localhost:3000/mcp'
          }
        >
          <Cable className="size-3" />
          MCP {bridge === 'connected' ? 'live' : 'ready'}
        </span>
      </div>
    </div>
  )
}
