import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { discoverAppleBooksDatabasePaths, selectAppleBooksDatabaseRoles } from "./appleBooksDiscovery";

test("discovers bounded versioned Apple Books database filenames deterministically", async () => {
  const homeDirectory = "/mock-home";
  const annotationDirectory = path.join(homeDirectory, "Library/Containers/com.apple.iBooksX/Data/Documents/AEAnnotation");
  const libraryDirectory = path.join(homeDirectory, "Library/Containers/com.apple.iBooksX/Data/Documents/BKLibrary");
  const paths = await discoverAppleBooksDatabasePaths({
    config: {},
    homeDirectory,
    fileSystem: {
      readdir: async (directory) => directory === annotationDirectory
        ? ["AEAnnotation_v10312011_1727_local.sqlite", "ignore.txt"]
        : directory === libraryDirectory
          ? ["BKLibrary-2024.sqlite", "not-a-database"]
          : [],
    },
  });

  assert.deepEqual(paths, [
    path.join(annotationDirectory, "AEAnnotation_v10312011_1727_local.sqlite"),
    path.join(libraryDirectory, "BKLibrary-2024.sqlite"),
  ]);
});

test("uses explicit config paths instead of scanning that database role", async () => {
  const paths = await discoverAppleBooksDatabasePaths({
    config: { apple_books: { annotation_database_path: "/configured/annotation.sqlite", library_database_path: "/configured/library.sqlite" } },
    homeDirectory: "/mock-home",
    fileSystem: { readdir: async () => { throw new Error("scan should not run"); } },
  });

  assert.deepEqual(paths, ["/configured/annotation.sqlite", "/configured/library.sqlite"]);
});

const HOME = "/mock-home";
const GROUP_ANNOTATION_DIR = path.join(HOME, "Library/Group Containers/27N4MQEA55.com.apple.iBooks/Documents/AEAnnotation");
const CONTAINER_ANNOTATION_DIR = path.join(HOME, "Library/Containers/com.apple.iBooksX/Data/Documents/AEAnnotation");
const CONTAINER_LIBRARY_DIR = path.join(HOME, "Library/Containers/com.apple.iBooksX/Data/Documents/BKLibrary");

function fsFromDirs(dirs: Record<string, string[]>) {
  return {
    readdir: async (directory: string) => {
      if (directory in dirs) return dirs[directory];
      throw new Error(`ENOENT: ${directory}`);
    },
  };
}

test("selectAppleBooksDatabaseRoles prefers the Group Containers exact path over a competing sandboxed-Containers exact path", async () => {
  const roles = await selectAppleBooksDatabaseRoles({
    config: {},
    homeDirectory: HOME,
    fileSystem: fsFromDirs({
      [GROUP_ANNOTATION_DIR]: ["AEAnnotation.sqlite"],
      [CONTAINER_ANNOTATION_DIR]: ["AEAnnotation.sqlite", "AEAnnotation_v2.sqlite"],
    }),
  });
  assert.equal(roles.annotationPath, path.join(GROUP_ANNOTATION_DIR, "AEAnnotation.sqlite"));
});

test("selectAppleBooksDatabaseRoles prefers the sandboxed-Containers exact path over the competing _v2 exact path", async () => {
  const roles = await selectAppleBooksDatabaseRoles({
    config: {},
    homeDirectory: HOME,
    fileSystem: fsFromDirs({
      [GROUP_ANNOTATION_DIR]: [],
      [CONTAINER_ANNOTATION_DIR]: ["AEAnnotation.sqlite", "AEAnnotation_v2.sqlite"],
    }),
  });
  assert.equal(roles.annotationPath, path.join(CONTAINER_ANNOTATION_DIR, "AEAnnotation.sqlite"));
});

test("selectAppleBooksDatabaseRoles falls back to the _v2 exact path when the plain exact path is absent", async () => {
  const roles = await selectAppleBooksDatabaseRoles({
    config: {},
    homeDirectory: HOME,
    fileSystem: fsFromDirs({
      [GROUP_ANNOTATION_DIR]: [],
      [CONTAINER_ANNOTATION_DIR]: ["AEAnnotation_v2.sqlite"],
    }),
  });
  assert.equal(roles.annotationPath, path.join(CONTAINER_ANNOTATION_DIR, "AEAnnotation_v2.sqlite"));
});

