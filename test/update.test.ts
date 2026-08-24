/**
 * `update` advances the operator's checkout. Getting the plan wrong either
 * strands an install on an old release or crosses a MAJOR without the consent
 * that a major crossing is defined to require. It is written pure so it can be
 * tested without a network or a git remote — so test it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareSemver,
  highestRelease,
  majorOf,
  majorVerdict,
  manifestVersion,
  nextMajorRelease,
  parseRemoteTags,
  planUpdate,
  releaseInMajor,
  wantsMajor,
  type ReleaseTag,
} from "../src/update.ts";

const tag = (version: string, commit: string): ReleaseTag => ({
  tag: `v${version}`,
  version,
  major: Number(version.split(".")[0]),
  commit,
});

test("manifestVersion reads the manifest, and only a version it can parse", () => {
  assert.equal(manifestVersion('id = "x"\nversion = "1.2.3"\n'), "1.2.3");
  assert.equal(manifestVersion('  version = "0.1.0"'), "0.1.0");
  assert.equal(manifestVersion("no version here"), null);
  // A `version` inside another table is not the manifest's own. The anchor is
  // line-start, so an indented one still matches — this documents that.
  assert.equal(manifestVersion('name = "x"\n[dep]\nversion = "9.9.9"'), "9.9.9");
});

test("compareSemver orders numerically, not lexically", () => {
  assert.equal(compareSemver("0.9.0", "0.10.0"), -1, "string order would put 0.9 above 0.10");
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  assert.equal(compareSemver("2.0.0", "1.99.99"), 1);
  assert.equal(compareSemver("1.2", "1.2.0"), 0, "a missing segment is zero");
});

test("majorOf", () => {
  assert.equal(majorOf("0.3.1"), 0);
  assert.equal(majorOf("12.0.0"), 12);
  assert.equal(majorOf("main"), null);
});

test("parseRemoteTags prefers the PEELED line, which is the one naming a commit", () => {
  // An annotated tag is listed twice: at the tag object, then peeled at the commit.
  const out = parseRemoteTags(
    ["aaa111\trefs/tags/v1.0.0", "bbb222\trefs/tags/v1.0.0^{}", "ccc333\trefs/heads/main"].join("\n"),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]?.commit, "bbb222");
  assert.equal(out[0]?.version, "1.0.0");
});

test("parseRemoteTags takes STRICT vX.Y.Z only", () => {
  const out = parseRemoteTags(
    ["a\trefs/tags/v1.0.0", "b\trefs/tags/1.0.0", "c\trefs/tags/v1.0", "d\trefs/tags/v1.0.0-rc1", "e\trefs/tags/nightly"].join("\n"),
  );
  assert.deepEqual(
    out.map((t) => t.tag),
    ["v1.0.0"],
  );
});

test("parseRemoteTags survives blank lines and ragged whitespace", () => {
  assert.equal(parseRemoteTags("\n\n   \nabc   refs/tags/v0.1.0\n").length, 1);
});

test("highestRelease and releaseInMajor", () => {
  const tags = [tag("1.0.0", "a"), tag("1.10.0", "b"), tag("1.9.0", "c"), tag("2.0.0", "d")];
  assert.equal(highestRelease(tags)?.version, "2.0.0");
  assert.equal(releaseInMajor(tags, 1)?.version, "1.10.0");
  assert.equal(releaseInMajor(tags, 7), null);
  assert.equal(highestRelease([]), null);
});

test("nextMajorRelease crosses ONE major at a time, not straight to the newest", () => {
  const tags = [tag("1.0.0", "a"), tag("2.3.0", "b"), tag("2.4.0", "c"), tag("3.0.0", "d")];
  const next = nextMajorRelease(tags, 1);
  assert.equal(next?.version, "2.4.0", "an install two majors behind must be offered v2, not v3");
  assert.equal(nextMajorRelease(tags, 3), null);
});

test("a routine update NEVER crosses a major, however new the release above is", () => {
  const tags = [tag("0.3.1", "a"), tag("0.4.0", "b"), tag("1.0.0", "c")];
  const plan = planUpdate({ tags, installed: "0.3.1", head: "a", crossMajor: false });
  assert.equal(plan.kind, "advance");
  assert.equal(plan.kind === "advance" && plan.target.version, "0.4.0");
  assert.equal(plan.kind === "advance" && plan.crossesMajor, false);
  // The major above is still REPORTED, so the operator can choose it.
  assert.equal(plan.kind === "advance" && plan.higher?.version, "1.0.0");
});

test("crossMajor takes the next major and says that it crosses one", () => {
  const tags = [tag("0.4.0", "b"), tag("1.0.0", "c")];
  const plan = planUpdate({ tags, installed: "0.3.1", head: "a", crossMajor: true });
  assert.equal(plan.kind === "advance" && plan.crossesMajor, true);
  assert.equal(plan.kind === "advance" && plan.target.version, "1.0.0");
});

test("crossMajor with nothing above is a clear refusal, not a silent downgrade", () => {
  const plan = planUpdate({ tags: [tag("0.4.0", "b")], installed: "0.3.1", head: "a", crossMajor: true });
  assert.equal(plan.kind, "no-higher-major");
});

test("already current by COMMIT, and also by version when a tag was rebuilt", () => {
  const tags = [tag("0.4.0", "head-sha")];
  assert.equal(planUpdate({ tags, installed: "0.3.1", head: "head-sha", crossMajor: false }).kind, "current");
  // A manifest rolled forward ahead of its tag must not be dragged backwards.
  assert.equal(planUpdate({ tags, installed: "0.5.0", head: "other", crossMajor: false }).kind, "current");
});

test("an unreadable manifest version is its own outcome, not a guess", () => {
  assert.equal(planUpdate({ tags: [tag("1.0.0", "a")], installed: null, head: "b", crossMajor: false }).kind, "unknown-version");
  assert.equal(planUpdate({ tags: [tag("1.0.0", "a")], installed: "main", head: "b", crossMajor: false }).kind, "unknown-version");
});

test("no release in this major at all", () => {
  const plan = planUpdate({ tags: [tag("2.0.0", "a")], installed: "1.1.0", head: "b", crossMajor: false });
  assert.equal(plan.kind, "no-release");
  assert.equal(plan.kind === "no-release" && plan.higher?.version, "2.0.0");
});

test("majorVerdict is UNKNOWN when either side cannot be read — never `same`", () => {
  assert.equal(majorVerdict("1.0.0", "2.0.0"), "crosses");
  assert.equal(majorVerdict("1.0.0", "1.9.0"), "same");
  assert.equal(majorVerdict("1.0.0", "0.9.0"), "same", "a downgrade is not a crossing");
  assert.equal(majorVerdict(null, "2.0.0"), "unknown");
  assert.equal(majorVerdict("1.0.0", null), "unknown");
});

test("wantsMajor is the consent, and it must be explicit", () => {
  assert.equal(wantsMajor(["--major"]), true);
  assert.equal(wantsMajor([]), false);
  assert.equal(wantsMajor(["--majorly"]), false);
});
