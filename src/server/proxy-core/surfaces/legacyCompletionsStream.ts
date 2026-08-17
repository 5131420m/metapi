import { mergeProxyUsage, parseProxyUsage, pullSseDataEvents } from '../../services/proxyUsageParser.js';

type LegacyCompletionsStreamReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock(): void;
};

type LegacyCompletionsUsage = ReturnType<typeof parseProxyUsage>;

export type LegacyCompletionsStreamResult = {
  status: 'completed' | 'failed';
  committed: boolean;
  errorMessage: string | null;
  usage: LegacyCompletionsUsage;
};

function emptyUsage(): LegacyCompletionsUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    promptTokensIncludeCache: null,
  };
}

export async function pipeLegacyCompletionsStream(input: {
  reader: LegacyCompletionsStreamReader;
  commit: () => void;
  write: (chunk: string) => void;
}): Promise<LegacyCompletionsStreamResult> {
  const decoder = new TextDecoder();
  let usage = emptyUsage();
  let sseBuffer = '';
  let committed = false;
  let terminalSeen = false;

  const consume = (chunk: string) => {
    if (!chunk) return;
    if (!committed) {
      input.commit();
      committed = true;
    }
    input.write(chunk);
    sseBuffer += chunk;
    const pulled = pullSseDataEvents(sseBuffer);
    sseBuffer = pulled.rest;
    for (const eventPayload of pulled.events) {
      if (eventPayload.trim() === '[DONE]') {
        terminalSeen = true;
        continue;
      }
      try {
        usage = mergeProxyUsage(usage, parseProxyUsage(JSON.parse(eventPayload)));
      } catch {
        // Preserve unknown legacy completion events without treating them as usage.
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await input.reader.read();
      if (done) break;
      if (!value) continue;
      consume(decoder.decode(value, { stream: true }));
    }
    consume(decoder.decode());
    if (!committed) {
      return {
        status: 'failed',
        committed: false,
        errorMessage: 'upstream completion stream ended before output',
        usage,
      };
    }
    if (sseBuffer.trim()) {
      const pulled = pullSseDataEvents(`${sseBuffer}\n\n`);
      for (const eventPayload of pulled.events) {
        if (eventPayload.trim() === '[DONE]') {
          terminalSeen = true;
          continue;
        }
        try {
          usage = mergeProxyUsage(usage, parseProxyUsage(JSON.parse(eventPayload)));
        } catch {
          // Preserve unknown legacy completion events without treating them as usage.
        }
      }
    }
    if (!terminalSeen) input.write('data: [DONE]\n\n');
    return { status: 'completed', committed: true, errorMessage: null, usage };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (committed && !terminalSeen) {
      input.write(`data: ${JSON.stringify({ error: { message: errorMessage, type: 'upstream_error' } })}\n\n`);
      input.write('data: [DONE]\n\n');
    }
    return { status: 'failed', committed, errorMessage, usage };
  } finally {
    input.reader.releaseLock();
  }
}
