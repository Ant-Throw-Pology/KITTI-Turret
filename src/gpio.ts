import { dlopen, FFIType, type Pointer } from 'bun:ffi';

export type Pin = `GPIO${number}_${'A'|'B'|'C'|'D'}${0|1|2|3|4|5|6|7}`;
export function parsePin(pin: Pin) {
  const m = /^GPIO(\d+)_([A-D])([0-7])$/.exec(pin);
  if (!m) throw new Error(`Invalid GPIO pin: ${pin}`);
  const bank = Number(m[1]);
  const offset = ('ABCD'.indexOf(m[2]!) * 8) + Number(m[3]);
  return {bank, offset, global: bank * 32 + offset};
}
export interface DigitalIo {
  output(pin: Pin, initial: boolean): void;
  input(pin: Pin, pullUp: boolean): void;
  write(pin: Pin, high: boolean): void;
  read(pin: Pin): boolean;
  close(): void;
}
export class MockGpio implements DigitalIo {
  readonly values = new Map<Pin, boolean>();
  readonly modes = new Map<Pin, 'input'|'output'>();
  output(pin: Pin, initial: boolean) { this.modes.set(pin,'output'); this.values.set(pin,initial); }
  input(pin: Pin, _pullUp: boolean) { this.modes.set(pin,'input'); this.values.set(pin,false); }
  write(pin: Pin, high: boolean) { if(this.modes.get(pin)!=='output') throw new Error(`Unbound output ${pin}`); this.values.set(pin,high); }
  read(pin: Pin) { if(this.modes.get(pin)!=='input') throw new Error(`Unbound input ${pin}`); return this.values.get(pin)??false; }
  setInput(pin: Pin, high: boolean) { if(this.modes.get(pin)!=='input') throw new Error(`Unbound input ${pin}`); this.values.set(pin,high); }
  close() { this.modes.clear(); this.values.clear(); }
}
// libgpiod v2 opaque objects; constants from gpiod.h: INPUT=2 OUTPUT=3, PULL_UP=4.
const P=FFIType.ptr, I=FFIType.int, V=FFIType.void, U=FFIType.u32;
const symbols={
 gpiod_chip_open:{args:[P],returns:P},gpiod_chip_close:{args:[P],returns:V},
 gpiod_line_settings_new:{args:[],returns:P},gpiod_line_settings_free:{args:[P],returns:V},
 gpiod_line_settings_set_direction:{args:[P,I],returns:I},
 gpiod_line_settings_set_bias:{args:[P,I],returns:I},
 gpiod_line_settings_set_output_value:{args:[P,I],returns:I},
 gpiod_line_config_new:{args:[],returns:P},gpiod_line_config_free:{args:[P],returns:V},
 gpiod_line_config_add_line_settings:{args:[P,P,U,P],returns:I},
 gpiod_chip_request_lines:{args:[P,P,P],returns:P},
 gpiod_line_request_release:{args:[P],returns:V},
 gpiod_line_request_set_value:{args:[P,U,I],returns:I},
 gpiod_line_request_get_value:{args:[P,U],returns:I},
} as const;
function nativePointer(p: Pointer | null): Pointer { if (!p) throw new Error('libgpiod returned NULL'); return p; }
export class Gpiod implements DigitalIo {
 private lib=dlopen('/lib/aarch64-linux-gnu/libgpiod.so.3',symbols).symbols;
 private chips=new Map<number,Pointer>();
 private lines=new Map<Pin,Pointer>();
 private bind(pin:Pin, mode:'input'|'output', initial=false, pullUp=false) {
  if(this.lines.has(pin)) throw new Error(`GPIO already bound: ${pin}`);
  const {bank,offset}=parsePin(pin);
  let chip=this.chips.get(bank);
  if(!chip) {
   const path=new TextEncoder().encode(`/dev/gpiochip${bank}\0`);
   try { chip=nativePointer(this.lib.gpiod_chip_open(path)); }
   catch { throw new Error(`Cannot open /dev/gpiochip${bank}; check udev rule and gpio group`); }
   this.chips.set(bank,chip);
  }
  const s=nativePointer(this.lib.gpiod_line_settings_new());
  const c=nativePointer(this.lib.gpiod_line_config_new());
  try {
   if(this.lib.gpiod_line_settings_set_direction(s,mode==='output'?3:2)<0) throw new Error('direction');
   if(pullUp && this.lib.gpiod_line_settings_set_bias(s,4)<0) throw new Error('pull-up');
   if(mode==='output' && this.lib.gpiod_line_settings_set_output_value(s,initial?1:0)<0) throw new Error('initial value');
   const off=new Uint32Array([offset]);
   if(this.lib.gpiod_line_config_add_line_settings(c,off,1,s)<0) throw new Error('line config');
   const req=nativePointer(this.lib.gpiod_chip_request_lines(chip,null,c));
   this.lines.set(pin,req);
  } finally { this.lib.gpiod_line_config_free(c); this.lib.gpiod_line_settings_free(s); }
 }
 output(pin:Pin, initial:boolean) {this.bind(pin,'output',initial);}
 input(pin:Pin,pullUp:boolean) {this.bind(pin,'input',false,pullUp);}
 write(pin:Pin,high:boolean) {const r=this.lines.get(pin); if(!r || this.lib.gpiod_line_request_set_value(r,parsePin(pin).offset,high?1:0)<0) throw new Error(`GPIO write failed: ${pin}`);}
 read(pin:Pin) {const r=this.lines.get(pin); if(!r) throw new Error(`GPIO unbound: ${pin}`); const v=this.lib.gpiod_line_request_get_value(r,parsePin(pin).offset); if(v<0) throw new Error(`GPIO read failed: ${pin}`); return v===1;}
 close() {for(const r of this.lines.values()) this.lib.gpiod_line_request_release(r); this.lines.clear(); for(const c of this.chips.values()) this.lib.gpiod_chip_close(c); this.chips.clear();}
}
