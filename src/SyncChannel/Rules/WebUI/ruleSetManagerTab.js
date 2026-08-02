define(['jQuery', 'configurationpage?name=SyncChannelStoreJs',
        'configurationpage?name=SyncChannelDragEngineJs',
        'configurationpage?name=SyncChannelSharedHelpersJs',
        'configurationpage?name=SyncChannelRuleBuilderTabJs'],
    function ($, store, dragEngine, helpers, ruleBuilderTab) {
        'use strict';

        function emptyRoot() {
            return { Kind: 'Group', LogicOperator: 'And', Not: false, Children: [] };
        }

        function ruleSetsForCurrentSchema(view) {
            var schemaId = view.querySelector('#rcsSchemaSelect').value;
            return store.ruleSetsForSchema(schemaId);
        }

        function captureCurrentEditsIntoFile(view) {
            var currentRuleSetIndex = store.get('currentRuleSetIndex');
            if (currentRuleSetIndex < 0) return;
            var ruleSetsFile = store.get('ruleSetsFile');
            var current = ruleSetsFile.RuleSets[currentRuleSetIndex];
            if (!current) return;
            if (!store.isRuleSetEdited(current.Id)) return;
            var rootGroupEl = view.querySelector('#conditionsList > .rcsGroupRoot');
            if (!rootGroupEl) return;
            if (current.IsBuiltIn) {
                var drafts = store.get('builtInRuleDraftRootsById');
                drafts[current.Id] = ruleBuilderTab.readGroupFromDom(rootGroupEl);
            } else {
                current.Root = ruleBuilderTab.readGroupFromDom(rootGroupEl);
            }
        }

        function renderRuleSetSelect(view) {
            var select = view.querySelector('#rcsRuleSetSelect');
            select.innerHTML = '';

            var matching = ruleSetsForCurrentSchema(view);
            var currentRuleSetIndex = store.get('currentRuleSetIndex');

            matching.forEach(function (x) {
                var opt = document.createElement('option');
                opt.value = String(x.idx);
                opt.innerText = (x.rs.Name || '(unnamed)') + (x.rs.IsBuiltIn ? ' 🔒' : '');
                if (x.idx === currentRuleSetIndex) opt.selected = true;
                select.appendChild(opt);
            });

            if (matching.length === 0) {
                store.set('currentRuleSetIndex', -1);
            } else if (!matching.some(function (x) { return x.idx === currentRuleSetIndex; })) {
                store.set('currentRuleSetIndex', matching[0].idx);
                select.value = String(matching[0].idx);
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

            var currentRuleSetIndex = store.get('currentRuleSetIndex');
            var ruleSetsFile = store.get('ruleSetsFile');

            if (currentRuleSetIndex < 0) {
                var hint = document.createElement('div');
                hint.className = 'rcsEmptyHint';
                hint.innerText = 'No rule sets exist yet for this endpoint — click "+ New" to create one.';
                list.appendChild(hint);
                return;
            }

            var ruleSet = ruleSetsFile.RuleSets[currentRuleSetIndex];

            if (ruleSet.IsBuiltIn) {
                var lockNotice = document.createElement('div');
                lockNotice.className = 'fieldDescription';
                lockNotice.style.marginBottom = '0.8em';
                lockNotice.innerText = '🔒 This is a protected built-in Rule Set. You can test and edit it here; Save will ask for a new Rule Set name and preserve the built-in unchanged.';
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

                    var onChange = function () { ruleBuilderTab.scheduleAutoPreview(view, true); };
                    var drafts = store.get('builtInRuleDraftRootsById');
                    var displayedRoot = drafts[ruleSet.Id] || ruleSet.Root || emptyRoot();
                    list.appendChild(ruleBuilderTab.buildGroupNode(displayedRoot, true, onChange, connectionId, schemaId));

                    ruleBuilderTab.scheduleAutoPreview(view, false);
                });
        }

        function switchRuleSetTo(view, idx) {
            captureCurrentEditsIntoFile(view);
            store.set('currentRuleSetIndex', idx);
            renderRuleSetSelect(view);
            renderCanvasForCurrentIndex(view);
        }

        function onSchemaChanged(view) {
            captureCurrentEditsIntoFile(view);
            var matching = ruleSetsForCurrentSchema(view);
            store.set('currentRuleSetIndex', matching.length ? matching[0].idx : -1);
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

            // Guarded the same way refreshBtn already is below -- this function
            // is called after every save (Connections, Endpoint Schemas) plus
            // initial load, and connSel/schemaSel are the same persisting DOM
            // nodes each time (only their options are rebuilt). Without this
            // guard, each call stacked another 'change' listener on top of the
            // last.
            if (!connSel.dataset.wired) {
                connSel.dataset.wired = '1';
                connSel.addEventListener('change', function () {
                    rebuildRuleSetsSchemaOptions(view);
                    onSchemaChanged(view);
                });
            }

            if (!schemaSel.dataset.wired) {
                schemaSel.dataset.wired = '1';
                schemaSel.addEventListener('change', function () { onSchemaChanged(view); });
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
            store.set('ruleSetsSavedSnapshot', JSON.stringify(store.get('ruleSetsFile') || { RuleSets: [] }));
            store.clearRuleSetEditFlags();
            store.set('builtInRuleDraftRootsById', {});
        }

        function refreshRuleSetDirtyState(view) {
            var warning = view.querySelector('#rcsDirtyWarning');
            var discard = view.querySelector('#rcsDiscardBtn');
            if (!warning) return;
            var dirty = store.isRuleSetsDirty();
            warning.innerText = dirty ? 'Unsaved changes' : '';
            if (discard) discard.disabled = !dirty;
        }

        function discardRuleSetChanges(view) {
            if (store.get('ruleSetsSavedSnapshot') === null) return;
            var currentRuleSetIndex = store.get('currentRuleSetIndex');
            var ruleSetsFile = store.get('ruleSetsFile');
            var selected = currentRuleSetIndex >= 0 ? ruleSetsFile.RuleSets[currentRuleSetIndex] : null;
            var selectedId = selected ? selected.Id : '';
            var restored = JSON.parse(store.get('ruleSetsSavedSnapshot'));
            store.clearRuleSetEditFlags();
            store.set('builtInRuleDraftRootsById', {});
            store.set('ruleSetsFile', restored, 'ruleSetsChanged');
            var newIndex = restored.RuleSets.findIndex(function (ruleSet) { return ruleSet.Id === selectedId; });
            var matching = ruleSetsForCurrentSchema(view);
            store.set('currentRuleSetIndex', newIndex >= 0 ? newIndex : (matching.length ? matching[0].idx : -1));
            renderRuleSetSelect(view);
            renderCanvasForCurrentIndex(view);
            view.querySelector('#rcsSaveStatus').innerText = '';
            refreshRuleSetDirtyState(view);
        }

        function saveRuleSets(view) {
            var currentRuleSetIndex = store.get('currentRuleSetIndex');
            var rootGroupEl = view.querySelector('#conditionsList > .rcsGroupRoot');

            // currentRuleSetIndex < 0 is a legitimate state after deleting the
            // last rule set for this schema — there's nothing to validate or
            // capture from the canvas, just a pending deletion already sitting
            // in ruleSetsFile that still needs to reach the server. Only bail
            // out here when a rule set IS supposed to be selected but its DOM
            // is unexpectedly missing.
            if (currentRuleSetIndex >= 0 && !rootGroupEl) {
                Dashboard.alert('No rule set is selected to save. Create one with "+ New" first.');
                return;
            }

            if (currentRuleSetIndex >= 0 && rootGroupEl) {
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
            var current = currentRuleSetIndex >= 0 ? ruleSetsFile.RuleSets[currentRuleSetIndex] : null;
            if (current && current.IsBuiltIn) {
                var copyName = prompt(
                    'The built-in Rule Set "' + current.Name.replace(/^\[Built-in\]\s*/, '') +
                    '" cannot be overwritten.\nName the new Rule Set for these edits:',
                    current.Name.replace(/^\[Built-in\]\s*/, '') + ' custom');
                if (!copyName || !copyName.trim()) return;
                copyName = copyName.trim();
                if (store.ruleSetNameExists(current.EndpointSchemaId, copyName)) {
                    Dashboard.alert('Rule Set names must be unique within a Schema.');
                    return;
                }
                var copy = JSON.parse(JSON.stringify(current));
                copy.Id = helpers.newId();
                copy.Name = copyName;
                copy.IsBuiltIn = false;
                copy.Root = ruleBuilderTab.readGroupFromDom(rootGroupEl);
                ruleSetsFile.RuleSets.push(copy);
                store.set('currentRuleSetIndex', ruleSetsFile.RuleSets.length - 1);
                ruleBuilderTab.markRuleSetsDirty(view);
                renderRuleSetSelect(view);
            } else {
                captureCurrentEditsIntoFile(view);
            }

            var statusEl = view.querySelector('#rcsSaveStatus');
            statusEl.innerText = 'Saving…';

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
                store.emit('ruleSetsChanged');
            }).catch(function () {
                statusEl.innerText = '';
                Dashboard.alert('Save failed — see server log.');
            });
        }

        function exportRuleSet(view) {
            var ruleSetsFile = store.get('ruleSetsFile');
            var currentRuleSetIndex = store.get('currentRuleSetIndex');
            var source = currentRuleSetIndex >= 0 ? ruleSetsFile.RuleSets[currentRuleSetIndex] : null;
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
                store.set('currentRuleSetIndex', ruleSetsFile.RuleSets.length - 1);
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
                switchRuleSetTo(view, parseInt(e.target.value, 10));
            });

            view.querySelector('#rcsNewRuleSet').addEventListener('click', function () {
                captureCurrentEditsIntoFile(view);
                var schemaId = view.querySelector('#rcsSchemaSelect').value;
                var name = prompt('Name for the new rule set:', 'New Rule Set');
                if (!name) return;
                if (store.ruleSetNameExists(schemaId, name)) { Dashboard.alert('Rule Set names must be unique within a Schema.'); return; }
                var ruleSetsFile = store.get('ruleSetsFile');
                ruleSetsFile.RuleSets.push({ Id: helpers.newId(), Name: name.trim(), EndpointSchemaId: schemaId, IsBuiltIn: false, Root: emptyRoot() });
                ruleBuilderTab.markRuleSetsDirty(view);
                switchRuleSetTo(view, ruleSetsFile.RuleSets.length - 1);
            });

            view.querySelector('#rcsDuplicateRuleSet').addEventListener('click', function () {
                captureCurrentEditsIntoFile(view);
                var ruleSetsFile = store.get('ruleSetsFile');
                var currentRuleSetIndex = store.get('currentRuleSetIndex');
                var source = ruleSetsFile.RuleSets[currentRuleSetIndex];
                if (currentRuleSetIndex < 0 || !source) { Dashboard.alert('No rule set selected to duplicate.'); return; }
                var defaultName = (source.Name || '').replace(/^\[Built-in\]\s*/, '') + ' copy';
                var name = prompt('Name for the duplicated rule set:', defaultName);
                if (!name) return;
                if (store.ruleSetNameExists(source.EndpointSchemaId, name)) { Dashboard.alert('Rule Set names must be unique within a Schema.'); return; }
                var clone = JSON.parse(JSON.stringify(source));
                clone.Id = helpers.newId();
                clone.Name = name.trim();
                clone.IsBuiltIn = false;
                var drafts = store.get('builtInRuleDraftRootsById');
                if (drafts[source.Id]) {
                    clone.Root = JSON.parse(JSON.stringify(drafts[source.Id]));
                }
                ruleSetsFile.RuleSets.push(clone);
                ruleBuilderTab.markRuleSetsDirty(view);
                switchRuleSetTo(view, ruleSetsFile.RuleSets.length - 1);
            });

            view.querySelector('#rcsRenameRuleSet').addEventListener('click', function () {
                var ruleSetsFile = store.get('ruleSetsFile');
                var currentRuleSetIndex = store.get('currentRuleSetIndex');
                var current = ruleSetsFile.RuleSets[currentRuleSetIndex];
                if (currentRuleSetIndex < 0 || !current) { Dashboard.alert('No rule set selected to rename.'); return; }
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
                var currentRuleSetIndex = store.get('currentRuleSetIndex');
                var current = ruleSetsFile.RuleSets[currentRuleSetIndex];
                if (currentRuleSetIndex < 0 || !current) {
                    Dashboard.alert('No rule set selected to delete.');
                    return;
                }
                if (current.IsBuiltIn) { Dashboard.alert('Built-in rule sets are read-only and cannot be deleted.'); return; }
                var currentTree = store.get('currentTree');
                if (store.folderTreeUsesAnyRuleSet(currentTree && currentTree.RootFolder, [current.Id])) {
                    Dashboard.alert('This Rule Set cannot be deleted because a Folder Fetch uses it.');
                    return;
                }
                if (!confirm('Delete rule set "' + current.Name + '"?')) {
                    return;
                }
                ruleSetsFile.RuleSets.splice(currentRuleSetIndex, 1);
                ruleBuilderTab.markRuleSetsDirty(view);
                var remaining = ruleSetsForCurrentSchema(view);
                switchRuleSetTo(view, remaining.length ? remaining[0].idx : -1);
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
            store.on('ruleSetsDirtyStateChanged', function () { refreshRuleSetDirtyState(view); });
        }

        return {
            init: init,
            renderConnectionAndSchemaSelects: renderConnectionAndSchemaSelects,
            renderRuleSetSelect: renderRuleSetSelect,
            renderCanvasForCurrentIndex: renderCanvasForCurrentIndex,
            refreshRuleSetDirtyState: refreshRuleSetDirtyState
        };
    });
