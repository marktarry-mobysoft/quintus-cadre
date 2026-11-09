# Cadence Course Platform

A course platform where Learners buy courses and may ask for their money back. One name per concept: use these terms in code, UI text, emails, comments and issues.

## Language

### People

**Learner**:
A user of the system. A Learner may request a refund.

**Reviewer**:
Whoever decides whether a Refund Request is Approved or Declined: an admin, a moderator, or an automation/agent.
_Avoid_ (in code and internal text): our team. Learner-facing text says "our team"; this is the one deliberate difference between customer-facing and internal wording.

### Refunds

**Refund Request**:
A Learner's request to get their money back for a purchase.
_Avoid_: cancel, cancellation, raised. "Cancel" is still fine on buttons that close a form.

**Refund**:
The money returned after a Refund Request is Approved (`amountRefunded`). How the bank actually moves the money is outside this repo.
_Avoid_: reversal, chargeback

**Refund window**:
The 14 days after purchase during which a Learner may request a refund.

### Refund Request states

**Requested**:
The state a Refund Request starts in, before a Reviewer has decided it.
_Avoid_: pending, open. "Open" is fine when it describes the current state of one or more Refund Requests ("a refund request open for this purchase"), but not on its own as a status, badge or label.

**Approved**:
The Reviewer agreed to the Refund Request, so a Refund is due.

**Declined**:
The Reviewer turned down the Refund Request.

**Resolved**:
A Refund Request is resolved once it's Approved or Declined.
