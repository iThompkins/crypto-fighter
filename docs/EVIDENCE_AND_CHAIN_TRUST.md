# Evidence availability and chain trust

This document states the practical trust assumptions for Crypto Fighter. The
goal is to make risks visible and predictable, not to eliminate every possible
network, storage, or participant failure.

## Practical policy

- Players choose whom they play. Repeated failure to respond is primarily a
  matchmaking, reputation, and community problem.
- Each player is responsible for keeping the public evidence needed to defend
  their own position and for responding before published deadlines.
- A non-response does not prove cheating, but the settlement rules may still
  assign it a timeout consequence so funds do not remain locked forever.
- The application may trust its configured RPC provider. A user who wants
  stronger assurance can configure a different provider or run their own node.
- Local evidence storage and exports are acceptable for the prototype. The
  protocol does not promise that another party will host or recover a lost file.
- Recent chain history can change. A production deployment must publish a simple
  network-specific confirmation rule and resynchronize after a reorganization.

These are disclosed operating assumptions, not hidden guarantees. They do not
authorize public deployment today; contracts and funding remain local-only.

## Plain-language terms

| Term | Meaning |
| --- | --- |
| RPC provider | A server the wallet or application asks for blockchain data. Using the configured provider means trusting its answers. |
| Own node | Software the user operates to verify and serve blockchain data directly instead of relying entirely on somebody else's RPC service. |
| Confirmation | A later block built after the block containing a transaction. Waiting for confirmations lowers—but does not eliminate—the chance that recent history changes. |
| Reorganization (“reorg”) | The network replaces some recent blocks with another accepted history. A recently visible transaction can disappear and may need to be resubmitted. |
| Evidence archive | The saved public match journal containing authorization, readiness, and signed input statements needed to reconstruct a dispute. |
| Non-response | A player fails to submit a required valid action before its published deadline. It is a procedural fact, not proof of motive. |

The earlier phrase “a single RPC is not economic finality” was too absolute for
this project's policy. The intended, simpler rule is:

> Crypto Fighter may rely on the user's configured RPC. The community should
> understand that this introduces provider risk, and users who care more about
> that risk can run their own node.

## Examples

### A normal player uses the wallet's RPC

Alice uses the RPC already configured in her wallet. The application reads the
arena through it and waits for the confirmation rule published for that network.
Alice accepts that a stale or faulty provider could delay or misreport what she
sees. The protocol does not require her to consult multiple providers.

### A cautious player runs a node

Bob does not want to depend on a hosted RPC. He points the application at his own
node. This reduces his provider dependency, although ordinary software, network,
and chain-reorganization risks still exist.

### A player loses their archive

Alice deletes the browser data and backup containing her dispute evidence. If
she later cannot answer a required dispute turn, the contract sees only that she
did not respond in time. It does not need to determine whether she was careless,
offline, or malicious. Issue #4 defines the disclosed timeout consequence.

### A player stops responding

Bob repeatedly disappears during matches. Individual matches use the published
non-response rule so escrow can exit. Other players can choose not to match with
him, and a later reputation system may expose his reliability history. The
execution protocol does not need to prove why he disappeared.

### A recent transaction is reorganized out

Alice sees her trace challenge included, but a reorg removes it before the
network's configured confirmation threshold. The client reloads the arena state
and Alice resubmits if the challenge window is still open. The discarded fork's
deadline and transaction do not remain authoritative.

### A committed archive is unavailable or wrong

Publishing `journalHash` lets another player verify a file after receiving it;
the hash does not deliver the file. If the publisher does not provide the file,
or provides the wrong file and does not correct it before the response deadline,
the result is non-response under the disclosed rule. This need not prove fraud.

## Evidence responsibilities

| Evidence | Source and integrity check | Who keeps it / practical assumption |
| --- | --- | --- |
| Arena and match binding | Configured RPC; verify chain, arena, challenge, binding hash, registration, rules, participants, session keys, and authorization | Both players retain the locator and authorization. The configured RPC is trusted unless the user chooses their own node/provider. |
| Signed READY statements | Each session key; verify schema, match context, slot, and signature | Both players save both statements before gameplay. |
| Signed inputs and acknowledgements | Each session key; verify signature, match, slot, frame, mask, and chain links | Each player saves every sent and received statement before relying on it. |
| Complete journal | Browser IndexedDB and exported archive; verify strict schema and `journalHash` | Each player is responsible for local retention and any backups they want. No third-party recovery is promised. |
| Phase C bundle and trace | Deterministically rebuild from the journal; verify all hashes, openings, and terminal data | Each player must be able to regenerate their own bundle while a dispute is possible. |
| Published root/archive hash | Arena transaction; verify participant, root, and `journalHash` | The publisher is responsible for producing the matching archive when required. |
| Submitted Merkle openings | Player's trace tree and public transaction calldata; verify context, index, checkpoint, and proof | Players retain their own tree. Previously submitted opponent openings can be recovered from chain transaction data. |
| Objective fault evidence | Signed invalid-input packet or signed conflicting pair | Anyone who retained the signed bytes can submit them. |
| Dispute state and deadline | Configured RPC or own node; verify arena, trace phase, round, responders, and block time | Each player is responsible for monitoring while they have an active obligation. |

Private session keys are not evidence and must not be archived. Derived roots or
transcripts do not replace the source journal.

### Retention expectation

Players should keep their journal and dispute artifacts until all match and
dispute deadlines have ended and settlement has received the configured number
of confirmations. A player may delete them earlier, but accepts the risk of being
unable to answer. Exact backup tooling and retention reminders are product work,
not settlement prerequisites.

## Minimum evidence for each dispute action

“Win” here means obtain the current neutral technical verdict. The current code
does not move funds from that verdict.

