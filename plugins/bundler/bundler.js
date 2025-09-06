/* eslint-disable no-console, no-param-reassign */
const { fs, path } = Plugin;
const versionFilePath = './version.desktop';
const chokidar = Npm.require('chokidar');

/**
 * Utility function to compare two arrays for identical elements.
 *
 * @param {Array} a - First array.
 * @param {Array} b - Second array.
 * @returns {boolean} - True if arrays are identical, else false.
 */
function arraysIdentical(a, b) {
    let i = a.length;
    if (i !== b.length) return false;
    while (i) {
        i -= 1;
        if (a[i] !== b[i]) return false;
    }
    return true;
}

// TODO: Implement periodic cache purging.

fs.existsSync = function existsSync(pathToCheck) {
    try {
        return !!this.statSync(pathToCheck);
    } catch (e) {
        return null;
    }
}.bind(fs);

/**
 * Adds 'version.desktop' to the .gitignore file if it's not already present.
 */
function addToGitIgnore() {
    let gitIgnore;
    try {
        gitIgnore = fs.readFileSync('./.gitignore', 'utf8');
        if (!gitIgnore.includes('version.desktop')) {
            gitIgnore += '\nversion.desktop\n';
            fs.writeFileSync('./.gitignore', gitIgnore);
        }
    } catch (e) {
        console.warn('[meteor-desktop] could not add version.desktop to .gitignore, please do it manually');
    }
}

// Initialize the version.desktop file if it doesn't exist.
if (!fs.existsSync(versionFilePath)) {
    fs.writeFileSync(
        versionFilePath,
        JSON.stringify({ version: 'initial' }, null, 2),
        'UTF-8'
    );
    addToGitIgnore();
}

/**
 * Converts a given string to camelCase.
 *
 * @param {string} name - The string to convert.
 * @returns {string} - The camelCase version of the input string.
 */
function toCamelCase(name) {
    return name
        .replace(/[-/](.)/g, (_, group1) => group1.toUpperCase())
        .replace(/[-@/]/g, '');
}

/*
 * Important! This is a Proof of Concept (POC).
 *
 * Much of this code is duplicated from the main npm package due to issues with requiring
 * `meteor-desktop`. The stack traces from build plugins were not sufficiently descriptive,
 * leading to the necessity of implementing minimal required functionality by copying code.
 * This duplication should be investigated and resolved.
 */

class MeteorDesktopBundler {
    /**
     * Initializes the bundler with the provided file system.
     *
     * @param {Object} fileSystem - The file system interface.
     */
    constructor(fileSystem) {
        this.fs = fileSystem;
        this.deps = ['cacache'];
        this.buildDeps = [
            '@electron/asar',
            'shelljs',
            'del',
            '@babel/core',
            '@babel/preset-env',
            'terser',
            'md5',
            'cacache'
        ];

        this.version = null;
        this.packageJson = null;
        this.requireLocal = null;
        this.cachePath = './.meteor/local/desktop-cache';
        this.desktopPath = './.desktop';
        this.utils = null;
        this.performanceStamps = {};

        this.watcherEnabled = false;
        this.timeout = null;

        // Initialize file watcher.
        this.watcher = chokidar.watch(this.desktopPath, {
            persistent: true,
            ignored: /tmp___/,
            ignoreInitial: true
        });

        // Handle file system events.
        this.watcher.on('all', (event, filePath) => {
            if (this.timeout) {
                clearTimeout(this.timeout);
            }
            // Simple 2-second debounce to prevent excessive rebuilds.
            this.timeout = setTimeout(() => {
                if (this.watcherEnabled && this.utils) {
                    console.log(`[meteor-desktop] ${filePath} has been changed, triggering desktop rebuild.`);
                    this.handleFileChange();
                }
            }, 2000);
        });
    }

    /**
     * Handles file changes by computing the hash and updating the version file.
     */
    async handleFileChange() {
        try {
            const result = await this.utils.readFilesAndComputeHash(
                this.desktopPath,
                file => file.replace('.desktop', '')
            );
            const { hash } = result;
            fs.writeFileSync(
                versionFilePath,
                JSON.stringify({ version: `${hash}_dev` }, null, 2),
                'UTF-8'
            );
        } catch (e) {
            throw new Error(`[meteor-desktop] failed to compute .desktop hash: ${e}`);
        }
    }

