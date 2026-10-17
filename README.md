# Dugout Digest

Nightly stats and recaps for your fantasy baseball rosters (MLB and minor leagues), viewable on desktop or phone through a GitHub Pages link.

**How it works:** a GitHub Action runs every morning (6am Eastern), pulls last night's game logs for every rostered player from the free MLB Stats API (MLB, AAA, AA, High-A, A, Rookie), scores them with your league's rules, writes a recap with Claude, and saves the results into `docs/`. GitHub Pages serves `docs/index.html`.

## Set up

1. Create a GitHub repo and push this folder to it.
2. Edit `config/leagues.json`: one entry per fantasy team, with your players' names and (optionally) scoring.
3. Repo **Settings > Pages**: deploy from branch `main`, folder `/docs`.
4. Repo **Settings > Secrets and variables > Actions**: add `ANTHROPIC_API_KEY` for AI-written recaps. Without it, recaps fall back to plain stat lines.
5. **Actions > Nightly update > Run workflow** once to generate the first day. After that it runs by itself.

Your link will be `https://<your-username>.github.io/<repo-name>/`.

## Privacy note

GitHub Pages sites are public to anyone with the link (private-repo Pages needs a paid plan). Only player names and stats are published, nothing about your accounts or league logins.

## Config

- `players`: names as MLB lists them. If a name is ambiguous the run log warns you; add `"mlbId": 123456` to fix it.
- `"bench": true` keeps a player out of that day's fantasy-point total.
- `scoring`: points per stat. Keys:
  - Batting `bat.`: `singles doubles triples homeRuns runs rbi baseOnBalls strikeOuts stolenBases hitByPitch`
  - Pitching `pit.`: `inningsPitched strikeOuts earnedRuns h baseOnBalls wins losses saves holds qs`

## Run locally

```
node scripts/nightly.mjs 2026-09-20      # a specific date
npx serve docs                           # then open the printed address
```

Needs Node 20+; no packages to install.

## Not built yet

- Automatic roster import from Fantrax/Fleaflicker (rosters are typed into `config/leagues.json` for now)
- Category-league scoring (H2H categories / roto standings); only points scoring so far
- Waiver pickups, trades and injury news
