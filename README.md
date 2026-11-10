# Bridge P2P

Duplicate bridge tournaments (matchpoints) that run entirely in the players' browsers.
There is no game server: browsers talk to each other over WebRTC, and the list of
tournaments lives in the Issues of a public GitHub repository.

## Try it

```bash
npm install
npm run dev        # open the printed URL, then "Play a demo vs robots"
npm test           # 77 tests: rules, scoring, tournament simulation, directory
npm run build      # static site in dist/ (host it on GitHub Pages or anywhere)
```

To try several players on one machine: Settings → Connection → "This browser only",
then open the page in a few tabs and "Join private room" with the same code.

## Setting up the tournament directory

1. Create a public GitHub repository (for example `yourname/bridge-club`) with Issues enabled.
2. In the app, open Settings and enter `yourname/bridge-club`.
   To bake it in for everyone, build with `VITE_DIRECTORY_REPO=yourname/bridge-club npm run build`.
3. Optional: each person who wants to create tournaments, register or publish results from
   inside the app pastes a fine-grained GitHub token with "Issues: read and write" on that
   repository. Without a token the app opens github.com with the form pre-filled.

How the directory maps onto GitHub:

| Tournament data | Where it lives |
|---|---|
| Name, director, type, start time, time zone, level, capacity, format | The issue (readable table plus a hidden JSON block) |
| Initiator / director | The issue author |
| Registered players | Comments containing `/register Name` (`/withdraw` undoes it; optional `pair:CODE` picks a partner) |
| Results | A comment with the ranking table, after which the issue is closed |
| Status | Derived: upcoming, in progress, finished, cancelled, expired |

## How a tournament runs

- Everyone opens the tournament and presses "Enter playing room". The room name is
  `owner/repo#issue`, so all players of that tournament find each other.
- One browser is the host (coordinator). The rule is the same on every device, so no vote
  is needed: the director if connected, otherwise the most capable device (desktop over
  tablet over phone, then CPU cores), otherwise the lowest peer id.
- The host starts the tournament. Players sharing a partner code are paired; the rest are
  paired in arrival order; robots fill empty seats.
- Every action goes to the host, which checks it against the rules and appends it to a log
  that all peers hold. The whole tournament is a pure function of that log, and deals come
  from a seed in the first log entry, so any peer can take over as host at any moment.
- If the host disappears, the next device takes over after catching up with the longest log.
  A robot plays for anyone who has been disconnected for 20 seconds, until they return.
- Movement: North-South pairs stay put, East-West pairs move up one table per round, and
  every table plays the same boards in a round.

## Layout

```
src/engine      cards, deals, bidding, play, duplicate scoring, matchpoints, robot
src/tournament  state.ts (event log reducer, movement, standings), node.ts (peer + host logic)
src/net         transport interface; in-memory, same-browser tabs, and WebRTC (Trystero)
src/directory   GitHub Issues directory and time-zone helpers
src/ui          plain DOM + TypeScript interface
tests           vitest suites
```

## Known limits

- No protection against cheating, by design: every peer holds the seed and so could work
  out all four hands. The interface only shows what a player is entitled to see.
- All players of a tournament share one WebRTC mesh. Fine for a club game of a few tables;
  dozens of tables would need a mesh per table.
- Players behind strict firewalls may fail to connect without a TURN relay
  (`trysteroTransport(roomId, { turnConfig })`).
- Host hand-over has no fencing: if the old host is still alive while a new one takes over
  (a network split), the two logs can diverge.
- No round clock, claims, undos, alerts or chat yet. The robot is a basic player.
- Unauthenticated GitHub reads are limited to 60 per hour per IP address.
