import { stat } from "node:fs/promises";
import { join } from "node:path";

export const CONTENT_DIR = join(import.meta.dirname!, "..", "content");
export const PACKAGES_DIR = join(CONTENT_DIR, "packages");
export const BASE_URL = "https://package.elm-lang.org";

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface PackageVersion {
  org: string;
  pkg: string;
  version: string;
}

export function parsePackageString(raw: string): PackageVersion {
  const [orgPkg, version] = raw.split("@");
  const [org, pkg] = orgPkg.split("/");
  return { org, pkg, version };
}

export function versionDir(pv: PackageVersion): string {
  return join(PACKAGES_DIR, pv.org, pv.pkg, pv.version);
}
