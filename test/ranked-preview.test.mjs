import test from "node:test";
import assert from "node:assert/strict";
import { rankedPreviewText } from "../src/ranked.ts";

test("ranked preview plainly states risk, deterministic reward, eligibility and protocol issuance", () => {
  assert.equal(
    rankedPreviewText({
      eligible: true,
      startingStreak: "8",
      anteCfc: "1",
      nextWinRewardCfc: "34.0",
      policyVersion: "3",
    }),
    "Ranked: exactly 1 CFC at risk; streak 8; next accepted win mints 34.0 CFC; same-rank opponent eligible; protocol-issued reward; policy v3.",
  );
  assert.match(
    rankedPreviewText({
      eligible: false,
      startingStreak: "8",
      anteCfc: "1",
      nextWinRewardCfc: "0.0",
      policyVersion: "3",
    }),
    /opponent not currently eligible; protocol-issued reward/,
  );
});
