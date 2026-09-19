import { EventEmitter } from "node:events";
import HID from "node-hid";

export const VENDOR_ID = 0x1941;
export const PRODUCT_ID = 0x8021;

export const enum ReportByte {
  Up = 0x01,
  Down = 0x02,
  Left = 0x04,
  Right = 0x08,
  Fire = 0x10,
  MoveSpeed = 0x02,
  StopSpeed = 0x00,
}

export enum CannonDirection {
  Up = "up",
  Down = "down",
  Left = "left",
  Right = "right",
}

interface DirectionConfig {
  command: number[];
  limitIndex: number;
  limitMask: number;
}

// Mirrors the Swift CannonDirection.limitConfig:
// .up -> (0, 0x80), .down -> (0, 0x40), .left -> (1, 0x04), .right -> (1, 0x08)
const DIRECTION_CONFIG: Record<CannonDirection, DirectionConfig> = {
  [CannonDirection.Up]: {
    command: [ReportByte.Up, ReportByte.MoveSpeed, 0, 0, 0, 0, 0, 0],
    limitIndex: 0,
    limitMask: 0x80,
  },
  [CannonDirection.Down]: {
    command: [ReportByte.Down, ReportByte.MoveSpeed, 0, 0, 0, 0, 0, 0],
    limitIndex: 0,
    limitMask: 0x40,
  },
  [CannonDirection.Left]: {
    command: [ReportByte.Left, ReportByte.MoveSpeed, 0, 0, 0, 0, 0, 0],
    limitIndex: 1,
    limitMask: 0x04,
  },
  [CannonDirection.Right]: {
    command: [ReportByte.Right, ReportByte.MoveSpeed, 0, 0, 0, 0, 0, 0],
    limitIndex: 1,
    limitMask: 0x08,
  },
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The launcher's firmware is slow: it must ACK each control-pipe SET_REPORT before
// accepting the next one. Sending reports faster than that yields IOHIDDeviceSetReport
// "I/O Timeout" errors, and hammering it can knock the USB device offline. This
// minimum spacing between writes keeps the device from getting overwhelmed.
const MIN_WRITE_INTERVAL_MS = 80;
const WRITE_RETRY_DELAY_MS = 200;
const MAX_WRITE_RETRIES = 2;
const RECONNECT_BACKOFF_MS = 500;

export class AirCannon extends EventEmitter {
  private device: HID.HID | null = null;
  private lastStatus: Uint8Array = new Uint8Array(8);
  // Serial writes, equivalent to the Swift hidWriteQueue so reports never overlap.
  private writeChain: Promise<void> = Promise.resolve();
  // Equivalent of the Swift movementQueue/activeMovementID guard.
  private activeMovementId: symbol | null = null;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnecting = false;
  private hasEverConnected = false;

  constructor() {
    super();
    this.connect();
  }

  get isConnected(): boolean {
    return this.device !== null;
  }

  private connect(): void {
    const matches = HID.devices(VENDOR_ID, PRODUCT_ID);
    if (matches.length === 0) {
      if (!this.hasEverConnected) {
        this.hasEverConnected = true;
        this.emit("error", new Error(`Missile launcher (${VENDOR_ID.toString(16)}:${PRODUCT_ID.toString(16)}) not found. Is it plugged in?`));
      }
      this.scheduleReconnect();
      return;
    }

    try {
      this.device = new HID.HID(VENDOR_ID, PRODUCT_ID);
    } catch (error) {
      if (!this.hasEverConnected) {
        this.hasEverConnected = true;
        this.emit("error", new Error(`Failed to open missile launcher: ${(error as Error).message}`));
      }
      this.scheduleReconnect();
      return;
    }

    this.hasEverConnected = true;
    this.device.on("data", (data: Buffer) => {
      this.lastStatus = new Uint8Array(data);
      this.emit("status", this.lastStatus);
    });
    this.device.on("error", (error: Error) => {
      this.emit("error", error);
      this.handleDeviceError(error);
    });
    this.lastStatus = new Uint8Array(8);
    this.emit("connected");
  }

  // A write/read failure does not necessarily mean the launcher is gone: transient
  // control-pipe errors are handled by spacing writes, but once the read thread
  // dies (node-hid stops reading permanently after a single hid_read_timeout
  // error, and writes then fail with "Device is disconnected") this device object
  // is unusable no matter what. In that case tear down and re-open so a reset or
  // replugged launcher keeps working; re-opening also restarts the read thread.
  private handleDeviceError(error: Error): void {
    if (this.closed || this.reconnecting) return;

    const message = error.message;
    const fatal = /disconnected|offline|not ready|disconnect|could not read|error waiting for more data/i.test(message);
    if (!fatal) return;

    this.reconnecting = true;
    this.teardownDevice();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => void this.reconnect(), RECONNECT_BACKOFF_MS);
  }

  private async reconnect(): Promise<void> {
    this.reconnectTimer = null;
    if (this.closed) return;

    try {
      this.connect();
    } finally {
      this.reconnecting = false;
    }
  }

  private teardownDevice(): void {
    if (this.device) {
      this.device.removeAllListeners();
      try {
        this.device.close();
      } catch {
        // ignore
      }
      this.device = null;
    }
  }

  // MARK: - Status

  getStatus(): Uint8Array {
    return this.lastStatus;
  }

  private getStatusByte(index: number): number {
    return index < this.lastStatus.length ? this.lastStatus[index] : 0;
  }

  // Equivalent of Swift isFiringInProgress: (status[1] & 0x80) != 0
  get isFiringInProgress(): boolean {
    return (this.getStatusByte(1) & 0x80) !== 0;
  }

  // Equivalent of Swift isLimitReached(for:)
  isLimitReached(direction: CannonDirection): boolean {
    const config = DIRECTION_CONFIG[direction];
    return (this.getStatusByte(config.limitIndex) & config.limitMask) !== 0;
  }

  // MARK: - Sending commands

  private send(report: number[]): void {
    this.writeChain = this.writeChain
      .then(() => sleep(MIN_WRITE_INTERVAL_MS))
      .then(() => {
        if (this.device) {
          // node-hid treats the first byte as the report ID. This device does not
          // use numbered reports, so prepend 0x00 and hidapi/macOS strips it back
          // off before issuing the 8-byte output report.
          this.device!.write([0x00, ...report]);
        }
      })
      .catch((error: Error) => this.handleWriteError(report, error));
  }

  // node-hid throws synchronously when a write fails. Transient timeouts (the
  // launcher busy ACKing the previous report) are silently retried up to
  // MAX_WRITE_RETRIES times; anything worse is surfaced and may trigger reconnect.
  private handleWriteError(report: number[], error: Error, attempts = 0): void {
    const retryable = /timeout|not ready|unknown/i.test(error.message);
    if (retryable && attempts < MAX_WRITE_RETRIES && !this.closed && this.device) {
      this.writeChain = this.writeChain
        .then(() => sleep(WRITE_RETRY_DELAY_MS))
        .then(() => {
          if (this.device) {
            this.device!.write([0x00, ...report]);
          }
        })
        .catch((retryError: Error) => this.handleWriteError(report, retryError, attempts + 1));
      return;
    }

    this.emit("error", error);
    this.handleDeviceError(error);
  }

  stop(): void {
    this.send([0, 0, 0, 0, 0, 0, 0, 0]);
  }

  up(): void {
    this.send(DIRECTION_CONFIG[CannonDirection.Up].command);
  }

  down(): void {
    this.send(DIRECTION_CONFIG[CannonDirection.Down].command);
  }

  left(): void {
    this.send(DIRECTION_CONFIG[CannonDirection.Left].command);
  }

  right(): void {
    this.send(DIRECTION_CONFIG[CannonDirection.Right].command);
  }

  fire(): void {
    this.send([ReportByte.Fire, ReportByte.MoveSpeed, 0, 0, 0, 0, 0, 0]);
  }

  // MARK: - Movement with limit monitoring

  startMoving(direction: CannonDirection): void {
    if (this.isLimitReached(direction)) {
      this.emit("limit", direction);
      this.stopMoving();
      return;
    }

    this.activeMovementId = Symbol("movement");
    this.move(direction);
    this.monitorLimit(direction, this.activeMovementId);
  }

  stopMoving(): void {
    this.activeMovementId = null;
    this.stop();
  }

  private move(direction: CannonDirection): void {
    switch (direction) {
      case CannonDirection.Up:
        this.up();
        break;
      case CannonDirection.Down:
        this.down();
        break;
      case CannonDirection.Left:
        this.left();
        break;
      case CannonDirection.Right:
        this.right();
        break;
    }
  }

  private monitorLimit(direction: CannonDirection, movementId: symbol): void {
    const run = async (): Promise<void> => {
      while (this.activeMovementId === movementId && this.device !== null) {
        if (this.isLimitReached(direction)) {
          this.emit("limit", direction);
          this.stopMoving();
          return;
        }
        await sleep(5);
      }
    };
    run().catch((error: Error) => {
      this.emit("error", error);
    });
  }

  // Equivalent of Swift moveSmart(direction:duration:) - move for a duration or
  // until a limit is hit, then stop. Resolves once stopped.
  async moveSmart(direction: CannonDirection, durationMs: number): Promise<void> {
    this.move(direction);

    const startTime = Date.now();
    while (Date.now() - startTime < durationMs) {
      if (this.device === null) return;
      if (this.isLimitReached(direction)) {
        this.emit("limit", direction);
        break;
      }
      await sleep(5);
    }

    this.stop();
  }

  // Equivalent of Swift fireAndWait(completion:) - fire, wait for the pump
  // motor to start (status bit set), wait for it to return home (bit cleared),
  // then stop. Resolves once the firing cycle completes.
  async fireAndWait(): Promise<void> {
    this.fire();

    // Wait for the motor to start moving (the bit becomes 1)
    while (!this.isFiringInProgress) {
      if (this.device === null) return;
      await sleep(10);
    }

    // Wait for the motor to return home (the bit becomes 0)
    while (this.isFiringInProgress) {
      if (this.device === null) return;
      await sleep(10);
    }

    this.stop();
    this.emit("fired");
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownDevice();
  }
}