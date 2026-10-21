# Roadmap

Today, local gameplay, durable evidence, trace construction, bisection, and
neutral one-step adjudication are implemented. Settlement is not safe or enabled.

Next:

1. **Remove legacy ambiguity ([Issue #6](https://github.com/iThompkins/crypto-fighter/issues/6)).** Clearly isolate the old result/timeout payout code and the temporary pre-join `matchContextHash`.
2. **Define evidence and chain assumptions ([Issue #5](https://github.com/iThompkins/crypto-fighter/issues/5)).** Decide how missing archives, withholding, RPC trust, confirmations, and reorgs are handled.
3. **Design safe settlement ([Issue #4](https://github.com/iThompkins/crypto-fighter/issues/4)).** Define payouts, refunds, non-response, `neither` verdicts, and an objective exit from every funded state.
4. **Implement and audit only after those rules are approved.** Keep browser settlement disabled and deployment local until adversarial tests and external review support enabling it.

Public-chain deployment, real funds, token economics, reputation, and broad UI
work are not current roadmap items.
