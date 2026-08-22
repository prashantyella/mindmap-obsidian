import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { discoverAppleBooksDatabasePaths } from "./appleBooksDiscovery";

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
