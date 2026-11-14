import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { classIdsForTarget, matchDetectionsToFrame, parseJpegFrame, targetOptions, boxSize, type DetectionPacket } from './protocol';
import { createWaterController } from './gesture';

type Control = Record<string, unknown>;

// ── WebSocket with bounded reconnect ──────────────────────────────────────
let ws: WebSocket | null = null;
let wsReconnectAttempts = 0;
let wsReconnectTimer: ReturnType<typeof setTimeout> | undefined;
const WS_MAX_RECONNECT = 20;

const send = (m: Control) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };

function cleanupWs() {
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = undefined; }
  if (ws) {
    ws.onopen = null;
    ws.onclose = null;
    ws.onmessage = null;
    try { ws.close(); } catch { /* already closed */ }
    ws = null;
  }
}

function connectWebSocket(handlers: {
  onopen: () => void;
  onclose: () => void;
  onmessage: (event: MessageEvent) => void;
}) {
  cleanupWs();
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  wsReconnectAttempts++;
  ws.onopen = () => {
    wsReconnectAttempts = 0;
    handlers.onopen();
  };
  ws.onclose = () => {
    handlers.onclose();
    if (wsReconnectAttempts < WS_MAX_RECONNECT) {
      const delay = Math.min(30000, Math.pow(2, wsReconnectAttempts) * 100);
      wsReconnectTimer = setTimeout(() => connectWebSocket(handlers), delay);
    }
  };
  ws.onmessage = handlers.onmessage;
}

// ── Constants ──────────────────────────────────────────────────────────────
const TARGETS = targetOptions();
const KEY_MAP: Record<string, string> = { arrowleft: 'yaw:-1', a: 'yaw:-1', arrowright: 'yaw:1', d: 'yaw:1', arrowup: 'pitch:-1', w: 'pitch:-1', arrowdown: 'pitch:1', s: 'pitch:1' };

