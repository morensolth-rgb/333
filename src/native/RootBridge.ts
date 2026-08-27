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
  file: string;
  relative: string;
  line: number;
  text: string;
}

export const rootBridge = {
  checkRoot:     (): Promise<boolean>             => RootBridge.checkRoot(),
  execShell:     (cmd: string): Promise<string>   => RootBridge.execShell(cmd),
  getInstalledApps: (): Promise<AppInfo[]>        => RootBridge.getInstalledApps(),
  getAppIcon:    (pkg: string): Promise<string | null> => RootBridge.getAppIcon(pkg),

  locateUnityFiles:   (pkg: string): Promise<LocateResult>    => RootBridge.locateUnityFiles(pkg),
  dumpIl2cpp:         (pkg: string): Promise<DumpResult>      => RootBridge.dumpIl2cpp(pkg),
  extractUnityAssets: (pkg: string): Promise<ExtractResult>   => RootBridge.extractUnityAssets(pkg),
  listExtracted:      (pkg: string): Promise<ExtractedFile[]> => RootBridge.listExtracted(pkg),
  searchFiles:        (pkg: string, query: string): Promise<SearchMatch[]> => RootBridge.searchFiles(pkg, query),

  readDir:        (path: string): Promise<FileEntry[]> => RootBridge.readDir(path),
  readFile:       (path: string): Promise<string>      => RootBridge.readFile(path),
  writeFile:      (path: string, content: string): Promise<string> => RootBridge.writeFile(path, content),
  getScratchRoot: (): Promise<string>                  => RootBridge.getScratchRoot(),
};
