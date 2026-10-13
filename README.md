# signalpipe

Watch a list of companies for buying signals, score each one with **cited evidence**, draft outreach from that evidence, and **measure how often the scoring agrees with a human**.

```
accounts ──► collect signals ──► score (rules + Claude judge) ──► draft ──► you review and send
                 │                         │
         job boards, homepages,     every reason cites signal IDs;
         news (public, no logins)   uncited reasons are dropped and counted
                                           │
                               evals: your blind labels vs. each method
```

Most "AI prospecting" tools hand you a score and ask you to trust it. signalpipe treats every claim about an account as a record with a source:

```
[sig_32e08da69e] hiring/growth (observed, 2026-10-06) Hiring growth / demand gen: "Agentic Operator, Growth Marketing" (Remote, USA)
    source: https://boards.greenhouse.io/circleci/jobs/…
[sig_c64e340eee] stack/tool:hubspot (observed) HubSpot loads on circleci.com
    source: https://circleci.com/
```

Scores and drafts can only point at those IDs. When the judge cites an ID that doesn't exist, or makes a claim that cites nothing, that reason is thrown away and counted against it.

## What it collects

All sources are public and unauthenticated. Nothing logs in, nothing runs on anyone's site.

| Signal | Source | Basis |
|---|---|---|
| Open roles matching your profile's patterns (e.g. GTM engineer, RevOps, SDRs) | Greenhouse, Lever and Ashby public job boards | observed |
| Tools installed on the site (HubSpot, Segment, 6sense, Marketo, Koala, …) | script fingerprints in the homepage HTML | observed |
| Tools named in job posts (Clay, Salesforce, Gong, n8n, …) | open role descriptions | inferred: used or wanted, not proven installed |
| Funding, layoffs, acquisitions, leadership changes, launches | Google News RSS, only headlines where the company is the subject | observed (headline) |

Signals are never deleted. A role that closes stops being "current" but stays on record with the dates it was seen.

## Two scorers, compared

- **rules**: deterministic weights from your profile, with caps and negative signals (layoffs). Cheap, repeatable, the baseline.
- **judge**: Claude reads your offer, your ideal customer and the account's signal ledger, then returns a tier, a score, cited reasons, explicit unknowns, and the angle an outreach note should open with. Scraped text is fenced as untrusted data, and the model runs with no tools.

## Evals

You label accounts **blind**: `label-sheet` shows each account's signals but never its scores. Then `signalpipe eval` reports, per method:

- exact tier agreement and within-one-tier agreement
- **hot precision** (of the accounts it called hot, how many you'd actually reach out to; this is what costs a salesperson time) and hot recall
- Cohen's kappa (agreement beyond chance)
- citation validity: the share of judge reasons whose citations all resolved
- a confusion matrix and every disagreement by name

Reports are written to `out/evals/<date>.md`, so improvements (or regressions) after a prompt or weight change are visible over time.

## Quick start

Node 22.18+ and, for the judge and drafts, the [`claude`](https://claude.com/claude-code) CLI signed in. No other dependencies.

```bash
git clone https://github.com/toryradtke-star/signalpipe && cd signalpipe
mkdir -p profile && cp examples/gtm-engineer-job-search/profile.json profile/profile.json   # or examples/sales-tool
cp examples/accounts.example.json accounts.json                                            # your target list

./bin/signalpipe.ts import accounts.json
./bin/signalpipe.ts domains            # find missing websites (kept only when the homepage names the company)
./bin/signalpipe.ts collect            # job boards + homepages + news
./bin/signalpipe.ts score --judge      # rules for everyone, Claude for the top 25
./bin/signalpipe.ts top
./bin/signalpipe.ts show circleci      # the full evidence ledger for one account
./bin/signalpipe.ts draft circleci     # written to out/drafts/, never sent

./bin/signalpipe.ts label-sheet        # blind labeling sheet
./bin/signalpipe.ts label circleci hot
./bin/signalpipe.ts eval
```

The import format is a JSON array of `{name, domain?, ats?, slug?, tags?}`, the same shape as [jobpipe](https://github.com/toryradtke-star/jobpipe)'s employer registry.

## Profiles

A profile says what you sell, to whom, and what counts as a signal: regex patterns and weights for roles, per-tool weights, news weights (negative ones too), tier cut-offs, and the draft's goal and length. Two examples ship:

- `examples/gtm-engineer-job-search`: the first real use. The "seller" is a GTM engineer looking for a role, and the accounts are companies whose go-to-market teams are growing and leaning on tooling.
- `examples/sales-tool`: a made-up parallel dialer selling to SDR teams, to show the same pipeline pointed at a normal B2B sale.

## Design notes

- **Zero dependencies.** Node's built-in `node:sqlite`, `fetch` and test runner; TypeScript runs through Node's type stripping.
- **Absence is not evidence.** A tool not found on a homepage may load later or behind a consent banner, so a miss records nothing, and the judge is told to put what it couldn't tell into `unknowns`.
- **Subject, not mention.** "Render Networks announces funding" is not news about Render, and "ramp up funding" is not Ramp. Headlines count only when the company is the subject or the target of a deal, and market chatter (price targets, analyst notes) is excluded.
- **Big ledgers are capped, not summarized.** An account with 128 open AE roles shows the judge the 6 most recent per label plus a count, so every ID it can cite is real.
- **Nothing is sent.** Drafts are files. A person reads, edits and sends them.

## Roadmap

- MCP server exposing the same commands to agents
- HubSpot sync (companies, notes with citations, tasks)
- Contacts: who leads GTM / RevOps at each account
- Page-change signals (pricing, careers, product pages) and a scheduled run
- Published eval results

## License

MIT
