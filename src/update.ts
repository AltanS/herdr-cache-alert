/**
 * `update` — advance this checkout and re-register it with Herdr, in one step.
 *
 * A link-mode Herdr plugin IS its on-disk git checkout, and Herdr has no
 * `plugin update` verb. Without this, updating means a hand-typed sequence of
 * `git pull`, `herdr plugin link`, and a reload — over ssh, per machine, with a
 * silent failure mode if the re-link is forgotten (Herdr caches the action set
 * at link time, so a newly added action answers `plugin_action_not_found`).
 *
 * The checkout arrives in one of TWO shapes, and they update differently:
 *
 *   `git clone` + `herdr plugin link`      → a normal clone, ON A BRANCH
 *   `herdr plugin install AltanS/herdr-cache-alert` → `git init` + `fetch --depth 1` +
 *                                            `checkout --detach`, i.e. DETACHED
 *                                            and SHALLOW, with no remote-tracking refs
 *
 * A bare `git pull --ff-only` has nothing to pull into in the second shape, so
 * one predicate — `git symbolic-ref -q HEAD` — picks the strategy.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BIN } from "./config.ts";
import { runSafe } from "./runtime.ts";
import { herdrBin } from "./herdr.ts";
import { PLUGIN_ID, pluginRoot, type Step } from "./setup.ts";

/** The command that consents to a major crossing — printed wherever one is refused. */
export const MAJOR_COMMAND = `herdr plugin action invoke update-major --plugin ${PLUGIN_ID}`;

export interface ReleaseTag {
  /** The ref name (`v1.2.3`) — we fetch by ref, because a bare sha may not be a valid want. */
  tag: string;
  version: string;
  major: number;
  commit: string;
}

const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/** The version in a `herdr-plugin.toml`, or null when it names none we can read. */
export function manifestVersion(toml: string): string | null {
  return /^\s*version\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
}

export function majorOf(version: string): number | null {
  const major = /^(\d+)\./.exec(version)?.[1];
  return major === undefined ? null : Number(major);
}

