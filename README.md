# JSMissile

A command-line app for controlling the **Dream Cheeky USB Missile Launcher** (Vendor ID `0x1941`, Product ID `0x8021`) from Node.js.

The launcher is a USB HID device: this app opens the device, sends 8-byte output reports to drive the motors, and reads the status reports the launcher sends back to detect the end-of-travel limits and the firing-cycle state. It is a TypeScript port of the author's Swift class for the same hardware.

## Software Freedom Day

This project was inspired by the Jacksonville Software Freedom day.

## Requirements

- macOS (the app uses `node-hid`, which wraps macOS IOKit)
- Node.js 20+
- The missile launcher plugged into a USB-A port

`node-hid` ships prebuilt binaries for common platforms. If it must compile from source, the Xcode Command Line Tools are required.

## Install

```sh
npm install
```

## Build

```sh
npm run build     # compile TypeScript to dist/
npm run typecheck # type-check without emitting
```

You can run in development directly from TypeScript with `npm run cli` (uses `tsx`); after a build you can also run `node dist/cli.js`.

## Usage

### Interactive mode

```sh
npm start
```

or

```sh
npm run cli
```

Once the launcher is connected, control it from the keyboard:

| Key                | Action                                       |
| ------------------ | -------------------------------------------- |
| Arrow keys / W A S D | Hold to move the launcher                      |
| Space / F          | Fire a missile (waits for the cycle to finish) |
| X                  | Stop all movement                            |
| Q / Ctrl-C         | Quit                                         |

Movement is hold-to-move: the launcher moves while the key is held and stops shortly after you release it (terminals do not emit key-up events, so release is detected when the OS key-repeat stops; see [Configuration](#configuration)). Movement also stops automatically at the launcher's end-of-travel limits.

### One-shot commands

```sh
npm run cli -- up 500      # move up for 500ms (or until the limit)
npm run cli -- down 250    # move down for 250ms
npm run cli -- left        # move left for the default 500ms
npm run cli -- right 500
npm run cli -- fire        # fire a missile and wait for the cycle
npm run cli -- stop        # stop all movement
npm run cli -- list        # detect and list Dream Cheeky devices
```

When no command is given the app launches into interactive mode. If the launcher is unplugged or resets mid-session, the app automatically reconnects (every ~500ms) so you don't have to restart it.

## Configuration

| Variable             | Default | Description                                                              |
| -------------------- | ------- | ------------------------------------------------------------------------ |
| `MISSILE_RELEASE_MS` | `250`   | How long to keep moving after the last key press before assuming release |

```sh
MISSILE_RELEASE_MS=150 npm start
```

Other tunables (write spacing, retries, reconnect backoff) are constants at the top of [`src/cannon.ts`](src/cannon.ts).

## How it works

- Opens the HID device `0x1941:0x8021` via `node-hid`.
- Output reports are 8 bytes, e.g. `up` is `[0x01, 0x02, 0, 0, 0, 0, 0, 0]`. `node-hid` treats the first byte of a write as the report ID, so the app prepends `0x00` and hidapi strips it off before the 8-byte report is issued.
- Every command generates an 8-byte status report (`data` events):
  - `status[1] & 0x80` — firing cycle in progress
  - `status[0] & 0x80` / `& 0x40` — up / down limit reached
  - `status[1] & 0x04` / `& 0x08` — left / right limit reached
- The launcher's firmware is slow, so writes are spaced, transient timeouts are retried silently, and fatal `device disconnected` errors trigger an automatic reconnect.

## Troubleshooting

- **"Missile launcher not found"** — make sure it's plugged in, then run `npm run cli -- list` and check the VID/PID (`0x1941:0x8021`).
- **"Cannot open ... I/O Timeout"** — the launcher was momentarily busy; writes are retried automatically. If problems persist, unplug and replug the launcher.
- **Movement doesn't stop when you release a key** — increase `MISSILE_RELEASE_MS` if your keyboard's key-repeat rate is slow.

## Disclaimer

This is a toy. Aim it at something soft, be careful, and — as the author put it — please do not shoot your eye out.

## License

[MIT](LICENSE)