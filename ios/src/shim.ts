// Import first. tweetnacl looks for its random source on `self` (browsers) or through `require`
// (Node); QuickJS has neither, but it has Web Crypto on globalThis.
import { connect } from "websocket";
import { createQueuedWebSocket } from "./ws-queue";

(globalThis as any).self ??= globalThis;
// Replace nsh 0.4.0's 8-slot global WebSocket with a FIFO-queued adapter over WebSocketConnection
// so burst sends never throw "WebSocket outbound queue is full" and desync E2E counters.
if (typeof connect === "function") {
  (globalThis as any).WebSocket = createQueuedWebSocket(connect);
}
