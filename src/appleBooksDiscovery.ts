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
