# Demo video script (about 2 minutes)

**Before recording:** `rm -rf data/ && npm start`. Open http://127.0.0.1:4317 at 100% zoom. Click **Fetch evidence** once off-camera to warm up Nimble. Do the blocked run (testing guide, step 7) ahead of time in a second tab. Cut the model and Nimble wait times, and say "edited for time".

## Part 1: The problem (0:00–0:25), title card or face-cam

> "Support agents don't just answer anymore. They issue credits, send emails and close tickets. Long tasks get interrupted: deploys, crashes, timeouts.
>
> The worst moment is when the action has happened but the agent never heard back. It restarts and has to guess. Memory can't help, because the answer never arrived. Guess 'retry' and the customer gets credited twice. GitHub's own September 13 postmortem blames exactly that: a retry loop that kept re-sending writes."

## Part 2: The approach (0:25–0:45), README diagram or title card

> "RECEIPT gives every action a stable operation key, saved before the call. After a crash, a fresh worker doesn't guess. It asks the provider for the receipt under that key. If the tool can't prove what happened, the agent stops and hands a human a precise note.
>
> Each tool gets a grade: Receipt, Idempotent or Blind. That's the conversation I have as an FDE before an agent touches a customer's stack."

## Part 3: The demo (0:45–2:00)

| Time | On screen | Say |
|---|---|---|
| 0:45–1:00 | Evidence card, then the generated plan | "Nimble pulls GitHub's real incident page, so the credit rests on evidence. A Liquid model drafts the plan: credit, email, close. It's schema-constrained, validated in code, and approved by a human." |
| 1:00–1:15 | Click **Approve & run**; both lanes go amber, PIDs struck through | "Two lanes, same plan: RECEIPT, and the common default, retry on error. We SIGKILL the worker right after the credit lands. The agent says 'uncertain'. The provider says one credit." |
| 1:15–1:35 | Click **Resume in a fresh worker**; point at the $50 in red, then RECEIPT's 1/1/1 | "Fresh processes. Retry on error sends it again: $50. RECEIPT finds the receipt and moves on: one credit, one email, ticket closed." |
| 1:35–1:50 | Switch to the blocked tab: red box and handoff note | "With a Blind email tool, RECEIPT won't guess. It stops and tells a human exactly what to check. The retry lane sent two emails." |
| 1:50–2:00 | Click **Run audit**: "Anything twice? no / YES" | "Tinybird's RawTree holds every event; the audit asks one question: did anything happen twice? Agents that act on customers need receipts, not memories." |

End card: repo URL, and "Liquid AI · Nimble · Tinybird RawTree".

## Notes

- Keep the red "2" in the Retry on error lane on screen while you mention it; it's the hook.
- If the model returns an invalid plan on camera, keep it: "the validator caught it, nothing ran". Then regenerate.
- The money is simulated. The crash and the database writes are real, so say so once.
