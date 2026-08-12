import type { IncomingMessage } from 'node:http';

const RESPONSES_WEBSOCKET_BRIDGE_CONTEXT = Symbol('responsesWebsocketBridgeContext');

export interface ResponsesWebsocketBridgeContext {
  preserveIncrementalMode: boolean;
}

export function markResponsesWebsocketBridgeRequest(
  requestType: typeof IncomingMessage,
  context: ResponsesWebsocketBridgeContext,
): typeof IncomingMessage {
  Object.defineProperty(requestType.prototype, RESPONSES_WEBSOCKET_BRIDGE_CONTEXT, {
    configurable: true,
    value: Object.freeze({ ...context }),
  });
  return requestType;
}

export function getResponsesWebsocketBridgeContext(
  request: IncomingMessage,
): ResponsesWebsocketBridgeContext | null {
  const value = (request as IncomingMessage & {
    [RESPONSES_WEBSOCKET_BRIDGE_CONTEXT]?: unknown;
  })[RESPONSES_WEBSOCKET_BRIDGE_CONTEXT];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    preserveIncrementalMode: (value as ResponsesWebsocketBridgeContext).preserveIncrementalMode === true,
  };
}
