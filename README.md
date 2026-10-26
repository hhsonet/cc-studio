# compiler-web

cc-studio: a small web IDE for C and C++. Write a multi-file project in the browser (Monaco editor,
file explorer), compile it with warnings shown inline, and run it in a live console: the program prints
a prompt, waits while you type, then continues. Code is compiled and run inside throwaway, locked-down
Docker containers. No database, no accounts, no build step.

- **Projects**: a project switcher at the top of the sidebar (create, rename, delete; up to 20). Each project
  has its own files, open file and folders, so two programs that each have a `main` live side by side.
  Everything is kept in your browser's localStorage.
- **Files**: a project explorer (new file, upload, download, delete). The open file's extension picks the
  language, and **only the sources in the open file's folder (subfolders included) are compiled and
  linked**, so `src/` and `src-2/` can each hold their own `main.c`. Files in other folders are still
  available for `#include` (the open file's folder is on the include path, and so is the project root).
- **Diagnostics**: compiler warnings and errors (`-Wall`) are parsed into a Diagnostics tab and drawn
  inline in the editor; click one to jump to it. Warnings are kept out of the Console (a clean build with
  warnings prints nothing from the compiler; a failed build prints only its errors) but always show up
  here and in the editor.
- **Console**: compiler output, the program's output and your input in one place. Type at `stdin ›`.
- **Friendly mode** (Settings, on by default): a plain-English hint under common compiler and linker
  errors ("You forgot a semicolon. Classic."), a note after crashes and limits (segfault, division by
  zero, runaway loops), a quip on the empty console, and a few easter eggs in the stdin box (`sudo`,
  `whoami`, `make coffee`, plus the real commands `ls` and `clear`). The easter eggs only trigger while
  no program is running, so a running program always receives exactly what you type. Turn it off for
  the raw compiler output. The hints live in `public/friendly.js` (one regex per message, unknown
  messages get no hint rather than a wrong one).
- **About**: type `about` (or the author's name: `sonet`, `hhs`, `hasan sonet`) in the stdin box, when no
  program is running, for a short card with a link to the author. The bottom bar always carries a "Built by ..." credit. Both read the `AUTHOR` constant at the top
  of `public/app.js`, which is the one place to change the name and link.
- **Format**: the **Format** button (or `Shift+Alt+F`, or right-click > Format Document) runs the real
  `clang-format`, compiled to WebAssembly and served from `public/vendor/clang-format/`, so nothing is sent to
  the server. It loads on first use (2.5 MB, then cached). It tidies spacing, braces and indentation, uses your
  Indent size and spaces only, and never folds short functions or `if`/`for` bodies onto one line. One undo
  step reverts it, and only the lines that change are touched, so your cursor stays put. Pick the style
  (LLVM, Google, GNU, Chromium, Mozilla, WebKit, Microsoft) in Settings. The page's CSP allows
  `'wasm-unsafe-eval'` for this (WebAssembly only, not JS `eval`).
- **Settings**: dark/light theme, four accent colors, the editor font size, **Auto indent** (on: smart
  indentation after `{`, `}` steps back; off: plain newlines) and **Indent size** (2, 4 or 8 spaces, used by
  Tab and auto indent), and Friendly mode. Changing them never rewrites code you already wrote. The Console
  has its own **Aa** button for its font size and text color.

```
browser ──HTTPS/WSS──▶ Caddy ──▶ Node/Express (:3000) ──docker run──▶ gcc container (per run)
```

## Local setup

Requires Node.js 20+ and Docker.

```bash
docker pull gcc:13                  # compiler image (override with RUNNER_IMAGE)
sudo usermod -aG docker "$USER"     # then log out and back in
npm install
cp .env.example .env                # optional
npm start
```

Open http://localhost:3000. The log should say `Runner ready (Docker image gcc:13)`.
`npm test` runs the test suite; it uses a fake runner and a fake `docker` binary, so it needs neither
Docker nor the image.

Membership in the `docker` group is root-equivalent for that user. Run the app as a dedicated
unprivileged user that does nothing else.

## Configuration

| Variable       | Default   | Purpose |
|----------------|-----------|---------|
| `PORT`         | `3000`    | Port the app listens on |
| `RUNNER_IMAGE` | `gcc:13`  | Docker image used to compile and run code (must already be pulled) |
| `TRUST_PROXY`  | *(on)*    | Per-IP limits use `X-Forwarded-For` when the connection comes from loopback (Caddy on the same host). Set to `false` if there is no proxy in front |
| `MAX_SESSIONS` | `200`     | Programs alive at once (most are just waiting for input, ~15 MB each) |
| `MAX_COMPILES` | cores - 1 | Container starts + compiles running at once; extra runs wait in line |
| `RUNS_PER_MINUTE` | `60`   | Runs per IP per minute (generous: a classroom or office can share one IP) |
| `CONNS_PER_IP` | `30`      | Simultaneous WebSocket connections per IP |

## How a run works

Each run gets **one** throwaway container (starting a container costs more than compiling, so one
per run roughly doubles throughput). A small shell wrapper compiles with `gcc`/`g++`, prints a marker
on stderr, then `exec`s the binary under `stdbuf` so output appears immediately even without a trailing
newline. The server uses the marker to tell compiler output from program output.

The container has no network, all capabilities dropped, `no-new-privileges`, a read-only root
filesystem, a non-root user, 192 MB of memory, 1 CPU and a 64-process limit. The source is mounted
read-only; the binary lives on a small tmpfs. The program gets 10 s of CPU time (waiting for your input
costs nothing). A run is also stopped after 5 minutes, after 60 s without input or output, or after 1 MB
of output. WebSocket upgrades from other origins are refused.

Keys: **Ctrl/Cmd+Enter** compiles and runs. In the stdin box: **Enter** sends a line, **Ctrl+C** stops
the program, **Ctrl+D** ends input, **↑/↓** recall earlier input. Lines typed before the program has
started are delivered as soon as it does.

## Capacity

Measured on an 8-core / 16 GB VM with a real Docker daemon:

- An idle program (waiting at an input prompt) costs about 15 MB and no CPU, so 200 simultaneous
  sessions use roughly 3 GB.
- Starting a container and compiling is the expensive part: the host sustains about **4 new runs per
  second** (load average near 7 of 8 cores). Raising `MAX_COMPILES` beyond cores - 1 does not help.
- 200 users each pressing Run once at a random moment over 60 s (about 3.3 runs/s): every run succeeded,
  median time to the first output 1.2 s, slowest 3.9 s.
- 200 users all pressing Run in the *same second*: every run succeeded, but they queue, so the median
  wait is about 25 s and the slowest about 50 s.

If you expect sustained load above roughly 4 runs per second, use a bigger VM or run a second instance
on another machine.

### WebSocket protocol (`/ws/run`)

Client to server (JSON): `{type:"run", language:"c"|"cpp", files:[{path, content}], entry}` (`entry` is the
open file: only the sources in its folder are compiled; at most 20 files,
64 KB in total; paths are relative, made of `A-Za-z0-9_.-/`, with a `.c .cpp .cc .cxx .h .hpp .hh .hxx
.txt` extension; `source_code` is accepted as shorthand for a single main file), `{type:"input", data}`,
`{type:"eof"}`, `{type:"kill"}`.

Server to client: `{type:"compile", text, ok}` (`ok:false`: the build failed, nothing runs; `ok:true`:
warnings only), `{type:"started"}`, `{type:"out", stream, data}`,
`{type:"exit", code, signal, reason, ms}`, `{type:"error", code, message}` where `code` is one of
`invalid`, `rate_limited`, `busy`, `unavailable`, `internal`.

## Deploy

On the VPS, put the app in e.g. `/opt/compiler-web`, run `npm ci --omit=dev`, create `.env`, and make
sure the service user is in the `docker` group and `docker pull gcc:13` has been done.

### Option A: pm2

```bash
sudo npm install -g pm2
cd /opt/compiler-web
pm2 start server.js --name compiler-web
pm2 save
pm2 startup        # run the command it prints, so the app restarts on boot
```

### Option B: systemd

`/etc/systemd/system/compiler-web.service`:

```ini
[Unit]
Description=compiler-web
After=network.target docker.service
Requires=docker.service

[Service]
WorkingDirectory=/opt/compiler-web
ExecStart=/usr/bin/node server.js
EnvironmentFile=/opt/compiler-web/.env
Restart=on-failure
User=compiler
SupplementaryGroups=docker
NoNewPrivileges=true
PrivateTmp=false
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

(`LimitNOFILE` is for 200 sessions, each holding several pipes and sockets. `PrivateTmp` stays off because the app writes each run's source to a temp dir that Docker must be able
to mount.)

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now compiler-web
journalctl -u compiler-web -f
```

### Caddy

`/etc/caddy/Caddyfile` (replace the domain; Caddy obtains the HTTPS certificate automatically and
proxies WebSockets without extra configuration):

```caddyfile
code.example.com {
    encode zstd gzip
    reverse_proxy localhost:3000
}
```

```bash
sudo systemctl reload caddy
```

## Layout

```
server.js            Express app: Helmet headers + static page; starts the HTTP and WebSocket server
lib/interactive.js   WebSocket /ws/run: protocol, per-IP limits, origin check
lib/runner.js        Docker runner: compile + run containers, limits, signals
lib/validate.js      request validation (language, file names, 20 files / 64 KB limits)
public/              index.html, app.js, friendly.js, format-config.js, style.css, fonts.css + fonts/ (self-hosted IBM Plex Sans and
                     JetBrains Mono, SIL OFL); Monaco is loaded from jsDelivr
tests/               node:test suite
```

## Notes

- The Content-Security-Policy allows scripts, styles and fonts from `cdn.jsdelivr.net`, `blob:` workers
  (Monaco needs them) and this host's `ws://`/`wss://` origin. If the CDN is unreachable the editor falls
  back to a plain textarea.
- Docker-based isolation is not as battle-tested as a dedicated judge such as Judge0 or isolate. Keep
  Docker and the kernel updated, and don't run anything else valuable as the same user.
