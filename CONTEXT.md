# Context

## Glossary

One name per concept. Use these terms in code, UI text, emails, comments and issues.

| Term               | Meaning                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Learner**        | A user of the system. A Learner may request a refund.                                                                                             |
| **Refund Request** | A Learner's request to get their money back for a purchase. It moves from **Requested** to either **Approved** or **Declined**.                   |
| **Reviewer**       | Whoever decides whether a Refund Request is approved or declined: an admin, a moderator, or an automation/agent.                                  |
| **Resolved**       | A Refund Request is resolved once it's Approved or Declined.                                                                                      |
| **Refund**         | The money returned after a request is Approved (`amountRefunded`). How the bank actually moves the money is outside this repo.                    |
| **Refund window**  | The 14 days after purchase during which a Learner may request a refund.                                                                           |
| **Words to avoid** | cancel / cancellation (when it means a refund), reversal, chargeback, pending, open, raised. "Cancel" is still fine on buttons that close a form. |

Learner-facing text says **"our team"**. Code and the glossary say **"Reviewer"**. This is the one deliberate difference between customer-facing and internal wording.
