/**
 * A server-sent-events decoder that does not care where the byte stream is cut:
 * chunks arrive however the transport batched them (the Rust bridge batches at
 * 16 KiB / 50 ms, fetch at whatever the socket gave), so a UTF-8 sequence, a
 * line ending or a whole event may straddle two chunks.
 *
 * Only `data:` fields matter here (OpenAI-compatible streams carry nothing
 * else); several `data:` lines of one event are joined with '\n', comments
 * (`:`) and other fields are skipped, and an event ends at a blank line.
 */
export class SseDecoder {
  private readonly text = new TextDecoder('utf-8');
  private buffer = '';
  private data: string[] = [];

  /** Feed one chunk; returns the `data` of every event it completed. */
  push(chunk: Uint8Array): string[] {
    this.buffer += this.text.decode(chunk, { stream: true });
    return this.drain();
  }

  /** The stream ended: flush a final event that had no trailing blank line. */
  end(): string[] {
    this.buffer += this.text.decode();
    const out = this.drain();
    if (this.buffer.length > 0) { this.line(this.buffer, out); this.buffer = ''; }
    if (this.data.length > 0) { out.push(this.data.join('\n')); this.data = []; }
    return out;
  }

  private drain(): string[] {
    const out: string[] = [];
    let nl: number;
    while ((nl = this.buffer.search(/\r\n|\r|\n/)) >= 0) {
      // A lone '\r' at the very end may be the first half of '\r\n'.
      if (this.buffer[nl] === '\r' && nl === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + (this.buffer.startsWith('\r\n', nl) ? 2 : 1));
      this.line(line, out);
    }
    return out;
  }

  private line(line: string, out: string[]): void {
    if (line === '') {
      if (this.data.length > 0) { out.push(this.data.join('\n')); this.data = []; }
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== 'data') return;
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    this.data.push(value);
  }
}
