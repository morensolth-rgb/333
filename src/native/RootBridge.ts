import {NativeModules} from 'react-native';

const {RootBridge} = NativeModules;

export interface AppInfo {
  packageName: string;
  appName: string;
  isSystemApp: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: string;
  perms: string;
}

export interface LocateResult {
  hasMetadata: boolean;
  hasLib: boolean;
  metadataPath: string;
  libPath: string;
  unity3d: string[];
  isUnity: boolean;
}

export interface DumpResult {
  success: boolean;
  outputDir: string;
  log: string;
  dumpCsSize?: string;
  dumpCsBytes?: number;
}

export interface ExtractResult {
  success: boolean;
  outputDir: string;
  summary: string;
}

export interface ExtractedFile {
  name: string;
  path: string;
  relative: string;
  size: string;
}

export interface SearchMatch {
  file: string;   // path relative to scratch root (display)
  path: string;   // absolute path (use for opening)
  line: number;
  text: string;
}

export interface FileRange {
  startLine: number;
  content: string;
}

export interface TokenMatch {
  apk: string;
  type: string;
  path_id: string;
  file: string;
  path: string;
  size: number;
}

export interface FileAnalysis {
  path: string;
  name: string;
  size: string;
  bytes: number;
  type: 'lua' | 'zip' | 'gzip' | 'elf' | 'unity' | 'text' | 'binary';
  label: string;    // Arabic human-readable type label
  binary: boolean;
  preview: string;  // readable content: text as-is, or strings dump for binary
}

export const rootBridge = {
  checkRoot:     (): Promise<boolean>             => RootBridge.checkRoot(),
  execShell:     (cmd: string): Promise<string>   => RootBridge.execShell(cmd),
  getInstalledApps: (): Promise<AppInfo[]>        => RootBridge.getInstalledApps(),
  getAppIcon:    (pkg: string): Promise<string | null> => RootBridge.getAppIcon(pkg),

  locateUnityFiles:   (pkg: string): Promise<LocateResult>    => RootBridge.locateUnityFiles(pkg),
  dumpIl2cpp:         (pkg: string): Promise<DumpResult>      => RootBridge.dumpIl2cpp(pkg),
  extractUnityAssets: (pkg: string): Promise<ExtractResult>   => RootBridge.extractUnityAssets(pkg),
  inspectApk:         (pkg: string): Promise<ExtractResult>   => RootBridge.inspectApk(pkg),
  huntToken:          async (pkg: string, token: string): Promise<{count: number; matches: TokenMatch[]}> =>
    JSON.parse(await RootBridge.huntToken(pkg, token)),
  huntTokenInFile:    async (srcPath: string, token: string): Promise<{count: number; matches: TokenMatch[]; error?: string}> =>
    JSON.parse(await RootBridge.huntTokenInFile(srcPath, token)),
  listExtracted:      (pkg: string): Promise<ExtractedFile[]> => RootBridge.listExtracted(pkg),
  searchFiles:        (pkg: string, query: string, scope: 'all' | 'dump' | 'assets' | 'apkfull' = 'all'): Promise<SearchMatch[]> =>
    RootBridge.searchFiles(pkg, query, scope),

  readDir:        (path: string): Promise<FileEntry[]> => RootBridge.readDir(path),
  readFile:       (path: string): Promise<string>      => RootBridge.readFile(path),
  analyzeFile:    (path: string): Promise<FileAnalysis> => RootBridge.analyzeFile(path),
  readFileRange:  (path: string, startLine: number, lineCount: number): Promise<FileRange> =>
    RootBridge.readFileRange(path, startLine, lineCount),
  writeFile:      (path: string, content: string): Promise<string> => RootBridge.writeFile(path, content),
  getScratchRoot: (): Promise<string>                  => RootBridge.getScratchRoot(),
};
