# CADdy Link

A small program that lets CADdy McCADFace send prints to your Bambu Lab printers and show what they are doing.

Browsers cannot open the kind of connection a Bambu printer uses (MQTT over TLS on port 8883, and FTPS on port 990, both with a self-signed certificate). CADdy Link does it for the app. It is optional: without it you can still slice and export a `.gcode.3mf` and print from an SD card or Bambu Studio.

It talks only to this computer (the app) and to printers on your own network. It never contacts Bambu Cloud or the internet.

## Install and run

1. Download the file for your system from the [releases page](https://github.com/WrathPak/caddy-mccadface/releases) (look for the `caddy-link-v...` release):
   - Windows: `caddy-link-windows-amd64.exe` (or `-arm64`)
   - macOS: `caddy-link-darwin-arm64` for Apple silicon, `caddy-link-darwin-amd64` for Intel
   - Linux: `caddy-link-linux-amd64` or `-arm64`
2. Run it. It opens a console window and prints a six digit pairing code. Leave the window open while you print.
   - Windows may show a SmartScreen warning because the file is not signed. Choose More info, then Run anyway.
   - macOS: if it is blocked, run `xattr -d com.apple.quarantine caddy-link-darwin-arm64` and `chmod +x` it, then start it from Terminal.
   - Linux: `chmod +x caddy-link-linux-amd64 && ./caddy-link-linux-amd64`
3. In CADdy McCADFace open the Print tab and choose Printers. Type the pairing code the first time. The app keeps a token, so you only do this once per browser.
4. Add your printer: pick it from the list if it was found, or type its IP address, serial number and access code.

Your browser may ask whether the site can connect to devices on your local network (Chrome calls it Local Network Access). Allow it, otherwise the app cannot reach CADdy Link.

## On the printer

Control from other programs needs LAN Only mode and Developer Mode:

1. On the printer's screen open Settings, then Network (WLAN).
2. Turn on LAN Only mode, then Developer Mode (the wording differs a little between models).
3. Note the IP address and the access code on the same screen. The serial number is under Settings, Device, or on the sticker.

Turning Developer Mode on or off changes the access code, so enter the new one in the app. Without Developer Mode some printers still show status but refuse to start a print. A storage card must be in the printer: files are stored on it before the print starts.

## Options

```
caddy-link [--port 47821] [--config-dir DIR] [--allow-origin https://example.com] [--mock] [--mock-speed 1] [--version]
```

- `--port`: the port on 127.0.0.1 (the app expects 47821; the app reads `localStorage['caddy.link.port']` for another one).
- `--config-dir`: where settings are kept. The default is `caddy-link` in your user config folder (`%AppData%` on Windows, `~/Library/Application Support` on macOS, `~/.config` on Linux).
- `--allow-origin`: also let this web page connect, for example a copy of the app you host yourself. Repeatable.
- `--mock`: run a fake printer with an AMS of four trays, so you can try everything without hardware. Discover finds it. Its access code is `12345678`.
- `--mock-speed`: how fast the fake printer prints. 1 is about a minute per plate.

## Security model

- The server listens on 127.0.0.1 only, so other computers cannot reach it, and it refuses requests whose Host is not a loopback name.
- Browsers do not enforce cross-origin rules for WebSockets, so the helper checks the `Origin` header itself. Only `https://wrathpak.github.io`, `http://localhost:*`, `http://127.0.0.1:*` and what you add with `--allow-origin` may connect. A connection with no origin is refused.
- The first connection from a browser must be paired: the helper prints a six digit code in its own window and the app asks you to type it. The helper then returns a long random token, which the app stores and sends on later connects. Only the hash of the token is kept on disk. Five wrong codes replace the code. After each successful pairing a new code is generated.
- Printer access codes are kept in `printers.json` in the settings folder (readable by your user only) and never go back to the browser.
- Printers use self-signed certificates. CADdy Link trusts the certificate on first use, pins its fingerprint, and refuses to connect if it changes later, with a message in the app. To trust a new certificate, remove the printer and add it again.
- Preflight requests from Chrome's Private Network Access are answered with `Access-Control-Allow-Private-Network: true` for allowed origins only.

## How it talks to the printer

- Status: MQTT 3.1.1 over TLS to port 8883, user `bblp`, the access code as the password. It subscribes to `device/<serial>/report`, sends `pushall` on connect and every five minutes, and merges the partial reports a P1 or A1 sends into one state.
- Printing: the `.gcode.3mf` goes over FTPS to port 990 (implicit TLS, the data channel resumes the control channel's TLS session as the printer requires), then `print.project_file` is published with the AMS mapping and options. The printer answers; a refusal or no answer is shown in the app with a reason.
- Discovery: SSDP on UDP 2021 (listening for the printers' announcements and sending an M-SEARCH). Discovery needs the printer on the same network segment as this computer, and your firewall may ask whether CADdy Link may listen on the private network the first time (needed to hear the printers' announcements; typing the IP address works without it).

## Build

```
cd helper
go build -o caddy-link .
go vet ./... && go test ./...
```

The tests run the helper against the built-in mock printer: pairing, adding a printer, status, sending a file over FTPS, starting the print, and pause, resume and stop. Pushing a tag named `caddy-link-vX.Y.Z` builds the binaries for Windows, macOS and Linux (amd64 and arm64) and attaches them to a release.

## License

AGPL-3.0, like the rest of the project.
