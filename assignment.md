# Final Project (assignment instructions, pasted by user 2026-10-24)

Build an AI agent app that does something useful for real people. Then show how it works, what it costs, and how you kept it safe.

**Due Monday, October 26, 2026 at 6:00 PM on Canvas**

## The big idea

All semester you built agents piece by piece: tools, structured outputs, chat websites, multi-agent teams, caching, and defenses against prompt injection. Now you put it together on a problem you care about.

Pick something that matters to someone: a business, a nonprofit, a classroom, a hospital, your old job, your family, your community. It does not have to make money. It has to make a difference. The best projects are ones you could hand over to a real person tomorrow and they would actually use it.

## What you submit

| What | Where | Details |
|---|---|---|
| GitHub repo | Canvas (website URL) | Link to your repo. Holds all the code, with a README that explains how to run it. Public, or private with `zlisto` added. |
| Report (`report.html`) | Canvas | A single HTML file, 10-15 pages when printed. |
| Slide deck (`slides.html`) | Canvas | A single HTML file that summarizes the project, 10 slides max. |
| Demo video (optional) | Canvas | A 2-3 minute screen recording of you using the app. |

Solo project. Submit three things on Canvas: the repo link, report.html, and slides.html. Optional demo video.

**Self-contained HTML:** both HTML files should open by double-clicking them, on any computer, with every screenshot showing. Embed the images inside the file so nothing is missing.

## The report (10-15 pages)

Write it for a smart manager who has never seen your app. Use these sections, in this order. Put screenshots of your app wherever they help.

You can write it with AI assistance. You are responsible for every word and number in it, so check that it matches what your app actually does.

1. **Title + links**: project name, your name, the GitHub repo link, the link to the app if online, and one sentence that says what the app does.
2. **Motivation**: Who has this problem? How do they deal with it today, and what does that cost them in money, time, or frustration? Why should anyone care?
3. **What is new here**: What already exists (apps, startups, ChatGPT itself)? What does your project do that those don't? Be honest. If something close exists, say what you do differently and why that matters.
4. **The agents**:
   - What are the AI agents in your app, and what does each one do?
   - What tools can each agent use?
   - If more than one agent: how are they organized? Who hands work to whom? Draw a diagram.
   - Which model(s) you used and why.
   - Walk through one real run, step by step, with screenshots.
5. **Tokenomics**:
   - How many tokens does one typical run use (input, cached input, output)? Measure from real runs.
   - What does one run cost? What does it cost per user per month?
   - What would it cost at scale: 100 users? 10,000 users?
   - What did you do to keep cost down?
   - Did any cost cutting make the app perform worse? Show evidence.
6. **Safety**: What could go wrong, and what did you build to stop it? Cover the risks that matter for your app, e.g.:
   - Attacks: prompt injection, users trying to get the agent to leak data or misbehave.
   - Agent malfunction: invents facts, takes the wrong action, or loops forever. How do you protect the user?
   - Overspending: what stops a bug or bad actor from burning through your token budget?
   - Show at least one defense actually working, with a screenshot or a test.
7. **Impact**: If this helps an organization or people, put numbers on it: money saved, hours saved, faster turnaround, better quality, more people served, or something that was impossible before. Say where numbers come from (own tests, pilot user, public data, careful estimate). Strongest evidence is a real user trying it.
8. **Limits + next steps**: What doesn't work yet? What would you build next with another month?

Page count is for a normal printed page (letter, regular font, screenshots included). Fifteen pages of real detail beats fifteen pages of filler. Filler costs points.

## The slide deck

HTML slide deck, 10 slides max, telling the story in a few minutes. Suggested order:

1. Title: project name, your name, one-line pitch
2. The problem and who has it
3. What is new about your solution
4. How the agents work (diagram)
5. Demo screenshots
6. Cost to run
7. Safety
8. Impact: the numbers
9. What's next

Use **reveal.js** (from a CDN). One HTML file, arrow keys to move, F for full screen. Put screenshots and diagram right inside the file. Clean design, big text, same colors as the app.

## The GitHub repo

- All the code someone needs to run the app.
- `README.md` that says what the app is and how to run it, step by step (or the link, if online).
- `.env.example` listing keys needed, no real values. Never commit the real `.env` or `PORTKEY_API_KEY`.
- Public, or private with GitHub user `zlisto` added as collaborator.

### Model + budget

