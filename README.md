# Meal Planner

A single-user, Docker Compose meal planner. SQLite on the host is the source of truth for the meal library, slots, settings and planned meals. A read-only calendar feed puts the plan on your phone.

## Run

The x1c deployment uses `compose.yaml` behind Caddy at `https://meals.happydaysblr.ddns.net`, which only admits the home network and the tailnet; the app itself has no login.

```bash
./setup.sh                      # private .env with host UID/GID and a calendar token
sudo systemctl enable --now homelab-dinner-planner.service
```

Caddy must keep the LAN/Tailscale gate on everything except the calendar feed:

```
meals.happydaysblr.ddns.net {
	@calendar path_regexp ^/api/calendar/[A-Za-z0-9_-]{20,}\.ics$
	handle @calendar {
		reverse_proxy 172.17.0.1:8789
	}
	@trusted remote_ip 192.168.0.0/24 100.64.0.0/10 fd7a:115c:a1e0::/48 127.0.0.1 ::1
	handle @trusted {
		reverse_proxy 172.17.0.1:8789
	}
	handle {
		respond "Meals is available only on the home network or Tailscale." 403
	}
}
```

## Data and behavior

- Monday–Sunday board; meal-slot rows share one global configurable list and each slot has a unique preset time (Asia/Kolkata). Change them in Settings.
- On phones and other screens 900px wide or narrower, the week fills the screen without vertical scrolling and the library panel is hidden: plan with the + in each cell (its dialog also has Shuffle), and manage the library in Settings → Meal library.
- Tap or click the faint + in any cell to add a meal to that day and slot, or drag a library meal into a slot. Drag a planned meal to another cell to move it, or onto the trash to delete it (with confirmation). On touch screens, tap a planned meal for move/delete actions, or hold and drag.
- A meal counts as eaten (✓) once its date and slot time have passed; moving it changes that automatically.
- Changes are recorded in a durable SQLite outbox and applied by a background worker, so the board stays responsive; small per-meal spinner/check indicators show progress. Acknowledged entries older than a week are pruned hourly.
- Settings → Calendar shows the private subscription link (`/api/calendar/<ICS_TOKEN>.ics`) for Google Calendar or iPhone. It covers two weeks back and three months ahead and refreshes about hourly. Rotate `ICS_TOKEN` in `.env` to revoke the old link.
- Appearance follows the system by default; Settings offers System, Light and Dark.

## Security and storage

- No login: Caddy's network gate decides who can reach the app. The server still checks the Host header and rejects any write whose Origin is not the planner itself, so other websites cannot post to it from your browser.
- The process runs as the host UID/GID from `.env`, read-only root filesystem, no Linux capabilities, bound only to `172.17.0.1:8789` for Caddy.
- SQLite lives at `DATABASE_PATH` (default `/data/meals.sqlite3`) on the `./data` bind mount and is snapshotted nightly by the homelab backup.
- Never commit `.env` or `data/`.

## Todoist

The planner used to keep planned meals in a Todoist project named `Meals`. That provider (`TODOIST_MODE=live`) and a fake for tests are still in the code. `npm run import:todoist -- --from YYYY-MM-DD` copies a Meals project into the local tables (re-runnable; keyed by Todoist task ID). See [typescript/README.md](typescript/README.md).

## Checks

```bash
sudo docker build --target build .   # typecheck, unit tests and production build
sudo docker compose config -q
```
