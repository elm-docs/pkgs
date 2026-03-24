import type { PackageVersion } from "./packages.ts";

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
export const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
export const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
export const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const MAX_DISPLAY = 5;

export function formatLabel(pv: PackageVersion): string {
  return `${pv.org}/${pv.pkg}@${pv.version}`;
}

export function printList(title: string, color: (s: string) => string, items: PackageVersion[]): void {
  if (items.length === 0) return;

  console.log();
  console.log(color(bold(title)));
  const shown = items.slice(0, MAX_DISPLAY);
  for (const pv of shown) {
    console.log(`  ${dim("•")} ${formatLabel(pv)}`);
  }
  const remaining = items.length - shown.length;
  if (remaining > 0) {
    console.log(dim(`  … and ${remaining} more`));
  }
}

export function writeLine(msg: string): void {
  process.stdout.write(`\r\x1b[K${msg}`);
}
