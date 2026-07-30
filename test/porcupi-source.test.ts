import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const patchPath = "patches/0001-add-observational-memory-core-capabilities.patch";
const piBaseCommit = "20be4b18d4c57487f8993d2762bace129f0cf7c6";

describe("PorcuPi Source Repository contract", () => {
  it("publishes the loadable TypeScript extension and its required Patch", () => {
    const packageManifest = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8"),
    ) as {
      files: string[];
      pi: { extensions: string[] };
      peerDependencies: Record<string, string>;
    };
    const porcupiManifest = JSON.parse(
      readFileSync(resolve(root, "porcupi.json"), "utf8"),
    ) as {
      schemaVersion: number;
      patches: Array<{
        path: string;
        description: string;
        supportedPiBaseVersions: string[];
        supportedPiBaseCommits: string[];
      }>;
    };

    expect(packageManifest.files).toContain("src");
    expect(packageManifest.pi.extensions).toEqual(["./src/index.ts"]);
    expect(packageManifest.peerDependencies).toMatchObject({
      "@earendil-works/pi-ai": "*",
      "@earendil-works/pi-coding-agent": "*",
    });
    expect(lstatSync(resolve(root, "src/index.ts")).isFile()).toBe(true);
    expect(porcupiManifest).toMatchObject({
      schemaVersion: 1,
      patches: [
        {
          path: patchPath,
          supportedPiBaseVersions: ["v0.81.1"],
          supportedPiBaseCommits: [piBaseCommit],
        },
      ],
    });
    expect(porcupiManifest.patches[0]?.description).toContain(
      "Required by src/index.ts",
    );
    expect(lstatSync(resolve(root, patchPath)).isFile()).toBe(true);
    expect(readFileSync(resolve(root, patchPath), "utf8")).toContain(
      "diff --git a/packages/coding-agent/",
    );
  });
});
