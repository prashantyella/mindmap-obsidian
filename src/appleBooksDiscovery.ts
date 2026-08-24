import path from "node:path";

export interface AppleBooksDiscoveryFileSystem {
  readdir(directory: string): Promise<string[]>;
}

export interface AppleBooksDiscoveryOptions {
  config: Record<string, unknown>;
  homeDirectory: string;
  fileSystem: AppleBooksDiscoveryFileSystem;
}

export async function discoverAppleBooksDatabasePaths(options: AppleBooksDiscoveryOptions): Promise<string[]> {
  const configuredAnnotation = configuredPath(options.config, [
    "annotation_database_path",
    "annotation_db_path",
    "apple_books_annotation_database_path",
    "apple_books_annotation_db_path",
  ], options.homeDirectory);
  const configuredLibrary = configuredPath(options.config, [
    "library_database_path",
    "library_db_path",
    "apple_books_library_database_path",
    "apple_books_library_db_path",
  ], options.homeDirectory);
  const paths = [
    ...(configuredAnnotation ? [configuredAnnotation] : await discoverMatches(annotationDirectories(options.homeDirectory), /^AEAnnotation.*\.sqlite$/i, options.fileSystem)),
    ...(configuredLibrary ? [configuredLibrary] : await discoverMatches(libraryDirectories(options.homeDirectory), /^BKLibrary.*\.sqlite$/i, options.fileSystem)),
  ];
  return [...new Set(paths)].sort();
}

function annotationDirectories(homeDirectory: string): string[] {
  return [
    path.join(homeDirectory, "Library/Group Containers/27N4MQEA55.com.apple.iBooks/Documents/AEAnnotation"),
    path.join(homeDirectory, "Library/Containers/com.apple.iBooksX/Data/Documents/AEAnnotation"),
  ];
}

function libraryDirectories(homeDirectory: string): string[] {
  return [
    path.join(homeDirectory, "Library/Group Containers/27N4MQEA55.com.apple.iBooks/Documents/BKLibrary"),
    path.join(homeDirectory, "Library/Containers/com.apple.iBooksX/Data/Documents/BKLibrary"),
  ];
}

async function discoverMatches(directories: string[], pattern: RegExp, fileSystem: AppleBooksDiscoveryFileSystem): Promise<string[]> {
  const matches: string[] = [];
  for (const directory of directories) {
    try {
      const entries = await fileSystem.readdir(directory);
      matches.push(...entries.filter((entry) => pattern.test(entry)).map((entry) => path.join(directory, entry)));
    } catch {
      // Missing or inaccessible Apple Books folders are expected until access is granted.
    }
  }
  return matches.sort();
}

function configuredPath(config: Record<string, unknown>, keys: string[], homeDirectory: string): string | null {
  const nested = config.apple_books && typeof config.apple_books === "object" && !Array.isArray(config.apple_books)
    ? config.apple_books as Record<string, unknown>
    : {};
  for (const key of keys) {
    for (const source of [config, nested]) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) {
        return value.replace(/^~(?=\/|$)/, homeDirectory);
      }
    }
  }
  return null;
}

export interface AppleBooksRoleSelection {
  annotationPath: string | null;
  libraryPath: string | null;
}

async function pathExists(fileSystem: AppleBooksDiscoveryFileSystem, fullPath: string): Promise<boolean> {
  try {
    const entries = await fileSystem.readdir(path.dirname(fullPath));
    return entries.includes(path.basename(fullPath));
  } catch {
    return false;
  }
}

async function firstExisting(fileSystem: AppleBooksDiscoveryFileSystem, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await pathExists(fileSystem, candidate)) return candidate;
  }
  return null;
}

async function firstSortedGlobMatch(fileSystem: AppleBooksDiscoveryFileSystem, directory: string, pattern: RegExp): Promise<string | null> {
  try {
    const entries = await fileSystem.readdir(directory);
    const matches = entries.filter((entry) => pattern.test(entry)).sort();
    return matches.length > 0 ? path.join(directory, matches[0]) : null;
  } catch {
    return null;
  }
}

