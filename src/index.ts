import { createServer, Socket } from 'node:net';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { loadConfig } from './config';
import { PacketDecoder, PacketType, encodePacket } from './ipc';
import { MockGpio, Gpiod } from './gpio';
import { Stepper, MOTOR_PINS } from './stepper';
import { Pump, MockRelay, GpioRelay } from './pump';
import { Manual } from './manual';
import { VideoPeer } from './webrtc';
import { Tracker } from './tracking';

const cfg = loadConfig();
const io = process.env.KITTI_MOCK === '1' ? new MockGpio() : cfg.relayActiveHigh === null ? null : new Gpiod();
const clients = new Set<any>();
const peers = new Map<any, VideoPeer>();
const broadcast = (v: unknown) => { for (const c of clients) c.send(JSON.stringify(v)); };
const pump = new Pump(io && cfg.relayActiveHigh !== null ? new GpioRelay(io, 'GPIO1_C6', cfg.relayActiveHigh) : new MockRelay(),
  {minPulseMs:50,maxPulseMs:2000,maxContinuousMs:cfg.maxPumpMs}, (on,remainingMs,error)=>broadcast({type:'pumpState',on,remainingMs,error}));
const manual = io && cfg.yawNegativeSwitch ? new Manual({yaw:new Stepper(io,MOTOR_PINS.yaw),pitch:new Stepper(io,MOTOR_PINS.pitch)},pump,io,
  {negative:cfg.yawNegativeSwitch as 'GPIO1_B6'|'GPIO1_B7',positive:cfg.yawNegativeSwitch === 'GPIO1_B6'?'GPIO1_B7':'GPIO1_B6',graceSteps:64,backoffSteps:128,backoffRate:960,maxBackoffSteps:2400}) : null;