    /**
     * Reads and parses the settings.json from the desktop directory.
     *
     * @param {string} desktopPath - Path to the desktop directory.
     * @param {Object} file - The file being processed by the build plugin.
     * @returns {Object} - Parsed settings object.
     */
    getSettings(desktopPath, file) {
        let settings = {};
        try {
            const settingsPath = path.join(desktopPath, 'settings.json');
            const settingsContent = this.fs.readFileSync(settingsPath, 'UTF-8');
            settings = JSON.parse(settingsContent);
        } catch (e) {
            file.error({
                message: `Error while trying to read 'settings.json' from '${desktopPath}' module`
            });
        }
        return settings;
    }

    /**
     * Reads and parses the module.json from a specific module path.
     *
     * @param {string} modulePath - Path to the module directory.
     * @param {Object} file - The file being processed by the build plugin.
     * @returns {Object} - Parsed module configuration.
     */
    getModuleConfig(modulePath, file) {
        let moduleConfig = {};
        try {
            const moduleJsonPath = path.join(modulePath, 'module.json');
            const moduleJsonContent = this.fs.readFileSync(moduleJsonPath, 'UTF-8');
            moduleConfig = JSON.parse(moduleJsonContent);
        } catch (e) {
            file.error({
                message: `Error while trying to read 'module.json' from '${modulePath}' module`
            });
        }
        return moduleConfig;
    }

    /**
     * Checks if a given path is empty.
     *
     * @param {string} searchPath - Path to check.
     * @returns {boolean} - True if the path is empty, else false.
     */
    isEmpty(searchPath) {
        try {
            const stat = this.fs.statSync(searchPath);
            if (stat.isDirectory()) {
                const items = this.fs.readdirSync(searchPath);
                return !items || !items.length;
            }
            return false;
        } catch (e) {
            return true;
        }
    }

    /**
     * Gathers module configurations from the modules directory.
     *
     * @param {Object} shell - ShellJS instance.
     * @param {string} modulesPath - Path to the modules directory.
     * @param {Object} file - The file being processed by the build plugin.
     * @returns {Array} - Array of module configurations.
     */
    gatherModuleConfigs(shell, modulesPath, file) {
        const configs = [];

        if (!this.isEmpty(modulesPath)) {
            const modules = this.fs.readdirSync(modulesPath);
            modules.forEach(module => {
                const moduleDir = path.join(modulesPath, module);
                if (this.fs.lstatSync(moduleDir).isDirectory()) {
                    const moduleConfig = this.getModuleConfig(moduleDir, file);
                    // moduleConfig.dirName = path.parse(module).name || path.basename(module);
                    moduleConfig.dirName = path.basename(module);
                    configs.push(moduleConfig);
                }
            });
        }
        return configs;
    }

    /**
     * Merges core dependency lists with those defined in .desktop settings.
     *
     * @param {string} desktopPath - Path to the desktop directory.
     * @param {Object} file - The file being processed by the build plugin.
     * @param {Array} configs - Array of module configurations.
     * @param {Object} depsManager - DependenciesManager instance.
     * @returns {Object} - Updated DependenciesManager instance.
     */
    getDependencies(desktopPath, file, configs, depsManager) {
        const settings = this.getSettings(desktopPath, file);
        const dependencies = {
            fromSettings: {},
            plugins: {},
            modules: {}
        };

        if ('dependencies' in settings) {
            dependencies.fromSettings = settings.dependencies;
        }

        // Plugins are also treated as npm packages.
        if ('plugins' in settings) {
            dependencies.plugins = Object.keys(settings.plugins).reduce((plugins, plugin) => {
                const pluginVersion = typeof settings.plugins[plugin] === 'object'
                    ? settings.plugins[plugin].version
                    : settings.plugins[plugin];
                plugins[plugin] = pluginVersion;
                return plugins;
            }, {});
        }

        // Each module can have its own dependencies.
        const moduleDependencies = {};

        configs.forEach(moduleConfig => {
            if (!('dependencies' in moduleConfig)) {
                moduleConfig.dependencies = {};
            }
            if (moduleConfig.name in moduleDependencies) {
                file.error({
                    message: `Duplicate name '${moduleConfig.name}' in 'module.json' within '${moduleConfig.dirName}'. Another module has already registered the same name.`
                });
            }
            moduleDependencies[moduleConfig.name] = moduleConfig.dependencies;
        });

        dependencies.modules = moduleDependencies;

        try {
            depsManager.mergeDependencies('settings.json[dependencies]', dependencies.fromSettings);
            depsManager.mergeDependencies('settings.json[plugins]', dependencies.plugins);

            Object.keys(dependencies.modules).forEach(module =>
                depsManager.mergeDependencies(`module[${module}]`, dependencies.modules[module])
            );

            return depsManager;
        } catch (e) {
            file.error({ message: e.message });
            return {};
        }
    }

