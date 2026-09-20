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
// A dead read thread does not mean the device is gone (macOS hidapi's
// pthread_cond_timedwait can return EINTR when Node handles a signal such as
// SIGWINCH). When the USB device is still enumerated, recovery can be instant.
const RECONNECT_READ_HICCUP_MS = 120;

interface CannonEvents {
  error: (error: Error) => void;
  status: (status: Uint8Array) => void;
  connected: () => void;
  limit: (direction: CannonDirection) => void;
  fired: () => void;
}

// Minimal typed emitter; an alternative to inheriting from EventEmitter that
// keeps the same on()/emit() API for the cannon's own events.
function createEmitter(): {
  on<K extends keyof CannonEvents>(event: K, listener: CannonEvents[K]): void;
  emit<K extends keyof CannonEvents>(event: K, ...args: Parameters<CannonEvents[K]>): void;
} {
  const listeners: { [K in keyof CannonEvents]?: CannonEvents[K][] } = {};
  return {
    on: (event: keyof CannonEvents, listener: CannonEvents[keyof CannonEvents]): void => {
      const bucket = (listeners[event] as CannonEvents[keyof CannonEvents][] | undefined) ??= [];
      bucket.push(listener as CannonEvents[typeof event]);
    },
    emit: (event: keyof CannonEvents, ...args: any[]): void => {
      (listeners[event] as ((...args: any[]) => void)[] | undefined)?.forEach((listener) => listener(...args));
    },
  };
}

export interface AirCannon {
  readonly isConnected: boolean;
  readonly isFiringInProgress: boolean;
  getStatus(): Uint8Array;
  isLimitReached(direction: CannonDirection): boolean;
  stop(): void;
  up(): void;
  down(): void;
  left(): void;
  right(): void;
  fire(): void;
  startMoving(direction: CannonDirection): void;
  stopMoving(): void;
  moveSmart(direction: CannonDirection, durationMs: number): Promise<void>;
  fireAndWait(): Promise<void>;
  close(): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "status", listener: (status: Uint8Array) => void): void;
  on(event: "connected", listener: () => void): void;
  on(event: "limit", listener: (direction: CannonDirection) => void): void;
  on(event: "fired", listener: () => void): void;
}

