import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IconBallFootball,
  IconBallBasketball,
  IconBallTennis,
  IconBallBaseball,
  IconBallVolleyball,
  IconBallAmericanFootball,
  IconGolf,
  IconTrophy,
} from "@tabler/icons-react";
import { getSportIconComponent, HockeyPuckIcon } from "./sportIcons";

test("getSportIconComponent: maps each supported sport to its Tabler icon", () => {
  assert.equal(getSportIconComponent("Football"), IconBallFootball);
  assert.equal(getSportIconComponent("Soccer"), IconBallFootball);
  assert.equal(getSportIconComponent("Basketball"), IconBallBasketball);
  assert.equal(getSportIconComponent("Tennis"), IconBallTennis);
  assert.equal(getSportIconComponent("Baseball"), IconBallBaseball);
  assert.equal(getSportIconComponent("Volleyball"), IconBallVolleyball);
  assert.equal(getSportIconComponent("Golf"), IconGolf);
});

test("getSportIconComponent: hockey resolves to the local HockeyPuckIcon (no Tabler puck icon exists)", () => {
  assert.equal(getSportIconComponent("Hockey"), HockeyPuckIcon);
});

test("getSportIconComponent: american football variants (spaces, hyphens, underscores, nfl) all resolve to the same icon", () => {
  assert.equal(getSportIconComponent("American Football"), IconBallAmericanFootball);
  assert.equal(getSportIconComponent("american-football"), IconBallAmericanFootball);
  assert.equal(getSportIconComponent("american_football"), IconBallAmericanFootball);
  assert.equal(getSportIconComponent("americanfootball"), IconBallAmericanFootball);
  assert.equal(getSportIconComponent("NFL"), IconBallAmericanFootball);
  assert.equal(getSportIconComponent("nfl"), IconBallAmericanFootball);
});

test("getSportIconComponent: is case-insensitive", () => {
  assert.equal(getSportIconComponent("football"), IconBallFootball);
  assert.equal(getSportIconComponent("FOOTBALL"), IconBallFootball);
  assert.equal(getSportIconComponent("FootBall"), IconBallFootball);
  assert.equal(getSportIconComponent("  Tennis  "), IconBallTennis);
});

test("getSportIconComponent: trims surrounding whitespace for any sport, not just the american-football aliases", () => {
  assert.equal(getSportIconComponent(" hockey "), HockeyPuckIcon);
  assert.equal(getSportIconComponent("\tbasketball\n"), IconBallBasketball);
});

test("getSportIconComponent: mixed-sport lookups stay independent per call", () => {
  // Simulates what BetTicket.tsx does per-leg in a mixed-sport EXPRESS
  // ticket — each selection's own sport resolves independently, one call
  // never affects another.
  const legs = ["Football", "Tennis", "Basketball", "Hockey"];
  const icons = legs.map(getSportIconComponent);
  assert.deepEqual(icons, [IconBallFootball, IconBallTennis, IconBallBasketball, HockeyPuckIcon]);
});

test("getSportIconComponent: falls back to IconTrophy for unknown, empty, null, or undefined sport", () => {
  assert.equal(getSportIconComponent("Darts"), IconTrophy);
  assert.equal(getSportIconComponent(""), IconTrophy);
  assert.equal(getSportIconComponent(null), IconTrophy);
  assert.equal(getSportIconComponent(undefined), IconTrophy);
});
