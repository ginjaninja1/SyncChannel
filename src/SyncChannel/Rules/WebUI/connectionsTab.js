define(['jQuery', 'configurationpage?name=SyncChannelStoreJs',
        'configurationpage?name=SyncChannelDirtyTrackerJs',
        'configurationpage?name=SyncChannelSharedHelpersJs'],
    function ($, store, dirtyTracker, helpers) {
        'use strict';

        // The Application dropdown's preset table. Single source of truth
        // for presets — separate from KNOWN_SYSTEM_TYPES below, which is a
        // free-form, open-ended list seeded from whatever's actually been
        // used (including past custom SystemTypes).
        var KNOWN_APPLICATIONS = [
            { key: 'radarr', label: 'Radarr (built-in)', apiKeyParamName: 'apikey', urlPlaceholder: 'http://192.168.1.10:7878' },
            { key: 'sonarr', label: 'Sonarr (built-in)', apiKeyParamName: 'apikey', urlPlaceholder: 'http://192.168.1.10:8989' },
            { key: 'emby', label: 'Emby (built-in)', apiKeyParamName: 'api_key', urlPlaceholder: 'http://192.168.1.10:8096' },
            { key: 'custom', label: 'Custom', apiKeyParamName: 'apikey', urlPlaceholder: 'http://192.168.1.10:port' }
        ];
        var CUSTOM_APPLICATION = KNOWN_APPLICATIONS[KNOWN_APPLICATIONS.length - 1];
        var KNOWN_SYSTEM_TYPES = ['radarr', 'sonarr'];

        var tracker = dirtyTracker.createTracker(editableConnectionsJson);

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
            store.set('pendingConnectionRemovals', {});
            var schemaOrder = {};
            store.get('schemas').forEach(function (schema, index) { schemaOrder[schema.Id] = index; });
            store.set('connectionSchemaOrder', schemaOrder);
            var ruleOrder = {};
            (store.get('ruleSetsFile').RuleSets || []).forEach(function (rs, index) { ruleOrder[rs.Id] = index; });
            store.set('connectionRuleOrder', ruleOrder);
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

            var schemas = store.get('schemas');
            var ruleSetsFile = store.get('ruleSetsFile');
            var pendingRemovals = store.get('pendingConnectionRemovals');
            Object.keys(pendingRemovals).forEach(function (connectionId) {
                var removed = pendingRemovals[connectionId];
                (removed.Schemas || []).forEach(function (schema) {
                    if (!schemas.some(function (existing) { return existing.Id === schema.Id; })) schemas.push(schema);
                });
                (removed.RuleSets || []).forEach(function (rs) {
                    if (!ruleSetsFile.RuleSets.some(function (existing) { return existing.Id === rs.Id; })) {
                        ruleSetsFile.RuleSets.push(rs);
                    }
                });
            });

            var schemaOrder = store.get('connectionSchemaOrder');
            schemas.sort(function (a, b) {
                var ai = schemaOrder.hasOwnProperty(a.Id) ? schemaOrder[a.Id] : Number.MAX_SAFE_INTEGER;
                var bi = schemaOrder.hasOwnProperty(b.Id) ? schemaOrder[b.Id] : Number.MAX_SAFE_INTEGER;
                return ai - bi;
            });
            var ruleOrder = store.get('connectionRuleOrder');
            ruleSetsFile.RuleSets.sort(function (a, b) {
                var ai = ruleOrder.hasOwnProperty(a.Id) ? ruleOrder[a.Id] : Number.MAX_SAFE_INTEGER;
                var bi = ruleOrder.hasOwnProperty(b.Id) ? ruleOrder[b.Id] : Number.MAX_SAFE_INTEGER;
                return ai - bi;
            });

            store.set('pendingConnectionRemovals', {});
            store.set('connections', restored);
            store.set('schemas', schemas, 'schemasChanged');
            store.set('ruleSetsFile', ruleSetsFile, 'ruleSetsChanged');
            view.querySelector('#connStatus').innerText = '';
            renderConnectionsTab(view);
            store.emit('connectionsChanged');
        }

        function refreshKnownSystemTypesFromConnections() {
            store.get('connections').forEach(function (c) {
                if (c.SystemType && KNOWN_SYSTEM_TYPES.indexOf(c.SystemType) === -1) {
                    KNOWN_SYSTEM_TYPES.push(c.SystemType);
                }
            });
        }

        function renderSystemTypeDatalist(view) {
            var list = view.querySelector('#knownSystemTypes');
            if (!list) return;
            list.innerHTML = '';
            KNOWN_SYSTEM_TYPES.forEach(function (t) {
                var opt = document.createElement('option');
                opt.value = t;
                list.appendChild(opt);
            });
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
                labelInput.addEventListener('change', function () { store.emit('connectionsChanged'); });

                var urlInput = document.createElement('input');
                urlInput.style.width = '16em';
                urlInput.value = c.BaseUrl;
                urlInput.addEventListener('input', function (e) {
                    c.BaseUrl = e.target.value;
                    c.BaseUrlIsUserEntered = !!e.target.value;
                });

                // Single decision point: Application. Radarr/Sonarr/Emby are
                // known, fixed presets (scheme/port hint + API key parameter
                // name); Custom hands control of SystemType and the API key
                // parameter name to the operator directly.
                var appSelect = document.createElement('select');
                appSelect.style.width = '10em';
                KNOWN_APPLICATIONS.forEach(function (app) {
                    var opt = document.createElement('option');
                    opt.value = app.key;
                    opt.textContent = app.label;
                    appSelect.appendChild(opt);
                });

                var customTypeInput = document.createElement('input');
                customTypeInput.setAttribute('list', 'knownSystemTypes');
                customTypeInput.style.width = '9em';
                customTypeInput.placeholder = 'system type';
                customTypeInput.title = 'Free-text identifier for this custom system -- must match the System Type set on its Endpoint Schema.';

                var paramNameInput = document.createElement('input');
                paramNameInput.style.width = '6em';
                paramNameInput.placeholder = 'apikey';
                paramNameInput.title = 'Eg \'apikey\' or \'api_key\'.';

                var currentApp = KNOWN_APPLICATIONS.filter(function (a) { return a.key === c.SystemType; })[0] || CUSTOM_APPLICATION;
                appSelect.value = currentApp.key;
                customTypeInput.value = c.SystemType || '';
                customTypeInput.style.display = (currentApp.key === 'custom') ? '' : 'none';
                paramNameInput.value = c.ApiKeyParamName || currentApp.apiKeyParamName;
                if (!c.SystemType) { c.SystemType = currentApp.key; }
                if (!c.ApiKeyParamName) { c.ApiKeyParamName = paramNameInput.value; }
                if (!c.BaseUrlIsUserEntered) { c.BaseUrl = currentApp.urlPlaceholder; urlInput.value = c.BaseUrl; }
                urlInput.placeholder = currentApp.urlPlaceholder;

                appSelect.addEventListener('change', function (e) {
                    var app = KNOWN_APPLICATIONS.filter(function (a) { return a.key === e.target.value; })[0] || CUSTOM_APPLICATION;

                    customTypeInput.style.display = (app.key === 'custom') ? '' : 'none';
                    urlInput.placeholder = app.urlPlaceholder;

                    if (!c.DisplayLabelIsUserEntered) {
                        c.DisplayLabel = computeDefaultDisplayLabel(app, connections, c.Id);
                        labelInput.value = c.DisplayLabel;
                    }

                    if (app.key === 'custom') {
                        if (KNOWN_APPLICATIONS.some(function (known) {
                            return known.key !== 'custom' && known.key === c.SystemType;
                        })) {
                            customTypeInput.value = '';
                        }
                        c.SystemType = customTypeInput.value;
                    } else {
                        c.SystemType = app.key;
                        c.ApiKeyParamName = app.apiKeyParamName;
                        paramNameInput.value = app.apiKeyParamName;
                    }

                    if (!c.BaseUrlIsUserEntered) {
                        c.BaseUrl = app.urlPlaceholder;
                        urlInput.value = c.BaseUrl;
                    }

                    refreshKnownSystemTypesFromConnections();
                    renderSystemTypeDatalist(view);
                    store.emit('connectionsChanged');
                });

                customTypeInput.addEventListener('input', function (e) {
                    c.SystemType = e.target.value;
                    refreshKnownSystemTypesFromConnections();
                    renderSystemTypeDatalist(view);
                    store.emit('connectionsChanged');
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
                    var schemas = store.get('schemas');
                    var ruleSetsFile = store.get('ruleSetsFile');
                    var ownedSchemas = store.schemasForConnection(c.Id);
                    var ownedSchemaIds = ownedSchemas.map(function (s) { return s.Id; });
                    var ownedRuleSets = ruleSetsFile.RuleSets
                        .filter(function (rs) { return ownedSchemaIds.indexOf(rs.EndpointSchemaId) !== -1; });
                    var ownedRuleIds = ownedRuleSets.map(function (rs) { return rs.Id; });
                    if (store.folderTreeUsesAnyRuleSet(store.get('currentTree'), ownedRuleIds)) {
                        Dashboard.alert('This connection cannot be removed because a Folder Fetch uses one of its Rule Sets.');
                        return;
                    }
                    if (!confirm('Remove connection "' + c.DisplayLabel + '" and all of its Schemas and Rule Sets?')) return;

                    var pendingRemovals = store.get('pendingConnectionRemovals');
                    pendingRemovals[c.Id] = {
                        Schemas: JSON.parse(JSON.stringify(ownedSchemas)),
                        RuleSets: JSON.parse(JSON.stringify(ownedRuleSets))
                    };
                    store.set('pendingConnectionRemovals', pendingRemovals);
                    store.set('schemas', schemas.filter(function (s) { return s.ConnectionId !== c.Id; }), 'schemasChanged');
                    ruleSetsFile.RuleSets = ruleSetsFile.RuleSets.filter(function (rs) {
                        return ownedSchemaIds.indexOf(rs.EndpointSchemaId) === -1;
                    });
                    store.set('ruleSetsFile', ruleSetsFile, 'ruleSetsChanged');
                    connections.splice(idx, 1);
                    store.set('connections', connections);
                    renderConnectionsTab(view);
                    store.emit('connectionsChanged');
                    refreshDirtyState(view);
                });

                var testBtn = document.createElement('span');
                testBtn.className = 'ftIconBtn';
                testBtn.style.cursor = 'pointer';
                testBtn.innerText = '\uD83D\uDD0C Test';
                var testStatus = document.createElement('span');
                testStatus.style.fontSize = '0.8em';
                testStatus.style.opacity = '0.7';

                // Tests the LIVE field values on screen — works before Save
                // as well as after, and persists LastTestSucceeded/
                // LastTestedUtc onto the connection if it already exists.
                testBtn.addEventListener('click', function () {
                    if (testBtn.dataset.busy === 'true') return;
                    testBtn.dataset.busy = 'true';
                    testStatus.innerText = 'Testing\u2026';

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
                        testStatus.innerText = result.Success ? '\u2705 Reachable' : '\u274C ' + result.Message;
                        c.LastTestSucceeded = result.Success;
                        c.LastTestedUtc = new Date().toISOString();
                        connBadge.innerText = helpers.connectionBadgeText(c);
                    }).catch(function () {
                        testBtn.dataset.busy = 'false';
                        testStatus.innerText = '\u274C Test request failed.';
                    });
                });

                var statusWrap = document.createElement('span');
                statusWrap.className = 'connStatusWrap';
                statusWrap.appendChild(testStatus);
                statusWrap.appendChild(connBadge);

                var systemWrap = document.createElement('span');
                systemWrap.style.display = 'inline-flex';
                systemWrap.style.flexDirection = 'column';
                systemWrap.style.gap = '0.3em';
                appSelect.style.width = '100%';
                customTypeInput.style.width = '100%';
                systemWrap.appendChild(appSelect);
                systemWrap.appendChild(customTypeInput);

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
            store.emit('connectionsChanged');
        }

        function saveConnections(view) {
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
            var currentRuleSetIndex = store.get('currentRuleSetIndex');
            var ruleSetsFile = store.get('ruleSetsFile');
            var selectedRuleSet = currentRuleSetIndex >= 0 ? ruleSetsFile.RuleSets[currentRuleSetIndex] : null;
            var selectedRuleSetId = selectedRuleSet ? selectedRuleSet.Id : '';
            var localCustomSchemas = store.get('schemas').filter(function (s) { return !s.IsBuiltIn; });
            var localCustomRuleSets = ruleSetsFile.RuleSets.filter(function (rs) { return !rs.IsBuiltIn; });
            statusEl.innerText = 'Saving\u2026';

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
                    var newSchemas = localCustomSchemas.concat(serverSchemas.filter(function (s) { return s.IsBuiltIn; }));
                    var newRuleSetsFile = {
                        RuleSets: localCustomRuleSets.concat(serverRuleSets.filter(function (rs) { return rs.IsBuiltIn; }))
                    };
                    store.set('schemas', newSchemas, 'schemasChanged');
                    store.set('ruleSetsFile', newRuleSetsFile, 'ruleSetsChanged');
                    store.set('currentSchemaId', selectedSchemaId);

                    var matching = store.ruleSetsForSchema(selectedSchemaId);
                    var selectedRuleIndex = newRuleSetsFile.RuleSets.findIndex(function (rs) { return rs.Id === selectedRuleSetId; });
                    store.set('currentRuleSetIndex', selectedRuleIndex >= 0 ? selectedRuleIndex : (matching.length ? matching[0].idx : -1));

                    renderConnectionsTab(view);
                    store.emit('connectionsChanged');
                    snapshotSaved();
                    refreshDirtyState(view);
                });
            }).catch(function () {
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
                store.emit('connectionsChanged');
                refreshDirtyState(view);
            };
            panel.style.display = '';
            text.focus();
        }

        // Wires this tab's static controls once and does the first render.
        // Called by SyncChannel.js after all tab modules are loaded.
        function init(view) {
            renderSystemTypeDatalist(view);
            refreshKnownSystemTypesFromConnections();
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
            renderSystemTypeDatalist: renderSystemTypeDatalist,
            hasUnsavedChanges: function () { return tracker.isDirty(store.get('connections')); }
        };
    });