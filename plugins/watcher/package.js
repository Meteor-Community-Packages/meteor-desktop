/* eslint-disable prefer-arrow-callback */
Package.describe({
    name: 'communitypackages:meteor-desktop-watcher',
    version: '3.3.0',
    summary: 'Watches .desktop dir and triggers rebuilds on file change.',
    git: 'https://github.com/Meteor-Community-Packages/meteor-desktop',
    documentation: 'README.md',
    debugOnly: true
});

Npm.depends({
    chokidar: '3.5.3'
});

Package.onUse(function onUse(api) {
    api.versionsFrom(['2.8.1', '2.16']);
    api.use('ecmascript');
    api.use('typescript');
    api.use([
        'communitypackages:meteor-desktop-bundler@3.2.0',
    ], ['server'], {
        weak: true
    });
    api.addFiles([
        'watcher.js'
    ], 'server');
});