    /**
     * Calculates an MD5 hash based on all dependencies.
     *
     * @param {Object} dependencies - Object containing all dependencies.
     * @param {string} desktopPath - Path to the desktop directory.
     * @param {Object} file - The file being processed by the build plugin.
     * @param {Function} md5 - MD5 hashing function.
     * @returns {string} - Calculated compatibility version.
     */
    calculateCompatibilityVersion(dependencies, desktopPath, file, md5) {
        const settings = this.getSettings(desktopPath, file);

        if ('desktopHCPCompatibilityVersion' in settings) {
            console.log(`[meteor-desktop] Compatibility version overridden to ${settings.desktopHCPCompatibilityVersion}`);
            return `${settings.desktopHCPCompatibilityVersion}`;
        }

        let deps = Object.keys(dependencies).sort();
        deps = deps.map(dependency => `${dependency}:${dependencies[dependency]}`);
        const mainCompatibilityVersion = this.requireLocal('@meteor-community/meteor-desktop/package.json')
            .version
            .split('.');
        const desktopCompatibilityVersion = settings.version.split('.')[0];
        deps.push(`meteor-desktop:${mainCompatibilityVersion[0]}`);
        deps.push(`desktop-app:${desktopCompatibilityVersion}`);
        if (process.env.METEOR_DESKTOP_DEBUG_DESKTOP_COMPATIBILITY_VERSION ||
            process.env.METEOR_DESKTOP_DEBUG
        ) {
            console.log('[meteor-desktop] Compatibility version calculated from', deps);
        }
        return md5(JSON.stringify(deps));
    }

    /**
     * Attempts to require a dependency from either the app's node_modules or meteor-desktop's node_modules.
     * Also verifies the version if necessary.
     *
     * @param {string} dependency - The dependency name.
     * @param {string} version - The required version.
     * @returns {Object|null} - The required dependency or null if not found.
     */
    getDependency(dependency, version) {
        let appScope = null;
        let meteorDesktopScope = null;

        try {
            // Attempt to require the dependency from the app's node_modules.
            const requiredDependency = this.requireLocal(dependency);
            const requiredVersion = this.requireLocal(`${dependency}/package.json`).version;
            appScope = { dependency: requiredDependency, version: requiredVersion };
            if (process.env.METEOR_DESKTOP_DEBUG) {
                console.log(`Found ${dependency}@${appScope.version} [required: ${version}]`);
            }
        } catch (e) {
            // Silently fail if not found.
        }

        try {
            // Attempt to require the dependency from meteor-desktop's node_modules.
            meteorDesktopScope = this.requireLocal(`@meteor-community/meteor-desktop/node_modules/${dependency}`);
            if (process.env.METEOR_DESKTOP_DEBUG) {
                console.log(`Found ${dependency} in meteor-desktop scope`);
            }
        } catch (e) {
            // Silently fail if not found.
        }

        if (appScope !== null && appScope.version === version) {
            return appScope.dependency;
        }
        if (meteorDesktopScope !== null) {
            return meteorDesktopScope;
        }

        return null;
    }

