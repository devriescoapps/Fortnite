# Putting SURGEFALL online

`npm run export` produces two uploadable packages in `export/`:

| File | What it is | Where it goes |
|---|---|---|
| `surgefall-web.zip` | Static HTML5 build. The game server runs **inside the browser**, so you play full matches against bots. Progress is saved in the browser. | itch.io, Netlify, GitHub Pages, Cloudflare Pages, any web space |
| `surgefall-server.zip` | The real multiplayer server with the game client built in (no `npm install` needed). Players on the same server play together; bots fill empty seats. | Render, Railway, Fly.io, a VPS, anything that runs Node 20+ or Docker |

Both work on desktop (keyboard/mouse, gamepad) and phones/tablets (touch controls, landscape).

---

## Option A — static web build (quickest)

### itch.io
1. Create a new project at <https://itch.io/game/new>.
2. **Kind of project:** `HTML`.
3. **Uploads:** upload `surgefall-web.zip` and tick **"This file will be played in the browser"**.
4. **Embed options:** viewport `1280 × 720`, enable **Fullscreen button**, **Mobile friendly** with orientation **Landscape**.
5. Save and open the page — press PLAY.

### Netlify (drag and drop)
1. Unzip `surgefall-web.zip`.
2. Open <https://app.netlify.com/drop> and drop the unzipped folder onto the page.
3. You get a public URL immediately.

### GitHub Pages
1. Create a repository (or a `gh-pages` branch) containing the **contents** of `surgefall-web.zip`
   (`index.html` at the top level).
2. Repository **Settings → Pages → Build and deployment → Deploy from a branch**, pick that branch and `/ (root)`.
3. The game is served at `https://<user>.github.io/<repo>/`.

Any other static host works the same way: upload the files, `index.html` is the entry point.
You can even open `index.html` straight from disk.

---

## Option B — multiplayer server

Unzip `surgefall-server.zip`, then pick one:

**Any machine with Node 20+**
```bash
node dist/server.cjs          # http://localhost:8080 — share your LAN/public address
PORT=3000 node dist/server.cjs
```

**Docker**
```bash
docker build -t surgefall .
docker run -p 8080:8080 -v surgefall-data:/app/data surgefall
```

**Render / Railway / Fly.io** — deploy the unzipped folder (or this whole repository, which has its
own `Dockerfile`) as a Docker web service. These hosts provide HTTPS, and the game automatically
uses secure WebSockets (`wss://`) there. Make sure the service allows WebSocket connections
(all three do by default). Set `PORT` if the host requires a specific one.

Profiles (levels, XP, cosmetics) are stored in `data/profiles.json`; keep that folder on a
persistent volume if your host restarts containers.

### Server settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 8080 | HTTP + WebSocket port |
| `MAX_PLAYERS` | 32 | Players per match (humans + bots) |
| `LOBBY_TIME` | 20 | Seconds in the pre-game Skyport |
| `QUEUE_WAIT` | 4 | Seconds to gather humans before creating a match |
| `STORM_SCALE` | 1 | Multiplies storm timings (e.g. `0.5` for quicker matches) |
| `BOT_SKILL` | 0.5 | Average bot skill 0..1 |
| `FILL_BOTS` | 1 | `0` disables bots (humans only) |
| `MAX_MATCHES` | 8 | Concurrent matches per server |
| `DATA_DIR` | `data` | Profile storage directory |

Never set `DEV_COMMANDS=1` on a public server (it enables test-only teleport/give commands).

---

## Play modes at a glance

- Opened from a static host or from disk → **offline mode** (you vs bots, instant start).
- Opened from the multiplayer server → **online mode**; if the server goes away before the game
  connects, the page falls back to offline mode automatically.
- Force one or the other with `?mode=offline` or `?mode=online` in the URL.
