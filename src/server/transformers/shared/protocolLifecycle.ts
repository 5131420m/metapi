type PulledEventBatch<TEvent> = {
  events: TEvent[];
  rest: string;
};

type ProxyStreamReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown>;
  releaseLock(): void;
};

type ProxyStreamLifecycleInput<TEvent> = {
  reader: ProxyStreamReader | null | undefined;
  response: { end(): void };
  pullEvents(buffer: string): PulledEventBatch<TEvent>;
  handleEvent(event: TEvent): Promise<boolean | void> | boolean | void;
  onEof?: () => Promise<void> | void;
  onReadError?: (error: unknown) => Promise<void> | void;
  onProcessingError?: (error: unknown) => Promise<void> | void;
};

export function createProxyStreamLifecycle<TEvent>(input: ProxyStreamLifecycleInput<TEvent>) {
  const flushBuffer = async (buffer: string): Promise<{ rest: string; stop: boolean }> => {
    let pulled: PulledEventBatch<TEvent>;
    try {
      pulled = input.pullEvents(buffer);
    } catch (error) {
      if (!input.onProcessingError) throw error;
      await input.onProcessingError(error);
      return { rest: '', stop: true };
    }
    try {
      for (const event of pulled.events) {
        if (await input.handleEvent(event)) {
          return {
            rest: pulled.rest,
            stop: true,
          };
        }
      }
    } catch (error) {
      if (!input.onProcessingError) throw error;
      await input.onProcessingError(error);
      return { rest: pulled.rest, stop: true };
    }

    return {
      rest: pulled.rest,
      stop: false,
    };
  };

  return {
    async run(): Promise<void> {
      const reader = input.reader;
      if (!reader) {
        try {
          await input.onEof?.();
        } finally {
          input.response.end();
        }
        return;
      }

      const decoder = new TextDecoder();
      let sseBuffer = '';
      let shouldStop = false;

      try {
        while (true) {
          let readResult: Awaited<ReturnType<typeof reader.read>>;
          try {
            readResult = await reader.read();
          } catch (error) {
            if (!input.onReadError) throw error;
            await input.onReadError(error);
            shouldStop = true;
            break;
          }
          const { done, value } = readResult;
          if (done) break;
          if (!value) continue;

          sseBuffer += decoder.decode(value, { stream: true });
          const flushed = await flushBuffer(sseBuffer);
          sseBuffer = flushed.rest;
          if (!flushed.stop) continue;

          shouldStop = true;
          await reader.cancel().catch(() => {});
          break;
        }

        if (!shouldStop) {
          sseBuffer += decoder.decode();
          if (sseBuffer.trim().length > 0) {
            const flushed = await flushBuffer(`${sseBuffer}\n\n`);
            sseBuffer = flushed.rest;
            shouldStop = flushed.stop;
          }
        }

        if (!shouldStop) {
          await input.onEof?.();
        }
      } finally {
        reader.releaseLock();
        input.response.end();
      }
    },
  };
}
