define(['jQuery'], function ($) {
    'use strict';

    var providerSchemas = [];   // [{ ProviderKey, DisplayName, Fields: [...] }]
    var radarrRuleSetOptions = []; // [{ Id, Name }]

    function newId() {
        // Good enough for client-generated ids — server treats Id as an
        // opaque stable string either way, and re-saves the whole tree
        // atomically so there's no risk of collision across concurrent edits.
        return 'xxxxxxxxxxxx'.replace(/x/g, function () {
            return (Math.random() * 16 | 0).toString(16);
        });
    }

    function schemaFor(providerKey) {
        return providerSchemas.filter(function (p) { return p.ProviderKey === providerKey; })[0];
    }

    // ===================================================================
    // Fetch field rendering — generated purely from the provider's schema,
    // so a brand-new provider needs zero JS changes here to work.
    // ===================================================================
    function buildFieldInput(field, currentValue) {
        var wrap = document.createElement('div');
        wrap.className = 'ftField';

        var label = document.createElement('label');
        label.innerText = field.DisplayName + (field.Required ? ' *' : '');
        wrap.appendChild(label);

        var input;

        if (field.Type === 'RuleSetPicker') {
            input = document.createElement('select');
            radarrRuleSetOptions.forEach(function (opt) {
                var o = document.createElement('option');
                o.value = opt.Id;
                o.innerText = opt.Name;
                if (opt.Id === currentValue) o.selected = true;
                input.appendChild(o);
            });
        } else if (field.Type === 'Bool') {
            input = document.createElement('select');
            ['true', 'false'].forEach(function (v) {
                var o = document.createElement('option');
                o.value = v;
                o.innerText = v;
                if (v === currentValue) o.selected = true;
                input.appendChild(o);
            });
        } else {
            input = document.createElement('input');
            input.type = field.Type === 'Password' ? 'password' : (field.Type === 'Number' ? 'number' : 'text');
            input.value = currentValue !== undefined && currentValue !== null ? currentValue : (field.DefaultValue || '');
        }

        input.dataset.fieldKey = field.Key;

        if (field.Description) {
            var desc = document.createElement('div');
            desc.className = 'fieldDescription';
            desc.style.fontSize = '0.75em';
            desc.innerText = field.Description;
            wrap.appendChild(input);
            wrap.appendChild(desc);
        } else {
            wrap.appendChild(input);
        }

        return wrap;
    }

    function readFieldValues(panelEl) {
        var values = {};
        panelEl.querySelectorAll('[data-field-key]').forEach(function (el) {
            values[el.dataset.fieldKey] = el.value;
        });
        return values;
    }

    // ===================================================================
    // Add-fetch flow: pick a provider, then render its schema, then commit
    // into the in-memory tree (nothing hits the server until Save All).
    // ===================================================================
    function openAddFetchPanel(container, folderNode, onChange) {
        container.innerHTML = '';

        var picker = document.createElement('div');
        picker.className = 'ftPanel ftProviderPicker';

        if (providerSchemas.length === 0) {
            picker.innerText = 'No fetch providers are registered.';
            container.appendChild(picker);
            return;
        }

        providerSchemas.forEach(function (schema) {
            var chip = document.createElement('span');
            chip.className = 'ftProviderChip';
            chip.innerText = schema.DisplayName;
            chip.addEventListener('click', function () {
                openFetchFieldForm(container, folderNode, schema, null, onChange);
            });
            picker.appendChild(chip);
        });

        container.appendChild(picker);
    }

    function openFetchFieldForm(container, folderNode, schema, existingFetch, onChange) {
        container.innerHTML = '';

        var panel = document.createElement('div');
        panel.className = 'ftPanel';

        var title = document.createElement('div');
        title.style.fontWeight = '600';
        title.style.marginBottom = '0.5em';
        title.innerText = (existingFetch ? 'Edit ' : 'Add ') + schema.DisplayName + ' fetch';
        panel.appendChild(title);

        var labelField = document.createElement('div');
        labelField.className = 'ftField';
        var labelLabel = document.createElement('label');
        labelLabel.innerText = 'Label';
        var labelInput = document.createElement('input');
        labelInput.type = 'text';
        labelInput.value = existingFetch ? existingFetch.DisplayLabel : (schema.DisplayName + ' Sync');
        labelInput.dataset.fieldKey = '__label';
        labelField.appendChild(labelLabel);
        labelField.appendChild(labelInput);
        panel.appendChild(labelField);

        schema.Fields.forEach(function (f) {
            var current = existingFetch ? existingFetch.Settings[f.Key] : undefined;
            panel.appendChild(buildFieldInput(f, current));
        });

        var btnRow = document.createElement('div');
        btnRow.className = 'ftAddRow';

        var saveBtn = document.createElement('button');
        saveBtn.setAttribute('is', 'emby-button');
        saveBtn.className = 'raised button-submit';
        saveBtn.type = 'button';
        saveBtn.innerText = existingFetch ? 'Update Fetch' : 'Add Fetch';
        saveBtn.addEventListener('click', function () {
            var values = readFieldValues(panel);
            var label = values.__label;
            delete values.__label;

            var missing = schema.Fields.filter(function (f) {
                return f.Required && (!values[f.Key] || values[f.Key].trim() === '');
            });
            if (missing.length > 0) {
                Dashboard.alert('Please fill in: ' + missing.map(function (f) { return f.DisplayName; }).join(', '));
                return;
            }

            if (existingFetch) {
                existingFetch.DisplayLabel = label;
                existingFetch.Settings = values;
            } else {
                folderNode.Fetches.push({
                    Id: newId(),
                    ProviderKey: schema.ProviderKey,
                    Enabled: true,
                    DisplayLabel: label,
                    Settings: values
                });
            }

            container.innerHTML = '';
            onChange();
        });

        var cancelBtn = document.createElement('button');
        cancelBtn.setAttribute('is', 'emby-button');
        cancelBtn.type = 'button';
        cancelBtn.innerText = 'Cancel';
        cancelBtn.addEventListener('click', function () { container.innerHTML = ''; });

        btnRow.appendChild(saveBtn);
        btnRow.appendChild(cancelBtn);
        panel.appendChild(btnRow);

        container.appendChild(panel);
    }

    // ===================================================================
    // Recursive folder node rendering
    // ===================================================================
    function buildFetchRow(fetch, folderNode, onChange) {
        var row = document.createElement('div');
        row.className = 'ftFetch' + (fetch.Enabled ? '' : ' ftFetchDisabled');

        var badge = document.createElement('span');
        badge.className = 'ftFetchProviderBadge';
        var schema = schemaFor(fetch.ProviderKey);
        badge.innerText = schema ? schema.DisplayName : fetch.ProviderKey;
        row.appendChild(badge);

        var label = document.createElement('span');
        label.className = 'ftFetchLabel';
        label.innerText = fetch.DisplayLabel || '(unnamed)';
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
            var schemaForEdit = schemaFor(fetch.ProviderKey);
            if (!schemaForEdit) {
                Dashboard.alert('This fetch uses an unknown provider and cannot be edited here.');
                return;
            }
            openFetchFieldForm(editPanel, folderNode, schemaForEdit, fetch, onChange);
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
        wrapper.appendChild(row);
        wrapper.appendChild(editPanel);
        return wrapper;
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
        nameInput.value = node.IsRoot ? '(root)' : node.DisplayName;
        nameInput.disabled = node.IsRoot;
        nameInput.addEventListener('change', function () {
            node.DisplayName = nameInput.value.trim() || 'Untitled Folder';
            nameInput.value = node.DisplayName;
        });
        header.appendChild(nameInput);

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
            openAddFetchPanel(addFetchPanel, node, onChange);
        });
        addRow.appendChild(addFetchBtn);

        var addSubfolderBtn = document.createElement('button');
        addSubfolderBtn.setAttribute('is', 'emby-button');
        addSubfolderBtn.type = 'button';
        addSubfolderBtn.innerText = '+ Add Subfolder';
        addSubfolderBtn.addEventListener('click', function () {
            node.Children.push({
                Id: newId(),
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

    // ===================================================================
    // Load / render / save
    // ===================================================================
    var currentTree = null;

    function render(view) {
        var container = view.querySelector('#ftRoot');
        container.innerHTML = '';
        container.appendChild(buildFolderNode(currentTree.RootFolder, null, function () { render(view); }));
    }

    function loadAll(view) {
        var statusEl = view.querySelector('#ftStatus');
        statusEl.innerText = 'Loading…';

        Promise.all([
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/FolderTree'), dataType: 'json' }),
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/FetchProviders'), dataType: 'json' }),
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/RadarrRuleSetOptions'), dataType: 'json' })
        ]).then(function (results) {
            currentTree = results[0];
            providerSchemas = results[1] || [];
            radarrRuleSetOptions = results[2] || [];
            statusEl.innerText = '';
            render(view);
        }).catch(function () {
            statusEl.innerText = 'Failed to load folder tree.';
        });
    }

    function saveAll(view) {
        var statusEl = view.querySelector('#ftStatus');
        statusEl.innerText = 'Saving…';

        ApiClient.ajax({
            type: 'POST',
            url: ApiClient.getUrl('ChannelSync/FolderTree'),
            data: JSON.stringify({ RootFolder: currentTree.RootFolder }),
            contentType: 'application/json',
            dataType: 'json'
        }).then(function () {
            statusEl.innerText = 'Saved. New folders/fetches populate on the next sync (every 15 min), or run "Sync Coming Soon Folder Tree" from Scheduled Tasks now.';
        }).catch(function () {
            statusEl.innerText = 'Save failed — see server log.';
        });
    }

    return function (view) {
        view.addEventListener('viewshow', function () {
            loadAll(view);

            view.querySelector('#ftSaveBtn').addEventListener('click', function () {
                saveAll(view);
            });
        });
    };
});