// Factory-function alternative to `export class AirCannon extends EventEmitter`.
// Private state lives in closures instead of `this`/fields, and events use the
// embedded emitter above instead of inheritance.
export function createAirCannon(): AirCannon {
  let device: HID.HID | null = null;
  let lastStatus: Uint8Array = new Uint8Array(8);
  // Serial writes, equivalent to the Swift hidWriteQueue so reports never overlap.
  let writeChain: Promise<void> = Promise.resolve();
  // Equivalent of the Swift movementQueue/activeMovementID guard.
  let activeMovementId: symbol | null = null;
  let closed = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnecting = false;
  let hasEverConnected = false;
  const { on, emit } = createEmitter();

  function connect(): void {
    const matches = HID.devices(VENDOR_ID, PRODUCT_ID);
    if (matches.length === 0) {
      if (!hasEverConnected) {
        hasEverConnected = true;
        emit("error", new Error(`Missile launcher (${VENDOR_ID.toString(16)}:${PRODUCT_ID.toString(16)}) not found. Is it plugged in?`));
      }
      scheduleReconnect();
      return;
    }

    try {
      device = new HID.HID(VENDOR_ID, PRODUCT_ID);
    } catch (error) {
      if (!hasEverConnected) {
        hasEverConnected = true;
        emit("error", new Error(`Failed to open missile launcher: ${(error as Error).message}`));
      }
      scheduleReconnect();
      return;
    }

    hasEverConnected = true;
    device.on("data", (data: Buffer) => {
      lastStatus = new Uint8Array(data);
      emit("status", lastStatus);
    });
    device.on("error", (error: Error) => {
      emit("error", error);
      handleDeviceError(error);
    });
    lastStatus = new Uint8Array(8);
    emit("connected");
  }

  // A write/read failure does not necessarily mean the launcher is gone: transient
  // control-pipe errors are handled by spacing writes, but once the read thread
  // dies (node-hid stops reading permanently after a single hid_read_timeout
  // error, and writes then fail with "Device is disconnected") this device object
  // is unusable no matter what. In that case tear down and re-open so a reset or
  // replugged launcher keeps working; re-opening also restarts the read thread.
  function handleDeviceError(error: Error): void {
    if (closed || reconnecting) return;

    const message = error.message;
    const fatal = /disconnected|offline|not ready|disconnect|could not read|error waiting for more data/i.test(message);
    if (!fatal) return;

    // If the read thread just died ("could not read...") the device is almost
    // certainly still present. Stop the motors before closing the handle so a
    // movement in progress doesn't keep driving into a limit during recovery.
    if (/could not read|error waiting for more data/i.test(message)) {
      activeMovementId = null;
      try {
        device?.write([0x00, 0, 0, 0, 0, 0, 0, 0, 0]); // stop
      } catch {
        // ignore; the handle is about to be torn down
      }
    }

    reconnecting = true;
    teardownDevice();
    scheduleReconnect(/could not read|error waiting for more data/i.test(message) ? RECONNECT_READ_HICCUP_MS : RECONNECT_BACKOFF_MS);
  }

  function scheduleReconnect(delayMs = RECONNECT_BACKOFF_MS): void {
    if (closed || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => void reconnect(), delayMs);
  }

  async function reconnect(): Promise<void> {
    reconnectTimer = null;
    if (closed) return;

    try {
      connect();
    } finally {
      reconnecting = false;
    }
  }

  function teardownDevice(): void {
    if (device) {
      device.removeAllListeners();
      try {
        device.close();
      } catch {
        // ignore
      }
      device = null;
    }
  }

  // MARK: - Status

  function getStatusByte(index: number): number {
    return index < lastStatus.length ? lastStatus[index] : 0;
  }

  function isLimitReached(direction: CannonDirection): boolean {
    const config = DIRECTION_CONFIG[direction];
    return (getStatusByte(config.limitIndex) & config.limitMask) !== 0;
  }

  // MARK: - Sending commands

  // node-hid throws synchronously when a write fails. Transient timeouts (the
  // launcher busy ACKing the previous report) are silently retried up to
  // MAX_WRITE_RETRIES times; anything worse is surfaced and may trigger reconnect.
  function handleWriteError(report: number[], error: Error, attempts = 0): void {
    const retryable = /timeout|not ready|unknown/i.test(error.message);
    if (retryable && attempts < MAX_WRITE_RETRIES && !closed && device) {
      writeChain = writeChain
        .then(() => sleep(WRITE_RETRY_DELAY_MS))
        .then(() => {
          if (device) {
            device!.write([0x00, ...report]);
          }
        })
        .catch((retryError: Error) => handleWriteError(report, retryError, attempts + 1));
      return;
    }

    emit("error", error);
    handleDeviceError(error);
  }

  function send(report: number[]): void {
    writeChain = writeChain
      .then(() => sleep(MIN_WRITE_INTERVAL_MS))
      .then(() => {
        if (device) {
          // node-hid treats the first byte as the report ID. This device does not
          // use numbered reports, so prepend 0x00 and hidapi/macOS strips it back
          // off before issuing the 8-byte output report.
          device!.write([0x00, ...report]);
        }
      })
      .catch((error: Error) => handleWriteError(report, error));
  }

  // MARK: - Movement with limit monitoring

  function stopMoving(): void {
    activeMovementId = null;
    stop();
  }

  function startMoving(direction: CannonDirection): void {
    if (isLimitReached(direction)) {
      emit("limit", direction);
      stopMoving();
      return;
    }

    activeMovementId = Symbol("movement");
    move(direction);
    monitorLimit(direction, activeMovementId);
  }

  function move(direction: CannonDirection): void {
    switch (direction) {
      case CannonDirection.Up:
        up();
        break;
      case CannonDirection.Down:
        down();
        break;
      case CannonDirection.Left:
        left();
        break;
      case CannonDirection.Right:
        right();
        break;
    }
  }

  function monitorLimit(direction: CannonDirection, movementId: symbol): void {
    const run = async (): Promise<void> => {
      while (activeMovementId === movementId && device !== null) {
        if (isLimitReached(direction)) {
          emit("limit", direction);
          stopMoving();
          return;
        }
        await sleep(5);
      }
    };
    run().catch((error: Error) => {
      emit("error", error);
    });
  }

  // Equivalent of Swift moveSmart(direction:duration:) - move for a duration or
  // until a limit is hit, then stop. Resolves once stopped.
  async function moveSmart(direction: CannonDirection, durationMs: number): Promise<void> {
    move(direction);

    const startTime = Date.now();
    while (Date.now() - startTime < durationMs) {
      if (device === null) return;
      if (isLimitReached(direction)) {
        emit("limit", direction);
        break;
      }
      await sleep(5);
    }

    stop();
  }

  // Equivalent of Swift fireAndWait(completion:) - fire, wait for the pump
  // motor to start (status bit set), wait for it to return home (bit cleared),
  // then stop. Resolves once the firing cycle completes.
  async function fireAndWait(): Promise<void> {
    fire();

    // Wait for the motor to start moving (the bit becomes 1)
    while (!firingInProgress()) {
      if (device === null) return;
      await sleep(10);
    }

    // Wait for the motor to return home (the bit becomes 0)
    while (firingInProgress()) {
      if (device === null) return;
      await sleep(10);
    }

    stop();
    emit("fired");
  }

  function close(): void {
    closed = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    teardownDevice();
  }

  function getStatus(): Uint8Array {
    return lastStatus;
  }

  function stop(): void {
    send([0, 0, 0, 0, 0, 0, 0, 0]);
  }

  function up(): void {
    send(DIRECTION_CONFIG[CannonDirection.Up].command);
  }

  function down(): void {
    send(DIRECTION_CONFIG[CannonDirection.Down].command);
  }

  function left(): void {
    send(DIRECTION_CONFIG[CannonDirection.Left].command);
  }

  function right(): void {
    send(DIRECTION_CONFIG[CannonDirection.Right].command);
  }

  function fire(): void {
    send([ReportByte.Fire, ReportByte.MoveSpeed, 0, 0, 0, 0, 0, 0]);
  }

  function firingInProgress(): boolean {
    return (getStatusByte(1) & 0x80) !== 0;
  }

  connect();

  return {
    get isConnected(): boolean {
      return device !== null;
    },
    get isFiringInProgress(): boolean {
      return firingInProgress();
    },
    getStatus,
    isLimitReached,
    stop,
    up,
    down,
    left,
    right,
    fire,
    startMoving,
    stopMoving,
    moveSmart,
    fireAndWait,
    close,
    on,
  };
}