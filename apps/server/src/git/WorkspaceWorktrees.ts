/**
 * Isolated runs in a multi-repo project get a container mirroring the project: one worktree per
 * repository at its relative path plus links to the project's other entries, so shared
 * instructions resolve as in the project. The thread's worktree path is the container.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's symlink has no type argument, and Windows needs a junction to link without elevation.
import * as NodeFSP from "node:fs/promises";

import { GitCommandError, type ProjectId, type VcsRepository } from "@t3tools/contracts";
import {
  flattenTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  WORKTREE_BRANCH_PREFIX,
} from "@t3tools/shared/git";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as WorkspaceRepositories from "../workspace/WorkspaceRepositories.ts";
import { managedWorktreesDirectories, resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import * as GitManager from "./GitManager.ts";

export interface CreateWorkspaceWorktreeInput {
  readonly workspaceRoot: string;
  /** Resolves the project's worktree settings, such as submodules. */
  readonly projectId: ProjectId | null;
  readonly repositories: ReadonlyArray<VcsRepository>;
  readonly branch: string;
  /** Fetch each repository's default branch and start from the remote's copy. */
  readonly startFromOrigin: boolean;
}

export class WorkspaceWorktrees extends Context.Service<
  WorkspaceWorktrees,
  {
    /**
     * Create a container with a worktree per repository, each started from its repository's
     * default branch. The container is reported as soon as it exists so a caller can remove a
     * partial one with `remove` if a later repository fails.
     */
    readonly create: (
      input: CreateWorkspaceWorktreeInput,
      options?: { readonly onContainerClaimed?: (path: string) => Effect.Effect<void> },
    ) => Effect.Effect<{ readonly path: string; readonly branch: string }, GitCommandError>;
    /** Rename the branch in every repository; the first repository decides the final name. */
    readonly renameBranch: (input: {
      readonly path: string;
      readonly oldBranch: string;
      readonly newBranch: string;
      readonly exactName?: boolean;
    }) => Effect.Effect<{ readonly branch: string }, GitCommandError>;
    /** Whether `path` is a container this service created. */
    readonly isContainer: (path: string) => Effect.Effect<boolean>;
    /**
     * Remove every repository's worktree, then the links and folders the container added.
     * Anything else left in the container is kept for the user.
     */
    readonly remove: (input: {
      readonly workspaceRoot: string;
      readonly path: string;
      readonly force: boolean;
    }) => Effect.Effect<void, GitCommandError>;
  }
