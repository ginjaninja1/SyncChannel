'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const webUiRoot = path.resolve(__dirname, '..', '..', 'Rules', 'WebUI');

function loadAmdModule(fileName) {
    let exported;
    const source = fs.readFileSync(path.join(webUiRoot, fileName), 'utf8');
    vm.runInNewContext(source, {
        define: function (_dependencies, factory) { exported = factory(); }
    }, { filename: fileName });
    return exported;
}

const sessions = loadAmdModule('editorSession.js');
const dirtyTracker = loadAmdModule('dirtyTracker.js');

(function canonicalComparisonIgnoresRuntimeOnlyState() {
    const saved = { Id: 'movies', Path: '/movie', Mapping: { CachedType: 'String', Value: 'id' } };
    const rendered = { Id: 'movies', Path: '/movie', Mapping: { CachedType: 'Number', Value: 'id' } };
    assert.strictEqual(
        sessions.canonicalJson(saved, { CachedType: true }),
        sessions.canonicalJson(rendered, { CachedType: true })
    );
    rendered.Path = '/changed';
    assert.notStrictEqual(
        sessions.canonicalJson(saved, { CachedType: true }),
        sessions.canonicalJson(rendered, { CachedType: true })
    );
})();

(function revertingToTheBaselineClearsDirtyState() {
    const tracker = dirtyTracker.createTracker(JSON.stringify);
    const draft = { Name: 'Original' };
    tracker.snapshotSaved(draft);
    draft.Name = 'Changed';
    assert.strictEqual(tracker.isDirty(draft), true);
    draft.Name = 'Original';
    assert.strictEqual(tracker.isDirty(draft), false);
})();

(function dirtyEditorBlocksAllNavigationUntilResolved() {
    const screens = ['connections', 'schemas', 'ruleSets', 'tree'];
    screens.forEach(owner => {
        let dirty = true;
        let saving = false;
        const unregister = sessions.register(owner + '-test', owner, () => dirty, () => saving);
        screens.forEach(destination => {
            assert.strictEqual(sessions.allowNavigation(destination), false, owner + ' must block ' + destination);
        });
        dirty = false;
        assert.strictEqual(sessions.allowNavigation('connections'), true);
        saving = true;
        assert.strictEqual(sessions.allowNavigation('connections'), false);
        saving = false;
        unregister();
    });
})();

(function savingLocksAndRestoresScreenControls() {
    const controls = [
        { disabled: false, dataset: {} },
        { disabled: true, dataset: {} }
    ];
    const view = {
        querySelector: () => ({ querySelectorAll: () => controls })
    };
    sessions.setBusy(view, 'schemas', true);
    assert.deepStrictEqual(controls.map(c => c.disabled), [true, true]);
    sessions.setBusy(view, 'schemas', false);
    assert.deepStrictEqual(controls.map(c => c.disabled), [false, true]);
})();

(function deletionSelectionIsNextThenPreviousThenBlank() {
    const id = item => item.Id;
    assert.strictEqual(sessions.selectionAfterDeletion([{ Id: 'a' }, { Id: 'c' }], 1, id), 'c');
    assert.strictEqual(sessions.selectionAfterDeletion([{ Id: 'a' }], 1, id), 'a');
    assert.strictEqual(sessions.selectionAfterDeletion([], 0, id), '');
})();

(function productionSourcesRetainTheStateBoundaries() {
    const connections = fs.readFileSync(path.join(webUiRoot, 'connectionsTab.js'), 'utf8');
    const schemas = fs.readFileSync(path.join(webUiRoot, 'schemaEditorTab.js'), 'utf8');
    const ruleSets = fs.readFileSync(path.join(webUiRoot, 'ruleSetManagerTab.js'), 'utf8');
    const ruleBuilder = fs.readFileSync(path.join(webUiRoot, 'ruleBuilderTab.js'), 'utf8');

    assert.ok(!connections.includes('pendingConnectionRemovals'));
    assert.ok(!schemas.includes('schemaOperationChangedRuleSets'));
    assert.ok(!schemas.includes('saveEditedBuiltInsAsCopies'));
    assert.ok(!ruleSets.includes('builtInRuleDraftRootsById'));
    assert.ok(!ruleSets.includes('currentRuleSetIndex'));
    assert.ok(!schemas.includes('CachedType ='));
    assert.ok(!schemas.includes('Target Connection (enter its number)'));
    assert.ok(schemas.includes('clone.ConnectionId = source.ConnectionId;'));
    assert.ok(schemas.includes('var locked = isBuiltInTemplate;'));
    assert.ok(ruleSets.includes('read-only built-in Rule Set'));
    assert.ok(!ruleSets.includes('JSON.stringify(ruleSet.Root'));
    assert.ok(ruleBuilder.includes('function buildGroupNode(data, isRoot, onChange, connectionId, schemaId, readOnly)'));
    const switchBody = /function switchRuleSetTo[\s\S]*?\n        }/.exec(ruleSets)[0];
    const schemaChangeBody = /function onSchemaChanged[\s\S]*?\n        }/.exec(ruleSets)[0];
    const ruleSetSelectBody = /function renderRuleSetSelect[\s\S]*?\n        }/.exec(ruleSets)[0];
    assert.ok(!switchBody.includes('captureCurrentEditsIntoFile'));
    assert.ok(!schemaChangeBody.includes('captureCurrentEditsIntoFile'));
    assert.ok(ruleSetSelectBody.includes('select.value = currentRuleSetId;'));
    assert.ok(ruleSets.includes('publishingOwnRuleSetSave = true;'));
    assert.ok(ruleSets.includes('if (publishingOwnRuleSetSave) return;'));

    const connectionCollectionSet = connections.indexOf("store.set('schemas', newSchemas);");
    const connectionSelectionRestore = connections.indexOf("store.set('currentSchemaId', selectedSchemaId);", connectionCollectionSet);
    const connectionChangePublish = connections.indexOf("store.emit('schemasChanged');", connectionSelectionRestore);
    assert.ok(connectionCollectionSet !== -1 && connectionCollectionSet < connectionSelectionRestore);
    assert.ok(connectionSelectionRestore < connectionChangePublish);

    const schemaCollectionSet = schemas.indexOf("store.set('schemas', newSchemas);");
    const schemaSelectionRestore = schemas.indexOf("store.set('currentSchemaId', selectedSchemaExists ? selectedSchemaId : '');", schemaCollectionSet);
    const schemaChangePublish = schemas.indexOf("store.emit('schemasChanged');", schemaSelectionRestore);
    assert.ok(schemaCollectionSet !== -1 && schemaCollectionSet < schemaSelectionRestore);
    assert.ok(schemaSelectionRestore < schemaChangePublish);

    assert.ok(connections.includes("type: 'DELETE'"));
    assert.ok(schemas.includes("ChannelSync/EndpointSchemas/"));
    assert.ok(ruleSets.includes("ChannelSync/RuleSets/"));
    assert.ok(connections.includes('folderTreeReferencesForRuleSets'));
    assert.ok(schemas.includes('folderTreeReferencesForRuleSets'));
    assert.ok(ruleSets.includes('folderTreeReferencesForRuleSets'));
    assert.ok(!schemas.includes('No schema selected -- use + New'));
    assert.ok(!ruleSets.includes('No rule sets exist yet for this endpoint'));
})();

console.log('WebUI editor-session regression tests passed.');