- **Course key:** `PORTKEY_API_KEY` with `gpt-6-luna` only. No other models on the course key.
- **Own key:** for a different model, use your own personal API key and pay yourself. For OpenAI, name it `OPENAI_API_KEY`.

### Testing the app

Teaching staff will use your app. Either:

- **Put it online.** Link at the top of README and report. Keep it up until final grades are posted. Free hosting often sleeps, so check the day you submit.
- **Run locally from a fresh clone** by following your README step by step. Keep setup simple; if it needs anything unusual (special software, big database, many services), put it online.

**The 10-minute rule:** if the app is not running after 10 minutes of following your README, 0 points for "The teaching staff can run it."

### Where the app finds API keys

```
submissions/
├── .env                <-- teaching staff's keys
├── your-project/       <-- your repo, cloned
│   ├── README.md
│   ├── .env.example
│   └── ...
└── another-project/
```

The app must look for `.env` in two places: first in the repo's own folder, then in the folder above. Test by moving your `.env` up one folder.

Staff `.env` has two keys: `PORTKEY_API_KEY` and `OPENAI_API_KEY`. Use one of those names exactly. List every key in `.env.example`. If you need any other key, put the app online and consult the professor.

### Big data

If the app uses a large dataset, include a small test dataset in the repo so it runs locally. Say in the README how to switch.

## Demo video

Optional, a good backup. 2-3 minute screen recording on your own computer, on a real example, start to finish. Talk through it. Upload on Canvas. If the app won't run for staff, the video can still earn "It works" and "Look + feel", but not the 5 points for "The teaching staff can run it."

## Before you submit

Dry run: clone your repo into a brand new folder, put `.env` one level above, follow your own README, use the app.

## Grading (100 points)

**Tier 1, It works.** App runs and does what it says. Idea is familiar. Report has the sections but skips details. Solid baseline.

**Tier 2, It's clever and new.** Tier 1 plus an idea not seen before or a smart new spin. Agents designed thoughtfully. Report complete, with measured token costs, a real safety defense, and screenshots.

**Tier 3, It makes a difference.** Tier 2 plus a very clever idea that clearly makes something better for real people and could be used in the real world. Evidence: a real user tried it, you measured time or quality against how it's done today, you thought through cost for a whole organization.

### Overdone ideas (capped at Tier 1 on idea unless real twist)

- Resume or cover letter reviewer
- Chat with a PDF or pile of documents
- Trip or travel planner
- Email or meeting summarizer
- Recipe or meal planner
- Generic study buddy or flashcard maker
- Anything built in class or in a homework, without a real new addition

### Evidence earns full credit

A report section without its listed evidence gets at most half of that row's points.

| Component | Points | Top of the range |
|---|---|---|
| **The idea** | 21 | |
| Novelty + real-world value | 21 | Very clever, clearly new, solves a real problem for real people, usable. |
| **The app** | 30 | |
| It works | 15 | Real work end to end: agents use real tools and data, useful results, no crashes. Clean repo, no secrets committed. |
| Teaching staff can run it | 5 | Online, or local from fresh clone per README with `.env` one folder up. Test dataset if large. |
| Look + feel | 10 | Clean layout, clear buttons and screens, a newcomer can figure it out. |
| **The report** | 41 | |
| Motivation + what is new | 8 | Real person behind the problem. Evidence: named existing products compared against. |
| Agent design | 10 | Each agent and tool explained, clear diagram. Evidence: one real run traced step by step with screenshots. |
| Tokenomics | 8 | Per run, per user, at scale; cost cuts and whether they hurt. Evidence: real token counts from logs or app screenshots. Estimates alone get half. |
| Safety | 8 | Risks that matter, defenses built. Evidence: screenshot or test of a defense stopping an attack or malfunction. Describing gets half. |
| Impact + metrics | 5 | Believable numbers with sources, honest limits. Evidence: a real user tried it. Guesses alone get half. |
| Design | 2 | Clean, readable, sharp screenshots and diagrams. |
| **The slides** | 8 | |
| Content | 6 | Whole story, diagram, screenshots, key numbers. |
| Design | 2 | Big readable text, consistent style, visuals carry the story. |
| **Total** | 100 | |

## Tips

- Start with a person, then the tech. "My aunt spends 6 hours a week on insurance paperwork for her clinic" beats "Build a multi-agent system."
- Talk to a real user. Even one 15-minute conversation makes Tier 3 easier.
- Screenshot as you go: good runs, bad runs, safety defenses catching something.
- Ship something that works first. Then make it clever.