>()("t3/git/WorkspaceWorktrees") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const workspaceRepositories = yield* WorkspaceRepositories.WorkspaceRepositories;

  const fail = (operation: string, cwd: string, detail: string, cause?: unknown) =>
    new GitCommandError({ operation, command: "worktree", cwd, detail, cause });

  const join = (root: string, relativePath: string) => path.join(root, ...relativePath.split("/"));

  // Containers made under an earlier worktree location stay removable after the setting moves.
  const isInsideWorktreesDir = Effect.fn("WorkspaceWorktrees.isInsideWorktreesDir")(function* (
    target: string,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => ({ worktreesDirectory: "", previousWorktreesDirectories: [] })),
    );
    const home = yield* HostProcess.HomeDirectory;
    return managedWorktreesDirectories(settings, config.worktreesDir, path, home).some(
      (directory) => {
        const relative = path.relative(directory, target);
        return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
      },
    );
  });

  const hasCommit = (cwd: string, refName: string) =>
    git
      .execute({
        operation: "WorkspaceWorktrees.hasCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", `${refName}^{commit}`],
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((result) => result.exitCode === 0));

  // The repository's default branch (from its primary remote), or its current checkout.
  const resolveStart = Effect.fn("WorkspaceWorktrees.resolveStart")(function* (
    cwd: string,
    startFromOrigin: boolean,
  ) {
    const remote = yield* git.resolvePrimaryRemoteName(cwd).pipe(Effect.option);
    const defaultBranch =
      remote._tag === "None"
        ? null
        : yield* git
            .resolveDefaultBranchName(cwd, remote.value)
            .pipe(Effect.orElseSucceed(() => null));
    if (remote._tag === "Some" && defaultBranch !== null && startFromOrigin) {
      yield* git.fetchRemote({ cwd, remoteName: remote.value, refName: defaultBranch });
      if (
        yield* git.remoteBranchExists({ cwd, remoteName: remote.value, refName: defaultBranch })
      ) {
        const tracking = yield* git.resolveRemoteTrackingCommit({
          cwd,
          refName: defaultBranch,
          fallbackRemoteName: remote.value,
        });
        return { startRef: tracking.commitSha, baseRef: defaultBranch };
      }
    }
    if (defaultBranch !== null && (yield* hasCommit(cwd, defaultBranch))) {
      return { startRef: defaultBranch, baseRef: defaultBranch };
    }
    return { startRef: "HEAD", baseRef: "HEAD" };
  });

  // Links are a convenience, so a platform that refuses one only loses that entry. With a
  // `.code-workspace` file only its listed folders are linked, plus top-level files and
  // dot-folders, which usually hold workspace-wide configuration; without one, every top-level
  // entry is. Folders holding or inside a repository are left for the worktrees.
  const linkSharedEntries = Effect.fn("WorkspaceWorktrees.linkSharedEntries")(function* (
    workspaceRoot: string,
    container: string,
  ) {
    const layout = yield* workspaceRepositories.describe(workspaceRoot);
    const platform = yield* HostProcess.Platform;
    const overlapsRepository = (entry: string) =>
      layout.repositories.some(
        ({ relativePath }) =>
          relativePath === entry ||
          relativePath.startsWith(`${entry}/`) ||
          entry.startsWith(`${relativePath}/`),
      );
    const isDirectory = (target: string) =>
      fileSystem.stat(target).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
    const entries = new Map<string, boolean>();
    for (const name of yield* fileSystem
      .readDirectory(workspaceRoot)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))) {
      if (overlapsRepository(name)) continue;
      const directory = yield* isDirectory(path.join(workspaceRoot, name));
      if (layout.listedFolders === null || name.startsWith(".") || !directory) {
        entries.set(name, directory);
      }
    }
    for (const folder of (layout.listedFolders ?? []).toSorted()) {
      const linkedAbove = [...entries.keys()].some(
        (entry) => folder === entry || folder.startsWith(`${entry}/`),
      );
      if (linkedAbove || overlapsRepository(folder)) continue;
      if (yield* isDirectory(join(workspaceRoot, folder))) entries.set(folder, true);
    }
    for (const [entry, directory] of entries) {
      const target = join(workspaceRoot, entry);
      const link = join(container, entry);
      yield* Effect.gen(function* () {
        yield* fileSystem.makeDirectory(path.dirname(link), { recursive: true });
        // Junctions need no symlink privilege on Windows; file links still do.
        if (directory && platform === "win32") {
          yield* Effect.tryPromise(() => NodeFSP.symlink(target, link, "junction"));
        } else {
          yield* fileSystem.symlink(target, link);
        }
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not link a workspace entry into an isolated run", {
            container,
            entry,
            cause,
          }),
        ),
      );
    }
  });

  const create: WorkspaceWorktrees["Service"]["create"] = Effect.fn("WorkspaceWorktrees.create")(
    function* (input, options) {
      const operation = "WorkspaceWorktrees.create";
      // A plain `t3` branch in any repository blocks `t3/*`, so all of them use `t3-<hash>`.
      let branch = input.branch;
      if (isTemporaryWorktreeBranch(branch)) {
        for (const repository of input.repositories) {
          const cwd = join(input.workspaceRoot, repository.relativePath);
          if (yield* hasCommit(cwd, `refs/heads/${WORKTREE_BRANCH_PREFIX}`)) {
            branch = flattenTemporaryWorktreeBranchName(branch);
            break;
          }
        }
      }
      const settings = yield* serverSettings.getSettings.pipe(Effect.option);
      const worktreesDirectory = settings._tag === "Some" ? settings.value.worktreesDirectory : "";
      const parentDir = resolveWorktreesDirectory(
        worktreesDirectory,
        config.worktreesDir,
        path,
        yield* HostProcess.HomeDirectory,
      );
      if (parentDir === null) {
        return yield* fail(
          operation,
          input.workspaceRoot,
          `The worktree location "${worktreesDirectory}" must be an absolute folder on this machine, not a drive root. Change it in Settings → Worktrees.`,
        );
      }
      const submodules =
        settings._tag === "Some"
          ? resolveProjectSettings(settings.value, input.projectId).settings.worktreeSubmodules
          : null;
      const container = path.join(
        parentDir,
        path.basename(input.workspaceRoot),
        branch.replace(/\//g, "-"),
      );
      if (yield* fileSystem.exists(container).pipe(Effect.orElseSucceed(() => true))) {
        return yield* fail(operation, input.workspaceRoot, `${container} already exists.`);
      }
      yield* fileSystem
        .makeDirectory(container, { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            fail(operation, input.workspaceRoot, `Could not create ${container}.`, cause),
          ),
        );
      if (options?.onContainerClaimed) yield* options.onContainerClaimed(container);
      // Link first: a `.code-workspace` link tells `remove` which folders to clean up if a
      // repository below fails.
      yield* linkSharedEntries(input.workspaceRoot, container);
      for (const repository of input.repositories) {
        const repositoryCwd = join(input.workspaceRoot, repository.relativePath);
        const worktreePath = join(container, repository.relativePath);
        yield* fileSystem
          .makeDirectory(path.dirname(worktreePath), { recursive: true })
          .pipe(
            Effect.mapError((cause) =>
              fail(operation, repositoryCwd, `Could not create ${worktreePath}.`, cause),
            ),
          );
        const start = yield* resolveStart(repositoryCwd, input.startFromOrigin);
        yield* gitManager.createWorktree(
          {
            cwd: repositoryCwd,
            refName: start.startRef,
            newRefName: branch,
            baseRefName: start.baseRef,
            path: worktreePath,
          },
          { submodules },
        );
      }
      return { path: container, branch };
    },
  );

  const renameBranch: WorkspaceWorktrees["Service"]["renameBranch"] = Effect.fn(
    "WorkspaceWorktrees.renameBranch",
  )(function* (input) {
    const [first, ...rest] = yield* workspaceRepositories.list(input.path);
    if (first === undefined) {
      return yield* fail(
        "WorkspaceWorktrees.renameBranch",
        input.path,
        "The isolated run holds no repositories.",
      );
    }
    const renamed = yield* git.renameBranch({
      cwd: join(input.path, first.relativePath),
      oldBranch: input.oldBranch,
      newBranch: input.newBranch,
      ...(input.exactName ? { exactName: true } : {}),
    });
    for (const [index, repository] of rest.entries()) {
      yield* git
        .renameBranch({
          cwd: join(input.path, repository.relativePath),
          oldBranch: input.oldBranch,
          newBranch: renamed.branch,
          exactName: true,
        })
        .pipe(
          // Put the renamed repositories back so every repository stays on one branch.
          Effect.tapError(() =>
            Effect.forEach([first, ...rest.slice(0, index)], (done) =>
              git
                .renameBranch({
                  cwd: join(input.path, done.relativePath),
                  oldBranch: renamed.branch,
                  newBranch: input.oldBranch,
                  exactName: true,
                })
                .pipe(Effect.ignore({ log: true })),
            ),
          ),
        );
    }
    return { branch: renamed.branch };
  });

  const hasGitEntry = (directory: string) =>
    fileSystem.exists(path.join(directory, ".git")).pipe(Effect.orElseSucceed(() => false));
  const isLink = (target: string) =>
    fileSystem.readLink(target).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  // A single-repository worktree has a `.git` entry at its root; a container never does.
  const isContainer: WorkspaceWorktrees["Service"]["isContainer"] = (target) =>
    isInsideWorktreesDir(target).pipe(
      Effect.flatMap((inside) =>
        inside
          ? fileSystem.stat(target).pipe(
              Effect.flatMap((info) =>
                info.type === "Directory"
                  ? hasGitEntry(target).pipe(Effect.map((found) => !found))
                  : Effect.succeed(false),
              ),
              Effect.orElseSucceed(() => false),
            )
          : Effect.succeed(false),
      ),
    );

  // The container's worktrees, found in the container itself so removal doesn't depend on
  // project files that may have changed since the run was created.
  const findWorktrees: (
    directory: string,
    relativePath?: string,
  ) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> = Effect.fn(
    "WorkspaceWorktrees.findWorktrees",
  )(function* (directory, relativePath = "") {
    const found: Array<string> = [];
    for (const name of yield* fileSystem.readDirectory(directory)) {
      const entry = path.join(directory, name);
      if ((yield* isLink(entry)) || (yield* fileSystem.stat(entry)).type !== "Directory") {
        continue;
      }
      const child = relativePath === "" ? name : `${relativePath}/${name}`;
      found.push(...((yield* hasGitEntry(entry)) ? [child] : yield* findWorktrees(entry, child)));
    }
    return found;
  });

  // Removes links and the folders nested repositories needed, bottom-up, keeping real files.
  const removeLeftovers: (
    directory: string,
  ) => Effect.Effect<boolean, PlatformError.PlatformError> = Effect.fn(
    "WorkspaceWorktrees.removeLeftovers",
  )(function* (directory) {
    for (const name of yield* fileSystem.readDirectory(directory)) {
      const entry = path.join(directory, name);
      if (yield* isLink(entry)) {
        yield* fileSystem.remove(entry);
      } else if ((yield* fileSystem.stat(entry)).type === "Directory") {
        yield* removeLeftovers(entry);
      }
    }
    if ((yield* fileSystem.readDirectory(directory)).length > 0) return false;
    yield* fileSystem.remove(directory, { recursive: true });
    return true;
  });

  const remove: WorkspaceWorktrees["Service"]["remove"] = Effect.fn("WorkspaceWorktrees.remove")(
    function* (input) {
      const operation = "WorkspaceWorktrees.remove";
      if (!(yield* isInsideWorktreesDir(input.path))) {
        return yield* fail(operation, input.path, "Not an isolated run folder.");
      }
      const worktrees = yield* findWorktrees(input.path).pipe(
        Effect.mapError((cause) =>
          fail(operation, input.path, "Could not read the isolated run folder.", cause),
        ),
      );
      for (const relativePath of worktrees) {
        yield* git.removeWorktree({
          cwd: join(input.workspaceRoot, relativePath),
          path: join(input.path, relativePath),
          force: input.force,
        });
      }
      yield* removeLeftovers(input.path).pipe(
        Effect.mapError((cause) =>
          fail(operation, input.path, "Could not remove the isolated run folder.", cause),
        ),
      );
    },
  );

  return WorkspaceWorktrees.of({ create, renameBranch, isContainer, remove });
});

export const layer = Layer.effect(WorkspaceWorktrees, make).pipe(
  Layer.provide(WorkspaceRepositories.layer),
);
