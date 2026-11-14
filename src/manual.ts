import type {DigitalIo,Pin} from './gpio';
import {Stepper} from './stepper';
import {Pump} from './pump';
export type Axis='yaw'|'pitch';
export interface LimitConfig {negative:Pin;positive:Pin;graceSteps:number;backoffSteps:number;backoffRate:number;maxBackoffSteps:number}
export const DEFAULT_LIMITS:LimitConfig={negative:'GPIO1_B6',positive:'GPIO1_B7',graceSteps:64,backoffSteps:128,backoffRate:960,maxBackoffSteps:2400};
export class Manual {
 enabled=false; speedPct=100; estopped=false;
 private running=new Map<Axis,Promise<void>>();
 private generation:Record<Axis,number>={yaw:0,pitch:0};
 constructor(readonly axes:Record<Axis,Stepper>,readonly pump:Pump,private io:DigitalIo,readonly limits:LimitConfig=DEFAULT_LIMITS,private invert:{yaw:boolean;pitch:boolean}={yaw:false,pitch:false}){
  if(limits.negative===limits.positive)throw new Error('Limit pins must differ');
  io.input(limits.negative,true);io.input(limits.positive,true);
 }
 switches(){return {negative:this.io.read(this.limits.negative),positive:this.io.read(this.limits.positive)};}
 enable(on:boolean){if(this.estopped&&on)throw new Error('E-stop active');if(on){for(const a of Object.values(this.axes))a.enable();this.enabled=true;}else{this.stop();for(const a of Object.values(this.axes))a.forceDisable();this.enabled=false;}}
 speed(pct:number){if(!Number.isFinite(pct)||pct<10||pct>200)throw new Error('Speed out of range');this.speedPct=pct;}
 stop(axis?:Axis){for(const [name,m] of Object.entries(this.axes) as [Axis,Stepper][])if(!axis||axis===name){this.generation[name]++;m.cancel();}}
 async start(axis:Axis,dir:1|-1,slow=false,overridePct?:number){
  if(!this.enabled||this.estopped)throw new Error('Motor disabled');
  if(overridePct!==undefined&&(!Number.isFinite(overridePct)||overridePct<10||overridePct>200))throw new Error('Speed out of range');
  const id=++this.generation[axis];
  if(this.running.has(axis)){this.axes[axis].cancel();await this.running.get(axis);}
  if(id!==this.generation[axis]||!this.enabled||this.estopped)throw new Error('Motor disabled');
  const motor=this.axes[axis];
  const effectiveDir = this.invert[axis] ? (dir * -1) as 1 | -1 : dir;
  const base=axis==='yaw'?1920:1280;
  const pct=overridePct??this.speedPct;
  const rate=base*pct/100*(slow?.25:1);
  const task=(async()=>{
   let moved=0;
   const atStart=axis==='yaw'?this.switches():undefined;
   // Limit-switch end semantics derive from the logical requested dir, not effectiveDir.
   // Only raw Stepper.move directions (normal and backoff) are multiplied by inversion sign.
   const blocking=dir<0?'negative':'positive';
   const opposite=dir<0?'positive':'negative';
   while(id===this.generation[axis]&&moved<motor.cfg.maxSteps&&this.enabled&&!this.estopped){
    if(axis==='yaw'){
     const now=this.switches();
     if(now[blocking])break;
     if(now[opposite]&&moved>=this.limits.graceSteps&&atStart?.[opposite])break;
    }
    const n=await motor.move(effectiveDir,Math.min(32,motor.cfg.maxSteps-moved),rate,axis==='yaw'?()=>{const sw=this.switches();return sw[blocking]||(moved>=this.limits.graceSteps&&!!atStart?.[opposite]&&sw[opposite]);}:undefined);
    moved+=n;if(n===0)break;
   }
   if(axis==='yaw'&&id===this.generation[axis]&&this.enabled&&!this.estopped){
    const now=this.switches();
    const hit=now[blocking]&&!atStart?.[blocking];
    if(hit&&!now[opposite]){
     const destOpposite=()=>this.switches()[opposite];
     const n=Math.min(this.limits.backoffSteps,this.limits.maxBackoffSteps);
     await motor.move(-effectiveDir as 1 | -1,n,this.limits.backoffRate,destOpposite);
    }
   }
  })();
  this.running.set(axis,task);try{await task;}finally{if(this.running.get(axis)===task)this.running.delete(axis);}
 }
 estop(){this.estopped=true;this.stop();const errors:string[]=[];for(const a of Object.values(this.axes)){try{a.forceDisable();}catch(e){errors.push(String(e));}}try{this.pump.estop();}catch(e){errors.push(String(e));}this.enabled=false;for(const e of errors)console.error('estop',e);}
 resetEstop(){this.estopped=false;this.pump.resetEstop();}
 /** Wait for all active move tasks to settle (e.g. after cancel). */
 async waitForIdle():Promise<void>{const tasks=Array.from(this.running.values());if(tasks.length)await Promise.allSettled(tasks);}
 shutdown(){this.estop();}
}
