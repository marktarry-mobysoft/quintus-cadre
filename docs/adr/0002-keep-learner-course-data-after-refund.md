---
status: accepted
---

# Keep a learner's course data after their Refund Request is approved

When a Refund Request is approved, the learner loses access to the course, but their progress, quiz attempts and watch history for it are kept. They're hidden while the learner has no access, and restored if the learner buys the course again. Two things are not kept: their course rating is removed, and their comments stay visible to others. We chose this over deleting the data straight away, which can't be undone and would wipe progress a returning learner expects to find. We also chose it over deleting after a set period, which adds scheduled clean-up for data that costs almost nothing to keep. Erasing a learner's personal data on request is a separate, account-wide process and is not triggered by a refund.

## Revisit when

- the volume of kept data adds meaningful database cost or slows things down, or
- the database moves off SQLite to a technology where storage or query cost behaves differently.

At that point, switch to deleting the data after a fixed period (for example 90 days).
