import { AppMetadata, DevMetadata, Platform, PlatformSpecificBuildOptions, Arch } from "./metadata"
import EventEmitter = NodeJS.EventEmitter
import { Promise as BluebirdPromise } from "bluebird"
import * as path from "path"
import { pack, ElectronPackagerOptions, userIgnoreFilter } from "electron-packager-tf"
import { readdir, remove, realpath } from "fs-extra-p"
import { statOrNull, use, unlinkIfExists, isEmptyOrSpaces } from "./util/util"
import { Packager } from "./packager"
import { AsarOptions } from "asar"
import { archiveApp } from "./targets/archive"
import { Minimatch } from "minimatch"
import { checkFileInPackage, createAsarArchive } from "./asarUtil"
import { deepAssign } from "./util/deepAssign"
import { warn, log, task } from "./util/log"
import { AppInfo } from "./appInfo"
import { listDependencies, createFilter, copyFiltered, hasMagic } from "./util/filter"

//noinspection JSUnusedLocalSymbols
const __awaiter = require("./util/awaiter")

export interface PackagerOptions {
  targets?: Map<Platform, Map<Arch, string[]>>

  projectDir?: string | null

  cscLink?: string | null
  cscKeyPassword?: string | null

  cscInstallerLink?: string | null
  cscInstallerKeyPassword?: string | null

  platformPackagerFactory?: ((packager: Packager, platform: Platform, cleanupTasks: Array<() => Promise<any>>) => PlatformPackager<any>) | null

  /**
   * The same as [development package.json](https://github.com/electron-userland/electron-builder/wiki/Options#development-packagejson).
   *
   * Development `package.json` will be still read, but options specified in this object will override.
   */
  readonly devMetadata?: DevMetadata

  /**
   * The same as [application package.json](https://github.com/electron-userland/electron-builder/wiki/Options#AppMetadata).
   *
   * Application `package.json` will be still read, but options specified in this object will override.
   */
  readonly appMetadata?: AppMetadata

  readonly effectiveOptionComputed?: (options: any) => boolean
}

export interface BuildInfo {
  options: PackagerOptions

  devMetadata: DevMetadata

  projectDir: string
  appDir: string

  electronVersion: string

  eventEmitter: EventEmitter

  isTwoPackageJsonProjectLayoutUsed: boolean

  // computed final effective appId
  appInfo: AppInfo
}

export class Target {
  constructor(public name: string) {
  }

  finishBuild(): Promise<any> {
    return BluebirdPromise.resolve()
  }
}

export abstract class TargetEx extends Target {
  abstract async build(appOutDir: string, arch: Arch): Promise<any>
}

export abstract class PlatformPackager<DC extends PlatformSpecificBuildOptions> {
  readonly options: PackagerOptions

  readonly projectDir: string
  readonly buildResourcesDir: string

  readonly devMetadata: DevMetadata

  readonly platformSpecificBuildOptions: DC

  readonly resourceList: Promise<Array<string>>

  abstract get platform(): Platform

  readonly appInfo: AppInfo

  constructor(public info: BuildInfo) {
    this.devMetadata = info.devMetadata
    this.platformSpecificBuildOptions = this.normalizePlatformSpecificBuildOptions((<any>info.devMetadata.build)[this.platform.buildConfigurationKey])
    this.appInfo = this.prepareAppInfo(info.appInfo)
    this.options = info.options
    this.projectDir = info.projectDir

    this.buildResourcesDir = path.resolve(this.projectDir, this.relativeBuildResourcesDirname)

    this.resourceList = readdir(this.buildResourcesDir)
      .catch(e => {
        if (e.code !== "ENOENT") {
          throw e
        }
        return []
      })
  }

  protected prepareAppInfo(appInfo: AppInfo) {
    return appInfo
  }

  normalizePlatformSpecificBuildOptions(options: DC | n): DC {
    return options == null ? Object.create(null) : options
  }

  createTargets(targets: Array<string>, mapper: (name: string, factory: (outDir: string) => Target) => void, cleanupTasks: Array<() => Promise<any>>): void {
    throw new Error("not implemented")
  }