    /**
     * Retrieves a specific field from meteor-desktop's package.json.
     *
     * @param {string} field - The field name to retrieve.
     * @returns {*} - The value of the specified field.
     */
    getPackageJsonField(field) {
        if (!this.packageJson) {
            try {
                this.packageJson = this.requireLocal('@meteor-community/meteor-desktop/package.json');
            } catch (e) {
                throw new Error('Could not load package.json from meteor-desktop. Is meteor-desktop installed?');
            }
        }
        return this.packageJson[field];
    }

    /**
     * Retrieves the version of meteor-desktop.
     *
     * @returns {string} - The version string.
     */
    getVersion() {
        return this.getPackageJsonField('version');
    }

    /**
     * Finds and requires all specified node_modules dependencies.
     *
     * @param {Array} deps - Array of dependency names.
     * @returns {Object} - Object containing all required dependencies.
     */
    lookForAndRequireDependencies(deps) {
        const dependencies = {};

        // Load the dependencies section from meteor-desktop's package.json to get correct versions.
        const versions = this.getPackageJsonField('dependencies');

        deps.forEach(dependency => {
            const dependencyCamelCased = toCamelCase(dependency);

            this.stampPerformance(`deps get ${dependency}`);
            dependencies[dependencyCamelCased] = this.getDependency(dependency, versions[dependency]);
            this.stampPerformance(`deps get ${dependency}`);

            if (dependencies[dependencyCamelCased] === null) {
                throw new Error(
                    `Error while trying to require ${dependency}. Are you sure you have meteor-desktop installed?`
                );
            }
        });

        return dependencies;
    }

    /**
     * Records a performance timestamp for a given identifier.
     *
     * @param {string} id - Identifier for the performance stamp.
     */
    stampPerformance(id) {
        if (id in this.performanceStamps) {
            this.performanceStamps[id] = Date.now() - this.performanceStamps[id].now;
        } else {
            this.performanceStamps[id] = { now: Date.now() };
        }
    }

    /**
     * Logs a summary of all performance stamps.
     */
    getPerformanceReport() {
        console.log('[meteor-desktop] Performance summary:');
        Object.keys(this.performanceStamps).forEach(stampName => {
            if (typeof this.performanceStamps[stampName] === 'number') {
                console.log(`\t${stampName}: ${this.performanceStamps[stampName]}ms`);
            }
        });
    }

    /**
     * Compares two stats objects for equality.
     *
     * @param {Object} stat1 - First stats object.
     * @param {Object} stat2 - Second stats object.
     * @returns {boolean} - True if stats are equal, else false.
     */
    static areStatsEqual(stat1, stat2) {
        const keys1 = Object.keys(stat1).sort();
        const keys2 = Object.keys(stat2).sort();

        if (keys1.length !== keys2.length) return false;
        if (!arraysIdentical(keys1, keys2)) return false;

        return keys1.every(key =>
            stat1[key].size === stat2[key].size &&
            stat1[key].dates[0] === stat2[key].dates[0] &&
            stat1[key].dates[1] === stat2[key].dates[1] &&
            stat1[key].dates[2] === stat2[key].dates[2]
        );
    }

