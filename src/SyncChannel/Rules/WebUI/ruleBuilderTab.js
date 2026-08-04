define(['jQuery', 'configurationpage?name=SyncChannelStoreJs',
        'configurationpage?name=SyncChannelDragEngineJs',
        'configurationpage?name=SyncChannelFieldDiscoveryJs',
        'configurationpage?name=SyncChannelSharedHelpersJs'],
    function ($, store, dragEngine, fieldDiscovery, helpers) {
        'use strict';

        // ===================================================================
        // Palette construction — schema-gated field list, operators unchanged.
        // ===================================================================
        var discoveryInFlight = {};

        function populatePalette(view, forceRefresh) {
            var opContainer = view.querySelector('#rcsOperatorChips');
            opContainer.innerHTML = '';
            helpers.ALL_OPERATORS.forEach(function (o) {
                opContainer.appendChild(makeOperatorChip(o));
            });

            var fieldContainer = view.querySelector('#rcsFieldChips');

            if (!store.get('connections').length) {
                fieldContainer.innerHTML = '<span class="rcsFieldHint">No connections saved yet — add and save one on the Connections tab first.</span>';
                return;
            }

            var connectionId = view.querySelector('#rcsConnectionSelect').value;
            var schemaId = view.querySelector('#rcsSchemaSelect').value;

            if (!connectionId || !schemaId) {
                fieldContainer.innerHTML = '<span class="rcsFieldHint">Pick a connection and endpoint to discover fields.</span>';
                return;
            }

            var cached = !forceRefresh && fieldDiscovery.getDiscoveredFields(connectionId, schemaId);
            if (cached) {
                renderFieldChips(view, connectionId, schemaId, cached);
                return;
            }

            fieldContainer.innerHTML = '<span class="rcsFieldHint">Discovering fields…</span>';

            ensureFieldsDiscovered(connectionId, schemaId, !!forceRefresh)
                .then(function (fields) {
                    // The user may have switched connection/schema while this
                    // was in flight — don't stomp on whatever they're looking
                    // at now.
                    if (view.querySelector('#rcsConnectionSelect').value !== connectionId ||
                        view.querySelector('#rcsSchemaSelect').value !== schemaId) {
                        return;
                    }
                    renderFieldChips(view, connectionId, schemaId, fields);
                })
                .catch(function (err) {
                    fieldContainer.innerHTML = '';
                    var errEl = document.createElement('span');
                    errEl.className = 'rcsFieldHint';
                    errEl.innerText = (err && err.message) || 'Field discovery failed.';
                    fieldContainer.appendChild(errEl);
                });
        }

        // Purely computed, every time — nothing here is ever written back to
        // EndpointSchemasFile. Cache-first server-side too (LastResponseCacheStore,
        // same as PreviewRule), so a cache hit is just a JSON walk, not a live
        // fetch. See ChannelSyncApiSurface.Post(DiscoverFields).
        //
        // Memoizes the in-flight Promise itself, not just the completed result —
        // populatePalette and renderCanvasForCurrentIndex both call this for the
        // same key on every canvas render; without this, a cold cache (or a
        // forced refresh) fires two concurrent identical requests before either
        // resolves.
        function ensureFieldsDiscovered(connectionId, schemaId, forceRefresh, draftSchema) {
            var key = connectionId + '|' + schemaId;

            if (!draftSchema) {
                var cached = fieldDiscovery.getDiscoveredFields(connectionId, schemaId);
                if (!forceRefresh && cached) return Promise.resolve(cached);
                if (discoveryInFlight[key]) return discoveryInFlight[key];
            }

            var request = ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl('ChannelSync/DiscoverFields'),
                data: JSON.stringify({ EndpointSchemaId: schemaId, ForceRefresh: !!forceRefresh, DraftSchema: draftSchema || null }),
                contentType: 'application/json',
                dataType: 'json'
            }).then(function (result) {
                delete discoveryInFlight[key];
                if (!result || result.Success === false) {
                    throw new Error((result && result.Message) || 'Field discovery failed.');
                }
                if (!draftSchema) {
                    fieldDiscovery.setDiscoveredFields(connectionId, schemaId, result.Fields || []);
                    return fieldDiscovery.getDiscoveredFields(connectionId, schemaId);
                }
                return result.Fields || [];
            }).catch(function (err) {
                delete discoveryInFlight[key];
                throw err;
            });

            if (!draftSchema) discoveryInFlight[key] = request;
            return request;
        }

        function renderFieldChips(view, connectionId, schemaId, fields) {
            var fieldContainer = view.querySelector('#rcsFieldChips');
            fieldContainer.innerHTML = '';

            if (!fields.length) {
                fieldContainer.innerHTML = '<span class="rcsFieldHint">No fields discovered — response may be empty or not a JSON array.</span>';
                return;
            }

            fields.forEach(function (f) {
                fieldContainer.appendChild(makeFieldChip(f.JsonPath, f.DisplayName, f.Type, !!f.IsFavorite, function () {
                    toggleFieldFavorite(view, connectionId, schemaId, f.JsonPath);
                }));
            });
        }

        // Bool -> Number -> Date -> String -> List, matching FieldDiscoveryService.
        var FIELD_TYPE_RANK = { Bool: 0, Number: 1, Date: 2, String: 3, List: 4 };

        function sortSchemaFields(fields) {
            return fields.slice().sort(function (a, b) {
                if (!!a.IsFavorite !== !!b.IsFavorite) return a.IsFavorite ? -1 : 1;
                var ra = FIELD_TYPE_RANK.hasOwnProperty(a.Type) ? FIELD_TYPE_RANK[a.Type] : 5;
                var rb = FIELD_TYPE_RANK.hasOwnProperty(b.Type) ? FIELD_TYPE_RANK[b.Type] : 5;
                return ra - rb;
            });
        }

        function toggleFieldFavorite(view, connectionId, schemaId, fieldPath) {
            var fields = fieldDiscovery.getDiscoveredFields(connectionId, schemaId);
            if (!fields) return;

            var field = fields.filter(function (f) { return f.JsonPath === fieldPath; })[0];
            if (!field) return;

            field.IsFavorite = !field.IsFavorite;
            var sorted = sortSchemaFields(fields);
            fieldDiscovery.setDiscoveredFields(connectionId, schemaId, sorted);

            renderFieldChips(view, connectionId, schemaId, sorted);
            persistFieldFavorite(schemaId, fieldPath, field.IsFavorite);
        }

        // Silent background save — favoriting is a per-user UI preference, not a
        // rule-set edit, so it doesn't use the visible save banner used
        // elsewhere. A failed save just means the toggle doesn't survive a page
        // reload; not worth interrupting the drag-and-drop flow to report.
        function persistFieldFavorite(schemaId, jsonPath, isFavorite) {
            ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl('ChannelSync/FieldFavorite'),
                data: JSON.stringify({ SchemaId: schemaId, JsonPath: jsonPath, IsFavorite: isFavorite }),
                contentType: 'application/json',
                dataType: 'json'
            });
        }

        function makeFieldChip(fieldPath, displayName, type, isFavorite, onToggleFavorite) {
            var chip = document.createElement('span');
            chip.className = 'rcsChip rcsChip-field' + (isFavorite ? ' rcsChip-field-favorite' : '');
            chip.innerText = displayName || fieldPath;
            chip.dataset.fieldPath = fieldPath;
            chip.dataset.fieldType = type;
            chip.title = isFavorite
                ? 'Right-click to remove from favorites'
                : 'Right-click to favorite — pins it to the top of the palette';

            var tag = document.createElement('span');
            tag.className = 'rcsFieldTypeTag';
            tag.innerText = '(' + type + ')';
            chip.appendChild(tag);

            chip.dataset.dragLabel = displayName || fieldPath;
            dragEngine.makeDraggableSource(chip, 'field', function () {
                return JSON.stringify({ path: fieldPath, type: type, display: displayName || fieldPath });
            });

            if (onToggleFavorite) {
                chip.addEventListener('contextmenu', function (e) {
                    e.preventDefault();
                    onToggleFavorite();
                });
            }

            return chip;
        }

        function makeOperatorChip(operator) {
            var chip = document.createElement('span');
            chip.className = 'rcsChip rcsChip-operator';
            chip.innerText = operator;
            dragEngine.makeDraggableSource(chip, 'operator', operator);
            return chip;
        }

        function wireStaticPaletteChips(view) {
            view.querySelectorAll('#rcsPalette .rcsChip[data-chip-kind]').forEach(function (chip) {
                var kind = chip.dataset.chipKind;
                var value = chip.dataset.chipValue || '';
                dragEngine.makeDraggableSource(chip, kind, value);
            });
        }

        // ===================================================================
        // Badge helpers
        // ===================================================================
        function makeNotBadge(active, onChange) {
            var badge = document.createElement('span');
            badge.className = 'rcsBadge rcsBadge-not' + (active ? ' rcsBadge-not-active' : ' rcsBadge-not-empty');
            badge.dataset.notActive = active ? 'true' : 'false';
            badge.innerText = active ? 'NOT ✕' : '¬';
            badge.title = 'Drag NOT here to negate; click an active NOT to remove it';

            dragEngine.registerDropTarget(badge, ['not'], function () {
                setNotBadgeActive(badge, true);
                if (onChange) onChange();
            });

            badge.addEventListener('click', function () {
                if (badge.dataset.notActive === 'true') {
                    setNotBadgeActive(badge, false);
                    if (onChange) onChange();
                }
            });

            return badge;
        }

        function setNotBadgeActive(badge, active) {
            badge.dataset.notActive = active ? 'true' : 'false';
            badge.classList.toggle('rcsBadge-not-active', active);
            badge.classList.toggle('rcsBadge-not-empty', !active);
            badge.innerText = active ? 'NOT ✕' : '¬';
        }

        function makeConnectorBadge(initialValue, onChange) {
            var badge = document.createElement('span');
            badge.className = 'rcsBadge rcsBadge-connector';
            badge.dataset.value = initialValue || 'And';
            badge.innerText = badge.dataset.value === 'Or' ? 'OR' : 'AND';
            badge.title = 'Drag AND / OR here to change how children combine';

            dragEngine.registerDropTarget(badge, ['logic'], function (value) {
                badge.dataset.value = value;
                badge.innerText = value === 'Or' ? 'OR' : 'AND';
                if (onChange) onChange();
            });

            return badge;
        }

        // ===================================================================
        // Value widget
        // ===================================================================
        function buildValueWidget(type, initialValue, onChange) {
            var widget = document.createElement('span');
            widget.className = 'rcsValueWidget';
            widget.dataset.value = initialValue || '';

            if (type === 'Bool') {
                var toggle = document.createElement('span');
                toggle.className = 'rcsBoolToggle';

                var trueOpt = document.createElement('span');
                trueOpt.className = 'rcsBoolOption';
                trueOpt.innerText = 'True';

                var falseOpt = document.createElement('span');
                falseOpt.className = 'rcsBoolOption';
                falseOpt.innerText = 'False';

                function setActive(val) {
                    widget.dataset.value = val;
                    trueOpt.classList.toggle('rcsBoolOption-active', val === 'true');
                    falseOpt.classList.toggle('rcsBoolOption-active', val === 'false');
                }

                trueOpt.addEventListener('click', function () { setActive('true'); if (onChange) onChange(); });
                falseOpt.addEventListener('click', function () { setActive('false'); if (onChange) onChange(); });

                setActive(initialValue === 'false' ? 'false' : (initialValue === 'true' ? 'true' : ''));

                toggle.appendChild(trueOpt);
                toggle.appendChild(falseOpt);
                widget.appendChild(toggle);
            } else {
                var input = document.createElement('input');
                input.setAttribute('is', 'emby-input');
                input.className = 'rcsValueInput';

                if (type === 'Number') {
                    input.type = 'number';
                } else if (type === 'Date') {
                    input.type = 'date';
                } else {
                    input.type = 'text';
                    input.placeholder = type === 'List' ? 'value to match in list…' : 'value…';
                }

                // Date fields store server-side timestamps ("2026-05-18T00:00:00Z")
                // but <input type=date> only accepts/returns "yyyy-MM-dd" — strip
                // the time component for display, RuleEvaluator compares by
                // calendar date so the bare form round-trips correctly either way.
                input.value = type === 'Date' && initialValue ? initialValue.slice(0, 10) : (initialValue || '');

                input.addEventListener('input', function () {
                    widget.dataset.value = input.value;
                    if (onChange) onChange();
                });

                widget.appendChild(input);
            }

            return widget;
        }

        // ===================================================================
        // Condition node
        // ===================================================================
        function buildConditionNode(data, onChange, connectionId, schemaId) {
            data = data || {};

            var node = document.createElement('div');
            node.className = 'rcsCondition';
            node.dataset.kind = 'Condition';

            var handle = document.createElement('span');
            handle.className = 'rcsHandle';
            handle.innerHTML = '&#9776;';
            dragEngine.makeDraggableSource(handle, 'reorder', '', function () { return node; });

            var fieldSlot = document.createElement('span');
            fieldSlot.className = 'rcsSlot rcsSlot-field';
            fieldSlot.dataset.slotType = 'field';
            fieldSlot.dataset.value = data.Field || '';
            fieldSlot.dataset.fieldType = data.Field ? fieldDiscovery.fieldTypeFromDiscovery(connectionId, schemaId, data.Field) : 'String';
            fieldSlot.innerText = data.Field || 'field…';
            if (data.Field) fieldSlot.classList.add('rcsSlot-filled');

            var operatorSlot = document.createElement('span');
            operatorSlot.className = 'rcsSlot rcsSlot-operator';
            operatorSlot.dataset.slotType = 'operator';
            operatorSlot.dataset.value = data.Operator || '';
            operatorSlot.innerText = data.Operator || 'op…';
            if (data.Operator) operatorSlot.classList.add('rcsSlot-filled');

            var valueHolder = document.createElement('span');
            valueHolder.className = 'rcsValueHolder';

            function currentType() { return fieldSlot.dataset.fieldType || 'String'; }

            function rebuildValueWidget(preserveValue) {
                valueHolder.innerHTML = '';
                var widget = buildValueWidget(currentType(), preserveValue || '', onChange);
                valueHolder.appendChild(widget);
            }

            function refreshOperatorLock() {
                var type = currentType();

                if (type === 'Bool') {
                    operatorSlot.dataset.value = 'EQ';
                    operatorSlot.innerText = 'EQ';
                    operatorSlot.classList.add('rcsSlot-filled', 'rcsSlot-locked');
                } else {
                    operatorSlot.classList.remove('rcsSlot-locked');
                    if (operatorSlot.dataset.value && !helpers.operatorAllowedForField(type, operatorSlot.dataset.value)) {
                        operatorSlot.dataset.value = '';
                        operatorSlot.innerText = 'op…';
                        operatorSlot.classList.remove('rcsSlot-filled');
                    }
                }
            }

            dragEngine.registerDropTarget(fieldSlot, ['field'], function (rawValue) {
                var parsed;
                try { parsed = JSON.parse(rawValue); } catch (e) { parsed = { path: rawValue, type: 'String', display: rawValue }; }

                var previousType = currentType();
                var previousValueWidget = valueHolder.querySelector('.rcsValueWidget');
                var previousValue = previousValueWidget ? previousValueWidget.dataset.value : '';

                fieldSlot.dataset.value = parsed.path;
                fieldSlot.dataset.fieldType = parsed.type;
                fieldSlot.innerText = parsed.display;
                fieldSlot.classList.add('rcsSlot-filled');
                refreshOperatorLock();
                rebuildValueWidget(previousType === parsed.type ? previousValue : '');
                if (onChange) onChange();
            });

            dragEngine.registerDropTarget(operatorSlot, ['operator'], function (value) {
                if (fieldSlot.dataset.value && !helpers.operatorAllowedForField(currentType(), value)) {
                    operatorSlot.classList.add('rcsSlotRejected');
                    setTimeout(function () { operatorSlot.classList.remove('rcsSlotRejected'); }, 500);
                    return;
                }
                operatorSlot.dataset.value = value;
                operatorSlot.innerText = value;
                operatorSlot.classList.add('rcsSlot-filled');
                if (onChange) onChange();
            });

            rebuildValueWidget(data.Value);
            refreshOperatorLock();

            var notBadge = makeNotBadge(!!data.Not, onChange);

            var removeBtn = document.createElement('span');
            removeBtn.className = 'rcsIconBtn';
            removeBtn.innerText = '✕';
            removeBtn.title = 'Remove condition';
            removeBtn.addEventListener('click', function () {
                node.parentNode.removeChild(node);
                if (onChange) onChange();
            });

            node.appendChild(handle);
            node.appendChild(fieldSlot);
            node.appendChild(operatorSlot);
            node.appendChild(valueHolder);
            node.appendChild(notBadge);
            node.appendChild(removeBtn);

            return node;
        }

        // ===================================================================
        // Group node (recursive)
        // ===================================================================
        function buildGroupNode(data, isRoot, onChange, connectionId, schemaId) {
            data = data || {};

            var group = document.createElement('div');
            group.className = 'rcsGroup' + (isRoot ? ' rcsGroupRoot' : '');
            group.dataset.kind = 'Group';

            var header = document.createElement('div');
            header.className = 'rcsGroupHeader';

            if (!isRoot) {
                var handle = document.createElement('span');
                handle.className = 'rcsHandle';
                handle.innerHTML = '&#9776;';
                dragEngine.makeDraggableSource(handle, 'reorder', '', function () { return group; });
                header.appendChild(handle);
            }

            var label = document.createElement('span');
            label.innerText = isRoot ? 'Root group —' : 'Group —';
            label.style.opacity = '0.6';
            label.style.fontSize = '0.85em';
            header.appendChild(label);

            var connectorBadge = makeConnectorBadge(data.LogicOperator || 'And', onChange);
            header.appendChild(connectorBadge);

            var notBadge = makeNotBadge(!!data.Not, onChange);
            header.appendChild(notBadge);

            if (!isRoot) {
                var removeBtn = document.createElement('span');
                removeBtn.className = 'rcsIconBtn';
                removeBtn.innerText = '✕ Remove group';
                removeBtn.addEventListener('click', function () {
                    group.parentNode.removeChild(group);
                    if (onChange) onChange();
                });
                header.appendChild(removeBtn);
            }

            group.appendChild(header);

            var childrenContainer = document.createElement('div');
            childrenContainer.className = 'rcsGroupChildren';

            var emptyHint = document.createElement('div');
            emptyHint.className = 'rcsEmptyHint';
            emptyHint.innerText = 'Drag "Condition" or "Group ( )" here';
            childrenContainer.appendChild(emptyHint);

            function refreshEmptyHint() {
                var hasChildren = !!childrenContainer.querySelector('.rcsCondition, .rcsGroup');
                emptyHint.style.display = hasChildren ? 'none' : '';
            }

            (data.Children || []).forEach(function (child) {
                if (child.Kind === 'Group') {
                    childrenContainer.appendChild(buildGroupNode(child, false, onChange, connectionId, schemaId));
                } else {
                    childrenContainer.appendChild(buildConditionNode(child, onChange, connectionId, schemaId));
                }
            });
            refreshEmptyHint();

            // onHover here is the generalization dragEngine.js expects:
            // this container decides its own vertical insertion indicator,
            // dragEngine has no idea what "rcsGroupChildren" means.
            var onHover = function (clientX, clientY) { dragEngine.showInsertionIndicatorAt(childrenContainer, clientY); };

            dragEngine.registerDropTarget(childrenContainer, ['reorder'], function (value, reorderEl, clientY) {
                if (!reorderEl) return;
                var insertBeforeEl = dragEngine.findInsertionPoint(childrenContainer, clientY);
                childrenContainer.insertBefore(reorderEl, insertBeforeEl);
                refreshEmptyHint();
                if (onChange) onChange();
            }, 'rcsDragOver', onHover);

            dragEngine.registerDropTarget(childrenContainer, ['new-condition'], function (value, reorderEl, clientY) {
                var insertBeforeEl = dragEngine.findInsertionPoint(childrenContainer, clientY);
                childrenContainer.insertBefore(buildConditionNode({}, onChange, connectionId, schemaId), insertBeforeEl);
                refreshEmptyHint();
                if (onChange) onChange();
            }, 'rcsDragOver', onHover);

            dragEngine.registerDropTarget(childrenContainer, ['new-group'], function (value, reorderEl, clientY) {
                var insertBeforeEl = dragEngine.findInsertionPoint(childrenContainer, clientY);
                childrenContainer.insertBefore(buildGroupNode({}, false, onChange, connectionId, schemaId), insertBeforeEl);
                refreshEmptyHint();
                if (onChange) onChange();
            }, 'rcsDragOver', onHover);

            group.appendChild(childrenContainer);

            var footer = document.createElement('div');
            footer.className = 'rcsGroupFooter';
            var hint = document.createElement('span');
            hint.className = 'rcsEmptyHint';
            hint.innerText = '(drop palette items anywhere in this box)';
            footer.appendChild(hint);
            group.appendChild(footer);

            return group;
        }

        // ===================================================================
        // Reading the tree back out of the DOM
        // ===================================================================
        function readGroupFromDom(groupEl) {
            var childrenContainer = groupEl.querySelector(':scope > .rcsGroupChildren');
            var header = groupEl.querySelector(':scope > .rcsGroupHeader');
            var connectorBadge = header.querySelector('.rcsBadge-connector');
            var notBadge = header.querySelector('.rcsBadge-not');

            var children = [];
            Array.prototype.forEach.call(childrenContainer.children, function (childEl) {
                if (childEl.classList.contains('rcsGroup')) {
                    children.push(readGroupFromDom(childEl));
                } else if (childEl.classList.contains('rcsCondition')) {
                    children.push(readConditionFromDom(childEl));
                }
            });

            return {
                Kind: 'Group',
                LogicOperator: connectorBadge.dataset.value || 'And',
                Not: notBadge.dataset.notActive === 'true',
                Children: children
            };
        }

        function readConditionFromDom(nodeEl) {
            var fieldSlot = nodeEl.querySelector('.rcsSlot-field');
            var operatorSlot = nodeEl.querySelector('.rcsSlot-operator');
            var valueWidget = nodeEl.querySelector('.rcsValueWidget');
            var notBadge = nodeEl.querySelector('.rcsBadge-not');

            return {
                Kind: 'Condition',
                Field: fieldSlot.dataset.value || '',
                Operator: operatorSlot.dataset.value || '',
                Value: (valueWidget && valueWidget.dataset.value) || '',
                Not: notBadge.dataset.notActive === 'true'
            };
        }

        // ===================================================================
        // Validation
        // ===================================================================
        function findInvalidConditionElements(rootGroupEl) {
            var invalid = [];
            rootGroupEl.querySelectorAll('.rcsCondition').forEach(function (nodeEl) {
                var fieldSlot = nodeEl.querySelector('.rcsSlot-field');
                var operatorSlot = nodeEl.querySelector('.rcsSlot-operator');
                var valueWidget = nodeEl.querySelector('.rcsValueWidget');

                var isValid = !!fieldSlot.dataset.value && !!operatorSlot.dataset.value &&
                    valueWidget && valueWidget.dataset.value !== '';

                if (!isValid) invalid.push(nodeEl);
            });
            return invalid;
        }

        function findEmptyGroupElements(rootGroupEl) {
            var empty = [];
            rootGroupEl.querySelectorAll('.rcsGroup').forEach(function (groupEl) {
                var childrenContainer = groupEl.querySelector(':scope > .rcsGroupChildren');
                var hasChildren = !!childrenContainer.querySelector(':scope > .rcsCondition, :scope > .rcsGroup');
                if (!hasChildren) empty.push(groupEl);
            });
            return empty;
        }

        function highlightInvalid(rootGroupEl, invalidNodes) {
            rootGroupEl.querySelectorAll('.rcsCondition').forEach(function (nodeEl) {
                nodeEl.classList.remove('rcsInvalid');
            });
            invalidNodes.forEach(function (nodeEl) { nodeEl.classList.add('rcsInvalid'); });
        }

        function highlightEmptyGroups(rootGroupEl, emptyGroupEls) {
            rootGroupEl.querySelectorAll('.rcsGroup').forEach(function (groupEl) {
                groupEl.classList.remove('rcsGroupEmpty');
            });
            emptyGroupEls.forEach(function (groupEl) { groupEl.classList.add('rcsGroupEmpty'); });
        }

        // ===================================================================
        // Preview — cache-first, self-sufficient (no folder-tree sync needed).
        // ===================================================================
        var autoPreviewTimer = null;
        var autoPreviewToken = 0;
        var ruleRawResponseBySchemaId = {};
        var ruleRawExpandedBySchemaId = {};
        var ruleRawStrippedBySchemaId = {};

        function renderRuleRawResponse(view, schemaId) {
            var details = view.querySelector('#rcsRawResponse');
            var pre = view.querySelector('#rcsRawResponseText');
            var strip = view.querySelector('#rcsStripRawResponse');
            if (!details || !pre || !strip) return;
            var raw = ruleRawResponseBySchemaId[schemaId];
            details.style.display = raw ? '' : 'none';
            if (!raw) return;

            details.open = !!ruleRawExpandedBySchemaId[schemaId];
            var cleaned = null;
            if (ruleRawStrippedBySchemaId[schemaId]) {
                try { cleaned = JSON.stringify(JSON.parse(raw), null, 2); } catch (e) { cleaned = null; }
            }
            pre.innerText = cleaned === null ? raw : cleaned;
            strip.innerText = ruleRawStrippedBySchemaId[schemaId] ? 'Show raw response' : 'Strip to valid JSON';
        }

        // Marks the currently-edited rule set dirty via the store's flag
        // (shared with ruleSetManagerTab, which owns the actual banner
        // render) and fires 'ruleSetsDirtyStateChanged' so that tab's own
        // subscriber updates its warning label/discard button — this tab
        // never touches ruleSetManagerTab's DOM directly.
        function scheduleAutoPreview(view, isUserEdit) {
            if (isUserEdit) {
                var currentRuleSetIndex = store.get('currentRuleSetIndex');
                var ruleSetsFile = store.get('ruleSetsFile');
                var edited = currentRuleSetIndex >= 0 ? ruleSetsFile.RuleSets[currentRuleSetIndex] : null;
                if (edited) store.markRuleSetEdited(edited.Id);
            }
            store.emit('ruleSetsDirtyStateChanged');
            if (autoPreviewTimer) clearTimeout(autoPreviewTimer);
            autoPreviewTimer = setTimeout(function () { runAutoPreview(view); }, 450);
        }

        function markRuleSetsDirty(view) {
            store.set('ruleSetsHaveUnsavedChanges', true);
            store.emit('ruleSetsDirtyStateChanged');
        }

        function renderPreviewTable(container, fields, matches) {
            container.innerHTML = '';

            if (!matches || matches.length === 0) {
                container.innerText = 'No matches.';
                return;
            }

            var wrapper = document.createElement('div');
            wrapper.className = 'rcsPreviewTableWrapper';

            var table = document.createElement('table');
            table.className = 'rcsPreviewTable';

            var headerRow = document.createElement('tr');
            var corner = document.createElement('th');
            corner.innerText = 'Item';
            headerRow.appendChild(corner);
            matches.forEach(function (m) {
                var th = document.createElement('th');
                th.innerText = m.Title;
                headerRow.appendChild(th);
            });
            table.appendChild(headerRow);

            fields.forEach(function (f) {
                var row = document.createElement('tr');
                var label = document.createElement('td');
                label.innerText = f;
                row.appendChild(label);

                matches.forEach(function (m) {
                    var td = document.createElement('td');
                    var val = m.Values && m.Values[f];
                    td.innerText = (val === undefined || val === null || val === '') ? '—' : val;
                    row.appendChild(td);
                });

                table.appendChild(row);
            });

            wrapper.appendChild(table);
            container.appendChild(wrapper);
        }

        function runAutoPreview(view) {
            var rootGroupEl = view.querySelector('#conditionsList > .rcsGroupRoot');
            if (!rootGroupEl) return;

            var statusEl = view.querySelector('#rcsPreviewStatus');
            var resultEl = view.querySelector('#previewResult');
            var schemaId = view.querySelector('#rcsSchemaSelect').value;
            renderRuleRawResponse(view, schemaId);

            var invalid = findInvalidConditionElements(rootGroupEl);
            var emptyGroups = findEmptyGroupElements(rootGroupEl);
            highlightEmptyGroups(rootGroupEl, emptyGroups);

            if (invalid.length > 0) {
                statusEl.innerText = 'Expression incomplete (' + invalid.length + ' condition(s) missing a field, operator, or value) — preview will resume once it\'s valid.';
                resultEl.innerHTML = '';
                return;
            }

            var candidate = readGroupFromDom(rootGroupEl);

            var warningText = '';
            if (emptyGroups.length > 0) {
                warningText = ' ⚠ ' + emptyGroups.length + ' empty group(s) outlined in amber — an empty AND-group matches EVERY item by default, which may widen this rule further than intended.';
            }

            var connectionId = view.querySelector('#rcsConnectionSelect').value;
            var currentRuleSetIndex = store.get('currentRuleSetIndex');
            var ruleSetsFile = store.get('ruleSetsFile');
            var previewRuleSetId = currentRuleSetIndex >= 0 && ruleSetsFile.RuleSets[currentRuleSetIndex]
                ? ruleSetsFile.RuleSets[currentRuleSetIndex].Id : '';
            var previewToken = ++autoPreviewToken;

            statusEl.innerText = 'Checking…' + warningText;

            ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl('ChannelSync/RulePreview'),
                data: JSON.stringify({
                    EndpointSchemaId: schemaId,
                    Rule: candidate,
                    IncludeRawJson: !ruleRawResponseBySchemaId[schemaId]
                }),
                contentType: 'application/json',
                dataType: 'json'
            }).then(function (result) {
                var latestIndex = store.get('currentRuleSetIndex');
                var latestFile = store.get('ruleSetsFile');
                var activeRuleSet = latestIndex >= 0 ? latestFile.RuleSets[latestIndex] : null;
                if (previewToken !== autoPreviewToken ||
                    view.querySelector('#rcsConnectionSelect').value !== connectionId ||
                    view.querySelector('#rcsSchemaSelect').value !== schemaId ||
                    !activeRuleSet || activeRuleSet.Id !== previewRuleSetId) return;
                if (result.RawJson) {
                    ruleRawResponseBySchemaId[schemaId] = result.RawJson;
                    renderRuleRawResponse(view, schemaId);
                }
                if (result.Status === 'unavailable' || result.Status === 'error') {
                    statusEl.innerText = result.Message + warningText;
                    resultEl.innerHTML = '';
                    return;
                }

                var shown = (result.Matches || []).length;
                var countText = shown < result.MatchCount
                    ? result.MatchCount + ' match(es) — showing first ' + shown + ':'
                    : result.MatchCount + ' match(es):';
                statusEl.innerText = countText + warningText;

                renderPreviewTable(resultEl, result.Fields || [], result.Matches || []);
            }).catch(function () {
                if (previewToken !== autoPreviewToken) return;
                statusEl.innerText = 'Preview request failed — see server log.' + warningText;
                resultEl.innerHTML = '';
            });
        }

        function wireRawResponseControls(view) {
            var ruleRawDetails = view.querySelector('#rcsRawResponse');
            if (ruleRawDetails) {
                ruleRawDetails.addEventListener('toggle', function () {
                    var schemaId = view.querySelector('#rcsSchemaSelect').value;
                    if (schemaId) ruleRawExpandedBySchemaId[schemaId] = ruleRawDetails.open;
                });
            }
            var copyBtn = view.querySelector('#rcsCopyRawResponse');
            if (copyBtn) {
                copyBtn.addEventListener('click', function () {
                    helpers.copyTextToClipboard(view.querySelector('#rcsRawResponseText').innerText).then(function () {
                        copyBtn.innerText = 'Copied!';
                        setTimeout(function () { copyBtn.innerText = 'Copy to clipboard'; }, 1500);
                    }).catch(function () {
                        copyBtn.innerText = 'Copy blocked';
                    });
                });
            }
            var stripBtn = view.querySelector('#rcsStripRawResponse');
            if (stripBtn) {
                stripBtn.addEventListener('click', function () {
                    var schemaId = view.querySelector('#rcsSchemaSelect').value;
                    if (!schemaId) return;
                    ruleRawStrippedBySchemaId[schemaId] = !ruleRawStrippedBySchemaId[schemaId];
                    renderRuleRawResponse(view, schemaId);
                });
            }
        }

        return {
            populatePalette: populatePalette,
            wireStaticPaletteChips: wireStaticPaletteChips,
            buildGroupNode: buildGroupNode,
            buildConditionNode: buildConditionNode,
            readGroupFromDom: readGroupFromDom,
            findInvalidConditionElements: findInvalidConditionElements,
            findEmptyGroupElements: findEmptyGroupElements,
            highlightInvalid: highlightInvalid,
            highlightEmptyGroups: highlightEmptyGroups,
            renderRuleRawResponse: renderRuleRawResponse,
            scheduleAutoPreview: scheduleAutoPreview,
            markRuleSetsDirty: markRuleSetsDirty,
            runAutoPreview: runAutoPreview,
            ensureFieldsDiscovered: ensureFieldsDiscovered,
            makeFieldChip: makeFieldChip,
            sortSchemaFields: sortSchemaFields,
            persistFieldFavorite: persistFieldFavorite,
            wireRawResponseControls: wireRawResponseControls
        };
    });