const ANNOTATION_GLOB_PATTERN = /^AEAnnotation.*\.sqlite$/i;
const LIBRARY_GLOB_PATTERN = /^BKLibrary-.*\.sqlite$/i;

/**
 * Mirrors `discover_annotation_database`/`discover_library_database` in
 * python/apple_books_reader.py exactly, including precedence order:
 *
 * Annotation: explicit config override > exact well-known paths in order
 * (Group Containers exact, sandboxed-Containers exact, sandboxed-Containers
 * `_v2` exact) > alphabetically-first `AEAnnotation*.sqlite` glob match in
 * the Group Containers directory > same glob in the sandboxed Containers
 * directory > `null`.
 *
 * Library: explicit config override > a path *relative to wherever the
 * annotation database was actually found* (its grandparent `Documents`
 * folder's `BKLibrary` subfolder: exact `BKLibrary.sqlite`, else
 * alphabetically-first `BKLibrary-*.sqlite` glob match) > well-known
 * sandboxed-Containers fallback paths in order (exact `BKLibrary.sqlite`,
 * then the versioned `BKLibrary-1-091020131601.sqlite`) > `null`.
 *
 * Unlike `discoverAppleBooksDatabasePaths` (which globs every match across
 * both roles into one flat sorted list with no role/precedence
 * information -- never intended to select a single "the" database), this
 * is the role-aware, precedence-ordered selector Checkpoint 3's reader
 * uses to pick exactly one annotation and one library path.
 */
export async function selectAppleBooksDatabaseRoles(options: AppleBooksDiscoveryOptions): Promise<AppleBooksRoleSelection> {
  const { config, homeDirectory, fileSystem } = options;

  const configuredAnnotation = configuredPath(config, [
    "annotation_database_path",
    "annotation_db_path",
    "apple_books_annotation_database_path",
    "apple_books_annotation_db_path",
  ], homeDirectory);

  const [groupAnnotationDir, containerAnnotationDir] = annotationDirectories(homeDirectory);
  let annotationPath = configuredAnnotation;
  if (!annotationPath) {
    annotationPath = await firstExisting(fileSystem, [
      path.join(groupAnnotationDir, "AEAnnotation.sqlite"),
      path.join(containerAnnotationDir, "AEAnnotation.sqlite"),
      path.join(containerAnnotationDir, "AEAnnotation_v2.sqlite"),
    ]);
  }
  if (!annotationPath) {
    annotationPath = await firstSortedGlobMatch(fileSystem, groupAnnotationDir, ANNOTATION_GLOB_PATTERN);
  }
  if (!annotationPath) {
    annotationPath = await firstSortedGlobMatch(fileSystem, containerAnnotationDir, ANNOTATION_GLOB_PATTERN);
  }

  const configuredLibrary = configuredPath(config, [
    "library_database_path",
    "library_db_path",
    "apple_books_library_database_path",
    "apple_books_library_db_path",
  ], homeDirectory);

  let libraryPath = configuredLibrary;
  if (!libraryPath && annotationPath) {
    const docsDir = path.dirname(path.dirname(annotationPath));
    const bkDir = path.join(docsDir, "BKLibrary");
    const exact = path.join(bkDir, "BKLibrary.sqlite");
    libraryPath = (await pathExists(fileSystem, exact)) ? exact : await firstSortedGlobMatch(fileSystem, bkDir, LIBRARY_GLOB_PATTERN);
  }
  if (!libraryPath) {
    const [, containerLibraryDir] = libraryDirectories(homeDirectory);
    libraryPath = await firstExisting(fileSystem, [
      path.join(containerLibraryDir, "BKLibrary.sqlite"),
      path.join(containerLibraryDir, "BKLibrary-1-091020131601.sqlite"),
    ]);
  }

  return { annotationPath, libraryPath };
}
