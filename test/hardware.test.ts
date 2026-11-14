import {test,expect} from 'bun:test';
import {MockGpio,parsePin} from '../src/gpio';
import {GpioRelay,MockRelay,Pump} from '../src/pump';
import {Stepper,MOTOR_PINS} from '../src/stepper';
import {Manual} from '../src/manual';
test('pin offsets',()=>{expect(parsePin('GPIO1_C6')).toEqual({bank:1,offset:22,global:54});});
test('relay boot-off and timeout',async()=>{const io=new MockGpio();const relay=new GpioRelay(io,'GPIO1_C6',false);expect(io.values.get('GPIO1_C6')).toBe(true);const pump=new Pump(relay,{minPulseMs:5,maxPulseMs:100,maxContinuousMs:20});pump.start();expect(pump.on).toBe(true);await Bun.sleep(35);expect(pump.on).toBe(false);expect(io.values.get('GPIO1_C6')).toBe(true);pump.close();});
test('estop force disables untouched drivers and pump',()=>{const io=new MockGpio();const yaw=new Stepper(io,MOTOR_PINS.yaw);const pitch=new Stepper(io,MOTOR_PINS.pitch);const relay=new MockRelay();const pump=new Pump(relay);const manual=new Manual({yaw,pitch},pump,io);manual.enable(true);pump.start();manual.estop();expect(io.values.get(MOTOR_PINS.yaw.en)).toBe(true);expect(io.values.get(MOTOR_PINS.pitch.en)).toBe(true);expect(relay.on).toBe(false);});
test('step cap',async()=>{const io=new MockGpio();const m=new Stepper(io,MOTOR_PINS.yaw,{maxRate:1000,acceleration:10000,pulseUs:10,maxSteps:2});m.enable();expect(m.move(1,3,100)).rejects.toThrow();});
