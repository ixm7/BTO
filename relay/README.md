# Bridge Break relay

Lets players register, withdraw and find partners without a GitHub token of
their own. A Cloudflare Worker holds one token, posts only the handful of
commands players use (built from checked fields, never passed through as
typed), and signs each with a tag only the player's own browser can produce.
It also serves the tournament list through a 15-second cache, so players
share one allowance of requests instead of each network spending its own.

The site checks for the relay when it loads. If the relay does not answer,
everything works as it did before there was one.

## Setting it up

### 1. A token for the relay

GitHub → Settings → Developer settings → Personal access tokens →
**Fine-grained tokens** → Generate new token.

- Name: `Bridge Break relay`
- Expiration: the longest offered. Note the date: the relay stops posting when it expires.
- Repository access: **Only select repositories** → `ixm7/BTO`
- Permissions → Repository permissions → **Issues: Read and write**

Generate it and copy it.

### 2. The Worker

Cloudflare dashboard → **Workers & Pages** → Create → Create Worker.

1. Name it `bridge-break-relay` and Deploy the starter.
2. **Edit code**, replace everything with the contents of `worker.js`, Deploy.
3. **Settings → Variables and Secrets**, add three, then Deploy:

   | Name | Type | Value |
   |---|---|---|
   | `GITHUB_TOKEN` | Secret | the token from step 1 |
   | `REPO` | Text | `ixm7/BTO` — same capitals as the site uses |
   | `ALLOWED_ORIGINS` | Text | `https://www.bridgebreak.org,https://bridgebreak.org` |

4. **Settings → Domains & Routes** → Add → Custom domain → `api.bridgebreak.org`.
   Cloudflare adds the DNS record itself. The cache only works on a custom
   domain, not on the `workers.dev` address.

### 3. Check

`https://api.bridgebreak.org/` should answer `{"ok":true,"repo":"ixm7/BTO"}`.
Reload the site: a player with no token now gets a **Register** button
instead of a link to the tournament's page.

## How trust works

Each browser makes a private key once and keeps it. The relay derives the
player's public tag from it (`sha256("bridgebreak:" + key)`, first 20 hex
digits) and signs every comment with that tag. The app believes a tag only on
a comment posted by the relay's own account, so nobody can speak for another
player — but a player is tied to the browser they registered from.

Free plan: 100,000 requests a day.
