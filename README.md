# cc-studio

**Write, compile and run C and C++ in your browser, with a live console.** Your program prints a prompt,
waits while you type, and carries on, like a real terminal. Code is compiled and run in throwaway,
locked-down Docker containers.

![cc-studio running a two-file C program that asks for input](docs/screenshot.png)

- Works with **no accounts and no database**: your files live in your browser's localStorage.
- Add **Postgres** and you also get accounts, files saved to the cloud, teachers and classes, GitHub push and
  pull, and an admin dashboard. Every one of those is optional.
- A small Node server runs each program in its own sandbox and streams the input and output over a WebSocket.
- Built to be shown to other people: it can serve a classroom of about 200 at once on a modest VPS.

## Contents

[Features](#features) · [Quick start](#quick-start) · [Using the app](#using-the-app) ·
[Accounts, classes and GitHub](#accounts-classes-and-github) · [Admin dashboard](#admin-dashboard) ·
[Configuration](#configuration) · [How it works](#how-it-works) · [Security](#security-model-and-limits) ·
[Capacity](#capacity) · [Deployment](#deployment) · [HTTP API](#http-api) · [WebSocket protocol](#websocket-protocol) ·
[Project layout](#project-layout) · [Development](#development) · [Credits](#credits)

## Features

**Editor and files**
- Monaco editor (the editor from VS Code) with C, C++ and Markdown highlighting, in dark or light, four accent colors.
- A file explorer: new file, upload, download, delete, nested folders. Several files per program,
  headers included. File types: `.c .cpp .cc .cxx .h .hpp .hh .hxx .txt .md`.
- **Only the open file's folder is built.** Open `src/main.c` and the `.c` files under `src/` are compiled
  and linked; `src-2/` can have its own `main.c` and be run on its own. Files in other folders are still
  available to `#include`.
- **Format** button (`Shift+Alt+F`): the real `clang-format`, compiled to WebAssembly and run in your
  browser, so nothing is sent anywhere. Choose LLVM, Google, GNU, Chromium, Mozilla, WebKit or Microsoft style.
  One undo step reverts it.
- **Auto indent** on or off, and an **indent size** of 2, 4 or 8 spaces.

**Running**
- A real interactive console: output appears as it is printed (even a prompt with no newline), and what you
  type goes to the program's stdin. `Ctrl+C` stops it, `Ctrl+D` ends the input.
- Compiler warnings and errors (`-Wall`) are parsed into a **Diagnostics** tab and drawn inline in the editor.
  The console stays clean: a build with warnings prints nothing from the compiler, a failed build prints
  just its errors.

![Diagnostics: an error with a friendly hint, and a warning drawn inline in the editor](docs/screenshot-diagnostics.png)

**Friendly mode** (on by default, in Settings)
- A plain-English hint under common compiler and linker errors (*"You forgot a semicolon. Classic."*) and a
  note after crashes and limits (a segfault, a division by zero, a runaway loop).
- A quip on the empty console, a few easter eggs in the stdin box, and a build counter and streak in the
  bottom bar. Turn it off for the raw output.

**Comfort**
- **Resizable columns:** drag the dividers between Files, the editor and the console panel. Double-click a
  divider to reset it; the arrow keys work too. The editor never gets narrower than 280 px, and your widths
  are remembered.
- Collapsible sidebar and panel (they shrink to a slim rail), and a separate font size and text color for
  the console.
- Works on a phone-sized screen; if the editor library can't load, a plain textarea takes over.

**With a database (optional)**
- Log in with email and password, a username, or GitHub, and your files follow you to any device.
- Teachers and students: classes with a join code, starter code, shared programs, a roster, and a read-only
  view of a student's work.
- Push and pull one GitHub repository from the editor, and see its recent commits in a **Git** tab.
- An admin dashboard for the super admin.

## Quick start

You need **Node.js 20+** and **Docker**.

```bash
git clone https://github.com/hhsonet/cc-studio.git
cd cc-studio

docker pull gcc:13                  # the compiler image the sandboxes use
sudo usermod -aG docker "$USER"     # let your user run docker, then log out and back in

npm install
npm start
```

Open <http://localhost:3000>. The log should say `Runner ready (Docker image gcc:13)`. Press **Compile**.

If Docker isn't usable, the app still starts, but **Compile** answers "The code runner failed to start" or
"Interactive mode is not available". Run `docker image inspect gcc:13` as the same user to check.

> Being in the `docker` group is equivalent to root access for that user. Run cc-studio as a dedicated,
> unprivileged user on a machine that has nothing else valuable on it.

That is the whole setup for the no-accounts version. To turn on accounts and the rest, see
[Accounts, classes and GitHub](#accounts-classes-and-github).

## Using the app

| Key | Does |
|-----|------|
| `Ctrl/Cmd + Enter` | Compile and run |
| `Shift + Alt + F` | Format the open file |
| `Enter` (in `stdin ›`) | Send a line of input |
| `Ctrl + C` (in `stdin ›`) | Stop the running program |
| `Ctrl + D` (in `stdin ›`) | End of input (EOF) |
| `↑` / `↓` (in `stdin ›`) | Earlier inputs |
| `←` / `→` (on a column divider) | Resize it (`Shift` for bigger steps) |
| `Esc` | Close a menu |

Input typed before the program has started is delivered as soon as it does.

**Console commands** (type them at `stdin ›` while no program is running; a running program always
receives exactly what you type):

| Command | Does |
|---------|------|
| `about` (also `sonet`, `hhs`, `hasan sonet`) | Shows the author card |
| `ls` | Lists your files |
| `clear` | Clears the console |
| `help` | Lists these, plus a few jokes (`sudo`, `whoami`, `make coffee`, ...) |

**Settings** (the avatar at the bottom of the sidebar): theme, accent color, editor font size, auto indent,
indent size, format style and Friendly mode. The **Aa** button in the console sets its own font size and
text color. Changing a setting never rewrites code you already wrote.

## Accounts, classes and GitHub

Everything in this section needs a Postgres database. Without `DATABASE_URL` the app runs exactly as before
and none of these buttons appear.

### Turn it on

```bash
# a database for cc-studio (any recent Postgres works; this one is local to the machine)
docker run -d --name cc-studio-db --restart unless-stopped \
  -e POSTGRES_USER=ccstudio -e POSTGRES_PASSWORD='choose-a-password' -e POSTGRES_DB=ccstudio \
  -p 127.0.0.1:5433:5432 -v cc-studio-pgdata:/var/lib/postgresql/data postgres:16

openssl rand -base64 32             # a key for encrypting stored secrets (GitHub tokens)
```

Put these in `.env`, then start the app. The tables are created on start-up.

```ini
DATABASE_URL=postgres://ccstudio:choose-a-password@127.0.0.1:5433/ccstudio
TOKEN_ENCRYPTION_KEY=<the output of openssl rand -base64 32>
```

Create the first account, the **super admin** (the password comes from the environment so it never lands in
shell history or `ps`):

```bash
ADMIN_PASSWORD='a-long-password' node scripts/create-superadmin.js admin
```

Run it again for the same username to reset that account's password.

### Accounts

- **Sign up** with an email and a password of at least 8 characters. **Log in** with the email or a username.
- Passwords are hashed with scrypt. A login is a random token in an `httpOnly`, `SameSite=Lax` cookie (30 days);
  only its SHA-256 is stored.
- **Cloud files:** while you are logged in, your files are saved to your account a moment after you stop
  typing and loaded on any device. One workspace per account: up to 200 files, 64 KB per file, 2 MB in total.
  If your browser and your account differ at login, you choose which wins.
- **Profile:** your details, change password, and your GitHub connection.

### Roles

| Role | Can |
|------|-----|
| **Student** (everyone starts here) | Join classes, copy the starter code and shared programs |
| **Teacher** (promoted by the super admin) | Everything above, plus create classes, hand out code, manage the roster and see their students' work |
| **Super admin** | Everything, plus the [admin dashboard](#admin-dashboard) |

### Classes

- A teacher makes a class on the **Classes** page and gets a 7-character **join code**. Students enter the
  code once.
- **Assignments:** save a folder of your own files, then add it as an assignment. A student clicks **Get
  starter code** and gets their own copy in a folder of their files. If that folder already exists they are
  asked before it is replaced. Later changes to your files do not change copies already handed out.
- **Share a program:** the **Share** button in the editor sends the open file to a class in one step.
- **Roster:** reset a student's password (they are signed out everywhere) or remove them from the class.
  Removing a student does not delete their files.
- **View and run a student's code:** the roster opens the student's files in the editor as a **read-only
  copy**. You can run and edit it, but nothing is saved, neither in your browser nor to your account.
- A teacher can only see students who are in one of their own classes.

### GitHub

Link one repository to your profile, then push and pull it from the editor.

- **Pull** (one click in the top bar) brings the repository's source, header, text and Markdown files into a
  folder with the repository's name. Files with the same name are replaced (you are asked first if yours differ); files
  that only exist in cc-studio are kept.
- **Push** commits that folder to the repository's default branch as one commit, with your message. Only the
  repository's own folder is ever pushed.
- The **Git** tab next to Console lists the repository's last 20 commits, and every push or pull also writes
  a line in the Console.
- **Sign in with GitHub:** "Continue with GitHub" in the login dialog. It asks GitHub only for your public
  profile. A new GitHub user gets a student account named after their GitHub username (with a suffix if the
  name is taken); it never merges into an existing account by name or email. A GitHub account is tied to one
  cc-studio account by its numeric id, and a password account becomes reachable through GitHub only after it
  has connected that GitHub account in its profile.
- Connecting for push and pull asks for the `public_repo` permission (public repositories). Set
  `GITHUB_SCOPE=repo`, or choose it on the admin page, to allow private repositories too.

**Setting up GitHub** (once, by the super admin):

1. At <https://github.com/settings/applications/new> create an **OAuth App** (not a GitHub App: a GitHub App's
   token cannot create repositories and has to be installed on every repository). Set the homepage URL to
   your public address and the **Authorization callback URL** to
   `https://<your address>/api/github/oauth/callback`.
2. Tick **Enable Device Flow** if you want the typed-code fallback, and **Generate a new client secret**.
3. Open the [admin dashboard](#admin-dashboard) → **GitHub settings**, enter the public address, Client ID and
   client secret, and click **Save**. It applies right away, with no restart.

With a client secret, users get GitHub's normal **Authorize** page. Without one, GitHub login falls back to
typing a short code on github.com. Stored GitHub tokens are encrypted with `TOKEN_ENCRYPTION_KEY`; if you
change that key, everyone has to connect GitHub again.

## Admin dashboard

`/admin.html`, for the super admin only. It shares a sidebar and top bar with the Classes and Profile pages,
and the account menu has a Light and Dark switch.

| Page | What it does |
|------|--------------|
| **Overview** | Accounts, classes, assignments, signed-in sessions, database size, the newest accounts, and what needs attention (for example GitHub not set up) |
| **Users** | Search and filter everyone; change a role between student and teacher; reset a password; delete an account. Super admin accounts are protected |
| **All classes** | Every class on the server with its teacher, size and join code; delete any class |
| **GitHub settings** | The public address, Client ID, client secret (stored encrypted, never shown again) and permission. A button asks GitHub whether it knows the Client ID |

## Configuration

Copy `.env.example` to `.env`, or set the variables in the environment. All are optional.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | Port the server listens on (a reverse proxy such as Caddy forwards to it) |
| `RUNNER_IMAGE` | `gcc:13` | Docker image used to compile and run code. It must already be pulled |
| `TRUST_PROXY` | on | The per-IP limits and secure cookies believe `X-Forwarded-For` and `X-Forwarded-Proto` when the connection comes from loopback (a reverse proxy on the same host). Set to `false` if nothing is in front of the app |
| `MAX_SESSIONS` | `200` | Programs alive at once. Most are just waiting for input, about 15 MB each |
| `MAX_COMPILES` | cores - 1 | Container starts and compiles running at once; the rest wait in line |
| `RUNS_PER_MINUTE` | `60` | Runs per IP per minute (generous, because a classroom can share one IP) |
| `CONNS_PER_IP` | `30` | Simultaneous WebSocket connections per IP |
| `DATABASE_URL` | unset | Postgres connection string. Unset means no accounts, classes, GitHub or admin pages |
| `TOKEN_ENCRYPTION_KEY` | unset | 32 random bytes in base64 (`openssl rand -base64 32`). Encrypts stored secrets. Required for GitHub, and it must stay in `.env` |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `PUBLIC_URL`, `GITHUB_SCOPE` | unset, `public_repo` | **Defaults only.** The admin page saves the same values in the database, and what is saved there wins. `PUBLIC_URL` is where GitHub sends users back, for example `https://cc.example.com` |

To change the author name and link shown by the credit and the `about` card, edit the `AUTHOR` constant at
the top of `public/app.js`.

## How it works

```
browser ──HTTPS / WSS──▶ reverse proxy (Caddy) ──▶ Node + Express (:3000) ──docker run──▶ gcc container
   │                                                  │  static files, /api, /ws/run           (one per run)
   │                                                  └──▶ Postgres (optional): accounts, files, classes
   └─ without a database, files and settings stay in localStorage
```

1. The page sends the project's files and the open file to `/ws/run`.
2. The server validates them (names, sizes, language), writes them to a fresh temp directory and starts
   **one container**.
3. Inside it, a short shell wrapper compiles with `gcc` or `g++`, prints a marker on stderr, and then
   `exec`s the program under `stdbuf` so its output is unbuffered (a prompt with no newline still appears).
   The server uses the markers to tell compiler output from the program's own output.
4. Your input is written to the program's stdin; output and the final exit status stream back.
5. When the run ends, or the tab closes, the container is killed and the temp directory deleted.

Compiler flags: `gcc -std=gnu17 -Wall -O1` for C (plus `-lm`), `g++ -std=gnu++17 -Wall -O1` for C++, with
the project root and the open file's folder on the include path.

Running code never touches the database: the files for a run are sent over the WebSocket, whether or not you
are logged in.

**Database tables** (created on start-up): `users`, `sessions`, `workspaces` (one JSON document of files per
user), `classes`, `class_members`, `assignments` (assignments and shared programs), `github_links` (encrypted
token and the linked repository) and `app_settings` (admin settings, secrets encrypted).

## Security model and limits

Every run happens in a container with:

| Protection | Setting |
|------------|---------|
| Network | none (`--network none`) |
| Privileges | all capabilities dropped, `no-new-privileges`, non-root user (`65534`) |
| Filesystem | read-only root; your source mounted read-only; a 64 MB tmpfs for the binary |
| Resources | 192 MB memory (no swap), 1 CPU, 64 processes, 256 open files |
| CPU time | 10 s of CPU (waiting for your input costs nothing) |
| Wall clock | 5 minutes per run, 60 s without any input or output |
| Output | 1 MB, then the program is stopped |

Server side: one origin only (WebSocket upgrades from other sites are refused), a strict
Content-Security-Policy, size and name validation (`..`, absolute paths and odd characters are rejected;
at most 20 files and 64 KB in total), per-IP run and connection limits, and a global cap on live programs.
The page needs `'wasm-unsafe-eval'` in its CSP for the in-browser formatter; ordinary `eval()` stays blocked.

**Accounts and secrets** (when the database is on):
- Passwords: scrypt with a random salt. Sessions: a random token in an `httpOnly` cookie, stored only as a hash.
  Logging in does the same work for an unknown email, so response time doesn't reveal which emails exist.
- State-changing requests must come from this site (`Origin` check on top of `SameSite=Lax`), and anything
  with a body must be JSON. Login, sign-up, GitHub and password-reset endpoints are rate limited.
- GitHub tokens and the GitHub client secret are encrypted at rest (AES-256-GCM). The web sign-in flow uses a
  random one-time `state` kept in a cookie, and the client secret is never sent to the browser.
- Teachers can read only the workspaces of students in their own classes; admin routes check the role on
  every request; a super admin account cannot be deleted or demoted from the UI.
- Admin-saved settings never return the secret, only whether one is set.

Docker isolation is not as battle-tested as a dedicated judge such as isolate or Judge0. Keep Docker and the
kernel up to date, and don't run anything else valuable as the same user.

## Capacity

Measured on an 8-core, 16 GB VM with a real Docker daemon:

- A program waiting at an input prompt costs about **15 MB** and no CPU, so 200 live sessions use roughly 3 GB.
- Starting a container and compiling is the expensive part. The host sustains about **4 new runs per
  second** (load average near 7 of 8 cores); raising `MAX_COMPILES` beyond cores - 1 does not help.
- 200 users each pressing Run once, spread over a minute: every run succeeded, median time to first output
  1.2 s, slowest 3.9 s.
- 200 users pressing Run in the *same second*: every run succeeded, but they queue (median wait about 25 s,
  slowest about 50 s).

For sustained load above roughly 4 runs per second, use a bigger machine or a second instance. The account
features are light by comparison: a cloud save is one small JSON write.

## Deployment

On the server: put the app in `/opt/cc-studio`, run `npm ci --omit=dev`, create `.env`, make sure the service
user is in the `docker` group and has pulled the image (`docker pull gcc:13`). For accounts, also run Postgres
and set `DATABASE_URL` and `TOKEN_ENCRYPTION_KEY` (see [Turn it on](#turn-it-on)).

**pm2**

```bash
sudo npm install -g pm2
cd /opt/cc-studio
pm2 start server.js --name cc-studio
pm2 save
pm2 startup        # run the command it prints, so the app restarts on boot
```

**systemd** (`/etc/systemd/system/cc-studio.service`)

```ini
[Unit]
Description=cc-studio
After=network.target docker.service
Requires=docker.service

[Service]
WorkingDirectory=/opt/cc-studio
ExecStart=/usr/bin/node server.js
EnvironmentFile=/opt/cc-studio/.env
Restart=on-failure
User=ccstudio
SupplementaryGroups=docker
NoNewPrivileges=true
PrivateTmp=false
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

`LimitNOFILE` is for about 200 sessions, each holding several pipes and sockets. `PrivateTmp` stays off
because each run's source is written to a temp directory that Docker must be able to mount.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cc-studio
journalctl -u cc-studio -f
```

**Caddy** (`/etc/caddy/Caddyfile`; Caddy fetches the HTTPS certificate itself and proxies WebSockets with no
extra configuration)

```caddyfile
code.example.com {
    encode zstd gzip
    reverse_proxy localhost:3000
}
```

Over plain HTTP (for example `http://<ip>:3000`) everything works too; the app turns off the
`upgrade-insecure-requests` CSP directive so the CSS and scripts still load.

**Behind a proxy with accounts:** keep `TRUST_PROXY` on so cookies are marked `Secure` and per-IP limits see
real addresses, and set the **public address** on the admin page (or `PUBLIC_URL`) so GitHub sign-in sends
users back to the right place. The GitHub OAuth App's callback URL must match it. Back up the database
(`pg_dump`) and keep `TOKEN_ENCRYPTION_KEY` with the backup, because the stored GitHub tokens cannot be read
without it.

## HTTP API

JSON over HTTP, under `/api`, only when `DATABASE_URL` is set. Everything except sign-up, login, the
`/api/me` check and the GitHub sign-in routes needs a logged-in cookie.

| Area | Routes |
|------|--------|
| Account | `POST /signup`, `/login`, `/logout`, `/password` · `GET /me` · `GET`/`PUT /workspace` |
| Classes | `GET`/`POST /classes` · `POST /classes/join` · `GET`/`DELETE /classes/:id` · `/classes/:id/students/:uid` (remove, reset password, read workspace) · `/classes/:id/assignments` (add, delete, start) · `POST /classes/:id/shares` · `DELETE /classes/:id/membership` (leave) |
| GitHub | `GET /github/status`, `/repos`, `/commits` · `PUT`/`DELETE /github/repo` · `DELETE /github` (disconnect) · `POST /github/export`, `/import` · connect: `/github/device/start`, `/github/device/poll`, `/github/oauth/connect` · sign in: `/github/login/status`, `/github/login/start`, `/github/login/poll`, `/github/oauth/login`, `/github/oauth/callback` |
| Admin (super admin) | `GET /admin/stats`, `/admin/users`, `/admin/classes` · `PUT /admin/users/:id/role` · `POST /admin/users/:id/password` · `DELETE /admin/users/:id`, `/admin/classes/:id` · `GET`/`PUT /admin/settings/github` · `POST /admin/settings/github/check` |

## WebSocket protocol

Endpoint: `/ws/run`, JSON text messages.

Client to server:

| Message | Meaning |
|---------|---------|
| `{type:"run", language:"c"\|"cpp", files:[{path, content}], entry}` | Start a run. `entry` is the open file; only the sources in its folder are compiled. `source_code` is accepted instead of `files` for a single main file |
| `{type:"input", data}` | Text for the program's stdin (at most 4 KB per message, 64 KB per run) |
| `{type:"eof"}` | Close stdin |
| `{type:"kill"}` | Stop the program |

Server to client:

| Message | Meaning |
|---------|---------|
| `{type:"compile", text, ok}` | Compiler output. `ok:false`: the build failed and nothing runs. `ok:true`: warnings only |
| `{type:"started"}` | The program is running |
| `{type:"out", stream, data}` | stdout or stderr text |
| `{type:"exit", code, signal, reason, ms}` | The run ended. `reason` is one of `compile_error`, `timeout`, `idle`, `cpu_limit`, `memory_limit`, `output_limit`, `killed`, or empty |
| `{type:"error", code, message}` | `code` is `invalid`, `rate_limited`, `busy`, `unavailable` or `internal` |

Limits on `files`: at most 20, 64 KB in total; paths are relative, use `A-Za-z0-9_.-/`, and end in `.c`,
`.cpp`, `.cc`, `.cxx`, `.h`, `.hpp`, `.hh`, `.hxx`, `.txt` or `.md`.

## Project layout

```
server.js             Express app: security headers, static files, /api routers; starts the HTTP and WebSocket servers
lib/interactive.js    /ws/run: protocol, per-IP limits, origin check, session cap
lib/runner.js         Docker runner: one container per run, limits, markers, signals
lib/validate.js       Request validation and the "which files to compile" rule
lib/db.js             Postgres connection and the table definitions
lib/auth.js           Sign-up, login, sessions, password change, cloud workspace; shared guards
lib/classes.js        Classes, assignments, shared programs, roster
lib/github.js         GitHub connect, sign-in (device and web flow), push, pull, history
lib/settings.js       Run-time settings saved by an admin (GitHub app values), and their routes
lib/admin.js          Admin dashboard API: stats, users, classes
lib/crypto.js         AES-256-GCM for stored secrets
scripts/create-superadmin.js    Create or reset the super admin account
public/
  index.html          The editor page
  app.js              Editor, files, panels, console, settings, running
  account.js          Login dialog, cloud save, Share, teacher view
  github.js           Pull and Push buttons, the Git tab
  resize.js           Draggable column dividers
  friendly.js         Friendly mode: error hints, crash notes, quips, easter eggs, build stats
  format-config.js    The clang-format settings used by the Format button
  shell.js, shell.css, theme.js   The sidebar and top bar shared by the pages below, and the saved theme
  profile.*  classes.*  admin.*   The Profile, Classes and Admin pages
  style.css, fonts.css, fonts/    Look and self-hosted fonts
  vendor/clang-format/            clang-format compiled to WebAssembly (unmodified)
tests/                node:test suite
docs/                 Screenshots used in this README
```

There is no build step: the files in `public/` are served as they are. Monaco is loaded from jsDelivr.

## Development

```bash
npm install
npm test          # runs the whole suite
npm start         # PORT=3100 npm start to use another port
```

The tests for running code need **neither Docker nor the compiler image**: they use a fake runner for the
WebSocket protocol and a fake `docker` executable to exercise the real runner's process handling (compile
errors, crashes, kill, idle and output limits, the compile queue). They also load the same WebAssembly
formatter as the browser, and check validation, the Friendly-mode table, the column-resize maths and the
server's headers.

The account, class, GitHub and admin tests run against a real Postgres: with `DATABASE_URL` set (to a role that
may create databases) each suite creates a throwaway database, runs, and drops it, so your data is never
touched. Without `DATABASE_URL` those suites are skipped. GitHub is replaced by an in-memory fake, so no test
talks to the network.

To check the real thing end to end, start the app with Docker access and run a program in the browser.

## Credits

- [Monaco Editor](https://github.com/microsoft/monaco-editor) (MIT), loaded from jsDelivr.
- [clang-format](https://clang.llvm.org/docs/ClangFormat.html) from LLVM (Apache-2.0 with LLVM exceptions),
  as WebAssembly via [`@wasm-fmt/clang-format`](https://github.com/wasm-fmt/clang-format) (MIT). Both license
  texts are in `public/vendor/clang-format/`.
- [IBM Plex Sans](https://github.com/IBM/plex) and [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono)
  (SIL Open Font License 1.1), self-hosted; license texts in `public/fonts/`.
- The visual design follows a "C Compiler" design made in Claude Design.
- The compiler is `gcc`, from the official [`gcc` Docker image](https://hub.docker.com/_/gcc).

Built by [hhsonet](https://github.com/hhsonet).

## License

[MIT](LICENSE), Copyright (c) 2026 hhsonet.

The third-party pieces keep their own licenses, and their license texts are included next to the files they
cover: `public/fonts/IBM-Plex-OFL.txt`, `public/fonts/JetBrains-Mono-OFL.txt`,
`public/vendor/clang-format/LICENSE` (the WebAssembly wrapper, MIT) and
`public/vendor/clang-format/LLVM-LICENSE.txt` (clang-format itself, Apache-2.0 with LLVM exceptions).
