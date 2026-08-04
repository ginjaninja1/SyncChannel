define(['jQuery', 'configurationpage?name=SyncChannelStoreJs',
        'configurationpage?name=SyncChannelEditorSessionJs',
        'configurationpage?name=SyncChannelConnectionsTabJs',
        'configurationpage?name=SyncChannelSchemaEditorTabJs',
        'configurationpage?name=SyncChannelRuleSetManagerTabJs',
        'configurationpage?name=SyncChannelFolderTreeTabJs'],
    function ($, store, editorSession, connectionsTab, schemaEditorTab, ruleSetManagerTab, folderTreeTab) {
        'use strict';
        var pageNavigationGuardWired = false;

        // One coordinator owns every navigation decision. An editor with a
        // dirty draft (or a save in flight) keeps the operator on that screen
        // until Save or Discard resolves it.
        function wireTabs(view) {
            var buttons = view.querySelectorAll('.mcsTabBtn');

            function activateTab(btn) {
                buttons.forEach(function (b) {
                    var active = b === btn;
                    b.classList.toggle('mcsTabActive', active);
                    b.setAttribute('aria-selected', active ? 'true' : 'false');
                });

                view.querySelectorAll('.mcsTab').forEach(function (tab) {
                    tab.classList.toggle('mcsTabVisible', tab.id === 'tab-' + btn.dataset.tab);
                });

                // The field palette (and its auto-hydrated discovery cache)
                // otherwise only ever renders once, at initial page load --
                // switching to this tab later never picked up newer state
                // without this.
                if (btn.dataset.tab === 'schemas') {
                    schemaEditorTab.renderSchemaForm(view);
                }
            }

            buttons.forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    e.preventDefault();

                    if (!btn.classList.contains('mcsTabActive')) {
                        if (!editorSession.allowNavigation(btn.dataset.tab, null, function (blocked) {
                            alert(editorSession.blockedMessage(blocked));
                        })) {
                            return;
                        }
                    }

                    activateTab(btn);
                });

                btn.addEventListener('keydown', function (e) {
                    var index = Array.prototype.indexOf.call(buttons, btn);
                    var targetIndex = null;
                    if (e.key === 'ArrowLeft') targetIndex = (index + buttons.length - 1) % buttons.length;
                    else if (e.key === 'ArrowRight') targetIndex = (index + 1) % buttons.length;
                    else if (e.key === 'Home') targetIndex = 0;
                    else if (e.key === 'End') targetIndex = buttons.length - 1;
                    if (targetIndex === null) return;
                    e.preventDefault();
                    buttons[targetIndex].focus();
                    buttons[targetIndex].click();
                });
            });

            if (buttons.length) activateTab(buttons[0]);
        }

        function wirePageNavigationGuard(view) {
            if (pageNavigationGuardWired) return;
            pageNavigationGuardWired = true;
            document.addEventListener('click', function (event) {
                var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
                if (!anchor) return;
                var blocked = editorSession.blocker();
                if (!blocked) return;
                event.preventDefault();
                event.stopPropagation();
                alert(editorSession.blockedMessage(blocked));
            }, true);

            window.addEventListener('beforeunload', function (event) {
                if (!editorSession.blocker()) return;
                event.preventDefault();
                event.returnValue = '';
            });
        }

        // ===================================================================
        // Load everything, populate the shared store, then let each tab
        // module initialize itself off that store. Nothing here knows how
        // any individual tab renders.
        // ===================================================================
        function initMediaTests(view, settings) {
            settings = settings || {};
            view.querySelector('#mtEnabled').checked = !!settings.Enabled;
            view.querySelector('#mtVideoUrl').value = settings.VideoUrl || '';
            view.querySelector('#mtAudioUrl').value = settings.AudioUrl || '';
            view.querySelector('#mtImageUrl').value = settings.ImageUrl || '';
            view.querySelector('#mtHlsUrl').value = settings.HlsUrl || '';

            view.querySelector('#mtSaveRun').addEventListener('click', function () {
                var button = view.querySelector('#mtSaveRun');
                var status = view.querySelector('#mtStatus');
                button.disabled = true;
                status.innerText = 'Saving and starting channel refresh…';
                ApiClient.ajax({
                    type: 'POST',
                    url: ApiClient.getUrl('ChannelSync/MediaTestHarness'),
                    contentType: 'application/json',
                    dataType: 'json',
                    data: JSON.stringify({
                        Enabled: view.querySelector('#mtEnabled').checked,
                        VideoUrl: view.querySelector('#mtVideoUrl').value,
                        AudioUrl: view.querySelector('#mtAudioUrl').value,
                        ImageUrl: view.querySelector('#mtImageUrl').value,
                        HlsUrl: view.querySelector('#mtHlsUrl').value,
                        RunNow: true
                    })
                }).then(function (result) {
                    status.innerText = result && result.ImageError
                        ? 'Saved, but the test image could not be cached: ' + result.ImageError
                        : 'Saved. Channel refresh started; open Media Tests after it completes.';
                    button.disabled = false;
                }).catch(function () {
                    status.innerText = 'Save failed — see the Emby server log.';
                    button.disabled = false;
                });
            });
        }

        function loadAll(view) {
            Promise.all([
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/Connections'), dataType: 'json' }),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/EndpointSchemas'), dataType: 'json' }),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/RuleSets'), dataType: 'json' }),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/FolderTree'), dataType: 'json' }),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/MediaTestHarness'), dataType: 'json' })
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
                initMediaTests(view, results[4]);

                editorSession.register('connections', 'Connections', connectionsTab.hasUnsavedChanges, connectionsTab.isSaving);
                editorSession.register('schemas', 'Endpoint Schemas', schemaEditorTab.hasUnsavedChanges, schemaEditorTab.isSaving);
                editorSession.register('ruleSets', 'Rule Sets', ruleSetManagerTab.hasUnsavedChanges, ruleSetManagerTab.isSaving);
                editorSession.register('tree', 'Folder Tree', folderTreeTab.hasUnsavedChanges, folderTreeTab.isSaving);
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

                // Emby may raise viewshow repeatedly for a cached page. Wiring
                // again would stack click handlers and every tab module's store
                // subscriptions, so initialize this view exactly once.
                if (view.syncChannelInitialized) return;
                view.syncChannelInitialized = true;
                wireTabs(view);
                wirePageNavigationGuard(view);
                loadAll(view);
            });
        };
    });
