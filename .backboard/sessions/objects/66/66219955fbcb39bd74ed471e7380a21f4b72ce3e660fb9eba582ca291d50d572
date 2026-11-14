type Control = Record<string, unknown>;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
const canvas = $<HTMLCanvasElement>('video'), context = canvas.getContext('2d')!;
const boxes = $('boxes');
const send = (message: Control) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
let peer: RTCPeerConnection | undefined, channel: RTCDataChannel | undefined;
let lastSeq = -1, decoding = false, pending: ArrayBuffer | null = null;
let enabled = false, tracking = false, speed = 100;
const held = new Set<string>();
const keyMap: Record<string, string> = {arrowleft:'yaw:-1',a:'yaw:-1',arrowright:'yaw:1',d:'yaw:1',arrowup:'pitch:-1',w:'pitch:-1',arrowdown:'pitch:1',s:'pitch:1'};
const emitHeld = () => { for (const motion of held) { const [axis, dir] = motion.split(':'); send({type:'motor',axis,dir:Number(dir),on:true,slow:shift}); } };
let shift = false;
function stopMotion() { for (const motion of held) { const [axis,dir] = motion.split(':'); send({type:'motor',axis,dir:Number(dir),on:false}); } held.clear(); }
function startMotion(motion: string) { if (held.has(motion)) return; held.add(motion); emitHeld(); }
function releaseMotion(motion: string) { if (!held.delete(motion)) return; const [axis,dir] = motion.split(':'); send({type:'motor',axis,dir:Number(dir),on:false}); }
const speedInput = $<HTMLInputElement>('speed');
speedInput.oninput = () => { speed = Number(speedInput.value); $('speed-value').textContent = `${speed}%`; send({type:'speed',pct:speed}); };
const pulseInput = $<HTMLInputElement>('pulse');
pulseInput.oninput = () => { $('pulse-value').textContent = `${pulseInput.value} ms`; };
$('enable').onclick = () => send({type:'enable',on:!enabled});
$('estop').onclick = () => { stopMotion(); stopWater(); send({type:'estop'}); };
$('tracking').onclick = () => send({type:'tracking',on:!tracking,label:$<HTMLInputElement>('target').value,strategy:$<HTMLSelectElement>('strategy').value});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-move]')) {
  const motion = button.dataset.move!;
  button.onpointerdown = event => { event.preventDefault(); button.setPointerCapture(event.pointerId); startMotion(motion); };
  button.onpointerup = () => releaseMotion(motion);
  button.onpointercancel = () => releaseMotion(motion);
  button.onlostpointercapture = () => releaseMotion(motion);
}
const water = $('water');
let waterTimer: number | undefined, waterHeld = false, waterDown = false;
function startWater() { if (waterDown) return; waterDown = true; waterHeld = false; waterTimer = window.setTimeout(() => { if (!waterDown) return; waterHeld = true; send({type:'pump',on:true}); water.classList.add('active'); },250); }
function stopWater() { if (!waterDown) return; waterDown = false; clearTimeout(waterTimer); water.classList.remove('active'); if (waterHeld) send({type:'pump',on:false}); else send({type:'pump',on:true,durationMs:Number(pulseInput.value)}); waterHeld = false; }
function cancelWater() { if (!waterDown) return; waterDown = false; clearTimeout(waterTimer); water.classList.remove('active'); if (waterHeld) send({type:'pump',on:false}); waterHeld = false; }
water.onpointerdown = event => { event.preventDefault(); water.setPointerCapture(event.pointerId); startWater(); };
water.onpointerup = stopWater;
water.onpointercancel = cancelWater;
water.onlostpointercapture = cancelWater;
document.onkeydown = event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
  const key = event.key.toLowerCase();
  if (key === 'shift') { if (!shift) { shift = true; emitHeld(); } return; }
  if (event.repeat) return;
  if (keyMap[key]) { event.preventDefault(); startMotion(keyMap[key]); }
  else if (key === 'f') { event.preventDefault(); startWater(); }
  else if (key === 'e') send({type:'enable',on:!enabled});
  else if (key === 'q' || key === 'escape') { stopMotion(); cancelWater(); send({type:'estop'}); }
  else if (key === 't') $('tracking').click();
};
document.onkeyup = event => {
  const key = event.key.toLowerCase();
  if (key === 'shift') { shift = false; emitHeld(); }
  else if (keyMap[key]) releaseMotion(keyMap[key]);
  else if (key === 'f') stopWater();
};
window.onblur = () => { stopMotion(); cancelWater(); send({type:'pump',on:false}); };
window.onbeforeunload = () => { stopMotion(); send({type:'pump',on:false}); };
for (const id of ['aim-x','aim-y']) $<HTMLInputElement>(id).oninput = () => { const x=Number($<HTMLInputElement>('aim-x').value)/100,y=Number($<HTMLInputElement>('aim-y').value)/100; $('aim').style.left=`${x*100}%`; $('aim').style.top=`${y*100}%`; send({type:'aim',x,y}); };
$<HTMLInputElement>('target').onchange = () => send({type:'target',label:$<HTMLInputElement>('target').value});
$<HTMLSelectElement>('strategy').onchange = () => send({type:'strategy',value:$<HTMLSelectElement>('strategy').value});
async function drawLatest() {
  if (decoding || !pending) return;
  decoding = true;
  const data = pending; pending = null;
  try {
    const view = new DataView(data), seq = view.getUint32(0,true);
    if (seq > lastSeq) {
      const blob = new Blob([data.slice(12)],{type:'image/jpeg'});
      const bitmap = await createImageBitmap(blob);
      if (seq > lastSeq) { context.drawImage(bitmap,0,0,canvas.width,canvas.height); lastSeq=seq; }
      bitmap.close();
    }
  } catch (error) { $('error').textContent = String(error); }
  decoding = false; if (pending) void drawLatest();
}
async function connectPeer() {
  peer?.close(); peer = new RTCPeerConnection({iceServers:[]});
  channel = peer.createDataChannel('video'); channel.binaryType = 'arraybuffer';
  channel.onmessage = event => { pending = event.data as ArrayBuffer; void drawLatest(); };
  peer.onicecandidate = event => { if (event.candidate) send({type:'ice',candidate:event.candidate.candidate,mid:event.candidate.sdpMid}); };
  const offer = await peer.createOffer(); await peer.setLocalDescription(offer); send({type:'offer',sdp:offer.sdp});
}
ws.onopen = () => { void connectPeer(); send({type:'ping'}); };
ws.onclose = () => { stopMotion(); cancelWater(); peer?.close(); $('error').textContent='Connection lost'; };
setInterval(() => send({type:'ping'}),5000);
ws.onmessage = async event => {
  let message: any;
  try { message = JSON.parse(event.data); } catch { return; }
  if (message.type === 'answer' && peer) await peer.setRemoteDescription({type:'answer',sdp:message.sdp});
  else if (message.type === 'ice' && peer) await peer.addIceCandidate({candidate:message.candidate,sdpMid:message.mid});
  else if (message.type === 'motorState') { enabled=Boolean(message.enabled); $('enable').textContent=enabled?'Disable':'Enable'; if (message.speed !== undefined) { speed=message.speed; speedInput.value=String(speed); $('speed-value').textContent=`${speed}%`; } if (message.error) $('error').textContent=message.error; }
  else if (message.type === 'pumpState') { $('pump-state').textContent=message.on?`Pump on${message.remainingMs?` ${message.remainingMs} ms`:''}`:'Pump off'; if (message.error) $('error').textContent=message.error; }
  else if (message.type === 'switches') $('switches').textContent=`Yaw − ${message.negative?'ON':'off'} / + ${message.positive?'ON':'off'}`;
  else if (message.type === 'trackingState') { tracking=Boolean(message.enabled); $('tracking').textContent=tracking?'Tracking on':'Tracking off'; }
  else if (message.type === 'detections') {
    boxes.replaceChildren(); const width=message.width||640,height=message.height||480;
    for (const box of message.boxes||[]) { const el=document.createElement('div'); el.className='box'; el.style.left=`${box.x/width*100}%`;el.style.top=`${box.y/height*100}%`;el.style.width=`${box.w/width*100}%`;el.style.height=`${box.h/height*100}%`;const label=document.createElement('span');label.textContent=`${box.label} ${Math.round(box.confidence*100)}%`;el.append(label);boxes.append(el); }
    if (message.fps!==undefined) $('fps').textContent=`FPS ${message.fps}`;
    if (message.dropped!==undefined) $('dropped').textContent=`Dropped ${message.dropped}`;
    if (message.timestamp!==undefined) $('latency').textContent=`Latency ${Math.max(0,Date.now()-message.timestamp)} ms`;
  } else if (message.type==='error') $('error').textContent=message.error ?? message.message;
};
