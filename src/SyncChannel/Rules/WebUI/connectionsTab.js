define(['jQuery', 'configurationpage?name=SyncChannelStoreJs',
        'configurationpage?name=SyncChannelEditorSessionJs',
        'configurationpage?name=SyncChannelDirtyTrackerJs',
        'configurationpage?name=SyncChannelSharedHelpersJs'],
    function ($, store, editorSession, dirtyTracker, helpers) {
        'use strict';

        // The Application dropdown's preset table. SystemType is the internal
        // preset key; newly selected custom connections use the fixed
        // "custom" key (legacy free-text values still load as Custom).
        var KNOWN_APPLICATIONS = [
            { key: 'radarr', label: 'Radarr (built-in)', apiKeyParamName: 'apikey', urlPlaceholder: 'http://192.168.1.10:7878' },
            { key: 'sonarr', label: 'Sonarr (built-in)', apiKeyParamName: 'apikey', urlPlaceholder: 'http://192.168.1.10:8989' },
            { key: 'emby', label: 'Emby (built-in)', apiKeyParamName: 'api_key', urlPlaceholder: 'http://192.168.1.10:8096' },
            { key: 'custom', label: 'Custom', apiKeyParamName: 'apikey', urlPlaceholder: 'http://192.168.1.10:port' }
        ];
        var CUSTOM_APPLICATION = KNOWN_APPLICATIONS[KNOWN_APPLICATIONS.length - 1];

        var tracker = dirtyTracker.createTracker(editableConnectionsJson);
        var saving = false;

        function editableConnectionsJson(items) {
            return JSON.stringify((items || []).map(function (connection) {
                return {
                    Id: connection.Id,
                    DisplayLabel: connection.DisplayLabel,
                    DisplayLabelIsUserEntered: !!connection.DisplayLabelIsUserEntered,
                    BaseUrl: connection.BaseUrl,
                    BaseUrlIsUserEntered: !!connection.BaseUrlIsUserEntered,
                    ApiKey: connection.ApiKey,
                    SystemType: connection.SystemType,
                    ApiKeyParamName: connection.ApiKeyParamName
                };
            }));
        }

        // Mirrors the "suggest, don't force" pattern already used for
        // BaseUrl/ApiKeyParamName (BaseUrlIsUserEntered): only auto-fills the
        // label while the operator hasn't typed their own, and re-suggests
        // when the System changes. Counts existing connections whose label
        // still looks auto-generated for that app root, not just SystemType,
        // so a connection someone deliberately renamed doesn't get counted
        // against the numbering (e.g. "My radar connection" doesn't stop a
        // fresh Radarr connection from still suggesting "Radarr", not "Radarr2").
        function computeDefaultDisplayLabel(app, connections, excludeId) {
            var root = app.label.replace(/\s*\(built-in\)\s*/i, '').trim() || app.key;
            var pattern = new RegExp('^' + root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d*)$', 'i');
            var highest = 0;
            var rootTaken = false;
            connections.forEach(function (c) {
                if (c.Id === excludeId) return;
                var m = pattern.exec((c.DisplayLabel || '').trim());
                if (!m) return;
                if (!m[1]) { rootTaken = true; return; }
                var n = parseInt(m[1], 10);
                if (n > highest) highest = n;
            });
            if (!rootTaken && highest === 0) return root;
            return root + Math.max(2, highest + 1);
        }

        function snapshotSaved() {
            tracker.snapshotSaved(store.get('connections'));
            // discardChanges() needs the exact prior connection objects back
            // (including fields editableConnectionsJson strips out, like
            // LastTestSucceeded) — the tracker only keeps a comparison
            // string, not something restorable, so this is captured
            // separately. Missing this line was the bug: discardChanges()
            // read connectionsSavedFullSnapshot, found it permanently null,
            // and silently no-op'd on every Discard click.
            store.set('connectionsSavedFullSnapshot', JSON.stringify(store.get('connections')));
        }

        function refreshDirtyState(view) {
            tracker.refreshUi(view, '#connDirtyWarning', '#connDiscardBtn', store.get('connections'));
        }

        function discardChanges(view) {
            var savedFull = store.get('connectionsSavedFullSnapshot');
            if (savedFull === null || savedFull === undefined) return;
            var connections = store.get('connections');
            var latestTestState = {};
            connections.forEach(function (c) {
                latestTestState[c.Id] = { LastTestSucceeded: c.LastTestSucceeded, LastTestedUtc: c.LastTestedUtc };
            });
            var restored = JSON.parse(savedFull);
            restored.forEach(function (c) {
                var test = latestTestState[c.Id];
                if (test) {
                    c.LastTestSucceeded = test.LastTestSucceeded;
                    c.LastTestedUtc = test.LastTestedUtc;
                }
            });

            store.set('connections', restored);
            view.querySelector('#connStatus').innerText = '';
            renderConnectionsTab(view);
            store.emit('connectionsChanged');
        }

        function renderConnectionsTab(view) {
            var connections = store.get('connections');
            var list = view.querySelector('#connList');
            list.innerHTML = '';

            connections.forEach(function (c, idx) {
                var row = document.createElement('tr');
                row.className = 'connDataRow';

                var labelInput = document.createElement('input');
                labelInput.style.width = '10em';
                labelInput.value = c.DisplayLabel;
                labelInput.placeholder = 'Label';
                labelInput.addEventListener('input', function (e) {
                    c.DisplayLabel = e.target.value;
                    c.DisplayLabelIsUserEntered = !!e.target.value;
                });

                var urlInput = document.createElement('input');
                urlInput.style.width = '16em';
                urlInput.value = c.BaseUrl;
                urlInput.addEventListener('input', function (e) {
                    c.BaseUrl = e.target.value;
                    c.BaseUrlIsUserEntered = !!e.target.value;
                });

                // Single decision point: Application. Radarr/Sonarr/Emby are
                // known, fixed presets (scheme/port hint + API key parameter
                // name); Custom exposes only the API key parameter name. Its
                // internal SystemType is set to "custom" when selected.
                var appSelect = document.createElement('select');
                appSelect.style.width = '10em';
                KNOWN_APPLICATIONS.forEach(function (app) {
                    var opt = document.createElement('option');
                    opt.value = app.key;
                    opt.textContent = app.label;
                    appSelect.appendChild(opt);
                });

                var paramNameInput = document.createElement('input');
                paramNameInput.style.width = '6em';
                paramNameInput.placeholder = 'apikey';
                paramNameInput.title = 'Eg \'apikey\' or \'api_key\'.';

                var currentApp = KNOWN_APPLICATIONS.filter(function (a) { return a.key === c.SystemType; })[0] || CUSTOM_APPLICATION;
                appSelect.value = currentApp.key;
                paramNameInput.value = c.ApiKeyParamName || currentApp.apiKeyParamName;
                if (!c.SystemType) { c.SystemType = currentApp.key; }
                if (!c.ApiKeyParamName) { c.ApiKeyParamName = paramNameInput.value; }
                if (!c.BaseUrlIsUserEntered) { c.BaseUrl = currentApp.urlPlaceholder; urlInput.value = c.BaseUrl; }
                urlInput.placeholder = currentApp.urlPlaceholder;

                appSelect.addEventListener('change', function (e) {
                    var app = KNOWN_APPLICATIONS.filter(function (a) { return a.key === e.target.value; })[0] || CUSTOM_APPLICATION;

                    urlInput.placeholder = app.urlPlaceholder;

                    if (!c.DisplayLabelIsUserEntered) {
                        c.DisplayLabel = computeDefaultDisplayLabel(app, connections, c.Id);
                        labelInput.value = c.DisplayLabel;
                    }

                    c.SystemType = app.key;
                    if (app.key !== 'custom') {
                        c.ApiKeyParamName = app.apiKeyParamName;
                        paramNameInput.value = app.apiKeyParamName;
                    }

                    if (!c.BaseUrlIsUserEntered) {
                        c.BaseUrl = app.urlPlaceholder;
                        urlInput.value = c.BaseUrl;
                    }

                });

                paramNameInput.addEventListener('input', function (e) {
                    c.ApiKeyParamName = e.target.value;
                });

                var keyWrap = document.createElement('span');
                keyWrap.style.display = 'inline-flex';
                keyWrap.style.alignItems = 'center';
                keyWrap.style.gap = '0.3em';

                var keyInput = document.createElement('input');
                keyInput.type = 'password';
                keyInput.style.width = '12em';
                keyInput.value = c.ApiKey;
                keyInput.placeholder = 'API key';
                keyInput.title = 'Apikey value eg \'d4cf83dae629ad06ba1c34e94ad9b314\'.';

                keyInput.addEventListener('input', function (e) { c.ApiKey = e.target.value; });

                var toggleBtn = document.createElement('span');
                toggleBtn.className = 'ftIconBtn';
                toggleBtn.style.cursor = 'pointer';
                toggleBtn.title = 'Show/hide API key';
                toggleBtn.innerText = '\uD83D\uDC41';
                toggleBtn.addEventListener('click', function () {
                    keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
                });

                keyWrap.appendChild(keyInput);
                keyWrap.appendChild(toggleBtn);

                var connBadge = document.createElement('span');
                connBadge.className = 'connBadge';
                connBadge.innerText = helpers.connectionBadgeText(c);

                var removeBtn = document.createElement('span');
                removeBtn.className = 'ftIconBtn';
                removeBtn.style.cursor = 'pointer';
                removeBtn.innerText = '\u2715';
                removeBtn.title = 'Remove connection';
                removeBtn.addEventListener('click', function () {
                    var ruleSetsFile = store.get('ruleSetsFile');
                    var ownedSchemas = store.schemasForConnection(c.Id);
                    var ownedSchemaIds = ownedSchemas.map(function (s) { return s.Id; });
                    var ownedRuleSets = ruleSetsFile.RuleSets
                        .filter(function (rs) { return ownedSchemaIds.indexOf(rs.EndpointSchemaId) !== -1; });
                    var ownedRuleIds = ownedRuleSets.map(function (rs) { return rs.Id; });
                    var persisted = !!store.get('persistedConnectionIds')[c.Id];

                    // Removing a never-saved row is cancellation, not a server
                    // deletion. This is the only deletion path that mutates
                    // locally before a request succeeds.
                    if (!persisted) {
                        connections.splice(idx, 1);
                        store.set('connections', connections);
                        renderConnectionsTab(view);
                        refreshDirtyState(view);
                        return;
                    }
                    if (tracker.isDirty(store.get('connections'))) {
                        Dashboard.alert('Save or discard your Connection changes before deleting a saved Connection.');
                        return;
                    }

                    var currentTree = store.get('currentTree');
                    var references = store.folderTreeReferencesForRuleSets(
                        currentTree && currentTree.RootFolder, ownedRuleIds);
                    if (references.length) {
                        Dashboard.alert(helpers.folderFetchDependencyMessage(
                            'connection', c.DisplayLabel, references));
                        return;
                    }
                    // Built-ins are generated scaffolding owned by the
                    // connection, not user data. They disappear implicitly
                    // and must never be presented as destructive cascade
                    // targets. Only custom dependants need an explicit warning.
                    if (!confirm(helpers.connectionDeletionMessage(
                        c.DisplayLabel, ownedSchemas, ownedRuleSets))) return;

                    var statusEl = view.querySelector('#connStatus');
                    statusEl.innerText = 'Deleting\u2026';
                    saving = true;
                    editorSession.setBusy(view, 'connections', true);
                    ApiClient.ajax({
                        type: 'DELETE',
                        url: ApiClient.getUrl('ChannelSync/Connections/' + encodeURIComponent(c.Id)),
                        dataType: 'json'
                    }).then(function (result) {
                        if (!result || result.Success !== true) {
                            saving = false;
                            editorSession.setBusy(view, 'connections', false);
                            statusEl.innerText = 'Deletion blocked -- nothing was removed.';
                            Dashboard.alert((result && result.Error) || 'The Connection could not be deleted.');
                            return;
                        }
                        var newConnections = (result && result.Connections) || [];
                        var newSchemas = (result && result.Schemas) || [];
                        var newRuleSets = (result && result.RuleSets) || [];
                        var persistedIds = {};
                        newConnections.forEach(function (connection) { persistedIds[connection.Id] = true; });

                        store.set('connections', newConnections);
                        store.set('persistedConnectionIds', persistedIds);
                        store.set('schemas', newSchemas);
                        store.set('ruleSetsFile', { RuleSets: newRuleSets });
                        if (!newSchemas.some(function (schema) { return schema.Id === store.get('currentSchemaId'); })) {
                            store.set('currentSchemaId', '');
                        }
                        if (!newRuleSets.some(function (ruleSet) { return ruleSet.Id === store.get('currentRuleSetId'); })) {
                            store.set('currentRuleSetId', '');
                        }

                        snapshotSaved();
                        renderConnectionsTab(view);
                        store.emit('connectionsChanged');
                        store.emit('schemasChanged');
                        store.emit('ruleSetsChanged');
                        refreshDirtyState(view);
                        statusEl.innerText = 'Deleted.';
                        saving = false;
                        editorSession.setBusy(view, 'connections', false);
                    }).catch(function () {
                        saving = false;
                        editorSession.setBusy(view, 'connections', false);
                        statusEl.innerText = 'Delete failed \u2014 nothing was removed. See server log.';
                    });
                });

                var testBtn = document.createElement('span');
                testBtn.className = 'ftIconBtn';
                testBtn.style.cursor = 'pointer';
                testBtn.innerText = '\uD83D\uDD0C Test';
                // Tests the LIVE field values on screen — works before Save
                // as well as after, and persists LastTestSucceeded/
                // LastTestedUtc onto the connection if it already exists.
                testBtn.addEventListener('click', function () {
                    if (testBtn.dataset.busy === 'true') return;
                    testBtn.dataset.busy = 'true';
                    connBadge.innerText = 'Testing\u2026';

                    ApiClient.ajax({
                        type: 'POST',
                        url: ApiClient.getUrl('ChannelSync/TestConnection'),
                        data: JSON.stringify({
                            ConnectionId: c.Id,
                            BaseUrl: c.BaseUrl,
                            ApiKey: c.ApiKey,
                            SystemType: c.SystemType
                        }),
                        contentType: 'application/json',
                        dataType: 'json'
                    }).then(function (result) {
                        testBtn.dataset.busy = 'false';
                        c.LastTestSucceeded = result.Success;
                        c.LastTestedUtc = new Date().toISOString();
                        connBadge.innerText = result.Success
                            ? helpers.connectionBadgeText(c)
                            : '\u274C ' + result.Message + ' (' + new Date(c.LastTestedUtc).toLocaleString() + ')';
                    }).catch(function () {
                        testBtn.dataset.busy = 'false';
                        connBadge.innerText = '\u274C Test request failed.';
                    });
                });

                var statusWrap = document.createElement('span');
                statusWrap.className = 'connStatusWrap';
                statusWrap.appendChild(connBadge);

                var systemWrap = document.createElement('span');
                systemWrap.style.display = 'inline-flex';
                systemWrap.style.flexDirection = 'column';
                systemWrap.style.gap = '0.3em';
                appSelect.style.width = '100%';
                systemWrap.appendChild(appSelect);

                var actionsWrap = document.createElement('span');
                actionsWrap.style.display = 'inline-flex';
                actionsWrap.style.gap = '0.5em';
                actionsWrap.appendChild(testBtn);
                actionsWrap.appendChild(removeBtn);

                [systemWrap, labelInput, urlInput, paramNameInput, keyWrap, actionsWrap].forEach(function (content) {
                    var cell = document.createElement('td');
                    cell.appendChild(content);
                    row.appendChild(cell);
                });

                var statusRow = document.createElement('tr');
                statusRow.className = 'connStatusRow';
                var statusCell = document.createElement('td');
                statusCell.colSpan = 6;
                statusCell.appendChild(statusWrap);
                statusRow.appendChild(statusCell);

                list.appendChild(row);
                list.appendChild(statusRow);
                row.addEventListener('input', function () { refreshDirtyState(view); });
                row.addEventListener('change', function () { refreshDirtyState(view); });
            });
            refreshDirtyState(view);
        }

        function addConnection(view) {
            var connections = store.get('connections');
            var defaultApp = KNOWN_APPLICATIONS[0];
            connections.push({
                Id: helpers.newId(),
                DisplayLabel: computeDefaultDisplayLabel(defaultApp, connections),
                DisplayLabelIsUserEntered: false,
                BaseUrl: '',
                BaseUrlIsUserEntered: false,
                ApiKey: '',
                SystemType: defaultApp.key,
                ApiKeyParamName: defaultApp.apiKeyParamName,
                LastTestSucceeded: null,
                LastTestedUtc: null
            });
            store.set('connections', connections);
            renderConnectionsTab(view);
            refreshDirtyState(view);
        }

        function saveConnections(view) {
            if (saving) return;
            var connections = store.get('connections');
            var statusEl = view.querySelector('#connStatus');
            var connectionNames = {};
            for (var i = 0; i < connections.length; i++) {
                var normalizedName = (connections[i].DisplayLabel || '').trim().toLowerCase();
                if (!normalizedName || connectionNames[normalizedName] || !(connections[i].SystemType || '').trim()) {
                    Dashboard.alert('Every Connection needs a unique name and a System.');
                    return;
                }
                connectionNames[normalizedName] = true;
            }

            var selectedSchemaId = store.get('currentSchemaId');
            var selectedRuleSetId = store.get('currentRuleSetId');
            statusEl.innerText = 'Saving\u2026';
            saving = true;
            editorSession.setBusy(view, 'connections', true);

            ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl('ChannelSync/Connections'),
                data: JSON.stringify({ Payload: { Connections: connections } }),
                contentType: 'application/json',
                dataType: 'json'
            }).then(function (result) {
                var affected = (result && result.AffectedFolderCount) || 0;
                statusEl.innerText = affected > 0 ? 'Saved. Folder tree resync started.' : 'Saved.';
                return Promise.all([
                    ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/Connections'), dataType: 'json' }),
                    ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/EndpointSchemas'), dataType: 'json' }),
                    ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/RuleSets'), dataType: 'json' })
                ]).then(function (results) {
                    var newConnections = (results[0] && results[0].Connections) || [];
                    store.set('connections', newConnections);
                    var persistedIds = {};
                    newConnections.forEach(function (c) { persistedIds[c.Id] = true; });
                    store.set('persistedConnectionIds', persistedIds);

                    var serverSchemas = (results[1] && results[1].Schemas) || [];
                    var serverRuleSets = (results[2] && results[2].RuleSets) || [];
                    var newSchemas = serverSchemas;
                    var newRuleSetsFile = { RuleSets: serverRuleSets };
                    store.set('schemas', newSchemas, 'schemasChanged');
                    store.set('ruleSetsFile', newRuleSetsFile, 'ruleSetsChanged');
                    store.set('currentSchemaId', selectedSchemaId);

                    var matching = store.ruleSetsForSchema(selectedSchemaId);
                    var selectedRuleExists = newRuleSetsFile.RuleSets.some(function (rs) { return rs.Id === selectedRuleSetId; });
                    store.set('currentRuleSetId', selectedRuleExists ? selectedRuleSetId : (matching.length ? matching[0].rs.Id : ''));

                    renderConnectionsTab(view);
                    store.emit('connectionsChanged');
                    snapshotSaved();
                    refreshDirtyState(view);
                    saving = false;
                    editorSession.setBusy(view, 'connections', false);
                });
            }).catch(function () {
                saving = false;
                editorSession.setBusy(view, 'connections', false);
                statusEl.innerText = 'Save failed \u2014 see server log.';
            });
        }

        function exportConnections(view) {
            var panel = view.querySelector('#connImportExportPanel');
            var text = view.querySelector('#connImportExportText');
            var status = view.querySelector('#connImportExportStatus');
            var confirmBtn = view.querySelector('#connImportExportConfirm');
            var exported = {
                Connections: store.get('connections').map(function (connection) {
                    return {
                        DisplayLabel: connection.DisplayLabel,
                        BaseUrl: connection.BaseUrl,
                        ApiKey: connection.ApiKey,
                        SystemType: connection.SystemType,
                        ApiKeyParamName: connection.ApiKeyParamName
                    };
                })
            };
            text.value = JSON.stringify(exported, null, 2);
            status.innerText = 'This export contains API keys. Store and share it securely.';
            confirmBtn.innerText = 'Copy to clipboard';
            confirmBtn.onclick = function () {
                helpers.copyTextToClipboard(text.value).then(function () {
                    status.innerText = 'Copied to clipboard. This text contains API keys.';
                }).catch(function () {
                    text.select();
                    status.innerText = 'Copy was blocked; the text is selected for manual copying. It contains API keys.';
                });
            };
            panel.style.display = '';
            text.focus();
            text.select();
        }

        function importConnections(view) {
            var panel = view.querySelector('#connImportExportPanel');
            var text = view.querySelector('#connImportExportText');
            var status = view.querySelector('#connImportExportStatus');
            var confirmBtn = view.querySelector('#connImportExportConfirm');
            text.value = '';
            status.innerText = 'Paste exported Connection JSON, then click Import. Imported Connections are added as unsaved copies.';
            confirmBtn.innerText = 'Import';
            confirmBtn.onclick = function () {
                var parsed;
                try {
                    parsed = JSON.parse(text.value);
                } catch (e) {
                    status.innerText = 'Not valid JSON.';
                    return;
                }
                var imported = Array.isArray(parsed) ? parsed :
                    (parsed && Array.isArray(parsed.Connections) ? parsed.Connections : [parsed]);
                if (!imported.length || imported.some(function (connection) {
                    return !connection || typeof connection !== 'object' ||
                        !(connection.DisplayLabel || '').trim() || !(connection.SystemType || '').trim();
                })) {
                    status.innerText = 'Each imported Connection needs a Connection Name and System.';
                    return;
                }

                var connections = store.get('connections');
                var names = {};
                connections.forEach(function (connection) {
                    names[(connection.DisplayLabel || '').trim().toLowerCase()] = true;
                });
                for (var i = 0; i < imported.length; i++) {
                    var nameKey = imported[i].DisplayLabel.trim().toLowerCase();
                    if (names[nameKey]) {
                        status.innerText = 'A Connection named "' + imported[i].DisplayLabel +
                            '" already exists. Rename it in the JSON before importing.';
                        return;
                    }
                    names[nameKey] = true;
                }

                imported.forEach(function (connection) {
                    connections.push({
                        Id: helpers.newId(),
                        DisplayLabel: connection.DisplayLabel.trim(),
                        BaseUrl: (connection.BaseUrl || '').trim(),
                        BaseUrlIsUserEntered: true,
                        ApiKey: connection.ApiKey || '',
                        SystemType: connection.SystemType.trim(),
                        ApiKeyParamName: connection.ApiKeyParamName || '',
                        LastTestSucceeded: null,
                        LastTestedUtc: null
                    });
                });
                store.set('connections', connections);
                panel.style.display = 'none';
                renderConnectionsTab(view);
                refreshDirtyState(view);
            };
            panel.style.display = '';
            text.focus();
        }

        // Wires this tab's static controls once and does the first render.
        // Called by SyncChannel.js after all tab modules are loaded.
        function init(view) {
            renderConnectionsTab(view);
            snapshotSaved();

            var addBtn = view.querySelector('#connAddBtn');
            if (addBtn) addBtn.addEventListener('click', function () { addConnection(view); });
            var saveBtn = view.querySelector('#connSaveBtn');
            if (saveBtn) saveBtn.addEventListener('click', function () { saveConnections(view); });
            var discardBtn = view.querySelector('#connDiscardBtn');
            if (discardBtn) discardBtn.addEventListener('click', function () { discardChanges(view); });
            var exportBtn = view.querySelector('#connExport');
            if (exportBtn) exportBtn.addEventListener('click', function () { exportConnections(view); });
            var importBtn = view.querySelector('#connImport');
            if (importBtn) importBtn.addEventListener('click', function () { importConnections(view); });
            var cancelBtn = view.querySelector('#connImportExportCancel');
            if (cancelBtn) cancelBtn.addEventListener('click', function () {
                view.querySelector('#connImportExportPanel').style.display = 'none';
            });
        }

        return {
            init: init,
            renderConnectionsTab: renderConnectionsTab,
            refreshDirtyState: refreshDirtyState,
            hasUnsavedChanges: function () { return tracker.isDirty(store.get('connections')); },
            isSaving: function () { return saving; }
        };
    });