| Action | What the player needs |
| --- | --- |
| Enter escrow mode | Match locator, completed binding, both authorization signatures, delegated session identity, and an activated arena record from the configured RPC or own node. |
| Publish an archive commitment | The exact retained journal, its `journalHash`, and the derived trace root. Do not commit to a file you cannot later produce. |
| Call `claimTrace` | Complete uncontested journal/bundle, root, genesis opening, endpoint opening, and terminal state. |
| Call `challengeTrace` | Challenger's complete bundle/root under the same authorized context, with the same genesis and a different endpoint. |
| Answer a midpoint | The complete Merkle tree for the responder's already submitted root and the currently requested index. |
| Adjudicate the isolated step | Agreed pre-state/opening, both upper openings, and—unless already terminal—both signed input packets with their required chain links. |
| Prove invalid input or equivocation | The signed invalid packet or the two signed conflicting packets. A full archive is not required. |

If a player cannot produce required evidence or an action before the deadline,
that becomes non-response. Issue #4 defines the fund destination and timing.

## Failure and consequence table

| Situation | Technical classification | Practical handling |
| --- | --- | --- |
| Archive lost, deleted, or never backed up | Evidence unavailable to that player | The player may be unable to answer and receive the disclosed non-response consequence. |
| Opponent withholds a required archive/opening | Evidence unavailable, then non-response when its delivery/action deadline expires | Apply the published timeout consequence. The protocol need not prove motive. |
| Only one player retained a complete archive | Asymmetric availability | The player with evidence can submit it; the other may be unable to answer and receive the disclosed non-response consequence. |
| Archive is partial | Incomplete evidence | Reject it; allow correction until the deadline, then treat failure to correct as non-response. |
| Archive bytes do not match `journalHash` | Integrity failure | Reject them; allow the correct file until the deadline, then treat failure to correct as non-response. |
| Malformed or forged message | Invalid/unauthenticated evidence | Reject it. Do not attribute an unsigned forgery to a player. |
| Two valid conflicting packets | Objective equivocation | Preserve both. Issue #4 decides the economic consequence. |
| Valid witness matches neither trace root | `StepVerdict.Neither` | This is an execution result, not missing evidence. Issue #4 decides the economic consequence. |
| Player misses a required transaction deadline | Non-response | Apply the clearly published timeout/exit rule. |
| RPC is stale, unavailable, malicious, or wrong | Provider failure / retryable uncertainty | Retry, change provider, or use an own node. Deadlines remain a known operational risk. |
| Transaction lacks configured confirmations | Recent/unconfirmed chain state | Wait before treating it as settled. |
| Recent blocks are reorganized | Reorg | Reload canonical arena state and resubmit an action only if it is still valid. |

The categories stay distinct for diagnosis and review. Issue #4 may intentionally
give several categories the same timeout/refund/forfeit result if that behavior
is simple, disclosed, and leaves no funded state permanently locked.

## RPC, confirmations, and reorgs

A production deployment needs a short configuration for each supported network:

- expected chain, arena address, and deployed code/version;
- default RPC endpoint or wallet-provided RPC behavior;
- the number of confirmations, or network-provided finalized-block status, used
  before treating activation, dispute actions, verdicts, and settlement as final;
- what the client reloads after a reorg; and
- a clear recommendation that users may supply their own node/provider.

One configured RPC is acceptable. Independent-provider comparison is optional,
not a protocol requirement.

| Stage | Practical confirmation rule |
| --- | --- |
| Challenge discovery | The UI may show the configured RPC's latest state immediately. Mark recent transactions pending until the network rule is met. |
| Genesis authorization and escrow start | Wait for the configured activation confirmation rule before signing READY or match inputs. |
| Trace claim/challenge and midpoint turns | Show submitted actions as pending; reload the current trace phase, round, and deadline after confirmation or any suspected reorg. |
| Verdict and future settlement | Wait for the configured confirmation/finality rule before treating the result as settled. |

After a detected reorg:

1. Pause new dispute actions long enough to reload the arena.
2. Read the binding, trace phase, roots, round, responses, and deadline again.
3. Ignore transactions and deadlines that existed only on the discarded fork.
4. Resubmit only actions still allowed by the accepted chain.

This is ordinary operational recovery, not a requirement to build a light client
or eliminate all provider risk.

## Open decisions

### EA-001 — Response deadlines and consequences

- **Date:** 2026-10-29
- **Status:** Open; owned by Issue #4
- **Decision needed:** Set each response/delivery deadline and the terminating
  refund, payout, or forfeiture when a player does not respond.
- **Constraint:** The outcome must be disclosed before play and every funded
  state must have an exit. It need not prove why the player failed to respond.

### EA-002 — Network confirmation defaults

- **Date:** 2026-10-29
- **Status:** Open until a production network is selected
- **Decision needed:** Choose the default RPC behavior and confirmation/finality
  threshold for each supported network.
- **Constraint:** Users may replace the provider or run their own node. The
  community must be told what the default trusts.

### EA-003 — Evidence backup experience

- **Date:** 2026-10-29
- **Status:** Open product work
- **Decision needed:** Decide whether to add automatic exports, backup reminders,
  optional community hosting, or reputation signals for unreliable responders.
- **Constraint:** These features may improve reliability but are not prerequisites
  for defining a simple disclosed non-response rule.

## Out of scope

- Guaranteeing that every player, RPC, node, disk, or network remains available.
- Requiring multiple RPC providers, a light client, or a specific archive host.
- Choosing a storage vendor or production network.
- Implementing reputation, matchmaking filters, backup automation, provider
  switching, confirmation polling, or reorg recovery.
- Choosing payout economics; Issue #4 owns those consequences.
