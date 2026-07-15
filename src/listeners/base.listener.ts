// Common interface for all listeners (PumpPortal WebSocket, …) — swappable.

export interface BaseListener {
  start(): Promise<void>
  stop(): Promise<void>
  readonly isRunning: boolean
}