    /**
     * Compiles the protocols.index.js file.
     *
     * @param {Array} files - Array of files to process.
     */
    async processFilesForTarget(files) {
        this.performanceStamps = {};
        let inputFile = null;
        let versionFile = null;
        let requireLocal = null;

        // Identify relevant files.
        files.forEach(file => {
            if (file.getArch() === 'web.cordova') {
                if (
                    file.getPackageName() === 'communitypackages:meteor-desktop-bundler' &&
                    file.getPathInPackage() === 'version._desktop_.js'
                ) {
                    versionFile = file;
                }
                if (
                    file.getPackageName() === null &&
                    file.getPathInPackage() === 'version.desktop'
                ) {
                    requireLocal = file.require.bind(file);
                    inputFile = file;
                }
            } else if (
                file.getArch() !== 'web.browser' &&
                this.version &&
                file.getPathInPackage() === 'version._desktop_.js'
            ) {
                file.addJavaScript({
                    sourcePath: file.getPathInPackage(),
                    path: file.getPathInPackage(),
                    data: `METEOR_DESKTOP_VERSION = ${JSON.stringify(this.version)};`,
                    hash: file.getSourceHash(),
                    sourceMap: null
                });
                this.version = null;
            }
        });

        if (inputFile === null || requireLocal === null || versionFile === null) {
            return;
        }

        this.requireLocal = requireLocal;

        Profile.time('meteor-desktop: preparing desktop.asar', async () => {
            this.watcherEnabled = false;
            this.stampPerformance('whole build');
            const desktopPath = './.desktop';
            const settings = this.getSettings(desktopPath, inputFile);

            if (!settings.desktopHCP) {
                console.warn('[meteor-desktop] Skipping desktop.asar preparation because desktopHCP is set to false. Remove this plugin if you do not wish to use desktopHCP.');
                return;
            }

            console.time('[meteor-desktop] preparing desktop.asar took');

            let electronAsar, shelljs, babelCore, babelPresetEnv, terser, del, cacache, md5;

            /**
             * Explanation regarding String.prototype.to manipulation to prevent conflicts between different shelljs versions.
             */
            const StringPrototypeToOriginal = String.prototype.to;

            this.stampPerformance('basic deps lookout');
            let DependenciesManager, ElectronAppScaffold;
            try {
                const deps = this.lookForAndRequireDependencies(this.deps);
                ({ cacache } = deps);

                DependenciesManager = this.requireLocal('@meteor-community/meteor-desktop/dist/dependenciesManager').default;
                this.utils = this.requireLocal('@meteor-community/meteor-desktop/dist/utils');
                ElectronAppScaffold = this.requireLocal('@meteor-community/meteor-desktop/dist/electronAppScaffold').default;
            } catch (e) {
                // Restore original String.prototype.to to prevent side effects.
                String.prototype.to = StringPrototypeToOriginal; // eslint-disable-line

                inputFile.error({
                    message: e.message || e
                });
                return;
            }
            this.stampPerformance('basic deps lookout');

            const context = {
                env: {
                    isProductionBuild: () => process.env.NODE_ENV === 'production',
                    options: {
                        production: process.env.NODE_ENV === 'production'
                    }
                }
            };

            if (context.env.isProductionBuild()) {
                console.log('[meteor-desktop] Creating a production build');
            }

            let shelljsConfig;
            const self = this;

            /**
             * Logs debug messages if debugging is enabled.
             *
             * @param {...any} args - Arguments to log.
             */
            function logDebug(...args) {
                if (process.env.METEOR_DESKTOP_DEBUG) console.log(...args);
            }

            /**
             * Adds necessary files to the build output.
             *
             * @param {Buffer} contents - ASAR package contents.
             * @param {Object} desktopSettings - Settings object for the desktop build.
             * @returns {Object} - Version object.
             */
            function addFiles(contents, desktopSettings) {
                const versionObject = {
                    version: desktopSettings.desktopVersion,
                    compatibilityVersion: desktopSettings.compatibilityVersion
                };
                self.stampPerformance('file add');
                inputFile.addAsset({
                    path: 'version.desktop.json',
                    data: JSON.stringify(versionObject, null, 2)
                });

                inputFile.addAsset({
                    path: 'desktop.asar',
                    data: contents
                });

                versionFile.addJavaScript({
                    sourcePath: inputFile.getPathInPackage(),
                    path: inputFile.getPathInPackage(),
                    data: `METEOR_DESKTOP_VERSION = ${JSON.stringify(versionObject)};`,
                    hash: inputFile.getSourceHash(),
                    sourceMap: null
                });
                self.stampPerformance('file add');
                self.version = versionObject;
                return versionObject;
            }

            /**
             * Finalizes the build process by restoring configurations and logging performance.
             */
            function endProcess() {
                console.timeEnd('[meteor-desktop] preparing desktop.asar took');

                // Restore the original String.prototype.to to prevent conflicts.
                String.prototype.to = StringPrototypeToOriginal; // eslint-disable-line

                if (shelljs) {
                    shelljs.config = shelljsConfig;
                }
                self.stampPerformance('whole build');
                if (process.env.METEOR_DESKTOP_DEBUG) {
                    self.getPerformanceReport();
                }
            }

            const scaffold = new ElectronAppScaffold(context);
            const depsManager = new DependenciesManager(
                context,
                scaffold.getDefaultPackageJson().dependencies
            );

            this.stampPerformance('readdir');
            let readDirResult;
            try {
                readDirResult = await this.utils.readDir(desktopPath);
            } catch (e) {
                inputFile.error({
                    message: e.message || e
                });
                return;
            }
            this.stampPerformance('readdir');

            this.stampPerformance('cache check');
            let lastStats = null;
            try {
                const cacheGetResult = await cacache.get(this.cachePath, 'last');
                lastStats = JSON.parse(cacheGetResult.data.toString('utf8'));
            } catch (e) {
                logDebug('[meteor-desktop] No cache found');
            }

            if (
                settings.env !== 'prod' &&
                lastStats &&
                MeteorDesktopBundler.areStatsEqual(lastStats.stats, readDirResult.stats)
            ) {
                logDebug('[meteor-desktop] Cache match found');
                try {
                    const cacheAsarResult = await cacache.get(this.cachePath, 'lastAsar');
                    const contents = cacheAsarResult.data;
                    if (cacheAsarResult.integrity === lastStats.asarIntegrity) {
                        const cacheSettingsResult = await cacache.get(this.cachePath, 'lastSettings');
                        const lastSettings = JSON.parse(cacheSettingsResult.data.toString('utf8'));
                        if (lastSettings.asarIntegrity === lastStats.asarIntegrity) {
                            addFiles(contents, lastSettings.settings);
                            endProcess();
                            return;
                        }
                        logDebug('[meteor-desktop] Integrity check of settings failed');
                    } else {
                        logDebug('[meteor-desktop] Integrity check of ASAR failed');
                    }
                } catch (e) {
                    logDebug('[meteor-desktop] Cache miss during integrity checks');
                }
            } else {
                if (settings.env !== 'prod') {
                    logDebug('[meteor-desktop] Cache miss detected');
                }
                try {
                    await cacache.rm(this.cachePath, 'last');
                    logDebug('[meteor-desktop] Cache invalidated');
                } catch (e) {
                    logDebug('[meteor-desktop] Failed to invalidate cache:', e);
                }
            }
            this.stampPerformance('cache check');

            this.stampPerformance('build deps lookout');
            try {
                const deps = this.lookForAndRequireDependencies(this.buildDeps);
                ({
                    electronAsar,
                    shelljs,
                    del,
                    babelCore,
                    babelPresetEnv,
                    terser,
                    md5
                } = deps);
            } catch (e) {
                // Restore original String.prototype.to to prevent side effects.
                String.prototype.to = StringPrototypeToOriginal; // eslint-disable-line
                inputFile.error({
                    message: e.message || e
                });
                return;
            }
            this.stampPerformance('build deps lookout');

            shelljsConfig = { ...shelljs.config };
            shelljs.config.fatal = true;
            shelljs.config.silent = false;

            const desktopTmpPath = './.desktop-staging';
            const desktopTmpAsarPath = './.meteor/local';
            const modulesPath = path.join(desktopTmpPath, 'modules');

            this.stampPerformance('copy .desktop');
            shelljs.rm('-rf', desktopTmpPath);
            
            // Make sure to create the directory structure first
            shelljs.mkdir('-p', desktopTmpPath);
            shelljs.mkdir('-p', path.join(desktopTmpPath, 'modules'));
            shelljs.mkdir('-p', path.join(desktopTmpPath, 'assets'));

            shelljs.chmod('-R', '777', desktopTmpPath);
            shelljs.chmod('-R', '777', path.join(desktopTmpPath, 'modules'));
            shelljs.chmod('-R', '777', path.join(desktopTmpPath, 'assets'));

            // Copy files from .desktop to .desktop-staging
            shelljs.ls('-A', desktopPath).forEach(item => {
                const source = path.join(desktopPath, item);
                const target = path.join(desktopTmpPath, item);
                
                // For directories, copy them recursively if they don't exist yet
                if (fs.statSync(source).isDirectory()) {
                    if (!fs.existsSync(target)) {
                        shelljs.mkdir('-p', target);
                        shelljs.chmod('-R', '777', target);
                    }
                    shelljs.cp('-rf', path.join(source, '*'), target);
                } else {
                    // For files, just copy them directly
                    shelljs.cp('-f', source, target);
                }
            });
            
            // Ensure we create empty directories even if they're not in the source
            if (!fs.existsSync(path.join(desktopTmpPath, 'modules'))) {
                shelljs.mkdir('-p', path.join(desktopTmpPath, 'modules'));
                shelljs.chmod('-R', '777', path.join(desktopTmpPath, 'modules'));
            }
            if (!fs.existsSync(path.join(desktopTmpPath, 'assets'))) {
                shelljs.mkdir('-p', path.join(desktopTmpPath, 'assets'));
                shelljs.chmod('-R', '777', path.join(desktopTmpPath, 'assets'));
            }
            
            // Delete test files and macOS metadata files
            del.sync([
                path.join(desktopTmpPath, '**', '*.test.js'),
                path.join(desktopTmpPath, '**', '._*'),
                path.join(desktopTmpPath, '**', '.DS_Store')
            ]);
            
            // Set proper permissions
            shelljs.chmod('-R', '777', desktopTmpPath);
            // Make directories executable (necessary for traversal)
            shelljs.find(desktopTmpPath).forEach(function(file) {
                if (fs.statSync(file).isDirectory()) {
                    shelljs.chmod('777', file);
                }
            });
            shelljs.cp('-rf', desktopPath, desktopTmpPath);

            // del.sync([path.join(desktopTmpPath, '**', '*.test.js')]);
            // this.stampPerformance('copy .desktop');

            this.stampPerformance('compute dependencies');
            const configs = this.gatherModuleConfigs(shelljs, modulesPath, inputFile);
            const dependencies = this.getDependencies(desktopPath, inputFile, configs, depsManager);

            // Update settings with build environment.
            settings.env = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
            this.stampPerformance('compute dependencies');

            this.stampPerformance('desktop hash');
            let desktopHash, hashes, fileContents;

            try {
                const hashResult = await this.utils.readFilesAndComputeHash(
                    desktopPath,
                    file => file.replace('.desktop', '')
                );
                ({ fileContents, fileHashes: hashes, hash: desktopHash } = hashResult);
            } catch (e) {
                throw new Error(`[meteor-desktop] Failed to compute .desktop hash: ${e}`);
            }
            this.stampPerformance('desktop hash');

            const version = `${desktopHash}_${settings.env}`;
            console.log(`[meteor-desktop] Calculated .desktop hash version is ${version}`);

            settings.desktopVersion = version;
            settings.compatibilityVersion = this.calculateCompatibilityVersion(
                dependencies.getDependencies(),
                desktopPath,
                inputFile,
                md5
            );

            settings.meteorDesktopVersion = this.getVersion();

            if (process.env.METEOR_DESKTOP_PROD_DEBUG) {
                settings.prodDebug = true;
            }

            if (!fs.existsSync(desktopTmpPath)) {
                fs.mkdirSync(desktopTmpPath, { recursive: true });
            }
            fs.writeFileSync(
                path.join(desktopTmpPath, 'settings.json'),
                JSON.stringify(settings, null, 4)
            );

            // Remove files that should not be packaged into the ASAR archive.
            this.stampPerformance('extract');
            configs.forEach(config => {
                if ('extract' in config) {
                    const filesToExtract = Array.isArray(config.extract) ? config.extract : [config.extract];
                    filesToExtract.forEach(file => {
                        const filePath = path.join(modulesPath, config.dirName, file);
                        shelljs.rm(filePath);
                    });
                }
            });
            this.stampPerformance('extract');

            const options = 'uglifyOptions' in settings ? settings.uglifyOptions : {};
            const uglifyingEnabled = 'uglify' in settings && Boolean(settings.uglify);

            // Handle potential default export from babelPresetEnv.
            if (babelPresetEnv.default) {
                babelPresetEnv = babelPresetEnv.default;
            }

            // const preset = babelPresetEnv(
            //     {
            //         version: this.getPackageJsonField('dependencies')['@babel/preset-env'],
            //         assertVersion: () => {}
            //     },
            //     { targets: { node: '14' } }
            // );

            this.stampPerformance('babel/uglify');
            const processingPromises = Object.keys(fileContents).map(file => {
                const filePath = path.join(desktopTmpPath, file);
                const cacheKey = `${file}-${hashes[file]}`;

                return (async () => {
                    try {
                        const cacheEntry = await cacache.get(this.cachePath, cacheKey);
                        logDebug(`[meteor-desktop] Loaded from cache: ${file}`);
                        let code = cacheEntry.data;
                    
                        if (settings.env === 'prod' && uglifyingEnabled) {
                            const terserResult = await terser.minify(code.toString('utf8'), options);
                            if (terserResult.error) {
                                throw terserResult.error;
                            }
                            code = terserResult.code;
                        }
                    
                        fs.writeFileSync(filePath, code);
                    } catch (cacheError) {
                        logDebug(`[meteor-desktop] Processing from disk: ${file}`);
                        try {
                            const fileContent = fileContents[file];
                            const transformed = await babelCore.transformAsync(fileContent, {
                                presets: [ [babelPresetEnv, { targets: { node: '14' } }] ]
                            });
                    
                            if (!transformed || !transformed.code) {
                                throw new Error(`Babel transformation failed for file ${file}`);
                            }
                    
                            let code = transformed.code;
                    
                            await cacache.put(this.cachePath, `${file}-${hashes[file]}`, code);
                            logDebug(`[meteor-desktop] Cached: ${file}`);
                    
                            if (settings.env === 'prod' && uglifyingEnabled) {
                                const terserResult = await terser.minify(code, options);
                                if (terserResult.error) {
                                    throw terserResult.error;
                                }
                                code = terserResult.code;
                            }
                    
                            fs.writeFileSync(filePath, code);
                        } catch (transformError) {
                            this.watcherEnabled = true;
                            throw transformError;
                        }
                    }
                })();
            });

            try {
                await Promise.all(processingPromises);
            } catch (e) {
                inputFile.error({
                    message: e.message || e
                });
                return;
            }
            this.stampPerformance('babel/uglify');

            this.stampPerformance('@electron/asar');

            const asarPath = path.join(desktopTmpAsarPath, 'desktop.asar');
            try {
                await electronAsar.createPackage(desktopTmpPath, asarPath);
            } catch (e) {
                inputFile.error({
                    message: e.message || e
                });
                return;
            }
            this.stampPerformance('@electron/asar');

            const contents = fs.readFileSync(asarPath);

            /**
             * Saves the current build state to the cache.
             *
             * @param {Buffer} desktopAsar - The ASAR package buffer.
             * @param {Object} stats - File system stats.
             * @param {Object} desktopSettings - Desktop build settings.
             * @returns {Promise<string>} - The integrity hash of the saved ASAR.
             */
            async function saveCache(desktopAsar, stats, desktopSettings) {
                let asarIntegrity;
                try {
                    asarIntegrity = await cacache.put(self.cachePath, 'lastAsar', desktopAsar);
                    await cacache.put(self.cachePath, 'last', JSON.stringify({ stats, asarIntegrity }));
                    await cacache.put(
                        self.cachePath,
                        'lastSettings',
                        JSON.stringify({ settings: desktopSettings, asarIntegrity })
                    );
                    return asarIntegrity;
                } catch (e) {
                    throw e;
                }
            }

            if (settings.env !== 'prod') {
                try {
                    const integrity = await saveCache(contents, readDirResult.stats, settings);
                    logDebug('[meteor-desktop] Cache saved:', integrity);
                } catch (e) {
                    console.error('[meteor-desktop]: Saving cache failed:', e);
                }
            }

            addFiles(contents, settings);
            shelljs.rm(asarPath);

            if (!process.env.METEOR_DESKTOP_DEBUG) {
                this.stampPerformance('remove tmp');
                shelljs.rm('-rf', desktopTmpPath);
                this.stampPerformance('remove tmp');
            }

            endProcess();
        });
    }
}

// Register the compiler with Meteor if Plugin is defined.
if (typeof Plugin !== 'undefined') {
    Plugin.registerCompiler(
        { extensions: ['desktop', '_desktop_.js'] },
        () => new MeteorDesktopBundler(Plugin.fs)
    );
}