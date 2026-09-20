#!/usr/bin/env node
import readline from "node:readline";
import HID from "node-hid";
import { AirCannon, CannonDirection, PRODUCT_ID, VENDOR_ID, createAirCannon } from "./cannon.js";

const USAGE = `Usage:
  jsmissile                     Interactive keyboard control
  jsmissile list                List Dream Cheeky devices
  jsmissile <cmd> [ms]          One-shot command

Commands:
  up | down | left | right      Move in that direction for [ms] (default 500)
  fire                          Fire a missile and wait for the cycle to finish
  stop                          Stop all movement
`;

interface MoveKey {
  name: string;
  direction?: CannonDirection;
}

// How long (ms) to keep moving after the last key-down before assuming the key
// was released. macOS key repeat sends ~1 event per ~30-50ms while held, so this
// only fires once the repeated presses stop. Tune via MISSILE_RELEASE_MS.
const RELEASE_TIMEOUT_MS = Math.max(60, Number.parseInt(process.env.MISSILE_RELEASE_MS ?? "250", 10) || 250);

const COMMAND_DIRECTIONS: Record<string, CannonDirection> = {
  up: CannonDirection.Up,
  down: CannonDirection.Down,
  left: CannonDirection.Left,
  right: CannonDirection.Right,
};

function keyToDirection(name: string): CannonDirection | undefined {
  switch (name) {
    case "up":
    case "w":
      return CannonDirection.Up;
    case "down":
    case "s":
      return CannonDirection.Down;
    case "left":
    case "a":
      return CannonDirection.Left;
    case "right":
    case "d":
      return CannonDirection.Right;
    default:
      return undefined;
  }
}

function runInteractive(cannon: AirCannon): void {
  console.log("\nDream Cheeky Missile Launcher - interactive mode");
  console.log("  Arrows / W A S D  hold to move   Space / F  fire");
  console.log("  X                 stop           Q / Ctrl-C  quit\n");

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  let activeDirection: CannonDirection | null = null;
  let firing = false;
  // Terminals do not emit key-up events. While a key is held, the OS repeat
  // generates repeated key-down events, so we keep moving as long as presses
  // keep arriving and stop shortly after the last one (i.e. when released).
  let lastPressAt = 0;

  const beginMovement = (direction: CannonDirection): void => {
    lastPressAt = Date.now();
    if (activeDirection === direction) {
      return; // OS key repeat while the key is still held
    }
    if (!cannon.isConnected) {
      console.log("Launcher not connected; retrying...");
      return;
    }
    activeDirection = direction;
    cannon.startMoving(direction);
    console.log(`Moving ${direction}...`);
  };

  const releaseCheck = setInterval(() => {
    if (activeDirection === null || firing) return;
    if (Date.now() - lastPressAt > RELEASE_TIMEOUT_MS) {
      cannon.stopMoving();
      const stopped = activeDirection;
      activeDirection = null;
      console.log(`Stopped (${stopped} released).`);
    }
  }, 25);

  process.stdin.on("keypress", (_str: string, key: { name: string; ctrl: boolean } | undefined): void => {
    if (!key) return;

    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      exit(0);
      return;
    }

    if (key.name === "space" || key.name === "f" || key.name === "F") {
      if (firing) {
        console.log("Already firing...");
        return;
      }
      firing = true;
      console.log("Firing!");
      void cannon
        .fireAndWait()
        .catch((error: Error) => console.error(error.message))
        .finally(() => {
          firing = false;
          console.log("Firing cycle complete.");
        });
      return;
    }

    const direction = keyToDirection(key.name);
    if (direction) {
      if (firing) {
        console.log("Busy firing...");
        return;
      }
      beginMovement(direction);
      return;
    }

    if (key.name === "x" || key.name === "X") {
      clearInterval(releaseCheck);
      cannon.stopMoving();
      activeDirection = null;
      console.log("Stopped.");
    }
  });

  cannon.on("limit", (direction: CannonDirection) => {
    if (activeDirection === direction) activeDirection = null;
    console.log(`Limit reached for ${direction}; stopping.`);
  });

  cannon.on("error", (error: Error) => {
    if (/could not read from HID device/i.test(error.message)) {
      console.log("HID read hiccup; reconnecting...");
      return;
    }
    console.error(`Launcher error: ${error.message}`);
  });

  cannon.on("connected", () => {
    console.log("Launcher connected.");
  });

  const exit = (code: number): void => {
    clearInterval(releaseCheck);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    cannon.stopMoving();
    cannon.close();
    process.exit(code);
  };
  process.on("SIGINT", () => exit(130));
  process.on("SIGTERM", () => exit(143));
}

async function runCommand(cannon: AirCannon, args: string[]): Promise<void> {
  const [command, rawDuration] = args;
  const duration = rawDuration === undefined ? 500 : Math.max(0, Number.parseInt(rawDuration, 10));

  switch (command) {
    case "up":
    case "down":
    case "left":
    case "right": {
      const direction = COMMAND_DIRECTIONS[command];
      console.log(`Moving ${direction} for ${duration}ms (or until limit)...`);
      await cannon.moveSmart(direction, duration);
      console.log("Done.");
      break;
    }
    case "fire":
      console.log("Firing!");
      await cannon.fireAndWait();
      console.log("Firing cycle complete.");
      break;
    case "stop":
      cannon.stopMoving();
      console.log("Stopped.");
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error(USAGE);
      process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "list") {
    const matches = HID.devices(VENDOR_ID, PRODUCT_ID);
    if (matches.length === 0) {
      console.log("No Dream Cheeky launcher found.");
    } else {
      console.log("Dream Cheeky devices:");
      for (const device of matches) {
        console.log(`  vid=0x${device.vendorId.toString(16)} pid=0x${device.productId.toString(16)} path=${device.path ?? ""}`);
      }
    }
    return;
  }

  let cannon: AirCannon;
  try {
    cannon = createAirCannon();
    if (!cannon.isConnected) {
      console.error("Try: jsmissile list");
      process.exit(1);
    }
  } catch (error) {
    console.error((error as Error).message);
    console.error("Try: jsmissile list");
    process.exit(1);
  }

  if (args.length === 0) {
    runInteractive(cannon);
  } else {
    await runCommand(cannon, args);
    cannon.close();
  }
}

void main();