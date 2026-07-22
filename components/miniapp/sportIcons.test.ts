import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FootballIcon,
  BasketballIcon,
  TennisIcon,
  HockeyIcon,
  BaseballIcon,
  VolleyballIcon,
  AmericanFootballIcon,
  GolfIcon,
  TrophyIcon,
  getSportIconComponent,
} from "./sportIcons";

test("getSportIconComponent: maps each supported sport to its own local icon component", () => {
  assert.equal(getSportIconComponent("Football"), FootballIcon);
  assert.equal(getSportIconComponent("Soccer"), FootballIcon);
  assert.equal(getSportIconComponent("Basketball"), BasketballIcon);
  assert.equal(getSportIconComponent("Tennis"), TennisIcon);
  assert.equal(getSportIconComponent("Baseball"), BaseballIcon);
  assert.equal(getSportIconComponent("Volleyball"), VolleyballIcon);
  assert.equal(getSportIconComponent("Golf"), GolfIcon);
});

test("getSportIconComponent: hockey and ice hockey variants resolve to HockeyIcon", () => {
  assert.equal(getSportIconComponent("Hockey"), HockeyIcon);
  assert.equal(getSportIconComponent("Ice Hockey"), HockeyIcon);
  assert.equal(getSportIconComponent("ice-hockey"), HockeyIcon);
  assert.equal(getSportIconComponent("ice_hockey"), HockeyIcon);
});

test("getSportIconComponent: every mapped sport resolves to a visually distinct component", () => {
  const icons = [
    getSportIconComponent("Football"),
    getSportIconComponent("Basketball"),
    getSportIconComponent("Tennis"),
    getSportIconComponent("Hockey"),
    getSportIconComponent("Baseball"),
    getSportIconComponent("Volleyball"),
    getSportIconComponent("American Football"),
    getSportIconComponent("Golf"),
  ];
  assert.equal(new Set(icons).size, icons.length);
});

test("getSportIconComponent: american football variants (spaces, hyphens, underscores, nfl) all resolve to the same icon", () => {
  assert.equal(getSportIconComponent("American Football"), AmericanFootballIcon);
  assert.equal(getSportIconComponent("american-football"), AmericanFootballIcon);
  assert.equal(getSportIconComponent("american_football"), AmericanFootballIcon);
  assert.equal(getSportIconComponent("americanfootball"), AmericanFootballIcon);
  assert.equal(getSportIconComponent("NFL"), AmericanFootballIcon);
  assert.equal(getSportIconComponent("nfl"), AmericanFootballIcon);
});

test("getSportIconComponent: is case-insensitive", () => {
  assert.equal(getSportIconComponent("football"), FootballIcon);
  assert.equal(getSportIconComponent("FOOTBALL"), FootballIcon);
  assert.equal(getSportIconComponent("FootBall"), FootballIcon);
  assert.equal(getSportIconComponent("  Tennis  "), TennisIcon);
});

test("getSportIconComponent: trims surrounding whitespace for any sport, not just the american-football aliases", () => {
  assert.equal(getSportIconComponent(" hockey "), HockeyIcon);
  assert.equal(getSportIconComponent("\tbasketball\n"), BasketballIcon);
});

test("getSportIconComponent: mixed-sport lookups stay independent per call", () => {
  // Simulates what BetTicket.tsx does per-leg in a mixed-sport EXPRESS
  // ticket — each selection's own sport resolves independently, one call
  // never affects another.
  const legs = ["Football", "Tennis", "Basketball", "Hockey"];
  const icons = legs.map(getSportIconComponent);
  assert.deepEqual(icons, [FootballIcon, TennisIcon, BasketballIcon, HockeyIcon]);
});

test("getSportIconComponent: falls back to TrophyIcon for unknown, empty, null, or undefined sport", () => {
  assert.equal(getSportIconComponent("Darts"), TrophyIcon);
  assert.equal(getSportIconComponent(""), TrophyIcon);
  assert.equal(getSportIconComponent(null), TrophyIcon);
  assert.equal(getSportIconComponent(undefined), TrophyIcon);
});
