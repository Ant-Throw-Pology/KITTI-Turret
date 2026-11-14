type Signal = { type: string; sdp?: string; candidate?: string; mid?: string };

export class VideoPeer {
  private pc: any;
  private dc: any;
  private ready: Promise<void>;
  private closed = false;
  constructor(private readonly sendSignal: (message: Signal) => void, private readonly stun = '') {
    this.ready = this.initialize();
  }
  private async initialize(): Promise<void> {
    const rtc = await import('node-datachannel');
    if (this.closed) return;
    this.pc = new rtc.PeerConnection('kitti-video', { iceServers: this.stun ? [this.stun] : [] });
    this.pc.onLocalDescription((sdp: string, type: string) => this.sendSignal({ type: type.toLowerCase(), sdp }));
    this.pc.onLocalCandidate((candidate: string, mid: string) => this.sendSignal({ type: 'ice', candidate, mid }));
    this.pc.onDataChannel((channel: any) => {
      if (channel.getLabel() !== 'video') { channel.close(); return; }
      this.dc?.close();
      this.dc = channel;
    });
  }
  async signal(message: Signal): Promise<void> {
    await this.ready;
    if (this.closed || !this.pc) return;
    if (message.type === 'offer' && message.sdp) this.pc.setRemoteDescription(message.sdp, 'Offer');
    else if (message.type === 'ice' && message.candidate && message.mid !== undefined) this.pc.addRemoteCandidate(message.candidate, message.mid);
    else throw new Error(`Invalid WebRTC signal: ${message.type}`);
  }
  sendFrame(jpeg: Uint8Array): boolean {
    if (this.closed || !this.dc?.isOpen() || this.dc.bufferedAmount() > 4 * 1024 * 1024 || jpeg.length > this.dc.maxMessageSize()) return false;
    return this.dc.sendMessageBinary(Buffer.from(jpeg));
  }
  close(): void {
    this.closed = true;
    this.dc?.close(); this.pc?.close();
    this.dc = undefined; this.pc = undefined;
  }
}
