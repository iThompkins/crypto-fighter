import test from "node:test";
import assert from "node:assert/strict";
import { rankedPreviewText } from "../src/ranked.ts";

test("ranked preview plainly states risk, streak, reward, eligibility and reserve", () => {
  assert.equal(
    rankedPreviewText({
      eligible: true,
      rewardFunded: true,
      startingStreak: "8",
      anteCfc: "1",
      nextWinRewardCfc: "34.0",
      policyVersion: "3",
    }),
    "Ranked: exactly 1 CFC at risk; streak 8; next win pays 34.0 CFC; same-rank opponent eligible; reward reserved on confirmation; policy v3.",
  );
  assert.match(
    rankedPreviewText({
      eligible: false,
      rewardFunded: false,
      startingStreak: "8",
      anteCfc: "1",
      nextWinRewardCfc: "0.0",
      policyVersion: "3",
    }),
    /opponent not currently eligible; reward reserve currently insufficient/,
  );
});
