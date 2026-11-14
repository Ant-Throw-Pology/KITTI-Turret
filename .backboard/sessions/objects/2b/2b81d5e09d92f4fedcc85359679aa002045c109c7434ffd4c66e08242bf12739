import type {DigitalIo,Pin} from './gpio';
export interface AxisPins {step:Pin;dir:Pin;en:Pin}
export const MOTOR_PINS:Record<'yaw'|'pitch',AxisPins>={yaw:{step:'GPIO4_A3',dir:'GPIO4_A4',en:'GPIO0_D4'},pitch:{step:'GPIO4_B2',dir:'GPIO4_B3',en:'GPIO1_D3'}};
export interface MotionConfig {maxRate:number; acceleration:number; pulseUs:number; maxSteps:number}
export const DEFAULT_MOTION:MotionConfig={maxRate:4000,acceleration:16000,pulseUs:10,maxSteps:57600};
export class Stepper {
 position=0; enabled=false; moving=false;
 private bound=false; private cancelled=false; private generation=0;
 constructor(private io:DigitalIo,readonly pins:AxisPins,readonly cfg:MotionConfig=DEFAULT_MOTION) {
  if(cfg.pulseUs<10||cfg.maxRate<=0||cfg.acceleration<=0||cfg.maxSteps<=0) throw new Error('Unsafe motion config');
 }
 private bind() {if(this.bound)return; this.io.output(this.pins.en,true); this.io.output(this.pins.step,false); this.io.output(this.pins.dir,false); this.bound=true;}
 enable() {this.bind();this.io.write(this.pins.en,false);this.enabled=true;}
 disable() {this.cancel();this.forceDisable();}
 forceDisable() {this.bind();this.io.write(this.pins.en,true);this.enabled=false;}
 cancel() {this.cancelled=true;this.generation++;}
 async move(dir:1|-1,requestedSteps:number,requestedRate:number, shouldStop?:()=>boolean):Promise<number> {
  if(!this.enabled) throw new Error('Motor disabled');
  if(this.moving) throw new Error('Motor already moving');
  if(!Number.isSafeInteger(requestedSteps)||requestedSteps<0||requestedSteps>this.cfg.maxSteps) throw new Error('Motion exceeds hard cap');
  const rate=Math.min(requestedRate,this.cfg.maxRate);
  if(!Number.isFinite(rate)||rate<=0) throw new Error('Invalid rate');
  this.cancelled=false;this.moving=true;const generation=++this.generation;
  this.io.write(this.pins.dir,dir>0);
  let done=0;
  try {
   for(;done<requestedSteps;done++) {
    if(this.cancelled||generation!==this.generation||!this.enabled||shouldStop?.()) break;
    const ramp=Math.sqrt(2*this.cfg.acceleration*Math.min(done+1,requestedSteps-done));
    const actual=Math.min(rate,ramp);
    const due=performance.now()+1000/actual;
    this.io.write(this.pins.step,true);
    await waitUs(this.cfg.pulseUs);
    this.io.write(this.pins.step,false);
    this.position+=dir;
    await waitUntil(due);
    if(done%32===0) await Bun.sleep(0);
   }
  } finally {this.io.write(this.pins.step,false);this.moving=false;}
  return done;
 }
}
async function waitUs(us:number) {const end=performance.now()+us/1000;while(performance.now()<end){} }
async function waitUntil(time:number) {const remain=time-performance.now();if(remain>2) await Bun.sleep(remain-1);while(performance.now()<time){} }
