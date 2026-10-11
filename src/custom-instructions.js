import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export const MAX_CUSTOM_INSTRUCTION_SOURCE_CHARS = 4_000;
export const MAX_CUSTOM_INSTRUCTION_CHARS = MAX_CUSTOM_INSTRUCTION_SOURCE_CHARS * 2;
export const GLOBAL_POLICY_FILENAME = "codex-auto-review.md";
export const PROJECT_POLICY_RELATIVE_PATH = join(".opencode", GLOBAL_POLICY_FILENAME);

const MAX_POLICY_FILE_BYTES = MAX_CUSTOM_INSTRUCTION_SOURCE_CHARS * 4;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

export function resolveGlobalPolicyPath({
  xdgConfigHome = process.env.XDG_CONFIG_HOME,
  homeDirectory = homedir(),
} = {}) {
  const configHome = typeof xdgConfigHome === "string" && isAbsolute(xdgConfigHome)
    ? xdgConfigHome
    : join(homeDirectory, ".config");
  return join(configHome, "opencode", GLOBAL_POLICY_FILENAME);
}

/** Load the user-wide policy and exactly one project-root policy file. */
export async function loadCustomInstructions({
  projectDirectory,
  globalPolicyPath = resolveGlobalPolicyPath(),
} = {}) {
  if (typeof globalPolicyPath !== "string" || !isAbsolute(globalPolicyPath)) {
    throw new TypeError("global reviewer policy path must be absolute");
  }
  if (projectDirectory !== undefined && projectDirectory !== null &&
      (typeof projectDirectory !== "string" || !isAbsolute(projectDirectory))) {
    throw new TypeError("project reviewer policy root must be absolute");
  }

  const global = await readOptionalPolicy(globalPolicyPath, dirname(globalPolicyPath));
  const project = projectDirectory
    ? await readOptionalPolicy(join(projectDirectory, PROJECT_POLICY_RELATIVE_PATH), projectDirectory)
    : "";
  if (global.length + project.length > MAX_CUSTOM_INSTRUCTION_CHARS) {
    throw new Error("custom reviewer policy files exceed the configured limit");
  }
  return { global, project };
}

async function readOptionalPolicy(filePath, owningRoot) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw new Error("custom reviewer policy could not be inspected");
  }
  if (metadata.isSymbolicLink()) {
    throw new Error("custom reviewer policy symbolic links are not allowed");
  }
  if (!metadata.isFile()) {
    throw new Error("custom reviewer policy must be a regular file");
  }
  if (metadata.size > MAX_POLICY_FILE_BYTES) {
    throw new Error("custom reviewer policy files exceed the configured limit");
  }

  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_POLICY_FILE_BYTES) {
      throw new Error("custom reviewer policy files exceed the configured limit");
    }
    const [rootPath, actualPath] = await Promise.all([realpath(owningRoot), realpath(filePath)]);
    if (!isPathInside(rootPath, actualPath)) {
      throw new Error("custom reviewer policy resolves outside its owning scope");
    }
    const text = await handle.readFile({ encoding: "utf8" });
    if (text.length > MAX_CUSTOM_INSTRUCTION_SOURCE_CHARS ||
        Buffer.byteLength(text, "utf8") > MAX_POLICY_FILE_BYTES) {
      throw new Error("custom reviewer policy files exceed the configured limit");
    }
    return text.trim();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("custom reviewer policy")) throw error;
    throw new Error("custom reviewer policy could not be read");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function isPathInside(rootPath, candidatePath) {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}