  protected getCscPassword(): string {
    const password = this.options.cscKeyPassword || process.env.CSC_KEY_PASSWORD
    if (isEmptyOrSpaces(password)) {
      log("CSC_KEY_PASSWORD is not defined, empty password will be used")
      return ""
    }
    else {
      return password.trim()
    }
  }

  get relativeBuildResourcesDirname() {
    return use(this.devMetadata.directories, it => it!.buildResources) || "build"
  }

  protected computeAppOutDir(outDir: string, arch: Arch): string {
    return path.join(outDir, `${this.platform.buildConfigurationKey}${arch === Arch.x64 ? "" : `-${Arch[arch]}`}`)
  }

  dispatchArtifactCreated(file: string, artifactName?: string) {
    this.info.eventEmitter.emit("artifactCreated", {
      file: file,
      artifactName: artifactName,
      platform: this.platform,
    })
  }

  abstract pack(outDir: string, arch: Arch, targets: Array<Target>, postAsyncTasks: Array<Promise<any>>): Promise<any>

  protected async doPack(options: ElectronPackagerOptions, outDir: string, appOutDir: string, arch: Arch, platformSpecificBuildOptions: DC) {
    const asarOptions = this.computeAsarOptions(platformSpecificBuildOptions)
    options.initializeApp = async (opts, buildDir, appRelativePath) => {
      const appPath = path.join(buildDir, appRelativePath)
      const resourcesPath = path.dirname(appPath)

      const ignoreFiles = new Set([path.relative(this.info.appDir, outDir), path.relative(this.info.appDir, this.buildResourcesDir)])
      if (!this.info.isTwoPackageJsonProjectLayoutUsed) {
        const result = await BluebirdPromise.all([listDependencies(this.info.appDir, false), listDependencies(this.info.appDir, true)])
        const productionDepsSet = new Set(result[1])

        // npm returns real path, so, we should use relative path to avoid any mismatch
        const realAppDirPath = await realpath(this.info.appDir)

        for (let it of result[0]) {
          if (!productionDepsSet.has(it)) {
            if (it.startsWith(realAppDirPath)) {
              it = it.substring(realAppDirPath.length + 1)
            }
            else if (it.startsWith(this.info.appDir)) {
              it = it.substring(this.info.appDir.length + 1)
            }
            ignoreFiles.add(it)
          }
        }
      }

      let patterns = this.getFilePatterns("files", platformSpecificBuildOptions)
      if (patterns == null || patterns.length === 0) {
        patterns = ["**/*"]
      }

      let rawFilter: any = null
      const deprecatedIgnore = (<any>this.devMetadata.build).ignore
      if (deprecatedIgnore) {
        if (typeof deprecatedIgnore === "function") {
          log(`"ignore is specified as function, may be new "files" option will be suit your needs? Please see https://github.com/electron-userland/electron-builder/wiki/Options#BuildMetadata-files`)
        }
        else {
          warn(`"ignore is deprecated, please use "files", see https://github.com/electron-userland/electron-builder/wiki/Options#BuildMetadata-files`)
        }
        rawFilter = userIgnoreFilter(opts)
      }

      const filter = createFilter(this.info.appDir, this.getParsedPatterns(patterns, arch), ignoreFiles, rawFilter)
      const promise = asarOptions == null ?
        copyFiltered(this.info.appDir, appPath, filter, this.platform === Platform.WINDOWS)
        : createAsarArchive(this.info.appDir, resourcesPath, asarOptions, filter)

      const promises = [promise, unlinkIfExists(path.join(resourcesPath, "default_app.asar")), unlinkIfExists(path.join(appOutDir, "version"))]
      if (this.info.electronVersion[0] === "0") {
        // electron release >= 0.37.4 - the default_app/ folder is a default_app.asar file
        promises.push(remove(path.join(resourcesPath, "default_app")))
      }

      await BluebirdPromise.all(promises)
    }
    await task(`Packaging for platform ${this.platform.name} ${options.arch} using electron ${options.version} to ${path.relative(this.projectDir, appOutDir)}`, pack(options))

    await this.doCopyExtraFiles(true, appOutDir, arch, platformSpecificBuildOptions)
    await this.doCopyExtraFiles(false, appOutDir, arch, platformSpecificBuildOptions)

    const afterPack = this.devMetadata.build.afterPack
    if (afterPack != null) {
      await afterPack({
        appOutDir: appOutDir,
        options: options,
      })
    }

    await this.sanityCheckPackage(appOutDir, asarOptions != null)
  }

