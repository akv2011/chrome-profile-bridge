/**
 * Splits the NUL-delimited CDP byte stream of --remote-debugging-pipe into frames in linear time.
 *
 * The naive way (concat every chunk onto a growing buffer, then scan it from the start) is quadratic:
 * one 40 MB heap snapshot arriving in 64 KB chunks copied and rescanned gigabytes, backing up the pipe
 * until Chrome itself stalled. Here each byte is scanned once and copied once.
 */
export class NulFramer {
  private parts: Buffer[] = [];

  /** Feed one chunk; `onFrame` gets each complete frame (without its NUL), in order. */
  push(chunk: Buffer, onFrame: (frame: Buffer) => void): void {
    let start = 0;
    for (let z = chunk.indexOf(0); z >= 0; z = chunk.indexOf(0, start)) {
      const tail = chunk.subarray(start, z);
      const frame = this.parts.length ? Buffer.concat([...this.parts, tail]) : tail;
      this.parts = [];
      onFrame(frame);
      start = z + 1;
    }
    if (start < chunk.length) this.parts.push(chunk.subarray(start));
  }

  /** Drop a partial frame (the peer went away mid-message). */
  reset(): void {
    this.parts = [];
  }
}
