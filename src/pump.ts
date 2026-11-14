import type {DigitalIo,Pin} from './gpio';
export interface Relay {set(on:boolean):void;close():void}
export class MockRelay implements Relay {on=false; history:{on:boolean;at:number}[]=[];set(on:boolean){this.on=on;this.history.push({on,at:performance.now()});}close(){this.set(false);}}
export class GpioRelay implements Relay {
 private closed=false;
 constructor(private io:DigitalIo,private pin:Pin,private activeHigh:boolean) {io.output(pin,!activeHigh);}
 set(on:boolean){if(this.closed)throw new Error('Relay closed');this.io.write(this.pin,on===this.activeHigh);}
 close(){if(!this.closed){this.io.write(this.pin,!this.activeHigh);this.closed=true;}}
}
export interface PumpConfig {minPulseMs:number;maxPulseMs:number;maxContinuousMs:number}
export const DEFAULT_PUMP:PumpConfig={minPulseMs:50,maxPulseMs:2000,maxContinuousMs:10000};
export class Pump {
 on=false; error?:string; private timer?:ReturnType<typeof setTimeout>; private deadline=0; private estopped=false;
 constructor(private relay:Relay,private config:PumpConfig=DEFAULT_PUMP,private changed?:(on:boolean,remainingMs?:number,error?:string)=>void) {relay.set(false);}
 get remainingMs(){return this.on?Math.max(0,this.deadline-performance.now()):0;}
 start(durationMs?:number) {
  if(this.estopped)throw new Error('E-stop active');
  if(durationMs!==undefined && (!Number.isFinite(durationMs)||durationMs<this.config.minPulseMs||durationMs>this.config.maxPulseMs))throw new Error('Invalid pump duration');
  this.stop();this.error=undefined;this.on=true;this.deadline=performance.now()+(durationMs??this.config.maxContinuousMs);
  this.relay.set(true);this.changed?.(true,this.remainingMs);
  this.timer=setTimeout(()=>{this.error=durationMs===undefined?'Pump maximum-on timeout':undefined;this.stop();},durationMs??this.config.maxContinuousMs);
 }
 stop(){if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.relay.set(false);const changed=this.on;this.on=false;this.deadline=0;if(changed)this.changed?.(false,undefined,this.error);}
 estop(){this.estopped=true;this.stop();}
 resetEstop(){this.estopped=false;}
 close(){this.estop();this.relay.close();}
}