/** -1, 0, 1 over dotted versions. Non-numeric segments sort as 0. */
export function compareSemver(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * Strict `vX.Y.Z` release tags out of `git ls-remote --tags origin`.
 *
 * An ANNOTATED tag is listed twice — once at the tag object, once peeled
 * (`^{}`) at the commit it points to. The peeled line is the one that names a
 * commit, so it wins wherever both appear.
 */
export function parseRemoteTags(stdout: string): ReleaseTag[] {
  const byTag = new Map<string, { commit: string; peeled: boolean }>();
  for (const line of stdout.split("\n")) {
    const [commit, ref] = line.trim().split(/\s+/);
    if (commit === undefined || ref === undefined) continue;
    if (!ref.startsWith("refs/tags/")) continue;
    const raw = ref.slice("refs/tags/".length);
    const peeled = raw.endsWith("^{}");
    const name = peeled ? raw.slice(0, -3) : raw;
    if (!SEMVER_TAG.test(name)) continue;
    const seen = byTag.get(name);
    if (seen !== undefined && seen.peeled && !peeled) continue;
    byTag.set(name, { commit, peeled });
  }
  return [...byTag].map(([tag, { commit }]) => ({
    tag,
    version: tag.slice(1),
    major: Number(SEMVER_TAG.exec(tag)![1]),
    commit,
  }));
}

export function highestRelease(tags: readonly ReleaseTag[]): ReleaseTag | null {
  let best: ReleaseTag | null = null;
  for (const tag of tags) if (best === null || compareSemver(tag.version, best.version) > 0) best = tag;
  return best;
}

/** The newest release inside `major` — the target of a routine update. */
export function releaseInMajor(tags: readonly ReleaseTag[], major: number): ReleaseTag | null {
  return highestRelease(tags.filter((t) => t.major === major));
}

/**
 * The newest release of the NEXT major that has one — the target of `--major`.
 *
 * The next major, not the highest: an install two majors behind crosses one at a
 * time, so each crossing is the one the operator consented to and its release
 * notes are the ones that apply.
 */
export function nextMajorRelease(tags: readonly ReleaseTag[], major: number): ReleaseTag | null {
  const above = tags.filter((t) => t.major > major);
  if (!above.length) return null;
  const next = Math.min(...above.map((t) => t.major));
  return releaseInMajor(above, next);
}

export type UpdatePlan =
  | { kind: "advance"; target: ReleaseTag; crossesMajor: boolean; higher: ReleaseTag | null }
  | { kind: "current"; at: ReleaseTag; higher: ReleaseTag | null }
  | { kind: "no-release"; major: number; higher: ReleaseTag | null }
  | { kind: "no-higher-major"; major: number }
  /** The manifest named no readable version. The caller follows origin HEAD rather
   *  than strand an install on a parse failure. */
  | { kind: "unknown-version" };

/** Pure: what `update` should do, given the remote's tags and what is on disk. */
export function planUpdate(input: {
  tags: readonly ReleaseTag[];
  installed: string | null;
  /** The commit the checkout is on, or "" when git could not say. */
  head: string;
  crossMajor: boolean;
}): UpdatePlan {
  const { tags, installed, head, crossMajor } = input;
  const major = installed === null ? null : majorOf(installed);
  if (major === null || installed === null) return { kind: "unknown-version" };

  const higher = nextMajorRelease(tags, major);
  if (crossMajor) {
    return higher === null
      ? { kind: "no-higher-major", major }
      : { kind: "advance", target: higher, crossesMajor: true, higher };
  }

  const best = releaseInMajor(tags, major);
  if (best === null) return { kind: "no-release", major, higher };
  // Already there — by commit (the usual case) or by version (a rebuilt tag, a
  // manifest rolled forward ahead of its tag). Either means nothing is left to take.
  if (best.commit === head || compareSemver(best.version, installed) <= 0) {
    return { kind: "current", at: best, higher };
  }
  return { kind: "advance", target: best, crossesMajor: false, higher };
}

/** The major gate on the LINKED-CLONE path, where the target is the branch tip. */
export function majorVerdict(installed: string | null, fetched: string | null): "same" | "crosses" | "unknown" {
  const a = installed === null ? null : majorOf(installed);
  const b = fetched === null ? null : majorOf(fetched);
  if (a === null || b === null) return "unknown";
  return b > a ? "crosses" : "same";
}

const git = (root: string, args: string[]) => runSafe(["git"], ["-C", root, ...args]);

/**
 * True when the checkout has no branch — exactly how `herdr plugin install`
 * leaves it. ONE predicate decides BOTH how the checkout advances and whether it
 * is re-linked. Two detections would eventually disagree, and the disagreement
 * would be silent.
 */
export async function isManagedCheckout(root: string): Promise<boolean> {
  const { code } = await git(root, ["symbolic-ref", "-q", "HEAD"]);
  return code !== 0;
}

async function isShallow(root: string): Promise<boolean> {
  const { stdout, code } = await git(root, ["rev-parse", "--is-shallow-repository"]);
  return code === 0 && stdout.trim() === "true";
}

function installedVersion(root: string): string | null {
  const path = join(root, "herdr-plugin.toml");
  return existsSync(path) ? manifestVersion(readFileSync(path, "utf8")) : null;
}

/** Fetch `ref` and re-detach onto it, the way Herdr got this checkout here. */
async function detachOnto(root: string, ref: string): Promise<Step> {
  // `--depth 1` ONLY when already shallow, so an update never truncates the
  // history of a full clone that someone happens to have detached.
  const fetch = (await isShallow(root))
    ? ["fetch", "--depth", "1", "origin", ref]
    : ["fetch", "origin", ref];
  const fetched = await git(root, fetch);
  if (fetched.code !== 0) return { ok: false, what: "checkout", detail: `git fetch failed: ${fetched.stderr.trim()}` };

  // `--force` because a dirty tree would refuse the checkout and re-break the
  // very update path this exists to fix. `-q` because checkout otherwise warns
  // "you are leaving 1 commit behind" every time: true, alarming, and useless —
  // the commit left behind is the release just replaced.
  const out = await git(root, ["checkout", "-q", "--detach", "--force", "FETCH_HEAD"]);
  if (out.code !== 0) return { ok: false, what: "checkout", detail: `git checkout failed: ${out.stderr.trim()}` };

  const head = await git(root, ["log", "-1", "--format=%h %s"]);
  return { ok: true, what: "checkout", detail: `now at ${head.stdout.trim()}` };
}

/** A linked clone keeps its branch and its `--ff-only` pull; the gate runs BEFORE the pull. */
async function advanceLinked(root: string, installed: string | null, crossMajor: boolean): Promise<Step> {
  const fetched = await git(root, ["fetch", "origin"]);
  if (fetched.code !== 0) return { ok: false, what: "checkout", detail: `git fetch failed: ${fetched.stderr.trim()}` };

  // Judge exactly the commit the pull will land on: the current branch's OWN
  // upstream, not origin HEAD. On a clone kept on a maintenance branch those are
  // different commits, and a gate that judged one while the pull took the other
  // would refuse a fast-forward that never leaves the major.
  const upstream = await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const ref = upstream.code === 0 ? upstream.stdout.trim() : "";
  if (ref) {
    const show = await git(root, ["show", `${ref}:herdr-plugin.toml`]);
    if (!crossMajor && majorVerdict(installed, manifestVersion(show.stdout)) === "crosses") {
      const target = manifestVersion(show.stdout);
      return {
        ok: true,
        what: "checkout",
        detail: `held at ${installed} — ${ref} is ${target}, which crosses a MAJOR. Nothing was pulled. Read the release notes, then: ${MAJOR_COMMAND}`,
      };
    }
  }

  const pulled = await git(root, ["pull", "--ff-only"]);
  if (pulled.code !== 0) return { ok: false, what: "checkout", detail: `git pull --ff-only failed: ${pulled.stderr.trim()}` };
  const head = await git(root, ["log", "-1", "--format=%h %s"]);
  return { ok: true, what: "checkout", detail: `now at ${head.stdout.trim()}` };
}

/**
 * A Herdr-managed checkout is detached, so it is re-detached onto the newest
 * RELEASE TAG of the major it is on — never onto whatever the default branch
 * happens to say right now.
 */
async function advanceManaged(root: string, installed: string | null, crossMajor: boolean): Promise<Step> {
  const ls = await git(root, ["ls-remote", "--tags", "origin"]);
  if (ls.code !== 0) {
    return { ok: false, what: "checkout", detail: "could not list upstream release tags — is the remote reachable?" };
  }
  const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  const plan = planUpdate({ tags: parseRemoteTags(ls.stdout), installed, head, crossMajor });

  switch (plan.kind) {
    case "unknown-version":
      // A checkout that cannot name its major cannot be gated on one either.
      return detachOnto(root, "HEAD");
    case "no-higher-major":
      return { ok: true, what: "checkout", detail: `no release above major ${plan.major} exists yet` };
    case "no-release":
      return { ok: true, what: "checkout", detail: `no release of major ${plan.major} yet — left where it is` };
    case "current":
      return { ok: true, what: "checkout", detail: `already at v${plan.at.version}, the newest release of major ${plan.at.major}` };
    case "advance":
      return detachOnto(root, `refs/tags/${plan.target.tag}`);
  }
}

/**
 * Re-register the plugin so Herdr learns any action the update added.
 *
 * NEVER on a Herdr-managed checkout: `plugin link` re-registers it with
 * `source.kind = local`, after which Herdr REFUSES `plugin install` ("already
 * linked from a local path") — taking away the reinstall that is the operator's
 * only other way to repair the install. Best-effort otherwise: a failure prints
 * the command rather than failing the update.
 */
export async function refreshRegistry(root: string): Promise<Step> {
  if (await isManagedCheckout(root)) {
    return { ok: true, what: "registry", detail: "Herdr-managed install — left alone (a re-link would block `herdr plugin install`)" };
  }
  const bin = herdrBin();
  const { code } = await runSafe([bin], ["plugin", "link", root]);
  if (code === 0) return { ok: true, what: "registry", detail: "re-linked — new actions are invokable now" };
  return { ok: true, what: "registry", detail: `could not re-link (is the Herdr server running, and is \`herdr\` reachable?) — run: herdr plugin link "${root}"` };
}

export interface UpdateOptions {
  /** The consent for a MAJOR crossing. The flag IS the consent; there is no prompt. */
  major: boolean;
}

/** `--major` anywhere in argv. */
export function wantsMajor(args: readonly string[]): boolean {
  return args.includes("--major");
}

/**
 * Advance the checkout, then re-register it. Reports every step, failed ones
 * included — the same shape `setup` uses, so both read alike.
 */
export async function update(options: UpdateOptions = { major: false }): Promise<Step[]> {
  const root = pluginRoot();

  const isRepo = await git(root, ["rev-parse", "--git-dir"]);
  if (isRepo.code !== 0) {
    return [
      {
        ok: false,
        what: "checkout",
        detail: `${root} is not a git checkout — reinstall it with \`herdr plugin install AltanS/herdr-cache-alert --yes\``,
      },
    ];
  }

  const before = installedVersion(root);
  const advanced = (await isManagedCheckout(root))
    ? await advanceManaged(root, before, options.major)
    : await advanceLinked(root, before, options.major);
  if (!advanced.ok) return [advanced];

  const steps = [advanced, await refreshRegistry(root)];

  // `setup` is idempotent, but running it unasked would also restart the
  // watcher mid-update. Say the version moved and let the operator decide.
  const after = installedVersion(root);
  if (after !== null && before !== null && after !== before) {
    steps.push({ ok: true, what: "version", detail: `${before} → ${after} — run \`${BIN} setup\` to pick up any new action` });
  }
  return steps;
}
