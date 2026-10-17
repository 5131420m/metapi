import { parseProxyUsage } from '../../services/proxyUsageParser.js';
import { POSTCOMMIT_STREAM_FAILURE_CODE } from '../../services/upstreamFailureSignals.js';

type GeminiStreamReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock(): void;
};

type GeminiStreamResult = {
  status: 'completed' | 'failed';
  committed: boolean;
  errorMessage: string | null;
  usage: ReturnType<typeof parseProxyUsage>;
  rawStreamText: string;
};

export async function pipeGeminiSseStream(input: {
  reader: GeminiStreamReader;
  commit: () => void;
  write: (line: string) => void;
  consume: (buffer: string) => { rest: string; lines: string[] };
  aggregateState: unknown;
  captureRaw: boolean;
  /**
   * Public wording for a failure after output began (the per-key redaction policy). The raw
   * message is still returned in `errorMessage` for logging and channel bookkeeping.
   */
  publicFailureMessage?: (message: string) => string;
}): Promise<GeminiStreamResult> {
  const decoder = new TextDecoder();
  let rest = '';
  let rawStreamText = '';
  let committed = false;
  let terminalSeen = false;

  const emit = (lines: string[]) => {
    for (const line of lines) {
      if (line.includes('[DONE]')) terminalSeen = true;
      if (!committed) {
        input.commit();
        committed = true;
      }
      input.write(line);
    }
  };

  try {
    while (true) {
      const { done, value } = await input.reader.read();
      if (done) break;
      if (!value) continue;
      const chunkText = decoder.decode(value, { stream: true });
      if (input.captureRaw) rawStreamText += chunkText;
      const consumed = input.consume(rest + chunkText);
      rest = consumed.rest;
      emit(consumed.lines);
    }
    const tail = decoder.decode();
    if (tail) {
      if (input.captureRaw) rawStreamText += tail;
      const consumed = input.consume(rest + tail);
      rest = consumed.rest;
      emit(consumed.lines);
    }
    return {
      status: 'completed',
      committed,
      errorMessage: null,
      usage: parseProxyUsage(input.aggregateState),
      rawStreamText,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Gemini upstream stream failed';
    if (committed && !terminalSeen) {
      // Same in-band contract as the chat/responses transformers: the redacted wording plus the
      // stable machine code, so a client can route on the failure class without parsing prose.
      const publicMessage = input.publicFailureMessage?.(errorMessage) ?? errorMessage;
      input.write(`event: error\ndata: ${JSON.stringify({ error: { message: publicMessage, type: 'upstream_error', code: POSTCOMMIT_STREAM_FAILURE_CODE } })}\n\n`);
      input.write('data: [DONE]\n\n');
    }
    return {
      status: 'failed',
      committed,
      errorMessage,
      usage: parseProxyUsage(input.aggregateState),
      rawStreamText,
    };
  } finally {
    input.reader.releaseLock();
  }
}
