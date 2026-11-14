import { expect, test, mock } from 'bun:test';
import { VideoPeer } from '../src/webrtc';

class FakeChannel {
  closed = false;
  sent: Buffer[] = [];
  constructor(private readonly open = true, private readonly buffered = 0, private readonly max = 1024 * 1024) {}
  getLabel() { return 'video'; }
  isOpen() { return this.open; }
  bufferedAmount() { return this.buffered; }
  maxMessageSize() { return this.max; }
  sendMessageBinary(data: Buffer) { this.sent.push(data); return true; }
  close() { this.closed = true; }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  localDescription?: (sdp: string, type: string) => void;
  localCandidate?: (candidate: string, mid: string) => void;
  dataChannel?: (channel: FakeChannel) => void;
  remoteDescriptions: [string, string][] = [];
  candidates: [string, string][] = [];
  closed = false;
  constructor(readonly name: string, readonly config: { iceServers: string[] }) { FakePeerConnection.instances.push(this); }
  onLocalDescription(cb: (sdp: string, type: string) => void) { this.localDescription = cb; }
  onLocalCandidate(cb: (candidate: string, mid: string) => void) { this.localCandidate = cb; }
  onDataChannel(cb: (channel: FakeChannel) => void) { this.dataChannel = cb; }
  setRemoteDescription(sdp: string, type: string) { this.remoteDescriptions.push([sdp, type]); this.localDescription?.('answer-sdp', 'Answer'); }
  addRemoteCandidate(candidate: string, mid: string) { this.candidates.push([candidate, mid]); }
  close() { this.closed = true; }
}

test('VideoPeer.signal with missing peer creation (no PeerConnection) does not block signaling', async () => {
  // A peer that never received a channel should still tolerate signals gracefully
  FakePeerConnection.instances = [];
  const peer = new VideoPeer(() => {}, '', async () => ({ PeerConnection: FakePeerConnection }));
  await peer.signal({ type: 'offer', sdp: 'offer-sdp' });
  // Without a data channel, sendFrame returns false but does not throw
  const bytes = new Uint8Array(15);
  expect(peer.sendFrame(bytes)).toBe(false);
  peer.close();
});

test('VideoPeer handles offer/answer and ICE signaling', async () => {
  FakePeerConnection.instances = [];
  const signals: unknown[] = [];
  const peer = new VideoPeer(message => signals.push(message), 'stun:example', async () => ({ PeerConnection: FakePeerConnection }));
  await peer.signal({ type: 'offer', sdp: 'offer-sdp' });
  await peer.signal({ type: 'ice', candidate: 'candidate', mid: '0' });
  const pc = FakePeerConnection.instances[0]!;
  expect(pc.config.iceServers).toEqual(['stun:example']);
  expect(pc.remoteDescriptions).toEqual([['offer-sdp', 'Offer']]);
  expect(pc.candidates).toEqual([['candidate', '0']]);
  expect(signals).toContainEqual({ type: 'answer', sdp: 'answer-sdp' });
  pc.localCandidate?.('local-candidate', '0');
  expect(signals).toContainEqual({ type: 'ice', candidate: 'local-candidate', mid: '0' });
  peer.close();
});

test('VideoPeer sends prefixed JPEG payloads over the video data channel with queue limits', async () => {
  FakePeerConnection.instances = [];
  const peer = new VideoPeer(() => {}, '', async () => ({ PeerConnection: FakePeerConnection }));
  await peer.signal({ type: 'offer', sdp: 'offer-sdp' });
  const channel = new FakeChannel();
  FakePeerConnection.instances[0]!.dataChannel?.(channel);
  const bytes = new Uint8Array(15), view = new DataView(bytes.buffer);
  view.setUint32(0, 7, true); view.setBigUint64(4, 99n, true); bytes.set([1, 2, 3], 12);
  expect(peer.sendFrame(bytes)).toBe(true);
  expect(channel.sent[0]!.length).toBe(15);
  const blocked = new FakeChannel(true, 4 * 1024 * 1024 + 1);
  FakePeerConnection.instances[0]!.dataChannel?.(blocked);
  expect(peer.sendFrame(bytes)).toBe(false);
  peer.close();
});

test('VideoPeer.sendFrame tolerates a channel that throws on sendMessageBinary (close race)', async () => {
  FakePeerConnection.instances = [];
  const peer = new VideoPeer(() => {}, '', async () => ({ PeerConnection: FakePeerConnection }));
  await peer.signal({ type: 'offer', sdp: 'offer-sdp' });
  const channel = new FakeChannel(true, 0, 1024 * 1024);
  // Override sendMessageBinary to throw as if the channel closed between isOpen and the call
  const origSend = channel.sendMessageBinary.bind(channel);
  channel.sendMessageBinary = mock(() => { throw new Error('channel closed'); });
  FakePeerConnection.instances[0]!.dataChannel?.(channel);
  const bytes = new Uint8Array(15);
  // Should not throw — catch returns false
  const result = peer.sendFrame(bytes);
  expect(result).toBe(false);
  peer.close();
});

test('VideoPeer catches loadRtc rejection and reports it on signal', async () => {
  const failingLoadRtc = () => new Promise<any>((_, reject) => reject(new Error('node-datachannel missing')));
  const peer = new VideoPeer(() => {}, '', failingLoadRtc);
  // signal should throw the stored initError (caught by initialize's try/catch)
  await expect(peer.signal({ type: 'offer', sdp: 'test' })).rejects.toThrow('node-datachannel missing');
  // close should not throw even though init failed
  peer.close();
});

test('VideoPeer tolerates close before init completes (closed flag races loading)', async () => {
  const slowLoad = () => new Promise<any>(() => {}); // never resolves
  const peer = new VideoPeer(() => {}, '', slowLoad);
  // close immediately — should not throw and should prevent init from setting up pc/dc
  peer.close();
  // signal after close should succeed without throwing
  await peer.signal({ type: 'offer', sdp: 'test' });
});