if (manual) { manual.axes.yaw.forceDisable(); manual.axes.pitch.forceDisable(); }
const tracker = new Tracker();
let worker: Socket | null = null;
let latestDetection: any = null;
function safeStop() { pump.stop(); tracker.enabled=false; manual?.stop(); manual?.enable(false); }
function estop() { manual?.estop(); pump.estop(); tracker.enabled=false; broadcast({type:'motorState',enabled:false,moving:false,speed:manual?.speedPct??100,error:'E-stop'}); }
function state(ws:any) { ws.send(JSON.stringify({type:'motorState',enabled:manual?.enabled??false,moving:false,speed:manual?.speedPct??100})); ws.send(JSON.stringify({type:'pumpState',on:pump.on,remainingMs:pump.remainingMs,error:pump.error})); }
function route(ws:any,raw:string) {
 const m=JSON.parse(raw); if (!m || typeof m.type !== 'string') throw Error('invalid message');
 switch(m.type) {
  case 'ping': ws.send(JSON.stringify({type:'pong',timestamp:Date.now()})); break;
  case 'offer': case 'ice': void peers.get(ws)?.signal(m).catch((e:unknown)=>ws.send(JSON.stringify({type:'error',error:String(e)}))); break;
  case 'estop': estop(); break;
  case 'enable': if(typeof m.on!=='boolean') throw Error('invalid enable'); if(!manual) throw Error('hardware unavailable'); if(!m.on)tracker.enabled=false; manual.enable(m.on); broadcast({type:'motorState',enabled:manual.enabled,moving:false,speed:manual.speedPct}); break;
  case 'speed': if(typeof m.pct!=='number'||!manual) throw Error('invalid speed'); manual.speed(m.pct); broadcast({type:'motorState',enabled:manual.enabled,moving:false,speed:manual.speedPct}); break;
  case 'motor': if(!manual||!['yaw','pitch'].includes(m.axis)||![-1,1].includes(m.dir)||typeof m.on!=='boolean') throw Error('invalid motor'); tracker.enabled=false; if(m.on) void manual.start(m.axis,m.dir,!!m.slow).catch((e:unknown)=>broadcast({type:'motorState',enabled:manual.enabled,moving:false,speed:manual.speedPct,error:String(e)})); else manual.stop(m.axis); broadcast({type:'motorState',enabled:manual.enabled,moving:m.on,speed:manual.speedPct}); break;
  case 'pump': if(typeof m.on!=='boolean'||(m.durationMs!==undefined&&typeof m.durationMs!=='number')) throw Error('invalid pump'); if(m.on) {if(!manual) throw Error('hardware unavailable'); pump.start(m.durationMs);} else pump.stop(); break;
  case 'tracking': if(typeof m.on!=='boolean') throw Error('invalid tracking'); if(m.on&&!manual?.enabled) throw Error('enable motors first'); tracker.enabled=m.on; if(typeof m.label==='string')tracker.label=m.label; if(['confidence','area','confidence + area'].includes(m.strategy))tracker.strategy=m.strategy; if(typeof m.aimX==='number'&&m.aimX>=0&&m.aimX<=1)tracker.aimX=m.aimX; if(typeof m.aimY==='number'&&m.aimY>=0&&m.aimY<=1)tracker.aimY=m.aimY; broadcast({type:'trackingState',enabled:tracker.enabled,label:tracker.label,strategy:tracker.strategy,aimX:tracker.aimX,aimY:tracker.aimY}); break;
  case 'aim': if(typeof m.x!=='number'||typeof m.y!=='number'||m.x<0||m.x>1||m.y<0||m.y>1)throw Error('invalid aim');tracker.aimX=m.x;tracker.aimY=m.y;break;
  case 'target': if(typeof m.label!=='string')throw Error('invalid target');tracker.label=m.label;break;
  case 'strategy': if(!['confidence','area','confidence + area'].includes(m.value))throw Error('invalid strategy');tracker.strategy=m.value;break;
  default: throw Error(`unknown control type ${m.type}`);
 }
}
if(existsSync(cfg.socket)) {
 const live=await new Promise<boolean>(resolve=>{const s=new Socket();s.once('connect',()=>{s.destroy();resolve(true)});s.once('error',()=>resolve(false));s.connect(cfg.socket)});
 if(live)throw Error(`live IPC socket: ${cfg.socket}`);unlinkSync(cfg.socket);
}
const ipc=createServer(socket=>{
 if(worker){socket.destroy();return} worker=socket;const decoder=new PacketDecoder();
 socket.on('data',chunk=>{try{for(const p of decoder.push(Buffer.from(chunk))){
  if(p.type===PacketType.Frame){if(p.payload.length<12)throw Error('short frame');const view=new DataView(p.payload.buffer,p.payload.byteOffset);const seq=view.getUint32(0,true);const timestamp=Number(view.getBigUint64(4,true));for(const peer of peers.values())peer.sendFrame(p.payload);socket.write(encodePacket(PacketType.Ack,p.payload.slice(0,4)));broadcast({type:'frame',seq,timestamp});}
  else if(p.type===PacketType.Detection){latestDetection=JSON.parse(new TextDecoder().decode(p.payload));broadcast({type:'detections',...latestDetection,seq:latestDetection.sequence});}
  else throw Error(`unexpected packet ${p.type}`);
 }}catch(e){console.error(e);socket.destroy()}});
 socket.on('close',()=>{if(worker===socket)worker=null});
});ipc.listen(cfg.socket);
const server=Bun.serve({hostname:cfg.host,port:cfg.port,
 fetch(req,s){const path=new URL(req.url).pathname;if(path==='/ws')return s.upgrade(req)?undefined:new Response('upgrade failed',{status:400});if(path==='/estop'&&req.method==='POST'){estop();return new Response('ok')}if(path==='/')return new Response(readFileSync('dist/index.html'),{headers:{'content-type':'text/html'}});if(path==='/dist/client.js')return new Response(readFileSync('dist/client.js'),{headers:{'content-type':'application/javascript'}});if(path==='/dist/style.css')return new Response(readFileSync('dist/style.css'),{headers:{'content-type':'text/css'}});return new Response('not found',{status:404})},
 websocket:{open(ws){clients.add(ws);peers.set(ws,new VideoPeer(m=>ws.send(JSON.stringify(m)),process.env.KITTI_STUN));state(ws);if(latestDetection)ws.send(JSON.stringify({type:'detections',...latestDetection}))},message(ws,m){try{route(ws,String(m))}catch(e){ws.send(JSON.stringify({type:'error',error:String(e)}))}},close(ws){clients.delete(ws);peers.get(ws)?.close();peers.delete(ws);if(clients.size===0)safeStop()}}
});
console.log(`KITTI ${server.url}`);
function shutdown(){safeStop();manual?.shutdown();pump.close();for(const p of peers.values())p.close();worker?.destroy();ipc.close();server.stop(true);if(existsSync(cfg.socket))unlinkSync(cfg.socket)}
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
