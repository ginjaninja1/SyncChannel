define(['jQuery', 'configurationpage?name=SyncChannelStoreJs',
        'configurationpage?name=SyncChannelEditorSessionJs',
        'configurationpage?name=SyncChannelDragEngineJs',
        'configurationpage?name=SyncChannelSharedHelpersJs',
        'configurationpage?name=SyncChannelRuleBuilderTabJs'],
    function ($, store, editorSession, dragEngine, helpers, ruleBuilderTab) {
        'use strict';

        function emptyRoot() {
            return { Kind: 'Group', LogicOperator: 'And', Not: false, Children: [] };
        }

        function ruleSetsForCurrentSchema(view) {
            var schemaId = view.querySelector('#rcsSchemaSelect').value;
            return store.ruleSetsForSchema(schemaId);
        }

        var lastRuleSetConnectionId = '';
        var lastRuleSetSchemaId = '';
        var savingRuleSets = false;
        var publishingOwnRuleSetSave = false;
        var ruleSetsRestoreSnapshot = null;

        function canonicalRuleNode(node) {
            node = node || {};
            if (node.Kind === 'Condition') {
                return {
                    Kind: 'Condition',
                    Not: !!node.Not,
                    Field: node.Field || '',
                    Operator: node.Operator || '',
                    Value: node.Value || ''
                };
            }
            return {
                Kind: 'Group',
                Not: !!node.Not,
                LogicOperator: node.LogicOperator || 'And',
                Children: (node.Children || []).map(canonicalRuleNode)
            };
        }

        function ruleSetsForComparison(file) {
            return editorSession.canonicalJson({
                RuleSets: ((file && file.RuleSets) || []).map(function (ruleSet) {
                    return {
                        Id: ruleSet.Id,
                        Name: ruleSet.Name,
                        EndpointSchemaId: ruleSet.EndpointSchemaId,
                        IsBuiltIn: !!ruleSet.IsBuiltIn,
                        Root: canonicalRuleNode(ruleSet.Root)
                    };
                })
            });
        }

        function ruleSetsAreDirty() {
            var saved = store.get('ruleSetsSavedSnapshot');
            return saved !== null &&
                ruleSetsForComparison(store.get('ruleSetsFile')) !== saved;
        }

        function rememberRuleSetNavigation(view) {
            lastRuleSetConnectionId = view.querySelector('#rcsConnectionSelect').value;
            lastRuleSetSchemaId = view.querySelector('#rcsSchemaSelect').value;
        }

        function restoreRuleSetNavigation(view) {
            var connSel = view.querySelector('#rcsConnectionSelect');
            var schemaSel = view.querySelector('#rcsSchemaSelect');
            var currentRuleSet = store.ruleSetById(store.get('currentRuleSetId'));
            var currentSchema = currentRuleSet
                ? store.get('schemas').filter(function (schema) {
                    return schema.Id === currentRuleSet.EndpointSchemaId;
                })[0]
                : null;
            var connectionId = currentSchema ? currentSchema.ConnectionId : lastRuleSetConnectionId;
            var schemaId = currentSchema ? currentSchema.Id : lastRuleSetSchemaId;

            if (store.get('connections').some(function (connection) { return connection.Id === connectionId; })) {
                connSel.value = connectionId;
            }
            rebuildRuleSetsSchemaOptions(view);
            if (store.schemasForConnection(connSel.value).some(function (schema) { return schema.Id === schemaId; })) {
                schemaSel.value = schemaId;
            }
            renderRuleSetSelect(view);
        }

        function blockDirtyRuleSetNavigation(view, destinationName) {
            if (editorSession.allowNavigation(destinationName, null, function (blocked) {
                alert(editorSession.blockedMessage(blocked));
            })) return false;
            restoreRuleSetNavigation(view);
            return true;
        }

        function captureCurrentEditsIntoFile(view) {
            var current = store.ruleSetById(store.get('currentRuleSetId'));
            if (!current) return;
            var rootGroupEl = view.querySelector('#conditionsList > .rcsGroupRoot');
            if (!rootGroupEl) return;
            if (current.IsBuiltIn) return;
            current.Root = ruleBuilderTab.readGroupFromDom(rootGroupEl);
        }

        function renderRuleSetSelect(view) {
            var select = view.querySelector('#rcsRuleSetSelect');
            select.innerHTML = '';

            var matching = ruleSetsForCurrentSchema(view);
            var currentRuleSetId = store.get('currentRuleSetId');

            matching.forEach(function (x) {
                var opt = document.createElement('option');
                opt.value = x.rs.Id;
                opt.innerText = (x.rs.Name || '(unnamed)') + (x.rs.IsBuiltIn ? ' 🔒' : '');
                if (x.rs.Id === currentRuleSetId) opt.selected = true;
                select.appendChild(opt);
            });

            if (matching.length === 0) {
                store.set('currentRuleSetId', '');
            } else if (!matching.some(function (x) { return x.rs.Id === currentRuleSetId; })) {
                store.set('currentRuleSetId', matching[0].rs.Id);
                select.value = matching[0].rs.Id;
            } else {
                // Re-assert the stable selection after every option has been
                // appended. Emby's enhanced select can otherwise keep the
                // first appended option displayed after the save-triggered
                // ruleSetsChanged render, even though the store still points
                // at the rule set that was just saved.
                select.value = currentRuleSetId;
            }
        }

        var canvasRenderToken = 0; // guards against a stale ensureFieldsDiscovered response rendering over a newer selection

        function renderCanvasForCurrentIndex(view, forceRefresh) {
            var list = view.querySelector('#conditionsList');
            list.innerHTML = '';
            dragEngine.resetDragEngine();
            ruleBuilderTab.populatePalette(view, forceRefresh);
            ruleBuilderTab.wireStaticPaletteChips(view);

            var connectionId = view.querySelector('#rcsConnectionSelect').value;
            var schemaId = view.querySelector('#rcsSchemaSelect').value;
            ruleBuilderTab.renderRuleRawResponse(view, schemaId);
            refreshRuleSetDirtyState(view);

            var ruleSet = store.ruleSetById(store.get('currentRuleSetId'));

            if (!ruleSet) {
                return;
            }

            if (ruleSet.IsBuiltIn) {
                var lockNotice = document.createElement('div');
                lockNotice.className = 'fieldDescription';
                lockNotice.style.marginBottom = '0.8em';
                lockNotice.innerText = '🔒 This is a read-only built-in Rule Set. Use Duplicate to create an editable copy.';
                list.appendChild(lockNotice);
            }

            var loadingHint = document.createElement('div');
            loadingHint.className = 'rcsFieldHint';
            loadingHint.innerText = 'Loading field types…';
            list.appendChild(loadingHint);

            var renderToken = ++canvasRenderToken;

            ruleBuilderTab.ensureFieldsDiscovered(connectionId, schemaId, !!forceRefresh)
                .catch(function () { return []; }) // best-effort: still render the canvas on discovery failure, conditions just fall back to String typing
                .then(function () {
                    if (renderToken !== canvasRenderToken) return; // superseded by a newer render — drop this response
                    if (loadingHint.parentNode) loadingHint.parentNode.removeChild(loadingHint);

                    var onChange = function () {
                        captureCurrentEditsIntoFile(view);
                        store.emit('ruleSetsDirtyStateChanged');
                        ruleBuilderTab.scheduleAutoPreview(view, false);
                    };
                    var displayedRoot = ruleSet.Root || emptyRoot();
                    list.appendChild(ruleBuilderTab.buildGroupNode(
                        displayedRoot, true, onChange, connectionId, schemaId, !!ruleSet.IsBuiltIn));

                    ruleBuilderTab.scheduleAutoPreview(view, false);
                });
        }

        function switchRuleSetTo(view, ruleSetId) {
            store.set('currentRuleSetId', ruleSetId);
            renderRuleSetSelect(view);
            renderCanvasForCurrentIndex(view);
        }

        function onSchemaChanged(view) {
            var matching = ruleSetsForCurrentSchema(view);
            store.set('currentRuleSetId', matching.length ? matching[0].rs.Id : '');
            renderRuleSetSelect(view);
            renderCanvasForCurrentIndex(view);
        }

        function rebuildRuleSetsSchemaOptions(view) {
            var connSel = view.querySelector('#rcsConnectionSelect');
            var schemaSel = view.querySelector('#rcsSchemaSelect');
            var allowed = store.schemasForConnection(connSel.value);
            var currentVal = schemaSel.value;

            schemaSel.innerHTML = '';
            allowed.forEach(function (s) {
                var o = document.createElement('option');
                o.value = s.Id;
                o.innerText = store.schemaOptionLabel(s);
                if (s.Id === currentVal) o.selected = true;
                schemaSel.appendChild(o);
            });
        }

        function renderConnectionAndSchemaSelects(view) {
            var connSel = view.querySelector('#rcsConnectionSelect');
            var priorConnectionId = connSel.value;
            var schemaSel = view.querySelector('#rcsSchemaSelect');
            var priorSchemaId = schemaSel.value;
            var connections = store.get('connections');
            connSel.innerHTML = '';
            connections.forEach(function (c) {
                var o = document.createElement('option');
                o.value = c.Id;
                o.innerText = helpers.connectionBadgeGlyph(c) + ' ' + (c.DisplayLabel || '(unnamed connection)');
                connSel.appendChild(o);
            });
            if (connections.some(function (c) { return c.Id === priorConnectionId; })) {
                connSel.value = priorConnectionId;
            }

            rebuildRuleSetsSchemaOptions(view);
            if (store.schemasForConnection(connSel.value).some(function (s) { return s.Id === priorSchemaId; })) {
                schemaSel.value = priorSchemaId;
            }
            rememberRuleSetNavigation(view);

            // Guarded the same way refreshBtn already is below -- this function
            // is called after every save (Connections, Endpoint Schemas) plus
            // initial load, and connSel/schemaSel are the same persisting DOM
            // nodes each time (only their options are rebuilt). Without this
            // guard, each call stacked another 'change' listener on top of the
            // last.
            if (!connSel.dataset.wired) {
                connSel.dataset.wired = '1';
                connSel.addEventListener('change', function () {
                    if (blockDirtyRuleSetNavigation(view, 'connections')) return;
                    rebuildRuleSetsSchemaOptions(view);
                    onSchemaChanged(view);
                    rememberRuleSetNavigation(view);
                });
            }

            if (!schemaSel.dataset.wired) {
                schemaSel.dataset.wired = '1';
                schemaSel.addEventListener('change', function () {
                    if (blockDirtyRuleSetNavigation(view, 'schemas')) return;
                    onSchemaChanged(view);
                    rememberRuleSetNavigation(view);
                });
            }

            var refreshBtn = view.querySelector('#rcsRefreshFieldsBtn');
            if (refreshBtn && !refreshBtn.dataset.wired) {
                refreshBtn.dataset.wired = '1';
                refreshBtn.addEventListener('click', function () {
                    var connectionId = view.querySelector('#rcsConnectionSelect').value;
                    var schemaId = view.querySelector('#rcsSchemaSelect').value;
                    if (!connectionId || !schemaId) return;

                    // forceRefresh=true bypasses both this client's cache and
                    // the server's LastResponseCacheStore — a plain client-side
                    // cache delete alone would still return the same stale
                    // server-cached response.
                    renderCanvasForCurrentIndex(view, true);
                });
            }
        }

        function snapshotRuleSetsSaved() {
            ruleSetsRestoreSnapshot = JSON.stringify(store.get('ruleSetsFile') || { RuleSets: [] });
            store.set('ruleSetsSavedSnapshot', ruleSetsForComparison(store.get('ruleSetsFile')));
        }

        function refreshRuleSetDirtyState(view) {
            var warning = view.querySelector('#rcsDirtyWarning');
            var discard = view.querySelector('#rcsDiscardBtn');
            if (!warning) return;
            var dirty = ruleSetsAreDirty();
            warning.innerText = dirty ? 'Unsaved changes' : '';
            if (discard) discard.disabled = !dirty;
        }

        function discardRuleSetChanges(view) {
            if (ruleSetsRestoreSnapshot === null) return;
            var selectedId = store.get('currentRuleSetId');
            var restored = JSON.parse(ruleSetsRestoreSnapshot);
            store.set('ruleSetsFile', restored, 'ruleSetsChanged');
            var selectedExists = restored.RuleSets.some(function (ruleSet) { return ruleSet.Id === selectedId; });
            var matching = ruleSetsForCurrentSchema(view);
            store.set('currentRuleSetId', selectedExists ? selectedId : (matching.length ? matching[0].rs.Id : ''));
            renderRuleSetSelect(view);
            renderCanvasForCurrentIndex(view);
            view.querySelector('#rcsSaveStatus').innerText = '';
            refreshRuleSetDirtyState(view);
        }

        function saveRuleSets(view) {
            if (savingRuleSets) return;
            var currentRuleSetId = store.get('currentRuleSetId');
            var rootGroupEl = view.querySelector('#conditionsList > .rcsGroupRoot');

            // An empty selection is legitimate after deleting
            // the last rule set for this schema — there's nothing to
            // validate or capture from the canvas, just a pending deletion
            // already sitting in ruleSetsFile that still needs to reach the
            // server. Only bail out here when a rule set IS supposed to be
            // selected but its DOM is unexpectedly missing.
            if (currentRuleSetId && !rootGroupEl) {
                Dashboard.alert('No rule set is selected to save. Create one with "+ New" first.');
                return;
            }

            if (currentRuleSetId && rootGroupEl) {
                var invalidNodes = ruleBuilderTab.findInvalidConditionElements(rootGroupEl);
                ruleBuilderTab.highlightInvalid(rootGroupEl, invalidNodes);

                if (invalidNodes.length > 0) {
                    Dashboard.alert('Some conditions are incomplete (missing field, operator, or value) — they\'re outlined in red. Fill them in before saving.');
                    invalidNodes[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                    return;
                }

                var emptyGroups = ruleBuilderTab.findEmptyGroupElements(rootGroupEl);
                ruleBuilderTab.highlightEmptyGroups(rootGroupEl, emptyGroups);
                if (emptyGroups.length > 0) {
                    var proceed = confirm(
                        emptyGroups.length + ' group(s) are empty (outlined in amber). An empty AND-group matches EVERY item by default — ' +
                        'this rule may be wider than intended. Save anyway?'
                    );
                    if (!proceed) return;
                }
            }

            var ruleSetsFile = store.get('ruleSetsFile');
            var current = store.ruleSetById(currentRuleSetId);
            if (current && current.IsBuiltIn) {
                Dashboard.alert('Built-in Rule Sets are read-only. Use Duplicate to create an editable copy.');
                return;
            } else {
                captureCurrentEditsIntoFile(view);
            }

            var statusEl = view.querySelector('#rcsSaveStatus');
            statusEl.innerText = 'Saving…';
            savingRuleSets = true;
            editorSession.setBusy(view, 'ruleSets', true);

            ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl('ChannelSync/RuleSets'),
                data: JSON.stringify({ Payload: store.get('ruleSetsFile') }),
                contentType: 'application/json',
                dataType: 'json'
            }).then(function (result) {
                snapshotRuleSetsSaved();
                refreshRuleSetDirtyState(view);
                var affected = (result && result.AffectedFolderCount) || 0;
                statusEl.innerText = affected > 0 ? 'Saved. Folder tree resync started.' : 'Saved.';
                // Dependants need to know that the committed rule definitions
                // changed, but this editor is already rendering that exact
                // live collection and selection. Rebuilding its own enhanced
                // select here introduced an intermittent jump to the first
                // (usually built-in) option after saving a duplicate.
                publishingOwnRuleSetSave = true;
                try {
                    store.emit('ruleSetsChanged');
                } finally {
                    publishingOwnRuleSetSave = false;
                }
                savingRuleSets = false;
                editorSession.setBusy(view, 'ruleSets', false);
            }).catch(function () {
                savingRuleSets = false;
                editorSession.setBusy(view, 'ruleSets', false);
                statusEl.innerText = '';
                Dashboard.alert('Save failed — see server log.');
            });
        }

        function exportRuleSet(view) {
            var ruleSetsFile = store.get('ruleSetsFile');
            var source = store.ruleSetById(store.get('currentRuleSetId'));
            if (!source) { Dashboard.alert('No Rule Set selected to export.'); return; }

            var exported = JSON.parse(JSON.stringify(source));
            var rootGroupEl = view.querySelector('#conditionsList > .rcsGroupRoot');
            if (rootGroupEl) exported.Root = ruleBuilderTab.readGroupFromDom(rootGroupEl);

            var panel = view.querySelector('#rcsImportExportPanel');
            var text = view.querySelector('#rcsImportExportText');
            var status = view.querySelector('#rcsImportExportStatus');
            var confirmBtn = view.querySelector('#rcsImportExportConfirm');
            text.value = JSON.stringify(exported, null, 2);
            status.innerText = 'Copy this Rule Set JSON.';
            confirmBtn.innerText = 'Copy to clipboard';
            confirmBtn.onclick = function () {
                helpers.copyTextToClipboard(text.value).then(function () {
                    status.innerText = 'Copied to clipboard.';
                }).catch(function () {
                    text.select();
                    status.innerText = 'Copy was blocked; the text is selected for manual copying.';
                });
            };
            panel.style.display = '';
            text.focus();
            text.select();
        }

        function importRuleSet(view) {
            var schemaId = view.querySelector('#rcsSchemaSelect').value;
            if (!schemaId) { Dashboard.alert('Choose a Schema before importing a Rule Set.'); return; }

            var panel = view.querySelector('#rcsImportExportPanel');
            var text = view.querySelector('#rcsImportExportText');
            var status = view.querySelector('#rcsImportExportStatus');
            var confirmBtn = view.querySelector('#rcsImportExportConfirm');
            text.value = '';
            status.innerText = 'Paste an exported Rule Set, then click Import.';
            confirmBtn.innerText = 'Import';
            confirmBtn.onclick = function () {
                var parsed;
                try {
                    parsed = JSON.parse(text.value);
                } catch (e) {
                    status.innerText = 'Not valid JSON.';
                    return;
                }
                if (!parsed || typeof parsed !== 'object' || !parsed.Root) {
                    status.innerText = 'This does not look like a Rule Set.';
                    return;
                }
                parsed.Id = helpers.newId();
                parsed.EndpointSchemaId = schemaId;
                parsed.IsBuiltIn = false;
                parsed.Name = (parsed.Name || 'Imported Rule Set').replace(/^\[Built-in\]\s*/, '');
                var ruleSetsFile = store.get('ruleSetsFile');
                if (store.ruleSetNameExists(schemaId, parsed.Name)) {
                    status.innerText = 'A Rule Set with that name already exists for this Schema. Change Name in the JSON before importing.';
                    return;
                }
                ruleSetsFile.RuleSets.push(parsed);
                store.set('currentRuleSetId', parsed.Id);
                ruleBuilderTab.markRuleSetsDirty(view);
                renderRuleSetSelect(view);
                renderCanvasForCurrentIndex(view);
                panel.style.display = 'none';
                refreshRuleSetDirtyState(view);
            };
            panel.style.display = '';
            text.focus();
        }

        function wireRuleSetToolbar(view) {
            view.querySelector('#rcsRuleSetSelect').addEventListener('change', function (e) {
                if (blockDirtyRuleSetNavigation(view, 'Rule Sets')) return;
                switchRuleSetTo(view, e.target.value);
            });

            view.querySelector('#rcsNewRuleSet').addEventListener('click', function () {
                if (blockDirtyRuleSetNavigation(view, 'Rule Sets')) return;
                var schemaId = view.querySelector('#rcsSchemaSelect').value;
                var name = prompt('Name for the new rule set:', 'New Rule Set');
                if (!name) return;
                if (store.ruleSetNameExists(schemaId, name)) { Dashboard.alert('Rule Set names must be unique within a Schema.'); return; }
                var ruleSetsFile = store.get('ruleSetsFile');
                var created = { Id: helpers.newId(), Name: name.trim(), EndpointSchemaId: schemaId, IsBuiltIn: false, Root: emptyRoot() };
                ruleSetsFile.RuleSets.push(created);
                ruleBuilderTab.markRuleSetsDirty(view);
                switchRuleSetTo(view, created.Id);
            });

            view.querySelector('#rcsDuplicateRuleSet').addEventListener('click', function () {
                if (blockDirtyRuleSetNavigation(view, 'Rule Sets')) return;
                var ruleSetsFile = store.get('ruleSetsFile');
                var source = store.ruleSetById(store.get('currentRuleSetId'));
                if (!source) { Dashboard.alert('No rule set selected to duplicate.'); return; }
                var defaultName = (source.Name || '').replace(/^\[Built-in\]\s*/, '') + ' copy';
                var name = prompt('Name for the duplicated rule set:', defaultName);
                if (!name) return;
                if (store.ruleSetNameExists(source.EndpointSchemaId, name)) { Dashboard.alert('Rule Set names must be unique within a Schema.'); return; }
                var clone = JSON.parse(JSON.stringify(source));
                clone.Id = helpers.newId();
                clone.Name = name.trim();
                clone.IsBuiltIn = false;
                ruleSetsFile.RuleSets.push(clone);
                ruleBuilderTab.markRuleSetsDirty(view);
                switchRuleSetTo(view, clone.Id);
            });

            view.querySelector('#rcsRenameRuleSet').addEventListener('click', function () {
                var ruleSetsFile = store.get('ruleSetsFile');
                var current = store.ruleSetById(store.get('currentRuleSetId'));
                if (!current) { Dashboard.alert('No rule set selected to rename.'); return; }
                if (current.IsBuiltIn) { Dashboard.alert('Built-in rule sets are read-only. Use Duplicate to make an editable copy.'); return; }
                var name = prompt('Rename rule set:', current.Name);
                if (!name) return;
                if (store.ruleSetNameExists(current.EndpointSchemaId, name, current.Id)) { Dashboard.alert('Rule Set names must be unique within a Schema.'); return; }
                current.Name = name.trim();
                ruleBuilderTab.markRuleSetsDirty(view);
                renderRuleSetSelect(view);
            });

            view.querySelector('#rcsDeleteRuleSet').addEventListener('click', function () {
                var ruleSetsFile = store.get('ruleSetsFile');
                var current = store.ruleSetById(store.get('currentRuleSetId'));
                if (!current) {
                    Dashboard.alert('No rule set selected to delete.');
                    return;
                }
                if (current.IsBuiltIn) { Dashboard.alert('Built-in rule sets are read-only and cannot be deleted.'); return; }
                var sameSchema = ruleSetsForCurrentSchema(view).map(function (item) { return item.rs; });
                var deletedIndex = sameSchema.findIndex(function (ruleSet) { return ruleSet.Id === current.Id; });
                var currentTree = store.get('currentTree');
                var references = store.folderTreeReferencesForRuleSets(
                    currentTree && currentTree.RootFolder, [current.Id]);
                if (references.length) {
                    Dashboard.alert(helpers.folderFetchDependencyMessage(
                        'Rule Set', current.Name, references));
                    return;
                }

                var savedFile = ruleSetsRestoreSnapshot === null
                    ? { RuleSets: [] }
                    : JSON.parse(ruleSetsRestoreSnapshot);
                var persisted = savedFile.RuleSets.some(function (ruleSet) { return ruleSet.Id === current.Id; });
                if (!persisted) {
                    ruleSetsFile.RuleSets = ruleSetsFile.RuleSets.filter(function (ruleSet) { return ruleSet.Id !== current.Id; });
                    var localRemaining = ruleSetsFile.RuleSets.filter(function (ruleSet) {
                        return ruleSet.EndpointSchemaId === current.EndpointSchemaId;
                    });
                    switchRuleSetTo(view, editorSession.selectionAfterDeletion(
                        localRemaining, deletedIndex, function (ruleSet) { return ruleSet.Id; }));
                    refreshRuleSetDirtyState(view);
                    return;
                }
                if (ruleSetsAreDirty()) {
                    Dashboard.alert('Save or discard your Rule Set changes before deleting a saved Rule Set.');
                    return;
                }
                if (!confirm('Delete rule set "' + current.Name + '"?')) {
                    return;
                }

                var status = view.querySelector('#rcsSaveStatus');
                status.innerText = 'Deleting\u2026';
                savingRuleSets = true;
                editorSession.setBusy(view, 'ruleSets', true);
                ApiClient.ajax({
                    type: 'DELETE',
                    url: ApiClient.getUrl('ChannelSync/RuleSets/' + encodeURIComponent(current.Id)),
                    dataType: 'json'
                }).then(function (result) {
                    if (!result || result.Success !== true) {
                        savingRuleSets = false;
                        editorSession.setBusy(view, 'ruleSets', false);
                        status.innerText = 'Deletion blocked -- nothing was removed.';
                        Dashboard.alert((result && result.Error) || 'The Rule Set could not be deleted.');
                        return;
                    }
                    var newRuleSets = (result && result.RuleSets) || [];
                    var remaining = newRuleSets.filter(function (ruleSet) {
                        return ruleSet.EndpointSchemaId === current.EndpointSchemaId;
                    });
                    var nextRuleSetId = editorSession.selectionAfterDeletion(
                        remaining, deletedIndex, function (ruleSet) { return ruleSet.Id; });
                    store.set('ruleSetsFile', { RuleSets: newRuleSets });
                    store.set('currentRuleSetId', nextRuleSetId);
                    store.emit('ruleSetsChanged');
                    snapshotRuleSetsSaved();
                    refreshRuleSetDirtyState(view);
                    status.innerText = 'Deleted.';
                    savingRuleSets = false;
                    editorSession.setBusy(view, 'ruleSets', false);
                }).catch(function () {
                    savingRuleSets = false;
                    editorSession.setBusy(view, 'ruleSets', false);
                    status.innerText = 'Delete failed -- nothing was removed. See server log.';
                });
            });

            view.querySelector('#rcsExportRuleSet').addEventListener('click', function () { exportRuleSet(view); });
            view.querySelector('#rcsImportRuleSet').addEventListener('click', function () { importRuleSet(view); });

            var saveBtn = view.querySelector('#btnSave');
            if (saveBtn) saveBtn.addEventListener('click', function () { saveRuleSets(view); });
            var discardBtn = view.querySelector('#rcsDiscardBtn');
            if (discardBtn) discardBtn.addEventListener('click', function () { discardRuleSetChanges(view); });
        }

        // Called by SyncChannel.js after all tab modules are loaded. Also
        // subscribes to store events so it re-renders its own chrome when
        // Connections or Schemas change on another tab, instead of those
        // tabs calling in here directly.
        function init(view) {
            wireRuleSetToolbar(view);
            ruleBuilderTab.wireRawResponseControls(view);
            var cancelBtn = view.querySelector('#rcsImportExportCancel');
            if (cancelBtn) cancelBtn.addEventListener('click', function () {
                view.querySelector('#rcsImportExportPanel').style.display = 'none';
            });
            renderConnectionAndSchemaSelects(view);
            renderRuleSetSelect(view);
            renderCanvasForCurrentIndex(view);
            snapshotRuleSetsSaved();
            refreshRuleSetDirtyState(view);

            store.on('connectionsChanged', function () { renderConnectionAndSchemaSelects(view); });
            store.on('schemasChanged', function () {
                renderConnectionAndSchemaSelects(view);
                renderRuleSetSelect(view);
                renderCanvasForCurrentIndex(view);
            });
            store.on('ruleSetsChanged', function () {
                if (publishingOwnRuleSetSave) return;
                renderRuleSetSelect(view);
                renderCanvasForCurrentIndex(view);
                snapshotRuleSetsSaved();
                refreshRuleSetDirtyState(view);
            });
            store.on('ruleSetsDirtyStateChanged', function () { refreshRuleSetDirtyState(view); });
        }

        return {
            init: init,
            renderConnectionAndSchemaSelects: renderConnectionAndSchemaSelects,
            renderRuleSetSelect: renderRuleSetSelect,
            renderCanvasForCurrentIndex: renderCanvasForCurrentIndex,
            refreshRuleSetDirtyState: refreshRuleSetDirtyState,
            ruleSetsForComparison: ruleSetsForComparison,
            hasUnsavedChanges: ruleSetsAreDirty,
            isSaving: function () { return savingRuleSets; }
        };
    });
