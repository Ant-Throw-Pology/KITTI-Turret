export const enum PacketType { Frame = 1, Detection = 2, Control = 3, Ack = 4 }
export type Packet = { type: PacketType; payload: Uint8Array };
export function encodePacket(type: PacketType, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, payload.length, true);
  out.set(payload, 5);
  return out;
}
export class PacketDecoder {
  private buffer = new Uint8Array();
  push(chunk: Uint8Array): Packet[] {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer); joined.set(chunk, this.buffer.length);
    this.buffer = joined;
    const packets: Packet[] = [];
    while (this.buffer.length >= 5) {
      const size = new DataView(this.buffer.buffer, this.buffer.byteOffset).getUint32(1, true);
      if (size > 16 * 1024 * 1024) throw new Error('IPC packet too large');
      if (this.buffer.length < size + 5) break;
      packets.push({ type: this.buffer[0] as PacketType, payload: this.buffer.slice(5, size + 5) });
      this.buffer = this.buffer.slice(size + 5);
    }
    return packets;
  }
}
export class FrameWindow {
  private pending = new Map<number, number>();
  private queue: { seq: number; data: Uint8Array }[] = [];
  dropped = 0;
  offer(seq: number, data: Uint8Array): void {
    this.queue.push({ seq, data });
    if (this.queue.length > 2) { this.queue.shift(); this.dropped++; }
  }
  flush(send: (data: Uint8Array) => void, now = Date.now()): void {
    while (this.pending.size < 2 && this.queue.length) {
      const item = this.queue.shift()!;
      send(item.data); this.pending.set(item.seq, now);
    }
  }
  ack(seq: number): void { this.pending.delete(seq); }
  stalled(now = Date.now()): boolean { return [...this.pending.values()].some(t => now - t > 30000); }
  get inFlight(): number { return this.pending.size; }
}
