/**
 * How `setup` and `uninstall` talk to the operator.
 *
 * House style across the Herdr plugins in this family, and each part earns its
 * place:
 *
 *   ✓ green   the step is done, or was already done
 *   · dim     nothing needed doing — a re-run should read as quiet, not as work
 *   ! yellow  NEEDS YOU. Never a red ✗ for this: the step did not fail, it found
 *             something of yours and refused to touch it. Red says "broken" and
 *             sends people looking for a bug that is not there.
 *
 * Every `!` line carries its own remedy in the same string. A message that names
 * the problem and not the fix makes the operator go and read the source.
 *
 * COLOUR IS OPTIONAL AND THE LAYOUT DOES NOT DEPEND ON IT. `NO_COLOR`, a pipe, or
 * a dumb terminal all drop the escapes and the marks still read.
 */

import type { Step } from "./config-toml.ts";

const plain = process.env.NO_COLOR !== undefined || process.env.TERM === "dumb" || !process.stdout.isTTY;

const paint = (code: string, text: string) => (plain ? text : `[${code}m${text}[0m`);
export const bold = (text: string) => paint("1", text);
export const dim = (text: string) => paint("2", text);
const green = (text: string) => paint("32", text);
const yellow = (text: string) => paint("33", text);

/** The widest `what` in a run, so the details line up without a table library. */
function pad(steps: readonly Step[]): number {
  return steps.reduce((n, step) => Math.max(n, step.what.length), 0);
}

export function stepLine(step: Step, width: number): string {
  const label = step.what.padEnd(width);
  if (!step.ok) return `${yellow("!")} ${bold(label)}  ${step.detail}`;
  if (step.skipped === true) return `${dim("·")} ${dim(label)}  ${dim(step.detail)}`;
  return `${green("✓")} ${bold(label)}  ${step.detail}`;
}

/**
 * Prints a run and returns its exit code: 1 if any step needs the operator.
 *
 * `notes` is the closing paragraph — what to press, what was kept, what to do
 * next. It is dim, because it is context rather than result.
 */
export function report(steps: readonly Step[], notes: readonly string[] = []): number {
  const width = pad(steps);
  for (const step of steps) console.log(stepLine(step, width));
  if (notes.length > 0) {
    console.log("");
    for (const note of notes) console.log(dim(note));
  }
  return steps.every((step) => step.ok) ? 0 : 1;
}
