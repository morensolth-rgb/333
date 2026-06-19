import {NativeModules, NativeEventEmitter} from 'react-native';

const {RootBridge, RepackModule} = NativeModules;
export const repackEmitter = RepackModule ? new NativeEventEmitter(RepackModule) : null;

export interface AppInfo {
  packageName: string;
  appName: string;
  isSystemApp: boolean;
}

export interface BinaryStatus {
  fridaServer: boolean;
  fridaCli:    boolean;
  fridaServerSize: string;
  fridaCliSize:    string;
}

export const rootBridge = {
  checkRoot:             (): Promise<boolean>       => RootBridge.checkRoot(),
  startFridaServer:      (): Promise<string>        => RootBridge.startFridaServer(),
  stopFridaServer:       (): Promise<void>          => RootBridge.stopFridaServer(),
  isFridaRunning:        (): Promise<boolean>       => RootBridge.isFridaRunning(),
  getInstalledApps:      (): Promise<AppInfo[]>     => RootBridge.getInstalledApps(),
  // mode: 'pid' | 'name' | 'spawn'
  runScript:             (pkg: string, script: string, mode?: string): Promise<string> => RootBridge.runScript(pkg, script, mode ?? 'pid'),
  stopScript:            (): Promise<string> => RootBridge.stopScript(),
  execShell:             (cmd: string): Promise<string>  => RootBridge.execShell(cmd),
  downloadFridaBinaries: (version: string): Promise<string> => RootBridge.downloadFridaBinaries(version),
  checkBinaries:         (): Promise<BinaryStatus>  => RootBridge.checkBinaries(),
  readDir:               (path: string): Promise<FileEntry[]>  => RootBridge.readDir(path),
  readFile:              (path: string): Promise<string>       => RootBridge.readFile(path),
  writeFile:             (path: string, content: string): Promise<string> => RootBridge.writeFile(path, content),
  detectSdks:            (): Promise<Record<string, string>> => RootBridge.detectSdks(),
  getAppIcon:            (packageName: string): Promise<string | null> => RootBridge.getAppIcon(packageName),
  showFloatingLog:       (): Promise<string>   => RootBridge.showFloatingLog(),
  hideFloatingLog:       (): Promise<void>     => RootBridge.hideFloatingLog(),
  flushPendingLogs:      (): Promise<string[]> => RootBridge.flushPendingLogs(),
};

export const repackBridge = {
  repackApk: (apkPath: string, jshookApkPath: string, libfridamodPath: string): Promise<string> =>
    RepackModule.repackApk(apkPath, jshookApkPath, libfridamodPath),
};

export interface FileEntry {
  name:  string;
  path:  string;
  isDir: boolean;
  size:  string;
  perms: string;
}