  protected async computePackOptions(outDir: string, appOutDir: string, arch: Arch): Promise<ElectronPackagerOptions> {
    //noinspection JSUnusedGlobalSymbols
    const appInfo = this.appInfo
    const options: any = deepAssign({
      dir: this.info.appDir,
      "app-bundle-id": appInfo.id,
      out: outDir,
      name: appInfo.productName,
      productName: appInfo.productName,
      platform: this.platform.nodeName,
      arch: Arch[arch],
      version: this.info.electronVersion,
      icon: await this.getIconPath(),
      overwrite: true,
      "app-version": appInfo.version,
      "app-copyright": appInfo.copyright,
      "build-version": appInfo.buildVersion,
      tmpdir: false,
      generateFinalBasename: () => path.basename(appOutDir),
    }, this.devMetadata.build)

    if (this.platform === Platform.WINDOWS) {
      options["version-string"] = appInfo.versionString
    }

    delete options.osx
    delete options.win
    delete options.linux
    // this option only for windows-installer
    delete options.iconUrl
    return options
  }

  async getIconPath(): Promise<string | null> {
    return null
  }

  private computeAsarOptions(customBuildOptions: DC): AsarOptions | null {
    let result = this.devMetadata.build.asar
    let platformSpecific = customBuildOptions.asar
    if (platformSpecific != null) {
      result = platformSpecific
    }

    if (result === false) {
      return null
    }

    const buildMetadata = <ElectronPackagerOptions>this.devMetadata.build
    if (buildMetadata["asar-unpack"] != null) {
      warn("asar-unpack is deprecated, please set as asar.unpack")
    }
    if (buildMetadata["asar-unpack-dir"] != null) {
      warn("asar-unpack-dir is deprecated, please set as asar.unpackDir")
    }

    if (result == null || result === true) {
      return {
        unpack: buildMetadata["asar-unpack"],
        unpackDir: buildMetadata["asar-unpack-dir"]
      }
    }
    else {
      return result
    }
  }

  private expandPattern(pattern: string, arch: Arch): string {
    return pattern
      .replace(/\$\{arch}/g, Arch[arch])
      .replace(/\$\{os}/g, this.platform.buildConfigurationKey)
      .replace(/\$\{\/\*}/g, "{,/**/*,/**/.*}")
  }

  private async doCopyExtraFiles(isResources: boolean, appOutDir: string, arch: Arch, customBuildOptions: DC): Promise<any> {
    const base = isResources ? this.getResourcesDir(appOutDir) : this.platform === Platform.MAC ? path.join(appOutDir, `${this.appInfo.productFilename}.app`, "Contents") : appOutDir
    const patterns = this.getFilePatterns(isResources ? "extraResources" : "extraFiles", customBuildOptions)
    return patterns == null || patterns.length === 0 ? null : copyFiltered(this.projectDir, base, createFilter(this.projectDir, this.getParsedPatterns(patterns, arch)), this.platform === Platform.WINDOWS)
  }

  private getParsedPatterns(patterns: Array<string>, arch: Arch): Array<Minimatch> {
    const minimatchOptions = {}
    const parsedPatterns: Array<Minimatch> = []
    for (let i = 0; i < patterns.length; i++) {
      const pattern = this.expandPattern(patterns[i], arch)
      const parsedPattern = new Minimatch(pattern, minimatchOptions)
      parsedPatterns.push(parsedPattern)
      if (!hasMagic(parsedPattern)) {
        // https://github.com/electron-userland/electron-builder/issues/545
        // add **/*
        parsedPatterns.push(new Minimatch(`${pattern}/*/**`, minimatchOptions))
      }
    }

    return parsedPatterns
  }

  private getFilePatterns(name: "files" | "extraFiles" | "extraResources", customBuildOptions: DC): Array<string> | n {
    let patterns: Array<string> | string | n = (<any>this.devMetadata.build)[name]
    if (patterns != null && !Array.isArray(patterns)) {
      patterns = [patterns]
    }

    let platformSpecificPatterns: Array<string> | string | n = (<any>customBuildOptions)[name]
    if (platformSpecificPatterns != null) {
      if (!Array.isArray(platformSpecificPatterns)) {
        platformSpecificPatterns = [platformSpecificPatterns]
      }
      return patterns == null ? platformSpecificPatterns : Array.from(new Set(patterns.concat(platformSpecificPatterns)))
    }
    return patterns
  }

