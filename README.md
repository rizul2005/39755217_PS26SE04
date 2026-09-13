# Ledger — Personal Finance Anomaly Detector

A tool that reads a bank/credit statement (CSV) and flags transactions that
break from your own normal spending patterns — recurring charges that quietly
changed price, and spending that's a statistical outlier for its category.

Course: PS26-SE 04 — Artificial Intelligence C

## Why

Most people don't catch a subscription price hike or a forgotten recurring
charge until months later. Banking apps show every transaction but don't
tell you which ones are actually unusual. Ledger does that one job.

## How it works

1. **Parse** — CSV is read entirely client-side (no upload, no backend).
2. **Categorize** — each transaction is bucketed (subscriptions, food,
   transport, shopping, other) using keyword matching.
3. **Detect outliers** — within each category, amounts more than 2 standard
   deviations from that category's mean are flagged.
4. **Detect recurring-charge drift** — for subscription-like charges
   specifically, a >5% change between consecutive occurrences is flagged
   (this is intentionally *not* applied to variable spend like rideshares
   or coffee, which fluctuate normally and would just create noise).

## Status

Early scaffold — category keyword lists, the outlier threshold, and the
detection logic itself are all going to be refined as real statement data
gets tested against it. This is a v0, not the final model.

## Stack

Vanilla HTML/CSS/JS, no framework, no backend. Runs entirely in the browser.

## Running locally

Just open `index.html` in a browser, or serve the folder:

```
python3 -m http.server 8080
```

Then visit `http://localhost:8080`.
