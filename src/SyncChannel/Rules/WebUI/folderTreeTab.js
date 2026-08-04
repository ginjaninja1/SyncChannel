define(['jQuery', 'configurationpage?name=SyncChannelStoreJs',
        'configurationpage?name=SyncChannelEditorSessionJs',
        'configurationpage?name=SyncChannelSharedHelpersJs',
        'configurationpage?name=SyncChannelDirtyTrackerJs'],
    function ($, store, editorSession, helpers, dirtyTracker) {
        'use strict';

        var tracker = dirtyTracker.createTracker(function (tree) { return JSON.stringify(tree); });
        var pendingFetchEditors = 0;
        var activeView = null;
        var savingFolderTree = false;

        // dirtyTracker only exposes compare (isDirty) + UI (refreshUi), not
        // the raw snapshot itself — same split connectionsTab.js uses (see
        // its own connectionsSavedFullSnapshot), so restoring on Discard
        // needs this alongside the tracker, not instead of it.
        var folderTreeSavedSnapshot = null;

        function snapshotFolderTreeSaved() {
            folderTreeSavedSnapshot = JSON.stringify(store.get('currentTree'));
            tracker.snapshotSaved(store.get('currentTree'));
        }

        function refreshFolderTreeDirtyState(view) {
            tracker.refreshUi(view, '#ftDirtyWarning', '#ftDiscardBtn', store.get('currentTree'));

            if (pendingFetchEditors > 0) {
                var warning = view.querySelector('#ftDirtyWarning');
                var discard = view.querySelector('#ftDiscardBtn');
                warning.innerText = tracker.isDirty(store.get('currentTree'))
                    ? 'Unsaved changes — finish or cancel the open fetch editor'
                    : 'Finish or cancel the open fetch editor';
                if (discard) discard.disabled = false;
            }
        }

        function beginFetchEditor(container) {
            if (container.dataset.fetchEditorOpen === 'true') return;
            container.dataset.fetchEditorOpen = 'true';
            pendingFetchEditors++;
            if (activeView) refreshFolderTreeDirtyState(activeView);
        }

        function endFetchEditor(container) {
            if (container.dataset.fetchEditorOpen !== 'true') return;
            delete container.dataset.fetchEditorOpen;
            pendingFetchEditors = Math.max(0, pendingFetchEditors - 1);
            if (activeView) refreshFolderTreeDirtyState(activeView);
        }

        function discardFolderTreeChanges(view) {
            if (folderTreeSavedSnapshot === null) return;
            store.set('currentTree', JSON.parse(folderTreeSavedSnapshot));
            view.querySelector('#ftStatus').innerText = '';
            renderTree(view);
        }

        function openAddFetchPanel(container, folderNode, onChange) {
            container.innerHTML = '';
            openFetchFieldForm(container, folderNode, null, onChange);
        }

        function openFetchFieldForm(container, folderNode, existingFetch, onChange) {
            container.innerHTML = '';
            beginFetchEditor(container);

            var panel = document.createElement('div');
            panel.className = 'ftPanel';

            var title = document.createElement('div');
            title.style.fontWeight = '600';
            title.style.marginBottom = '0.5em';
            title.innerText = (existingFetch ? 'Edit fetch' : 'Add fetch');
            panel.appendChild(title);

            function makeSelectField(labelText, options, currentValue) {
                var wrap = document.createElement('div');
                wrap.className = 'ftField';
                var label = document.createElement('label');
                label.innerText = labelText;
                var select = document.createElement('select');
                options.forEach(function (opt) {
                    var o = document.createElement('option');
                    o.value = opt.value;
                    o.innerText = opt.text;
                    if (opt.value === currentValue) o.selected = true;
                    select.appendChild(o);
                });
                wrap.appendChild(label);
                wrap.appendChild(select);
                panel.appendChild(wrap);
                return select;
            }

            var labelField = document.createElement('div');
            labelField.className = 'ftField';
            var labelLabel = document.createElement('label');
            labelLabel.innerText = 'Label';
            var labelInput = document.createElement('input');
            labelInput.type = 'text';
            labelInput.value = existingFetch ? existingFetch.DisplayLabel : 'New Fetch';
            labelField.appendChild(labelLabel);
            labelField.appendChild(labelInput);
            panel.appendChild(labelField);

            var existingSchema = existingFetch ? store.schemaForRuleSetId(existingFetch.RuleSetId) : null;
            var existingConnection = existingSchema ? store.findConnection(existingSchema.ConnectionId) : null;
            var connections = store.get('connections');

            var connSelect = makeSelectField(
                'Connection',
                connections.map(function (c) { return { value: c.Id, text: helpers.connectionBadgeGlyph(c) + ' ' + c.DisplayLabel }; }),
                existingConnection ? existingConnection.Id : (connections[0] && connections[0].Id));

            var schemaSelect = makeSelectField(
                'Schema',
                store.schemasForConnection(connSelect.value).map(function (s) { return { value: s.Id, text: store.schemaOptionLabel(s) }; }),
                existingSchema ? existingSchema.Id : (store.schemasForConnection(connSelect.value)[0] && store.schemasForConnection(connSelect.value)[0].Id));

            var ruleSetSelect;

            function rebuildRuleSetOptions() {
                var schemaId = schemaSelect.value;
                var ruleSetsFile = store.get('ruleSetsFile');
                var matching = ruleSetsFile.RuleSets.filter(function (rs) { return rs.EndpointSchemaId === schemaId; });
                var currentVal = ruleSetSelect ? ruleSetSelect.value : (existingFetch ? existingFetch.RuleSetId : null);

                var wrap = document.createElement('div');
                wrap.className = 'ftField';
                var label = document.createElement('label');
                label.innerText = 'Rule set';
                ruleSetSelect = document.createElement('select');

                if (matching.length === 0) {
                    var o = document.createElement('option');
                    o.value = '';
                    o.innerText = '(no rule sets for this schema — create one on the Rule Sets tab)';
                    ruleSetSelect.appendChild(o);
                } else {
                    matching.forEach(function (rs) {
                        var opt = document.createElement('option');
                        opt.value = rs.Id;
                        opt.innerText = rs.Name + (rs.IsBuiltIn ? ' 🔒' : '');
                        if (rs.Id === currentVal) opt.selected = true;
                        ruleSetSelect.appendChild(opt);
                    });
                }

                wrap.appendChild(label);
                wrap.appendChild(ruleSetSelect);

                var existingWrap = panel.querySelector('.ftRuleSetFieldWrap');
                if (existingWrap) {
                    panel.replaceChild(wrap, existingWrap);
                } else {
                    panel.insertBefore(wrap, panel.querySelector('.ftAddRow'));
                }
                wrap.classList.add('ftRuleSetFieldWrap');
            }

            function rebuildSchemaOptions() {
                var allowed = store.schemasForConnection(connSelect.value);
                var currentVal = schemaSelect.value;
                schemaSelect.innerHTML = '';
                allowed.forEach(function (s) {
                    var o = document.createElement('option');
                    o.value = s.Id;
                    o.innerText = store.schemaOptionLabel(s);
                    if (s.Id === currentVal) o.selected = true;
                    schemaSelect.appendChild(o);
                });
                rebuildRuleSetOptions();
            }

            var ruleSetPlaceholder = document.createElement('div');
            ruleSetPlaceholder.className = 'ftField ftRuleSetFieldWrap';
            panel.appendChild(ruleSetPlaceholder);
            rebuildRuleSetOptions();

            connSelect.addEventListener('change', rebuildSchemaOptions);
            schemaSelect.addEventListener('change', rebuildRuleSetOptions);

            var btnRow = document.createElement('div');
            btnRow.className = 'ftAddRow';

            var saveBtn = document.createElement('button');
            saveBtn.setAttribute('is', 'emby-button');
            saveBtn.className = 'raised button-submit';
            saveBtn.type = 'button';
            saveBtn.innerText = existingFetch ? 'Update Fetch' : 'Add Fetch';
            saveBtn.addEventListener('click', function () {
                if (!ruleSetSelect.value) {
                    Dashboard.alert('This schema has no rule sets yet — create one on the Rule Sets tab first.');
                    return;
                }

                if (existingFetch) {
                    existingFetch.DisplayLabel = labelInput.value;
                    existingFetch.RuleSetId = ruleSetSelect.value;
                } else {
                    folderNode.Fetches.push({
                        Id: helpers.newId(),
                        Enabled: true,
                        DisplayLabel: labelInput.value,
                        RuleSetId: ruleSetSelect.value
                    });
                }

                endFetchEditor(container);
                container.innerHTML = '';
                onChange();
            });

            var cancelBtn = document.createElement('button');
            cancelBtn.setAttribute('is', 'emby-button');
            cancelBtn.type = 'button';
            cancelBtn.innerText = 'Cancel';
            cancelBtn.addEventListener('click', function () {
                endFetchEditor(container);
                container.innerHTML = '';
            });

            btnRow.appendChild(saveBtn);
            btnRow.appendChild(cancelBtn);
            panel.appendChild(btnRow);

            container.appendChild(panel);
        }

        // References missing entirely (deleted after the fact) — hard-fail
        // check, client-side mirror of the server's ValidateFetchReferences,
        // used to show a live "⚠ missing" badge on each fetch row without
        // waiting for a save round-trip.
        function fetchMissingReferences(fetch) {
            var problems = [];
            var ruleSet = store.ruleSetById(fetch.RuleSetId);
            if (!ruleSet) problems.push('rule set');
            var schema = ruleSet ? store.schemaForRuleSetId(fetch.RuleSetId) : null;
            if (ruleSet && !schema) problems.push('endpoint');
            if (schema && !store.findConnection(schema.ConnectionId)) problems.push('connection');
            return problems;
        }

        function buildFetchRow(fetch, folderNode, onChange) {
            var row = document.createElement('div');
            row.className = 'ftFetch' + (fetch.Enabled ? '' : ' ftFetchDisabled');

            var badge = document.createElement('span');
            badge.className = 'ftFetchProviderBadge';
            var owningSchema = store.schemaForRuleSetId(fetch.RuleSetId);
            var owningConnection = store.connectionForRuleSetId(fetch.RuleSetId);
            badge.innerText = owningSchema ? owningSchema.DisplayName : '(unknown endpoint)';
            row.appendChild(badge);

            var missing = fetchMissingReferences(fetch);
            if (missing.length > 0) {
                row.classList.add('ftFetchInvalid');
                var warnBadge = document.createElement('span');
                warnBadge.className = 'ftFetchWarnBadge';
                warnBadge.title = 'Missing: ' + missing.join(', ') + ' — this fetch cannot be saved until fixed.';
                warnBadge.innerText = '⚠';
                row.appendChild(warnBadge);
            }

            var label = document.createElement('span');
            label.className = 'ftFetchLabel';
            label.innerText = (fetch.DisplayLabel || '(unnamed)') +
                ' — ' + (owningConnection ? owningConnection.DisplayLabel : '(unknown connection)') +
                ' — ' + store.ruleSetLabel(fetch.RuleSetId);
            row.appendChild(label);

            var actions = document.createElement('span');
            actions.className = 'ftFetchActions';

            var toggleBtn = document.createElement('span');
            toggleBtn.className = 'ftIconBtn';
            toggleBtn.style.cursor = 'pointer';
            toggleBtn.title = fetch.Enabled ? 'Disable' : 'Enable';
            toggleBtn.innerText = fetch.Enabled ? '⏸' : '▶';
            toggleBtn.addEventListener('click', function () {
                fetch.Enabled = !fetch.Enabled;
                onChange();
            });
            actions.appendChild(toggleBtn);

            var editPanel = document.createElement('div');

            var editBtn = document.createElement('span');
            editBtn.className = 'ftIconBtn';
            editBtn.style.cursor = 'pointer';
            editBtn.title = 'Edit';
            editBtn.innerText = '✎';
            editBtn.addEventListener('click', function () {
                openFetchFieldForm(editPanel, folderNode, fetch, onChange);
            });
            actions.appendChild(editBtn);

            var removeBtn = document.createElement('span');
            removeBtn.className = 'ftIconBtn';
            removeBtn.style.cursor = 'pointer';
            removeBtn.title = 'Remove fetch';
            removeBtn.innerText = '✕';
            removeBtn.addEventListener('click', function () {
                var idx = folderNode.Fetches.indexOf(fetch);
                if (idx >= 0) folderNode.Fetches.splice(idx, 1);
                onChange();
            });
            actions.appendChild(removeBtn);

            row.appendChild(actions);

            var wrapper = document.createElement('div');
            wrapper.dataset.fetchId = fetch.Id;
            wrapper.appendChild(row);
            wrapper.appendChild(editPanel);
            return wrapper;
        }

        function countNodes(node) {
            var count = 1;
            node.Children.forEach(function (c) { count += countNodes(c); });
            return count;
        }

        function countFetches(node) {
            var count = node.Fetches.length;
            node.Children.forEach(function (c) { count += countFetches(c); });
            return count;
        }

        function buildFolderNode(node, parentNode, onChange) {
            var el = document.createElement('div');
            el.className = 'ftNode' + (node.IsRoot ? ' ftNodeRoot' : '');

            var header = document.createElement('div');
            header.className = 'ftNodeHeader';

            var icon = document.createElement('span');
            icon.className = 'ftFolderIcon';
            icon.innerText = '📁';
            header.appendChild(icon);

            var nameInput = document.createElement('input');
            nameInput.className = 'ftNodeName';
            nameInput.value = node.DisplayName;
            nameInput.addEventListener('change', function () {
                node.DisplayName = nameInput.value.trim() || (node.IsRoot ? 'Channel Sync' : 'Untitled Folder');
                nameInput.value = node.DisplayName;
                refreshFolderTreeDirtyState(activeView);
            });
            header.appendChild(nameInput);

            if (node.IsRoot) {
                var tagLabel = document.createElement('span');
                tagLabel.style.fontSize = '0.85em';
                tagLabel.style.opacity = '0.7';
                tagLabel.style.marginLeft = '0.6em';
                tagLabel.innerText = 'Tag:';
                header.appendChild(tagLabel);

                var tagInput = document.createElement('input');
                tagInput.className = 'ftNodeName';
                tagInput.style.minWidth = '9em';
                tagInput.title = 'Internal identity tag — used to find this channel across renames and detect orphaned entries.';
                tagInput.value = node.Tag || 'SyncChannel';
                tagInput.addEventListener('change', function () {
                    node.Tag = tagInput.value.trim() || 'SyncChannel';
                    tagInput.value = node.Tag;
                    refreshFolderTreeDirtyState(activeView);
                });
                header.appendChild(tagInput);
            }

            if (!node.IsRoot) {
                var imageUpdateLabel = document.createElement('label');
                imageUpdateLabel.style.display = 'inline-flex';
                imageUpdateLabel.style.alignItems = 'center';
                imageUpdateLabel.style.gap = '0.3em';
                imageUpdateLabel.style.fontSize = '0.85em';
                imageUpdateLabel.style.opacity = '0.85';
                imageUpdateLabel.style.marginLeft = '0.6em';

                var imageUpdateCheckbox = document.createElement('input');
                imageUpdateCheckbox.type = 'checkbox';
                imageUpdateCheckbox.checked = !!node.ReplaceImageOnContentChange;
                imageUpdateCheckbox.addEventListener('change', function () {
                    node.ReplaceImageOnContentChange = imageUpdateCheckbox.checked;
                    refreshFolderTreeDirtyState(activeView);
                });

                imageUpdateLabel.appendChild(imageUpdateCheckbox);
                imageUpdateLabel.appendChild(document.createTextNode('Image Update'));
                imageUpdateLabel.title = 'Off: folder image is built once and then left for you to manage manually. On: rebuilt whenever the 4 most recently added items change.';

                header.appendChild(imageUpdateLabel);
            }

            if (!node.IsRoot) {
                var actions = document.createElement('span');
                actions.className = 'ftNodeActions';

                var removeFolderBtn = document.createElement('button');
                removeFolderBtn.setAttribute('is', 'emby-button');
                removeFolderBtn.type = 'button';
                removeFolderBtn.innerText = 'Remove Folder';
                removeFolderBtn.addEventListener('click', function () {
                    var childCount = countNodes(node) - 1;
                    var fetchCount = countFetches(node);
                    var msg = 'Remove folder "' + node.DisplayName + '"?';
                    if (childCount > 0 || fetchCount > 0) {
                        msg += ' This will also remove ' + childCount + ' subfolder(s) and ' + fetchCount + ' fetch(es).';
                    }
                    if (!confirm(msg)) return;

                    var idx = parentNode.Children.indexOf(node);
                    if (idx >= 0) parentNode.Children.splice(idx, 1);
                    onChange();
                });
                actions.appendChild(removeFolderBtn);
                header.appendChild(actions);
            }

            el.appendChild(header);

            var fetchList = document.createElement('div');
            fetchList.className = 'ftFetchList';
            node.Fetches.forEach(function (fetch) {
                fetchList.appendChild(buildFetchRow(fetch, node, onChange));
            });
            el.appendChild(fetchList);

            var addFetchPanel = document.createElement('div');
            addFetchPanel.className = 'ftFetchList';
            el.appendChild(addFetchPanel);

            var addRow = document.createElement('div');
            addRow.className = 'ftAddRow';

            var addFetchBtn = document.createElement('button');
            addFetchBtn.setAttribute('is', 'emby-button');
            addFetchBtn.type = 'button';
            addFetchBtn.innerText = '+ Add Fetch';
            addFetchBtn.addEventListener('click', function () {
                if (store.get('connections').length === 0 || store.get('schemas').length === 0) {
                    Dashboard.alert('Add at least one Connection (Connections tab) before adding a fetch.');
                    return;
                }
                openAddFetchPanel(addFetchPanel, node, onChange);
            });
            addRow.appendChild(addFetchBtn);

            var addSubfolderBtn = document.createElement('button');
            addSubfolderBtn.setAttribute('is', 'emby-button');
            addSubfolderBtn.type = 'button';
            addSubfolderBtn.innerText = '+ Add Subfolder';
            addSubfolderBtn.addEventListener('click', function () {
                node.Children.push({
                    Id: helpers.newId(),
                    DisplayName: 'New Folder',
                    IsRoot: false,
                    Fetches: [],
                    Children: []
                });
                onChange();
            });
            addRow.appendChild(addSubfolderBtn);

            el.appendChild(addRow);

            if (node.Children.length > 0) {
                var childrenWrap = document.createElement('div');
                childrenWrap.className = 'ftChildren';
                node.Children.forEach(function (child) {
                    childrenWrap.appendChild(buildFolderNode(child, node, onChange));
                });
                el.appendChild(childrenWrap);
            }

            return el;
        }

        function renderTree(view) {
            var container = view.querySelector('#ftRoot');
            pendingFetchEditors = 0;
            container.innerHTML = '';
            var currentTree = store.get('currentTree');
            container.appendChild(buildFolderNode(currentTree.RootFolder, null, function () { renderTree(view); }));
            refreshFolderTreeDirtyState(view);
        }

        function saveFolderTree(view) {
            if (savingFolderTree) return;
            var statusEl = view.querySelector('#ftStatus');
            statusEl.innerText = 'Saving…';

            view.querySelectorAll('.ftFetch').forEach(function (el) { el.classList.remove('ftFetchInvalid'); });

            var currentTree = store.get('currentTree');
            savingFolderTree = true;
            editorSession.setBusy(view, 'tree', true);
            ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl('ChannelSync/FolderTree'),
                data: JSON.stringify({ RootFolder: currentTree.RootFolder }),
                contentType: 'application/json',
                dataType: 'json'
            }).then(function (result) {
                if (!result.Success) {
                    statusEl.innerText = 'Not saved — ' + result.Errors.length +
                        ' fetch(es) reference something that no longer exists:\n' +
                        result.Errors.map(function (e) { return '⚠ ' + e.Message; }).join('\n');

                    result.Errors.forEach(function (e) {
                        var wrapper = view.querySelector('[data-fetch-id="' + e.FetchId + '"]');
                        if (wrapper) {
                            var row = wrapper.querySelector('.ftFetch');
                            if (row) row.classList.add('ftFetchInvalid');
                        }
                    });

                    var firstBad = view.querySelector('.ftFetchInvalid');
                    if (firstBad) firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    savingFolderTree = false;
                    editorSession.setBusy(view, 'tree', false);
                    return;
                }

                statusEl.innerText = 'Saved. Folder tree resync started.';
                snapshotFolderTreeSaved();
                refreshFolderTreeDirtyState(view);
                savingFolderTree = false;
                editorSession.setBusy(view, 'tree', false);
            }).catch(function () {
                savingFolderTree = false;
                editorSession.setBusy(view, 'tree', false);
                statusEl.innerText = 'Save failed — see server log.';
            });
        }

        function init(view) {
            activeView = view;
            view.querySelector('#ftSaveBtn').addEventListener('click', function () { saveFolderTree(view); });
            view.querySelector('#ftDiscardBtn').addEventListener('click', function () { discardFolderTreeChanges(view); });
            snapshotFolderTreeSaved();
            renderTree(view);

            // Connections/Schemas/RuleSets changing elsewhere doesn't need
            // to re-render the tree itself (fetch rows resolve labels live
            // off store data already), but a schema/connection deletion can
            // turn a previously-valid fetch into a dangling reference —
            // re-render so the "⚠ missing" badge appears without waiting
            // for the next unrelated edit.
            store.on('schemasChanged', function () { renderTree(view); });
            store.on('connectionsChanged', function () { renderTree(view); });
            store.on('ruleSetsChanged', function () { renderTree(view); });
        }

        return {
            init: init,
            renderTree: renderTree,
            hasUnsavedChanges: function () {
                return pendingFetchEditors > 0 || tracker.isDirty(store.get('currentTree'));
            },
            isSaving: function () { return savingFolderTree; }
        };
    });
