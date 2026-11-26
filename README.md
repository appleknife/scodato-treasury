# Scodato's Treasury

A guild donation board for Shop Titans. Scodato posts what he can donate, guildmates request items for the building they're investing in, Scodato approves and picks the items, and everyone sees exactly what guild request to put up in game.

- **Players** need no account: Treasury (what's available) → Request (name, building, current investment) → watch the Board. Their own request stays pinned at the top on their device.
- **Scodato** unlocks his tab with a password that is checked on the server. He can drop, paste or pick a screenshot of his inventory, and the app reads the item names and counts and crops the icons. All of this runs in the browser.
- The queue is sorted by **lowest current investment first**.
- **One item per approval** by default. Scodato can change this limit in Settings, and the database enforces it.
- One open request per player. If someone got items in the last 24 hours, they get a heads-up (it never blocks them, in case their guild request didn't go through), and Scodato sees "got items Xh ago" on their request.
- Approving sets the items aside right away, so the same items can't be promised to two people. Undo puts them back.
- When the in-game donation is done, either person taps **Done** and the request leaves the board.

## Going live (one-time, about 5 minutes)

1. Create a free project at [supabase.com](https://supabase.com). The Secret Santa project works too, since the tables have different names.
2. Open `supabase-setup.sql` and change `change-me-please` on the last line to Scodato's password. In Supabase, go to SQL Editor → New query, paste the whole file and click Run.
3. In Supabase, go to Project Settings → API. Copy the **Project URL** and the **anon public** key into `config.js`.
4. Push to GitHub, then turn on Settings → Pages → Deploy from branch → `main` / root.

If `config.js` is left empty, the app runs in **demo mode**: data is saved only in that browser and the password is `demo`.

## Files
- `index.html`, `styles.css`, `app.js`: the app
- `api.js`: database calls (Supabase REST, with a localStorage demo fallback)
- `ocr.js`: screenshot reader (Tesseract.js, loaded on demand)
- `supabase-setup.sql`: tables, security rules and server-side functions

Fan-made; not affiliated with Kabam or Shop Titans.
