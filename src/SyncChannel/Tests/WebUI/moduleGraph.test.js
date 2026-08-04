'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const webUiRoot = path.resolve(__dirname, '..', '..', 'Rules', 'WebUI');
const resourceToFile = {
    SyncChannelStoreJs: 'store.js',
    SyncChannelEditorSessionJs: 'editorSession.js',
    SyncChannelDirtyTrackerJs: 'dirtyTracker.js',
    SyncChannelFieldDiscoveryJs: 'fieldDiscovery.js',
    SyncChannelSharedHelpersJs: 'sharedHelpers.js',
    SyncChannelDragEngineJs: 'dragEngine.js',
    SyncChannelConnectionsTabJs: 'connectionsTab.js',
    SyncChannelRuleBuilderTabJs: 'ruleBuilderTab.js',
    SyncChannelRuleSetManagerTabJs: 'ruleSetManagerTab.js',
    SyncChannelSchemaEditorTabJs: 'schemaEditorTab.js',
    SyncChannelFolderTreeTabJs: 'folderTreeTab.js'
};
const cache = { jQuery: {} };

function load(fileName) {
    if (cache[fileName]) return cache[fileName];
    let definition;
    vm.runInNewContext(fs.readFileSync(path.join(webUiRoot, fileName), 'utf8'), {
        define: (dependencies, factory) => { definition = { dependencies, factory }; }
    }, { filename: fileName });
    assert.ok(definition, fileName + ' must define an AMD module');
    const dependencies = definition.dependencies.map(resource => {
        if (resource === 'jQuery') return cache.jQuery;
        const name = resource.replace(/^configurationpage\?name=/, '');
        assert.ok(resourceToFile[name], 'Unknown resource ' + resource + ' in ' + fileName);
        return load(resourceToFile[name]);
    });
    const exported = definition.factory.apply(null, dependencies);
    cache[fileName] = exported;
    return exported;
}

Object.values(resourceToFile).forEach(load);
assert.strictEqual(typeof load('SyncChannel.js'), 'function');

const manager = load('ruleSetManagerTab.js');
const store = load('store.js');
const helpers = load('sharedHelpers.js');
const serverShape = { RuleSets: [{
    Id: 'builtin', Name: 'Missing', EndpointSchemaId: 'movies', IsBuiltIn: true,
    Root: { Kind: 'Group', Not: false, LogicOperator: 'And', Children: [{
        Kind: 'Condition', Not: false, LogicOperator: 'And', Children: [],
        Field: 'monitored', Operator: 'EQ', Value: 'true'
    }], Field: '', Operator: 'EQ', Value: '' }
}] };
const domShape = { RuleSets: [{
    Id: 'builtin', Name: 'Missing', EndpointSchemaId: 'movies', IsBuiltIn: true,
    Root: { Kind: 'Group', Not: false, LogicOperator: 'And', Children: [{
        Kind: 'Condition', Not: false, Field: 'monitored', Operator: 'EQ', Value: 'true'
    }] }
}] };
assert.strictEqual(manager.ruleSetsForComparison(serverShape), manager.ruleSetsForComparison(domShape));

const dependencyTree = {
    Id: 'root', DisplayName: 'Root', Fetches: [], Children: [{
        Id: 'films', DisplayName: 'Films', Children: [], Fetches: [{
            Id: 'missing-fetch', DisplayLabel: 'Missing movies', RuleSetId: 'missing'
        }]
    }]
};
const dependencies = store.folderTreeReferencesForRuleSets(dependencyTree, ['missing']);
assert.deepStrictEqual(JSON.parse(JSON.stringify(dependencies)), [{
    FolderId: 'films', FetchId: 'missing-fetch', RuleSetId: 'missing',
    Path: 'Root → Films', FetchName: 'Missing movies'
}]);
const dependencyMessage = helpers.folderFetchDependencyMessage('Rule Set', 'Missing', dependencies);
assert.ok(dependencyMessage.includes('Remove or reassign these Folder Fetches first'));
assert.ok(dependencyMessage.includes('Root → Films — Missing movies'));

const builtInsOnlyMessage = helpers.connectionDeletionMessage('Radarr',
    [{ IsBuiltIn: true }], [{ IsBuiltIn: true }, { IsBuiltIn: true }]);
assert.strictEqual(builtInsOnlyMessage, 'Delete connection "Radarr"?');
const customCascadeMessage = helpers.connectionDeletionMessage('Radarr',
    [{ IsBuiltIn: true }, { IsBuiltIn: false }],
    [{ IsBuiltIn: true }, { IsBuiltIn: true }, { IsBuiltIn: false }]);
assert.ok(customCascadeMessage.includes('1 custom Schema and 1 custom Rule Set'));
console.log('WebUI AMD module graph test passed.');
