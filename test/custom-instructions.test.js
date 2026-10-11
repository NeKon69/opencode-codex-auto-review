import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_CUSTOM_INSTRUCTION_SOURCE_CHARS,
  loadCustomInstructions,
  resolveGlobalPolicyPath,
} from "../src/custom-instructions.js";

async function withTempDirectory(run) {
  const directory = await mkdtemp(join("/tmp", "codex-auto-review-policy-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("loads always and project policy files into separate bounded scopes", async () => {
  await withTempDirectory(async (directory) => {
    const configDirectory = join(directory, "config", "opencode");
    const globalPolicyPath = join(configDirectory, "codex-auto-review.md");
    const projectDirectory = join(directory, "repo");
    const projectPolicyPath = join(projectDirectory, ".opencode", "codex-auto-review.md");
    await mkdir(configDirectory, { recursive: true });
    await mkdir(join(projectDirectory, ".opencode"), { recursive: true });
    await writeFile(globalPolicyPath, "Never approve outbound network access.\n");
    await writeFile(projectPolicyPath, "Only run this repository's tests when requested.\n");

    assert.deepEqual(await loadCustomInstructions({ projectDirectory, globalPolicyPath }), {
      global: "Never approve outbound network access.",
      project: "Only run this repository's tests when requested.",
    });
  });
});

test("omits absent policy files without searching parent directories", async () => {
  await withTempDirectory(async (directory) => {
    const projectDirectory = join(directory, "repo");
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(join(directory, "codex-auto-review.md"), "Parent policy must not leak into child projects.");

    assert.deepEqual(await loadCustomInstructions({
      projectDirectory,
      globalPolicyPath: join(directory, "config", "codex-auto-review.md"),
    }), { global: "", project: "" });
  });
});

test("rejects policy symlinks that escape their owning scope", async () => {
  await withTempDirectory(async (directory) => {
    const projectDirectory = join(directory, "repo");
    const outsidePolicy = join(directory, "outside-policy.md");
    const projectPolicyPath = join(projectDirectory, ".opencode", "codex-auto-review.md");
    await mkdir(join(projectDirectory, ".opencode"), { recursive: true });
    await writeFile(outsidePolicy, "Do not include external files.");
    await symlink(outsidePolicy, projectPolicyPath);

    await assert.rejects(
      loadCustomInstructions({ projectDirectory, globalPolicyPath: join(directory, "missing.md") }),
      /symbolic links are not allowed/i,
    );
  });
});

test("rejects oversized custom policy files instead of silently truncating them", async () => {
  await withTempDirectory(async (directory) => {
    const globalPolicyPath = join(directory, "config", "codex-auto-review.md");
    await mkdir(join(directory, "config"), { recursive: true });
    await writeFile(globalPolicyPath, "x".repeat(MAX_CUSTOM_INSTRUCTION_SOURCE_CHARS + 1));

    await assert.rejects(
      loadCustomInstructions({ globalPolicyPath }),
      /exceed the configured limit/i,
    );
  });
});

test("resolves the always policy under OpenCode's XDG config directory", () => {
  assert.equal(
    resolveGlobalPolicyPath({ xdgConfigHome: "/custom/config", homeDirectory: "/home/example" }),
    "/custom/config/opencode/codex-auto-review.md",
  );
  assert.equal(
    resolveGlobalPolicyPath({ xdgConfigHome: "relative", homeDirectory: "/home/example" }),
    "/home/example/.config/opencode/codex-auto-review.md",
  );
  assert.equal(resolveGlobalPolicyPath({ homeDirectory: "/home/example" }),
    "/home/example/.config/opencode/codex-auto-review.md");
});
