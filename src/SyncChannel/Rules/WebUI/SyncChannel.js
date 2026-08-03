define(['jQuery', 'configurationpage?name=SyncChannelStoreJs',
        'configurationpage?name=SyncChannelConnectionsTabJs',
        'configurationpage?name=SyncChannelSchemaEditorTabJs',
        'configurationpage?name=SyncChannelRuleSetManagerTabJs',
        'configurationpage?name=SyncChannelFolderTreeTabJs'],
    function ($, store, connectionsTab, schemaEditorTab, ruleSetManagerTab, folderTreeTab) {
        'use strict';

        // Every tab keeps its own edits live in the shared store as you
        // type, saved independently per tab (see each tab's own Save
        // button) — there's no cross-tab draft/undo, so switching tabs out
        // from under an unsaved edit would silently strand it or, worse,
        // get scooped up by whatever the next tab's Save button submits.
        // Simplest robust fix: block the switch outright until the current
        // tab's changes are saved or discarded, matching the same rule
        // already enforced within the Schema tab's own dropdowns.
        function unsavedChangesTabName() {
            if (connectionsTab.hasUnsavedChanges()) return 'Connections';
            if (schemaEditorTab.hasUnsavedChanges()) return 'Endpoint Schemas';
            if (ruleSetManagerTab.hasUnsavedChanges()) return 'Rule Sets';
            if (folderTreeTab.hasUnsavedChanges()) return 'Folder Tree';
            return null;
        }

        function wireTabs(view) {
            var buttons = view.querySelectorAll('.emby-tab-button');
            buttons.forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    e.preventDefault();

                    if (!btn.classList.contains('emby-tab-button-active')) {
                        var blockingTab = unsavedChangesTabName();
                        if (blockingTab) {
                            alert('Save or discard your changes on the "' + blockingTab + '" tab before switching tabs.');
                            return;
                        }
                    }

                    buttons.forEach(function (b) { b.classList.remove('emby-tab-button-active'); });
                    btn.classList.add('emby-tab-button-active');

                    view.querySelectorAll('.mcsTab').forEach(function (t) { t.classList.remove('mcsTabVisible'); });
                    view.querySelector('#tab-' + btn.dataset.tab).classList.add('mcsTabVisible');

                    // The field palette (and its auto-hydrated discovery cache)
                    // otherwise only ever renders once, at initial page load --
                    // switching to this tab later never picked up newer state
                    // without this.
                    if (btn.dataset.tab === 'schemas') {
                        schemaEditorTab.renderSchemaForm(view);
                    }
                });
            });

            buttons[0].classList.add('emby-tab-button-active');
            view.querySelector('#tab-' + buttons[0].dataset.tab).classList.add('mcsTabVisible');
        }

        // ===================================================================
        // Load everything, populate the shared store, then let each tab
        // module initialize itself off that store. Nothing here knows how
        // any individual tab renders.
        // ===================================================================
        function loadAll(view) {
            Promise.all([
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/Connections'), dataType: 'json' }),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/EndpointSchemas'), dataType: 'json' }),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/RuleSets'), dataType: 'json' }),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/FolderTree'), dataType: 'json' })
            ]).then(function (results) {
                var connections = (results[0] && results[0].Connections) || [];
                var persistedConnectionIds = {};
                connections.forEach(function (c) { persistedConnectionIds[c.Id] = true; });

                store.set('connections', connections);
                store.set('persistedConnectionIds', persistedConnectionIds);
                store.set('schemas', (results[1] && results[1].Schemas) || []);
                store.set('ruleSetsFile', (results[2] && results[2].RuleSets) ? results[2] : { RuleSets: [] });
                store.set('currentTree', results[3]);

                // Each tab module renders itself and snapshots its own
                // "saved" state for dirty tracking — this is just handoff
                // order, matching each tab's own internal dependencies
                // (e.g. Rule Set Manager reads Connections/Schemas that
                // must already be in the store).
                connectionsTab.init(view);
                schemaEditorTab.init(view);
                ruleSetManagerTab.init(view);
                folderTreeTab.init(view);
            }).catch(function () {
                Dashboard.alert('Failed to load Channel Sync configuration — see server log.');
            });
        }

        function applySurfaceBackgroundVariable(view) {
            var resolved = getComputedStyle(document.body).backgroundColor;

            if (!resolved || resolved === 'rgba(0, 0, 0, 0)' || resolved === 'transparent') {
                resolved = getComputedStyle(document.documentElement).backgroundColor;
            }
            if (!resolved || resolved === 'rgba(0, 0, 0, 0)' || resolved === 'transparent') {
                resolved = '#202028';
            }

            view.style.setProperty('--mcs-surface-bg', resolved);
        }

        return function (view) {
            view.addEventListener('viewshow', function () {
                applySurfaceBackgroundVariable(view);
                wireTabs(view);
                loadAll(view);
            });
        };
    });