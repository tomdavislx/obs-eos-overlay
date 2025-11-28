/**
 * Type definitions for the OSC library since @types/osc doesn't exist
 */

declare module 'osc' {
  export interface OSCArgument {
    type: string;
    value: any;
  }

  export interface OSCMessage {
    address: string;
    args: OSCArgument[];
    origin: {
      address: string;
      family: string;
      port: number;
      size: number;
    };
    timeTag?: {
      raw: [number, number];
      native: number;
    };
  }

  export interface UDPPortOptions {
    localAddress: string;
    localPort: number;
    metadata?: boolean;
  }

  export class UDPPort extends NodeJS.EventEmitter {
    constructor(options: UDPPortOptions);
    open(): void;
    close(): void;
    on(event: 'ready', listener: () => void): this;
    on(event: 'message', listener: (message: OSCMessage) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
  }
}