test("selectAppleBooksDatabaseRoles falls back to a sorted glob match in the Group Containers dir before ever trying the sandboxed-Containers dir", async () => {
  const roles = await selectAppleBooksDatabaseRoles({
    config: {},
    homeDirectory: HOME,
    fileSystem: fsFromDirs({
      [GROUP_ANNOTATION_DIR]: ["AEAnnotation_z.sqlite", "AEAnnotation_a.sqlite"],
      [CONTAINER_ANNOTATION_DIR]: ["AEAnnotation_earlier_alphabetically.sqlite"],
    }),
  });
  // Group dir's alphabetically-first match wins even though the container dir has a
  // lexicographically earlier-sorting name -- group-dir glob is strictly preferred to container-dir glob.
  assert.equal(roles.annotationPath, path.join(GROUP_ANNOTATION_DIR, "AEAnnotation_a.sqlite"));
});

test("selectAppleBooksDatabaseRoles picks a sibling BKLibrary.sqlite relative to wherever the annotation database was actually found", async () => {
  const roles = await selectAppleBooksDatabaseRoles({
    config: {},
    homeDirectory: HOME,
    fileSystem: fsFromDirs({
      [GROUP_ANNOTATION_DIR]: ["AEAnnotation.sqlite"],
      [path.join(HOME, "Library/Group Containers/27N4MQEA55.com.apple.iBooks/Documents/BKLibrary")]: ["BKLibrary.sqlite"],
      [CONTAINER_LIBRARY_DIR]: ["BKLibrary.sqlite"],
    }),
  });
  assert.equal(
    roles.libraryPath,
    path.join(HOME, "Library/Group Containers/27N4MQEA55.com.apple.iBooks/Documents/BKLibrary/BKLibrary.sqlite"),
    "the sibling library next to the actually-found annotation database must win over the unrelated container fallback",
  );
});

test("selectAppleBooksDatabaseRoles prefers a sibling versioned BKLibrary-*.sqlite glob over the unrelated container fallback", async () => {
  const siblingBkDir = path.join(HOME, "Library/Group Containers/27N4MQEA55.com.apple.iBooks/Documents/BKLibrary");
  const roles = await selectAppleBooksDatabaseRoles({
    config: {},
    homeDirectory: HOME,
    fileSystem: fsFromDirs({
      [GROUP_ANNOTATION_DIR]: ["AEAnnotation.sqlite"],
      [siblingBkDir]: ["BKLibrary-2024.sqlite", "BKLibrary-2020.sqlite"],
      [CONTAINER_LIBRARY_DIR]: ["BKLibrary.sqlite"],
    }),
  });
  assert.equal(roles.libraryPath, path.join(siblingBkDir, "BKLibrary-2020.sqlite"));
});

test("selectAppleBooksDatabaseRoles falls back to the well-known container library paths when no sibling library exists", async () => {
  const roles = await selectAppleBooksDatabaseRoles({
    config: {},
    homeDirectory: HOME,
    fileSystem: fsFromDirs({
      [GROUP_ANNOTATION_DIR]: ["AEAnnotation.sqlite"],
      [CONTAINER_LIBRARY_DIR]: ["BKLibrary-1-091020131601.sqlite"],
    }),
  });
  assert.equal(roles.libraryPath, path.join(CONTAINER_LIBRARY_DIR, "BKLibrary-1-091020131601.sqlite"));
});

test("selectAppleBooksDatabaseRoles honors explicit config overrides for both roles, skipping discovery entirely", async () => {
  const roles = await selectAppleBooksDatabaseRoles({
    config: { apple_books: { annotation_database_path: "/configured/annotation.sqlite", library_database_path: "/configured/library.sqlite" } },
    homeDirectory: HOME,
    fileSystem: { readdir: async () => { throw new Error("scan should not run"); } },
  });
  assert.deepEqual(roles, { annotationPath: "/configured/annotation.sqlite", libraryPath: "/configured/library.sqlite" });
});

test("selectAppleBooksDatabaseRoles returns null for both roles when nothing exists anywhere", async () => {
  const roles = await selectAppleBooksDatabaseRoles({ config: {}, homeDirectory: HOME, fileSystem: fsFromDirs({}) });
  assert.deepEqual(roles, { annotationPath: null, libraryPath: null });
});