  private getResourcesDir(appOutDir: string): string {
    return this.platform === Platform.MAC ? this.getOSXResourcesDir(appOutDir) : path.join(appOutDir, "resources")
  }

  private getOSXResourcesDir(appOutDir: string): string {
    return path.join(appOutDir, `${this.appInfo.productFilename}.app`, "Contents", "Resources")
  }

  private async checkFileInPackage(resourcesDir: string, file: string, isAsar: boolean) {
    const relativeFile = path.relative(this.info.appDir, path.resolve(this.info.appDir, file))
    if (isAsar) {
      await checkFileInPackage(path.join(resourcesDir, "app.asar"), relativeFile)
    }
    else {
      const outStat = await statOrNull(path.join(resourcesDir, "app", relativeFile))
      if (outStat == null) {
        throw new Error(`Application entry file "${relativeFile}" does not exist. Seems like a wrong configuration.`)
      }
      else if (!outStat.isFile()) {
        throw new Error(`Application entry file "${relativeFile}" is not a file. Seems like a wrong configuration.`)
      }
    }
  }

  private async sanityCheckPackage(appOutDir: string, isAsar: boolean): Promise<any> {
    const outStat = await statOrNull(appOutDir)

    if (outStat == null) {
      throw new Error(`Output directory "${appOutDir}" does not exist. Seems like a wrong configuration.`)
    }
    else if (!outStat.isDirectory()) {
      throw new Error(`Output directory "${appOutDir}" is not a directory. Seems like a wrong configuration.`)
    }

    const mainFile = this.appInfo.metadata.main || "index.js"
    await this.checkFileInPackage(this.getResourcesDir(appOutDir), mainFile, isAsar)
  }

  protected async archiveApp(format: string, appOutDir: string, outFile: string): Promise<any> {
    return archiveApp(this.devMetadata.build.compression, format, outFile, this.platform === Platform.MAC ? path.join(appOutDir, `${this.appInfo.productFilename}.app`) : appOutDir)
  }

  generateName(ext: string | null, arch: Arch, deployment: boolean): string {
    return this.generateName2(ext, arch === Arch.x64 ? null : Arch[arch], deployment)
  }

  generateName1(ext: string | null, arch: Arch, classifier: string, deployment: boolean): string {
    let c = arch === Arch.x64 ? null : Arch[arch]
    if (c == null) {
      c = classifier
    }
    else {
      c += `-${classifier}`
    }
    return this.generateName2(ext, c, deployment)
  }

  generateName2(ext: string | null, classifier: string | n, deployment: boolean): string {
    const dotExt = ext == null ? "" : `.${ext}`
    return `${deployment ? this.appInfo.name : this.appInfo.productFilename}-${this.appInfo.version}${classifier == null ? "" : `-${classifier}`}${dotExt}`
  }

  protected async getDefaultIcon(ext: string) {
    const resourceList = await this.resourceList
    const name = `icon.${ext}`
    if (resourceList.includes(name)) {
      return path.join(this.buildResourcesDir, name)
    }
    else {
      warn("Application icon is not set, default Electron icon will be used")
      return null
    }
  }
}

export function getArchSuffix(arch: Arch): string {
  return arch === Arch.x64 ? "" : `-${Arch[arch]}`
}

export interface ArtifactCreated {
  readonly file: string
  readonly artifactName?: string

  readonly platform: Platform
}

// fpm bug - rpm build --description is not escaped, well... decided to replace quite to smart quote
// http://leancrew.com/all-this/2010/11/smart-quotes-in-javascript/
export function smarten(s: string): string {
  // opening singles
  s = s.replace(/(^|[-\u2014\s(\["])'/g, "$1\u2018")
  // closing singles & apostrophes
  s = s.replace(/'/g, "\u2019")
  // opening doubles
  s = s.replace(/(^|[-\u2014/\[(\u2018\s])"/g, "$1\u201c")
  // closing doubles
  s = s.replace(/"/g, "\u201d")
  return s
}