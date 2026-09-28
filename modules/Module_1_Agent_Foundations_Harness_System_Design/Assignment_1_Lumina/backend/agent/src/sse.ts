import type { Response } from 'express';
import {
  DoneEvent,
  PlanEvent,
  SourcesEvent,
  StreamErrorEvent,
  TokenEvent,
  TraceEvent,
  type SseEventName
} from '@lumina/contract';

/**
 * One answer's event stream. The headers are sent LAZILY, on the first event, so that a
 * provider that fails before anything has streamed can still be answered with a real
 * HTTP 502 instead of a 200 that carries an error event.
 *
 * Every outbound event is validated against the contract before it is written: a trace
 * step with ok:false and no error string (the Live Translate shape) throws here rather
 * than reaching the UI.
 */
const SCHEMAS = {
  plan: PlanEvent,
  trace: TraceEvent,
  sources: SourcesEvent,
  token: TokenEvent,
  done: DoneEvent,
  error: StreamErrorEvent
} as const;

export class Sse {
  private opened = false;

  constructor(private readonly res: Response) {}

  get started(): boolean {
    return this.opened;
  }

  send(event: SseEventName, data: unknown): void {
    const parsed = SCHEMAS[event].parse(data);
    if (!this.opened) this.open();
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(parsed)}\n\n`);
    // @ts-expect-error `flush` exists when a compression middleware is present; harmless otherwise.
    if (typeof this.res.flush === 'function') this.res.flush();
  }

  end(): void {
    if (this.opened) this.res.end();
  }

  private open(): void {
    this.res.status(200);
    this.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    this.res.setHeader('Cache-Control', 'no-cache, no-transform');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.setHeader('X-Accel-Buffering', 'no');
    this.res.flushHeaders();
    this.opened = true;
  }
}
