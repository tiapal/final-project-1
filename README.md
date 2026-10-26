# Virtual Food Expo

A web app that lets food importers and distributors shop for manufacturers from home, the way they would at a food expo, with every message translated into the user's language. Built for buyers who can't or don't want to travel to trade shows.

**Live link:** none (runs locally; steps below take about 3 minutes).

## What it does

- **Buyers:** describe what you need ("organic olive oil, 5,000 bottles, under $4") and the Matchmaker agent ranks vendors. Browse vendors in scrolling rows like a delivery app, open a booth, and chat. Everything is translated: English, Spanish, Chinese, Vietnamese, Arabic, Bisaya (Cebuano), and a few more.
- **Vendors:** see leads, answer buyers, edit your booth.
- **One-tap actions in every chat:** set up a meeting time, set up a Zoom or Google Meet call (it asks which), request a free sample. Each one asks the other person to approve first, then offers "add to calendar" (Google, Apple/.ics, Outlook), or asks for a mailing address and sends the vendor's automatic message about what is being shipped.
- **Agents (all on `gpt-6-luna` through Portkey):** Translator, Matchmaker, Booth rep (one per vendor, answers only from that vendor's data), Deal brief.
- **Safety:** private vendor data never enters the model; output guard; number check on translations; token caps; tool-loop limit; rate limit. Run `tests/safety_demo.py` to see them work.

All vendors are fake demo data (`data/vendors.json`).

## Run it (fresh clone)

1. You need Python 3.11 or newer.
2. Put your key in a `.env` file **either** in this folder **or** one folder above it:
   ```
   PORTKEY_API_KEY=your-key-here
   ```
   (`.env.example` shows the format. Never commit the real `.env`.)
3. In a terminal, in this folder:
   ```bash
   python3 -m venv .venv
   ```
   ```bash
   .venv/bin/pip install -r requirements.txt
   ```
   ```bash
   .venv/bin/python -m uvicorn app:app --port 8000
   ```
4. Open <http://localhost:8000>.

## Try it (2 minutes)

1. Open <http://localhost:8000> and choose **Create account**: an **email**, a **password** (8+ characters), a **company name**, and whether you are a **buyer** or a **vendor**. A company license PDF is optional (see Admin below). Next time, use **Log in** with the email and password. Five wrong passwords in a row pauses logins for that email for 5 minutes.
2. A buyer lands on **My home**, a dashboard of every vendor contacted, what needs the buyer's answer, what is waiting on vendors, and meetings coming up. Click **Find vendors**, search "organic olive oil, 5,000 bottles, EU, under $4", and open a booth.
3. Chat in any language. Try the three green buttons. The demo vendors' booth assistants **accept meeting and sample requests automatically**, so you get the calendar and address pop-ups right away.
4. A vendor lands on **My home**: buyers who wrote in, what needs an answer, meetings coming up, samples to ship (with the buyer's address), and recent buyers. To see the vendor side, use **Log out** (or a private window) and sign in as a vendor. Typing the name of a demo company, for example `Cebu Spice Co.`, opens that company's booth. Any other name creates a new empty booth. In **My booth**, untick the auto-accept box to approve requests by hand (use a second browser window for the buyer).
5. Click the 🔢 button at the top to see tokens used, estimated cost, and the safety log.

## Admin: reviewing licenses

Open <http://localhost:8000/#/admin>. The password is `ADMIN_PASSWORD` from `.env`. If you did not set one, a random password is printed in the terminal each time the server starts. The page lists accounts, opens uploaded license PDFs, and lets you Approve or Reject. Approving a vendor puts a **✔ Verified** badge on its booth.

Passwords are stored as salted hashes, never in plain text. A wrong password shows "Log in unverified" in red on the form.

**Forgot password:** the Log in screen has a **Forgot password?** button. It emails a one-time link that works for 30 minutes (the same message is shown whether or not the address has an account). Using the link signs out old sessions and lets the user choose a new password.

To send real emails, add SMTP settings to `.env` (see `.env.example`; a Gmail "app password" works). **Without them, the app prints the email, including the reset link, in the terminal where the server runs**, so you can still test it. Set `APP_URL` if the app is hosted at a public address, so the link points to the right place.

## Putting it online (Render)

1. Push this folder to GitHub (never include `.env`; `.gitignore` already skips it).
2. On <https://render.com>, choose **New +, Blueprint** (or **Web Service**) and pick the repo. `render.yaml` sets the build and start commands.
3. When asked, enter `PORTKEY_API_KEY` and `ADMIN_PASSWORD`. After the first deploy, set `APP_URL` to the address Render gives you (used in password-reset links).
4. Free Render servers fall asleep when idle (the first visit then takes about a minute) and **lose the database on every restart**, so accounts and chats reset. Fine for a demo, not for real use.

## Safety tests

```bash
.venv/bin/python tests/safety_demo.py
```

Prints PASS/FAIL for each defense and saves `tests/safety_results.txt`. It makes a few real model calls.

## Notes and limits

- Interface labels for Spanish, Chinese, Vietnamese, Arabic and Bisaya ship pre-translated in `data/ui_translations.json`, so those switch instantly. Other languages are translated the first time they are picked. After editing `backend/ui_strings.py`, run `python pretranslate_ui.py` to refresh the file.
- Zoom and Google Meet links are placeholders for the demo. Real links need a connected Zoom or Google account.
- Prices per million tokens in `backend/llm.py` are assumptions. Set `PRICE_IN_PER_M`, `PRICE_CACHED_PER_M`, `PRICE_OUT_PER_M` in `.env` to the real `gpt-6-luna` prices.
- `gpt-6-luna` only allows function tools when `reasoning_effort` is `none`, so every call sets that.
- Data lives in `data/expo.db` (created on first run, ignored by git). Delete it to reset.

## Layout

```
app.py              web server and API
backend/agents.py   the four agents and their tools
backend/llm.py      the one place that calls the model: logs tokens, enforces caps
backend/db.py       SQLite storage
static/             the web pages (HTML, CSS, JavaScript, no build step)
data/vendors.json   fake vendors
tests/              safety checks (safety_demo.py) and their saved results
evidence/           real run logs and screenshots used in the report
docs/               report and slide sources; build_docs.py makes report.html and slides.html
report.html         the final report (open by double-clicking)
slides.html         the slide deck (reveal.js from a CDN, needs internet)
```