function App() {
  const [enabled, setEnabled] = useState(false);
  const enabledRef = useRef(false);
  const [tracking, setTracking] = useState(false);
  const [speed, setSpeed] = useState(100);
  const [pulseMs, setPulseMs] = useState(500);
  const pulseMsRef = useRef(500);
  const [target, setTarget] = useState('');
  const [strategy, setStrategy] = useState('confidence + area');
  const [aimX, setAimX] = useState(0.5);
  const [aimY, setAimY] = useState(0.5);
  const [error, setError] = useState('');
  const [pumpState, setPumpState] = useState('Pump off');
  const [switches, setSwitches] = useState('');
  const [fps, setFps] = useState('FPS —');
  const [latency, setLatency] = useState('Latency —');
  const [dropped, setDropped] = useState('Dropped —');

  const [detectionPackets, setDetectionPackets] = useState<DetectionPacket[]>([]);
  const [currentFrame, setCurrentFrame] = useState<{ seq: number; timestamp: number } | undefined>();
  const [matchedBoxes, setMatchedBoxes] = useState<DetectionPacket | undefined>();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const heldRef = useRef(new Set<string>());
  const shiftRef = useRef(false);
  const lastSeqRef = useRef(-1);
  const decodingRef = useRef(false);
  const pendingRef = useRef<ArrayBuffer | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);

  // Water gesture controller (ref to survive re-render)
  const waterRef = useRef<ReturnType<typeof createWaterController>>(undefined);
  if (!waterRef.current) {
    waterRef.current = createWaterController(
      (action) => {
        if (action.type === 'pulse') send({ type: 'pump', on: true, durationMs: action.durationMs });
        else if (action.type === 'hold-on') send({ type: 'pump', on: true });
        else if (action.type === 'off') send({ type: 'pump', on: false });
      },
    );
  }

  const emitHeld = useCallback(() => {
    const shift = shiftRef.current;
    for (const motion of heldRef.current) {
      const [axis, dir] = motion.split(':');
      send({ type: 'motor', axis, dir: Number(dir), on: true, slow: shift });
    }
  }, []);

  const stopMotion = useCallback(() => {
    for (const motion of heldRef.current) {
      const [axis, dir] = motion.split(':');
      send({ type: 'motor', axis, dir: Number(dir), on: false });
    }
    heldRef.current.clear();
  }, []);

  const startMotion = useCallback((motion: string) => {
    if (heldRef.current.has(motion)) return;
    heldRef.current.add(motion);
    emitHeld();
  }, [emitHeld]);

  const releaseMotion = useCallback((motion: string) => {
    if (!heldRef.current.delete(motion)) return;
    const [axis, dir] = motion.split(':');
    send({ type: 'motor', axis, dir: Number(dir), on: false });
  }, []);

  // WebSocket connection lifecycle
  useEffect(() => {
    connectWebSocket({
      onopen: () => { connectPeer().catch((e) => setError(String(e))); send({ type: 'ping' }); },
      onclose: () => { stopMotion(); cancelWater(); peerRef.current?.close(); setError('Connection lost'); },
      onmessage: (event) => {
        let msg: any;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'motorState') {
          enabledRef.current = Boolean(msg.enabled);
          setEnabled(enabledRef.current);
          if (msg.speed !== undefined) setSpeed(msg.speed);
          if (msg.error) setError(msg.error);
        } else if (msg.type === 'pumpState') {
          setPumpState(msg.on ? `Pump on${msg.remainingMs ? ` ${msg.remainingMs} ms` : ''}` : 'Pump off');
          if (msg.error) setError(msg.error);
        } else if (msg.type === 'switches') {
          setSwitches(`Yaw − ${msg.negative ? 'ON' : 'off'} / + ${msg.positive ? 'ON' : 'off'}`);
        } else if (msg.type === 'trackingState') {
          setTracking(Boolean(msg.enabled));
          if (msg.aimX !== undefined && msg.aimY !== undefined) { setAimX(Number(msg.aimX)); setAimY(Number(msg.aimY)); }
        } else if (msg.type === 'detections') {
          setDetectionPackets(prev => { const next = [...prev, msg]; while (next.length > 30) next.shift(); return next; });
          if (msg.fps !== undefined) setFps(`FPS ${msg.fps}`);
          if (msg.dropped !== undefined) setDropped(`Dropped ${msg.dropped}`);
          if (msg.timestamp !== undefined) setLatency(`Latency ${Math.max(0, Date.now() - msg.timestamp)} ms`);
        } else if (msg.type === 'error') {
          setError(msg.error ?? msg.message);
        } else if (msg.type === 'answer' && peerRef.current) {
          peerRef.current.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        } else if (msg.type === 'ice' && peerRef.current) {
          peerRef.current.addIceCandidate({ candidate: msg.candidate, sdpMid: msg.mid });
        }
      },
    });
    const ping = setInterval(() => send({ type: 'ping' }), 5000);
    return () => { clearInterval(ping); cleanupWs(); stopMotion(); send({ type: 'pump', on: false }); peerRef.current?.close(); };
  }, [stopMotion]);

  // Match detections to current frame
  useEffect(() => {
    if (!currentFrame) { setMatchedBoxes(undefined); return; }
    setMatchedBoxes(matchDetectionsToFrame(currentFrame, detectionPackets));
  }, [currentFrame, detectionPackets]);

  // WebRTC setup
  async function connectPeer() {
    peerRef.current?.close();
    const pc = new RTCPeerConnection({ iceServers: [] });
    const dc = pc.createDataChannel('video');
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (event) => {
      pendingRef.current = event.data as ArrayBuffer;
      if (!decodingRef.current) void drawLatest();
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) send({ type: 'ice', candidate: event.candidate.candidate, mid: event.candidate.sdpMid });
    };
    peerRef.current = pc;
    channelRef.current = dc;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ type: 'offer', sdp: offer.sdp });
    } catch (e) {
      peerRef.current?.close();
      peerRef.current = null;
      channelRef.current = null;
      setError(String(e));
    }
  }

  async function drawLatest() {
    if (decodingRef.current || !pendingRef.current) return;
    decodingRef.current = true;
    const data = pendingRef.current;
    pendingRef.current = null;
    try {
      const frame = parseJpegFrame(data);
      if (frame.seq > lastSeqRef.current) {
        const blob = new Blob([frame.jpeg], { type: 'image/jpeg' });
        const bitmap = await createImageBitmap(blob);
        if (frame.seq > lastSeqRef.current && canvasRef.current) {
          const ctx = canvasRef.current.getContext('2d');
          if (ctx) { ctx.drawImage(bitmap, 0, 0, canvasRef.current.width, canvasRef.current.height); }
          lastSeqRef.current = frame.seq;
          setCurrentFrame({ seq: frame.seq, timestamp: frame.timestamp });
        }
        bitmap.close();
      }
    } catch (e) { setError(String(e)); }
    decodingRef.current = false;
    if (pendingRef.current) void drawLatest();
  }

  function startWater() { waterRef.current?.start(); }
  function stopWater() { waterRef.current?.stop(pulseMsRef.current); }
  function cancelWater() { waterRef.current?.cancel(); }

  // Keyboard handler — installed once; reads stable refs for changing values
  useEffect(() => {
    const onkeydown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      const key = e.key.toLowerCase();
      if (key === 'shift') { shiftRef.current = true; emitHeld(); return; }
      if (e.repeat) return;
      if (KEY_MAP[key]) { e.preventDefault(); startMotion(KEY_MAP[key]); }
      else if (key === 'f') { e.preventDefault(); startWater(); }
      else if (key === 'e') send({ type: 'enable', on: !enabledRef.current });
      else if (key === 'q' || key === 'escape') { stopMotion(); cancelWater(); send({ type: 'estop' }); }
    };
    const onkeyup = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (key === 'shift') { shiftRef.current = false; emitHeld(); }
      else if (KEY_MAP[key]) releaseMotion(KEY_MAP[key]);
      else if (key === 'f') stopWater();
    };
    const onBlur = () => { stopMotion(); cancelWater(); send({ type: 'pump', on: false }); };
    window.addEventListener('keydown', onkeydown);
    window.addEventListener('keyup', onkeyup);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onkeydown);
      window.removeEventListener('keyup', onkeyup);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const matched = currentFrame && matchedBoxes ? matchedBoxes : undefined;
  const matchedWidth = matched?.width ?? 640;
  const matchedHeight = matched?.height ?? 480;

  return (
    <main className="dashboard">
      <section className="video-panel">
        <div id="frame">
          <canvas id="video" ref={canvasRef} width="640" height="480" />
          <div id="boxes">
            {matched?.boxes?.filter(b => boxSize(b).width > 0 && boxSize(b).height > 0).map((box, i) => {
              const s = boxSize(box);
              return (
                <div key={i} className="box"
                  style={{ left: `${box.x / matchedWidth * 100}%`, top: `${box.y / matchedHeight * 100}%`, width: `${s.width / matchedWidth * 100}%`, height: `${s.height / matchedHeight * 100}%` }}>
                  <span>{box.label} {Math.round(box.confidence * 100)}%</span>
                </div>
              );
            })}
          </div>
          <div id="aim" style={{ left: `${aimX * 100}%`, top: `${aimY * 100}%` }} />
        </div>
        <div className="metrics">
          <span id="fps">{fps}</span>
          <span id="latency">{latency}</span>
          <span id="dropped">{dropped}</span>
          <span id="npu">NPU —</span>
          <span id="temperature">Temp —</span>
        </div>
      </section>
      <section className="controls">
        <div className="row">
          <button id="enable" onClick={() => send({ type: 'enable', on: !enabledRef.current })}>{enabled ? 'Disable' : 'Enable'}</button>
          <button id="estop" className="danger" onClick={() => { stopMotion(); cancelWater(); send({ type: 'estop' }); }}>E-STOP</button>
          <button id="tracking" onClick={() => send({ type: 'tracking', on: !tracking, label: target, strategy })}>
            {tracking ? 'Tracking on' : 'Tracking off'}
          </button>
        </div>
        <div className="pad">
          <button data-move="pitch:-1" onPointerDown={e => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture(e.pointerId); startMotion('pitch:-1'); }} onPointerUp={() => releaseMotion('pitch:-1')} onPointerCancel={() => releaseMotion('pitch:-1')} onLostPointerCapture={() => releaseMotion('pitch:-1')}>▲</button>
          <button data-move="yaw:-1" onPointerDown={e => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture(e.pointerId); startMotion('yaw:-1'); }} onPointerUp={() => releaseMotion('yaw:-1')} onPointerCancel={() => releaseMotion('yaw:-1')} onLostPointerCapture={() => releaseMotion('yaw:-1')}>◀</button>
          <button data-move="yaw:1" onPointerDown={e => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture(e.pointerId); startMotion('yaw:1'); }} onPointerUp={() => releaseMotion('yaw:1')} onPointerCancel={() => releaseMotion('yaw:1')} onLostPointerCapture={() => releaseMotion('yaw:1')}>▶</button>
          <button data-move="pitch:1" onPointerDown={e => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture(e.pointerId); startMotion('pitch:1'); }} onPointerUp={() => releaseMotion('pitch:1')} onPointerCancel={() => releaseMotion('pitch:1')} onLostPointerCapture={() => releaseMotion('pitch:1')}>▼</button>
        </div>
        <label>Speed <input id="speed" type="range" min="10" max="200" value={speed} onChange={e => { const v = Number(e.target.value); setSpeed(v); send({ type: 'speed', pct: v }); }} /><output id="speed-value">{speed}%</output></label>
        <div className="row">
          <button id="water" onPointerDown={e => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture(e.pointerId); startWater(); }} onPointerUp={stopWater} onPointerCancel={cancelWater} onLostPointerCapture={cancelWater}>Water</button>
          <label>Pulse <input id="pulse" type="range" min="50" max="2000" value={pulseMs} onChange={e => { const v = Number(e.target.value); pulseMsRef.current = v; setPulseMs(v); }} /><output id="pulse-value">{pulseMs} ms</output></label>
        </div>
        <div className="row"><span id="pump-state">{pumpState}</span><span id="switches">{switches}</span></div>
        <label>Target <input id="target" type="search" list="targets" value={target} onChange={e => setTarget(e.target.value)} onBlur={() => { send({ type: 'target', label: target }); send({ type: 'classes', ids: classIdsForTarget(target) }); }} placeholder="Class or tag" />
          <datalist id="targets">{TARGETS.map((opt, i) => <option key={i} value={opt.value} label={opt.label} />)}</datalist>
        </label>
        <label>Strategy <select id="strategy" value={strategy} onChange={e => { setStrategy(e.target.value); send({ type: 'strategy', value: e.target.value }); }}>
          <option>confidence + area</option><option>confidence</option><option>area</option>
        </select></label>
        <label>Aim X <input id="aim-x" type="range" min="0" max="100" value={Math.round(aimX * 100)} onChange={e => { const v = Number(e.target.value) / 100; setAimX(v); send({ type: 'aim', x: v, y: aimY }); }} /></label>
        <label>Aim Y <input id="aim-y" type="range" min="0" max="100" value={Math.round(aimY * 100)} onChange={e => { const v = Number(e.target.value) / 100; setAimY(v); send({ type: 'aim', x: aimX, y: v }); }} /></label>
        <div id="error" role="alert">{error}</div>
      </section>
    </main>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);