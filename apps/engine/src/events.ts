import { EventEmitter } from 'node:events';

export type BusEvent =
  | { type: 'agent'; agent: unknown }
  | { type: 'run'; run: unknown }
  | { type: 'run_event'; event: unknown }
  | { type: 'review'; review: unknown };

class Bus extends EventEmitter {
  publish(e: BusEvent): void {
    this.emit('event', e);
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
