/* eslint-disable prefer-arrow-callback */
Package.describe({
    name: 'communitypackages:meteor-desktop-bundler',
    version: '3.3.0',
    summary: 'Bundles .desktop dir into desktop.asar.',
    git: 'https://github.com/Meteor-Community-Packages/meteor-desktop',
    documentation: 'README.md'
});

Package.registerBuildPlugin({
    name: 'meteor-desktop-bundler',
    use: ['ecmascript@0.16.9', 'typescript@4.9.5'],
    sources: ['bundler.js'],
    npmDependencies: { chokidar: '3.5.3' }
});

Package.onUse(function onUse(api) {
    api.versionsFrom(['2.8.1', '2.16']);
    api.use('isobuild:compiler-plugin@1.0.0');
    api.addFiles([
        'version._desktop_.js'
    ]);
    api.export('METEOR_DESKTOP_VERSION', 'server');
});
