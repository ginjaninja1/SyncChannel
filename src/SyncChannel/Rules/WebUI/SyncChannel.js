define(['jQuery'], function ($) {
    'use strict';

    // ===================================================================
    // Shared operator metadata. Field-level types now come from each
    // EndpointSchema's Fields list (server-driven), not a hardcoded map —
    // only the operator set per abstract type stays as client-side metadata,
    // since it's about the rule builder's UI, not any one provider's schema.
    // ===================================================================
    var OPERATORS_BY_TYPE = {
        Bool:   ['EQ'],
        Number: ['LT', 'LTE', 'GT', 'GTE', 'EQ', 'NEQ'],
        String: ['EQ', 'NEQ', 'CONTAINS', 'NOTCONTAINS', 'STARTSWITH', 'ENDSWITH'],
        List:   ['CONTAINS', 'NOTCONTAINS']
    };

    var ALL_OPERATORS = ['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'CONTAINS', 'NOTCONTAINS', 'STARTSWITH', 'ENDSWITH'];

    function operatorAllowedForField(fieldType, operator) {
        var allowed = OPERATORS_BY_TYPE[fieldType];
        return !allowed || allowed.indexOf(operator) !== -1;
    }

    function newId() {
        return 'xxxxxxxxxxxx'.replace(/x/g, function () {
            return (Math.random() * 16 | 0).toString(16);
        });
    }

    function connectionBadgeGlyph(c) {
        if (c.LastTestSucceeded === true) return '✅';
        if (c.LastTestSucceeded === false) return '❌';
        return '⚪';
    }

    function connectionBadgeText(c) {
        var glyph = connectionBadgeGlyph(c);
        if (!c.LastTestedUtc) return glyph + ' untested';
        var when = new Date(c.LastTestedUtc);
        return glyph + ' ' + (c.LastTestSucceeded ? 'reachable' : 'unreachable') + ' (' + when.toLocaleString() + ')';
    }

    // ===================================================================
    // Pointer-based drag engine (unchanged mechanics from the original
    // rulesPage.js / folderTreePage.js — native HTML5 DnD is unreliable in
    // Emby's webview, see Evidence.md).
    // ===================================================================
    var dropTargetRegistry = [];
    var activeDrag = null;
    var highlightedTarget = null;

    function resetDragEngine() {
        dropTargetRegistry = [];
        activeDrag = null;
        highlightedTarget = null;
    }

    function registerDropTarget(el, kinds, onDrop, highlightClass) {
        dropTargetRegistry.push({
            el: el,
            kinds: kinds,
            onDrop: onDrop,
            highlightClass: highlightClass || 'rcsDragOver'
        });
    }

    function makeDraggableSource(el, kind, valueFn, reorderElFn) {
        el.style.touchAction = 'none';
        el.addEventListener('pointerdown', function (e) {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            if (activeDrag) {
                // A previous drag never got a matching pointerup/cancel (e.g.
                // released over UI that swallowed the event) — clean it up
                // before starting a new one instead of stacking ghosts.
                teardownDrag();
            }
            e.preventDefault();
            var value = typeof valueFn === 'function' ? valueFn() : (valueFn || '');
            var reorderEl = typeof reorderElFn === 'function' ? reorderElFn() : (reorderElFn || null);
            startPointerDrag(e, kind, value, reorderEl, el);
        });
    }

    function startPointerDrag(e, kind, value, reorderElement, sourceEl) {
        var ghost = document.createElement('div');
        ghost.className = 'rcsDragGhost';
        ghost.innerText = value || (sourceEl ? sourceEl.innerText : kind);
        document.body.appendChild(ghost);

        activeDrag = { kind: kind, value: value, reorderElement: reorderElement, ghostEl: ghost };
        positionGhost(e.clientX, e.clientY);

        document.addEventListener('pointermove', onPointerMove, true);
        document.addEventListener('pointerup', onPointerUp, true);
        document.addEventListener('pointercancel', onPointerCancel, true);
        window.addEventListener('blur', onWindowBlurDuringDrag);
    }

    function positionGhost(x, y) {
        if (!activeDrag) return;
        activeDrag.ghostEl.style.left = (x + 14) + 'px';
        activeDrag.ghostEl.style.top = (y + 14) + 'px';
    }

    var insertionIndicatorEl = null;

    function ensureInsertionIndicator() {
        if (!insertionIndicatorEl) {
            insertionIndicatorEl = document.createElement('div');
            insertionIndicatorEl.className = 'rcsInsertionIndicator';
            document.body.appendChild(insertionIndicatorEl);
        }
        return insertionIndicatorEl;
    }

    function hideInsertionIndicator() {
        if (insertionIndicatorEl) insertionIndicatorEl.style.display = 'none';
    }

    function showInsertionIndicatorAt(containerEl, clientY) {
        var insertBeforeEl = findInsertionPoint(containerEl, clientY);
        var y;

        if (insertBeforeEl) {
            y = insertBeforeEl.getBoundingClientRect().top;
        } else {
            var items = Array.prototype.filter.call(containerEl.children, function (el) {
                return el.classList.contains('rcsCondition') || el.classList.contains('rcsGroup');
            });
            if (items.length) {
                y = items[items.length - 1].getBoundingClientRect().bottom;
            } else {
                y = containerEl.getBoundingClientRect().top + 8;
            }
        }

        var containerRect = containerEl.getBoundingClientRect();
        var indicator = ensureInsertionIndicator();
        indicator.style.display = 'block';
        indicator.style.left = containerRect.left + 'px';
        indicator.style.width = containerRect.width + 'px';
        indicator.style.top = (y - 2) + 'px';
    }

    function findDropTarget(x, y) {
        if (!activeDrag) return null;
        var elAtPoint = document.elementFromPoint(x, y);
        if (!elAtPoint) return null;

        var matches = dropTargetRegistry.filter(function (reg) {
            return reg.kinds.indexOf(activeDrag.kind) !== -1 &&
                (reg.el === elAtPoint || reg.el.contains(elAtPoint));
        });

        if (matches.length === 0) return null;
        if (matches.length === 1) return matches[0];

        for (var i = 0; i < matches.length; i++) {
            var isMostNested = true;
            for (var j = 0; j < matches.length; j++) {
                if (i !== j && matches[i].el !== matches[j].el && matches[i].el.contains(matches[j].el)) {
                    isMostNested = false;
                    break;
                }
            }
            if (isMostNested) return matches[i];
        }
        return matches[0];
    }

    function onPointerMove(e) {
        if (!activeDrag) return;
        positionGhost(e.clientX, e.clientY);

        var target = findDropTarget(e.clientX, e.clientY);

        if (highlightedTarget && highlightedTarget !== target) {
            highlightedTarget.el.classList.remove(highlightedTarget.highlightClass);
            highlightedTarget = null;
        }
        if (target) {
            target.el.classList.add(target.highlightClass);
            highlightedTarget = target;
        }

        if (target && target.el.classList.contains('rcsGroupChildren')) {
            showInsertionIndicatorAt(target.el, e.clientY);
        } else {
            hideInsertionIndicator();
        }
    }

    function onPointerUp(e) {
        if (!activeDrag) return;

        var target = findDropTarget(e.clientX, e.clientY);
        var drag = activeDrag;

        teardownDrag();

        if (target) {
            target.onDrop(drag.value, drag.reorderElement, e.clientY, e.clientX);
        }
    }

    function onPointerCancel() { teardownDrag(); }

    function onWindowBlurDuringDrag() { teardownDrag(); }

    function teardownDrag() {
        if (highlightedTarget) {
            highlightedTarget.el.classList.remove(highlightedTarget.highlightClass);
            highlightedTarget = null;
        }
        hideInsertionIndicator();
        if (activeDrag && activeDrag.ghostEl && activeDrag.ghostEl.parentNode) {
            activeDrag.ghostEl.parentNode.removeChild(activeDrag.ghostEl);
        }
        activeDrag = null;
        document.removeEventListener('pointermove', onPointerMove, true);
        document.removeEventListener('pointerup', onPointerUp, true);
        document.removeEventListener('pointercancel', onPointerCancel, true);
        window.removeEventListener('blur', onWindowBlurDuringDrag);
    }

    function findInsertionPoint(container, clientY) {
        var items = Array.prototype.filter.call(container.children, function (el) {
            return el.classList.contains('rcsCondition') || el.classList.contains('rcsGroup');
        });

        for (var i = 0; i < items.length; i++) {
            var rect = items[i].getBoundingClientRect();
            var midpoint = rect.top + rect.height / 2;
            if (clientY < midpoint) {
                return items[i];
            }
        }
        return null;
    }

    // ===================================================================
    // Rule-set state (module-scoped so the Rule Sets tab, the palette, and
    // the folder tree's Add-Fetch dropdown can all read the same lists).
    // ===================================================================
    var connections = [];          // [{ Id, DisplayLabel, BaseUrl, ApiKey, SystemType, LastTestSucceeded, LastTestedUtc }]
    var schemas = [];               // [{ Id, DisplayName, SystemType, Fields: [{Key/JsonPath, DisplayName, Type}] }]
    var ruleSetsFile = null;        // { RuleSets: [{ Id, Name, EndpointSchemaId, IsBuiltIn, Root }] }
    var currentRuleSetIndex = -1;   // index into ruleSetsFile.RuleSets bound to the canvas

    // ---- SystemType filtering helpers ----
    function schemasForSystemType(systemType) {
        if (!systemType) return schemas;
        return schemas.filter(function (s) { return s.SystemType === systemType; });
    }

    function connectionSystemType(connectionId) {
        var c = connections.filter(function (x) { return x.Id === connectionId; })[0];
        return c ? c.SystemType : '';
    }

    function findConnection(connectionId) {
        return connections.filter(function (x) { return x.Id === connectionId; })[0];
    }

    function schemaFields(schemaId) {
        var schema = schemas.filter(function (s) { return s.Id === schemaId; })[0];
        return schema ? schema.Fields : [];
    }

    function fieldTypeInSchema(schemaId, fieldKey) {
        var f = schemaFields(schemaId).filter(function (x) { return x.JsonPath === fieldKey; })[0];
        return f ? f.Type : 'String';
    }

    // ===================================================================
    // Palette construction — schema-gated field list, operators unchanged.
    // ===================================================================
    function populatePalette(view) {
        var schemaId = view.querySelector('#rcsSchemaSelect').value;

        var fieldContainer = view.querySelector('#rcsFieldChips');
        fieldContainer.innerHTML = '';
        schemaFields(schemaId).forEach(function (f) {
            fieldContainer.appendChild(makeFieldChip(f.JsonPath, f.DisplayName, f.Type));
        });

        var opContainer = view.querySelector('#rcsOperatorChips');
        opContainer.innerHTML = '';
        ALL_OPERATORS.forEach(function (o) {
            opContainer.appendChild(makeOperatorChip(o));
        });
    }

    function makeFieldChip(fieldPath, displayName, type) {
        var chip = document.createElement('span');
        chip.className = 'rcsChip rcsChip-field';
        chip.innerText = displayName || fieldPath;
        chip.dataset.fieldPath = fieldPath;
        chip.dataset.fieldType = type;

        var tag = document.createElement('span');
        tag.className = 'rcsFieldTypeTag';
        tag.innerText = '(' + type + ')';
        chip.appendChild(tag);

        makeDraggableSource(chip, 'field', function () {
            return JSON.stringify({ path: fieldPath, type: type, display: displayName || fieldPath });
        });
        return chip;
    }

    function makeOperatorChip(operator) {
        var chip = document.createElement('span');
        chip.className = 'rcsChip rcsChip-operator';
        chip.innerText = operator;
        makeDraggableSource(chip, 'operator', operator);
        return chip;
    }

    function wireStaticPaletteChips(view) {
        view.querySelectorAll('#rcsPalette .rcsChip[data-chip-kind]').forEach(function (chip) {
            var kind = chip.dataset.chipKind;
            var value = chip.dataset.chipValue || '';
            makeDraggableSource(chip, kind, value);
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

        registerDropTarget(badge, ['not'], function () {
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

        registerDropTarget(badge, ['logic'], function (value) {
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
            input.type = (type === 'Number') ? 'number' : 'text';
            input.placeholder = type === 'List' ? 'value to match in list…' : 'value…';
            input.value = initialValue || '';

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
    function buildConditionNode(data, onChange) {
        data = data || {};

        var node = document.createElement('div');
        node.className = 'rcsCondition';
        node.dataset.kind = 'Condition';

        var handle = document.createElement('span');
        handle.className = 'rcsHandle';
        handle.innerHTML = '&#9776;';
        makeDraggableSource(handle, 'reorder', '', function () { return node; });

        var fieldSlot = document.createElement('span');
        fieldSlot.className = 'rcsSlot rcsSlot-field';
        fieldSlot.dataset.slotType = 'field';
        fieldSlot.dataset.value = data.Field || '';
        fieldSlot.dataset.fieldType = 'String';
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
                if (operatorSlot.dataset.value && !operatorAllowedForField(type, operatorSlot.dataset.value)) {
                    operatorSlot.dataset.value = '';
                    operatorSlot.innerText = 'op…';
                    operatorSlot.classList.remove('rcsSlot-filled');
                }
            }
        }

        registerDropTarget(fieldSlot, ['field'], function (rawValue) {
            var parsed;
            try { parsed = JSON.parse(rawValue); } catch (e) { parsed = { path: rawValue, type: 'String', display: rawValue }; }

            fieldSlot.dataset.value = parsed.path;
            fieldSlot.dataset.fieldType = parsed.type;
            fieldSlot.innerText = parsed.display;
            fieldSlot.classList.add('rcsSlot-filled');
            refreshOperatorLock();
            rebuildValueWidget();
            if (onChange) onChange();
        });

        registerDropTarget(operatorSlot, ['operator'], function (value) {
            if (fieldSlot.dataset.value && !operatorAllowedForField(currentType(), value)) {
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
    function buildGroupNode(data, isRoot, onChange) {
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
            makeDraggableSource(handle, 'reorder', '', function () { return group; });
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
                childrenContainer.appendChild(buildGroupNode(child, false, onChange));
            } else {
                childrenContainer.appendChild(buildConditionNode(child, onChange));
            }
        });
        refreshEmptyHint();

        registerDropTarget(childrenContainer, ['reorder'], function (value, reorderEl, clientY) {
            if (!reorderEl) return;
            var insertBeforeEl = findInsertionPoint(childrenContainer, clientY);
            childrenContainer.insertBefore(reorderEl, insertBeforeEl);
            refreshEmptyHint();
            if (onChange) onChange();
        });

        registerDropTarget(childrenContainer, ['new-condition'], function (value, reorderEl, clientY) {
            var insertBeforeEl = findInsertionPoint(childrenContainer, clientY);
            childrenContainer.insertBefore(buildConditionNode({}, onChange), insertBeforeEl);
            refreshEmptyHint();
            if (onChange) onChange();
        });

        registerDropTarget(childrenContainer, ['new-group'], function (value, reorderEl, clientY) {
            var insertBeforeEl = findInsertionPoint(childrenContainer, clientY);
            childrenContainer.insertBefore(buildGroupNode({}, false, onChange), insertBeforeEl);
            refreshEmptyHint();
            if (onChange) onChange();
        });

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

    function scheduleAutoPreview(view) {
        if (autoPreviewTimer) clearTimeout(autoPreviewTimer);
        autoPreviewTimer = setTimeout(function () { runAutoPreview(view); }, 450);
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
        var jsonEl = view.querySelector('#rcsRuleJson');

        var invalid = findInvalidConditionElements(rootGroupEl);
        var emptyGroups = findEmptyGroupElements(rootGroupEl);
        highlightEmptyGroups(rootGroupEl, emptyGroups);

        if (invalid.length > 0) {
            statusEl.innerText = 'Expression incomplete (' + invalid.length + ' condition(s) missing a field, operator, or value) — preview will resume once it\'s valid.';
            resultEl.innerHTML = '';
            if (jsonEl) jsonEl.textContent = '';
            return;
        }

        var candidate = readGroupFromDom(rootGroupEl);
        if (jsonEl) jsonEl.textContent = JSON.stringify(candidate, null, 2);

        var warningText = '';
        if (emptyGroups.length > 0) {
            warningText = ' ⚠ ' + emptyGroups.length + ' empty group(s) outlined in amber — an empty AND-group matches EVERY item by default, which may widen this rule further than intended.';
        }

        var connectionId = view.querySelector('#rcsConnectionSelect').value;
        var schemaId = view.querySelector('#rcsSchemaSelect').value;

        statusEl.innerText = 'Checking…' + warningText;

        ApiClient.ajax({
            type: 'POST',
            url: ApiClient.getUrl('ChannelSync/RulePreview'),
            data: JSON.stringify({ ConnectionId: connectionId, EndpointSchemaId: schemaId, Rule: candidate }),
            contentType: 'application/json',
            dataType: 'json'
        }).then(function (result) {
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
            statusEl.innerText = 'Preview request failed — see server log.' + warningText;
            resultEl.innerHTML = '';
        });
    }

    // ===================================================================
    // Rule-set management
    // ===================================================================
    function emptyRoot() {
        return { Kind: 'Group', LogicOperator: 'And', Not: false, Children: [] };
    }

    function ruleSetsForCurrentSchema(view) {
        var schemaId = view.querySelector('#rcsSchemaSelect').value;
        return ruleSetsFile.RuleSets
            .map(function (rs, idx) { return { rs: rs, idx: idx }; })
            .filter(function (x) { return x.rs.EndpointSchemaId === schemaId; });
    }

    function captureCurrentEditsIntoFile(view) {
        if (currentRuleSetIndex < 0) return;
        var current = ruleSetsFile.RuleSets[currentRuleSetIndex];
        if (!current) return;
        if (current.IsBuiltIn) return; // read-only — never overwrite from the DOM
        var rootGroupEl = view.querySelector('#conditionsList > .rcsGroupRoot');
        if (!rootGroupEl) return;
        current.Root = readGroupFromDom(rootGroupEl);
    }

    function renderRuleSetSelect(view) {
        var select = view.querySelector('#rcsRuleSetSelect');
        select.innerHTML = '';

        var matching = ruleSetsForCurrentSchema(view);

        matching.forEach(function (x) {
            var opt = document.createElement('option');
            opt.value = String(x.idx);
            opt.innerText = (x.rs.Name || '(unnamed)') + (x.rs.IsBuiltIn ? ' 🔒' : '');
            if (x.idx === currentRuleSetIndex) opt.selected = true;
            select.appendChild(opt);
        });

        if (matching.length === 0) {
            currentRuleSetIndex = -1;
        } else if (!matching.some(function (x) { return x.idx === currentRuleSetIndex; })) {
            currentRuleSetIndex = matching[0].idx;
            select.value = String(currentRuleSetIndex);
        }
    }

    function renderCanvasForCurrentIndex(view) {
        var list = view.querySelector('#conditionsList');
        list.innerHTML = '';
        resetDragEngine();
        populatePalette(view);
        wireStaticPaletteChips(view);

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
            lockNotice.innerText = '🔒 This is a built-in rule set and is read-only. Use Duplicate above to make an editable copy.';
            list.appendChild(lockNotice);
        }

        var onChange = function () { scheduleAutoPreview(view); };
        list.appendChild(buildGroupNode(ruleSet.Root || emptyRoot(), true, onChange));

        scheduleAutoPreview(view);
    }

    function switchRuleSetTo(view, idx) {
        captureCurrentEditsIntoFile(view);
        currentRuleSetIndex = idx;
        renderRuleSetSelect(view);
        renderCanvasForCurrentIndex(view);
    }

    function onSchemaChanged(view) {
        captureCurrentEditsIntoFile(view);
        var matching = ruleSetsForCurrentSchema(view);
        currentRuleSetIndex = matching.length ? matching[0].idx : -1;
        renderRuleSetSelect(view);
        renderCanvasForCurrentIndex(view);
    }

    function rebuildRuleSetsSchemaOptions(view) {
        var connSel = view.querySelector('#rcsConnectionSelect');
        var schemaSel = view.querySelector('#rcsSchemaSelect');
        var allowed = schemasForSystemType(connectionSystemType(connSel.value));
        var currentVal = schemaSel.value;

        schemaSel.innerHTML = '';
        allowed.forEach(function (s) {
            var o = document.createElement('option');
            o.value = s.Id;
            o.innerText = s.DisplayName;
            if (s.Id === currentVal) o.selected = true;
            schemaSel.appendChild(o);
        });
    }

    function renderConnectionAndSchemaSelects(view) {
        var connSel = view.querySelector('#rcsConnectionSelect');
        connSel.innerHTML = '';
        connections.forEach(function (c) {
            var o = document.createElement('option');
            o.value = c.Id;
            o.innerText = connectionBadgeGlyph(c) + ' ' + (c.DisplayLabel || '(unnamed connection)');
            connSel.appendChild(o);
        });

        rebuildRuleSetsSchemaOptions(view);

        connSel.addEventListener('change', function () {
            rebuildRuleSetsSchemaOptions(view);
            onSchemaChanged(view);
        });

        var schemaSel = view.querySelector('#rcsSchemaSelect');
        schemaSel.addEventListener('change', function () { onSchemaChanged(view); });
    }

    function saveRuleSets(view) {
        var rootGroupEl = view.querySelector('#conditionsList > .rcsGroupRoot');

        if (!rootGroupEl) {
            Dashboard.alert('No rule set is selected to save. Create one with "+ New" first.');
            return;
        }

        var invalidNodes = findInvalidConditionElements(rootGroupEl);
        highlightInvalid(rootGroupEl, invalidNodes);

        if (invalidNodes.length > 0) {
            Dashboard.alert('Some conditions are incomplete (missing field, operator, or value) — they\'re outlined in red. Fill them in before saving.');
            invalidNodes[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }

        var emptyGroups = findEmptyGroupElements(rootGroupEl);
        highlightEmptyGroups(rootGroupEl, emptyGroups);
        if (emptyGroups.length > 0) {
            var proceed = confirm(
                emptyGroups.length + ' group(s) are empty (outlined in amber). An empty AND-group matches EVERY item by default — ' +
                'this rule may be wider than intended. Save anyway?'
            );
            if (!proceed) return;
        }

        captureCurrentEditsIntoFile(view);

        ApiClient.ajax({
            type: 'POST',
            url: ApiClient.getUrl('ChannelSync/RuleSets'),
            data: JSON.stringify({ Payload: ruleSetsFile }),
            contentType: 'application/json',
            dataType: 'json'
        }).then(function (result) {
            var affected = (result && result.AffectedFolderCount) || 0;
            if (affected > 0) {
                Dashboard.alert(
                    'Saved ' + ruleSetsFile.RuleSets.length + ' rule set(s). Re-syncing ' + affected +
                    ' folder(s) that use a changed rule set now — check the server log for fetch activity.');
            } else {
                Dashboard.alert(
                    'Saved ' + ruleSetsFile.RuleSets.length + ' rule set(s). Nothing was re-synced: no folder in the ' +
                    'Folder Tree tab currently has a Fetch using this rule set yet, so there is nothing to fetch. ' +
                    'Add a Fetch on the Folder Tree tab referencing it, then Save Folder Tree, to actually run it.');
            }
        }).catch(function () {
            Dashboard.alert('Save failed — see server log.');
        });
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
            ruleSetsFile.RuleSets.push({ Id: newId(), Name: name.trim(), EndpointSchemaId: schemaId, IsBuiltIn: false, Root: emptyRoot() });
            switchRuleSetTo(view, ruleSetsFile.RuleSets.length - 1);
        });

        view.querySelector('#rcsDuplicateRuleSet').addEventListener('click', function () {
            captureCurrentEditsIntoFile(view);
            var source = ruleSetsFile.RuleSets[currentRuleSetIndex];
            if (currentRuleSetIndex < 0 || !source) { Dashboard.alert('No rule set selected to duplicate.'); return; }
            var defaultName = (source.Name || '').replace(/^\[Built-in\]\s*/, '') + ' copy';
            var name = prompt('Name for the duplicated rule set:', defaultName);
            if (!name) return;
            var clone = JSON.parse(JSON.stringify(source));
            clone.Id = newId();
            clone.Name = name.trim();
            clone.IsBuiltIn = false;
            ruleSetsFile.RuleSets.push(clone);
            switchRuleSetTo(view, ruleSetsFile.RuleSets.length - 1);
        });

        view.querySelector('#rcsRenameRuleSet').addEventListener('click', function () {
            var current = ruleSetsFile.RuleSets[currentRuleSetIndex];
            if (currentRuleSetIndex < 0 || !current) { Dashboard.alert('No rule set selected to rename.'); return; }
            if (current.IsBuiltIn) { Dashboard.alert('Built-in rule sets are read-only. Use Duplicate to make an editable copy.'); return; }
            var name = prompt('Rename rule set:', current.Name);
            if (!name) return;
            current.Name = name.trim();
            renderRuleSetSelect(view);
        });

        view.querySelector('#rcsDeleteRuleSet').addEventListener('click', function () {
            var current = ruleSetsFile.RuleSets[currentRuleSetIndex];
            if (currentRuleSetIndex < 0 || !current) {
                Dashboard.alert('No rule set selected to delete.');
                return;
            }
            if (current.IsBuiltIn) { Dashboard.alert('Built-in rule sets are read-only and cannot be deleted.'); return; }
            if (!confirm('Delete rule set "' + current.Name + '"? Any folder-tree fetch still referencing it will be blocked from saving until reassigned.')) {
                return;
            }
            ruleSetsFile.RuleSets.splice(currentRuleSetIndex, 1);
            var remaining = ruleSetsForCurrentSchema(view);
            switchRuleSetTo(view, remaining.length ? remaining[0].idx : -1);
        });
    }

    // ===================================================================
    // Folder tree tab
    // ===================================================================
    var currentTree = null;

    function connectionLabel(id) {
        var c = findConnection(id);
        return c ? c.DisplayLabel : '(unknown connection)';
    }

    function schemaLabel(id) {
        var s = schemas.filter(function (x) { return x.Id === id; })[0];
        return s ? s.DisplayName : '(unknown endpoint)';
    }

    function ruleSetLabel(id) {
        var rs = ruleSetsFile.RuleSets.filter(function (x) { return x.Id === id; })[0];
        return rs ? rs.Name : '(unknown rule set)';
    }

    function openAddFetchPanel(container, folderNode, onChange) {
        container.innerHTML = '';
        openFetchFieldForm(container, folderNode, null, onChange);
    }

    function openFetchFieldForm(container, folderNode, existingFetch, onChange) {
        container.innerHTML = '';

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

        var connSelect = makeSelectField(
            'Connection',
            connections.map(function (c) { return { value: c.Id, text: connectionBadgeGlyph(c) + ' ' + c.DisplayLabel }; }),
            existingFetch ? existingFetch.ConnectionId : (connections[0] && connections[0].Id));

        var schemaSelect = makeSelectField(
            'Endpoint',
            schemasForSystemType(connectionSystemType(connSelect.value)).map(function (s) { return { value: s.Id, text: s.DisplayName }; }),
            existingFetch ? existingFetch.EndpointSchemaId : (schemas[0] && schemas[0].Id));

        var ruleSetSelect;

        function rebuildRuleSetOptions() {
            var schemaId = schemaSelect.value;
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
                o.innerText = '(no rule sets for this endpoint — create one on the Rule Sets tab)';
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
            var allowed = schemasForSystemType(connectionSystemType(connSelect.value));
            var currentVal = schemaSelect.value;
            schemaSelect.innerHTML = '';
            allowed.forEach(function (s) {
                var o = document.createElement('option');
                o.value = s.Id;
                o.innerText = s.DisplayName;
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
                Dashboard.alert('This endpoint has no rule sets yet — create one on the Rule Sets tab first.');
                return;
            }

            if (existingFetch) {
                existingFetch.DisplayLabel = labelInput.value;
                existingFetch.ConnectionId = connSelect.value;
                existingFetch.EndpointSchemaId = schemaSelect.value;
                existingFetch.RuleSetId = ruleSetSelect.value;
            } else {
                folderNode.Fetches.push({
                    Id: newId(),
                    Enabled: true,
                    DisplayLabel: labelInput.value,
                    ConnectionId: connSelect.value,
                    EndpointSchemaId: schemaSelect.value,
                    RuleSetId: ruleSetSelect.value
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

    // References missing entirely (deleted after the fact) — hard-fail
    // check, client-side mirror of the server's ValidateFetchReferences,
    // used to show a live "⚠ missing" badge on each fetch row without
    // waiting for a save round-trip.
    function fetchMissingReferences(fetch) {
        var problems = [];
        if (!findConnection(fetch.ConnectionId)) problems.push('connection');
        if (!schemas.some(function (s) { return s.Id === fetch.EndpointSchemaId; })) problems.push('endpoint');
        if (!ruleSetsFile.RuleSets.some(function (rs) { return rs.Id === fetch.RuleSetId; })) problems.push('rule set');
        return problems;
    }

    function buildFetchRow(fetch, folderNode, onChange) {
        var row = document.createElement('div');
        row.className = 'ftFetch' + (fetch.Enabled ? '' : ' ftFetchDisabled');

        var badge = document.createElement('span');
        badge.className = 'ftFetchProviderBadge';
        badge.innerText = schemaLabel(fetch.EndpointSchemaId);
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
            ' — ' + connectionLabel(fetch.ConnectionId) +
            ' — ' + ruleSetLabel(fetch.RuleSetId);
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
            if (connections.length === 0 || schemas.length === 0) {
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

    function renderTree(view) {
        var container = view.querySelector('#ftRoot');
        container.innerHTML = '';
        container.appendChild(buildFolderNode(currentTree.RootFolder, null, function () { renderTree(view); }));
    }

    function saveFolderTree(view) {
        var statusEl = view.querySelector('#ftStatus');
        statusEl.innerText = 'Saving…';

        view.querySelectorAll('.ftFetch').forEach(function (el) { el.classList.remove('ftFetchInvalid'); });

        ApiClient.ajax({
            type: 'POST',
            url: ApiClient.getUrl('ChannelSync/FolderTree'),
            data: JSON.stringify({ RootFolder: currentTree.RootFolder }),
            contentType: 'application/json',
            dataType: 'json'
        }).then(function (result) {
            if (!result.Success) {
                statusEl.innerHTML = 'Not saved — ' + result.Errors.length + ' fetch(es) reference something that no longer exists:<br>' +
                    result.Errors.map(function (e) { return '⚠ ' + e.Message; }).join('<br>');

                result.Errors.forEach(function (e) {
                    var wrapper = view.querySelector('[data-fetch-id="' + e.FetchId + '"]');
                    if (wrapper) {
                        var row = wrapper.querySelector('.ftFetch');
                        if (row) row.classList.add('ftFetchInvalid');
                    }
                });

                var firstBad = view.querySelector('.ftFetchInvalid');
                if (firstBad) firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            }

            statusEl.innerText = 'Saved. Syncing now…';
        }).catch(function () {
            statusEl.innerText = 'Save failed — see server log.';
        });
    }

    // ===================================================================
    // Connections tab
    // ===================================================================
    var KNOWN_SYSTEM_TYPES = ['radarr', 'sonarr'];

    function renderConnectionsTab(view) {
        var list = view.querySelector('#connList');
        list.innerHTML = '';

        connections.forEach(function (c, idx) {
            var row = document.createElement('div');
            row.className = 'connRow';

            var labelInput = document.createElement('input');
            labelInput.style.width = '10em';
            labelInput.value = c.DisplayLabel;
            labelInput.placeholder = 'Label';
            labelInput.addEventListener('input', function (e) { c.DisplayLabel = e.target.value; });

            var urlInput = document.createElement('input');
            urlInput.style.width = '16em';
            urlInput.value = c.BaseUrl;
            urlInput.placeholder = 'http://127.0.0.1:7878';
            urlInput.addEventListener('input', function (e) { c.BaseUrl = e.target.value; });

            var typeSelect = document.createElement('select');
            KNOWN_SYSTEM_TYPES.forEach(function (t) {
                var o = document.createElement('option');
                o.value = t;
                o.innerText = t;
                if (c.SystemType === t) o.selected = true;
                typeSelect.appendChild(o);
            });
            if (!c.SystemType) {
                c.SystemType = KNOWN_SYSTEM_TYPES[0];
                typeSelect.value = c.SystemType;
            }
            typeSelect.addEventListener('change', function (e) { c.SystemType = e.target.value; });

            var keyWrap = document.createElement('span');
            keyWrap.style.display = 'inline-flex';
            keyWrap.style.alignItems = 'center';
            keyWrap.style.gap = '0.3em';

            var keyInput = document.createElement('input');
            keyInput.type = 'password';
            keyInput.style.width = '12em';
            keyInput.value = c.ApiKey;
            keyInput.placeholder = 'API key';

            var keyLenBadge = document.createElement('span');
            keyLenBadge.style.fontSize = '0.75em';
            keyLenBadge.style.opacity = '0.6';
            keyLenBadge.style.minWidth = '3em';

            function refreshKeyLen() {
                keyLenBadge.innerText = '[' + c.ApiKey.length + ' chars]';
            }
            refreshKeyLen();

            keyInput.addEventListener('input', function (e) {
                c.ApiKey = e.target.value;
                refreshKeyLen();
            });

            var toggleBtn = document.createElement('span');
            toggleBtn.className = 'ftIconBtn';
            toggleBtn.style.cursor = 'pointer';
            toggleBtn.title = 'Show/hide API key';
            toggleBtn.innerText = '👁';
            toggleBtn.addEventListener('click', function () {
                keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
            });

            keyWrap.appendChild(keyInput);
            keyWrap.appendChild(toggleBtn);
            keyWrap.appendChild(keyLenBadge);

            var connBadge = document.createElement('span');
            connBadge.className = 'connBadge';
            connBadge.innerText = connectionBadgeText(c);

            var removeBtn = document.createElement('span');
            removeBtn.className = 'ftIconBtn';
            removeBtn.style.cursor = 'pointer';
            removeBtn.innerText = '✕';
            removeBtn.title = 'Remove connection';
            removeBtn.addEventListener('click', function () {
                if (!confirm('Remove connection "' + c.DisplayLabel + '"? Any fetch referencing it will be blocked from saving until reassigned.')) return;
                connections.splice(idx, 1);
                renderConnectionsTab(view);
                renderConnectionAndSchemaSelects(view);
            });

            var testBtn = document.createElement('span');
            testBtn.className = 'ftIconBtn';
            testBtn.style.cursor = 'pointer';
            testBtn.innerText = '🔌 Test';
            var testStatus = document.createElement('span');
            testStatus.style.fontSize = '0.8em';
            testStatus.style.opacity = '0.7';

            // Tests the LIVE field values on screen — works before Save as
            // well as after, and persists LastTestSucceeded/LastTestedUtc
            // onto the connection if it already exists on disk.
            testBtn.addEventListener('click', function () {
    if (testBtn.dataset.busy === 'true') return;
    testBtn.dataset.busy = 'true';
    testStatus.innerText = 'Testing…';

                var matching = schemasForSystemType(c.SystemType);
                var schemaId = matching.length ? matching[0].Id : (schemas.length ? schemas[0].Id : '');

                if (!schemaId) {
                    testStatus.innerText = '❌ No endpoint schema available for system type "' + c.SystemType + '".';
                    return;
                }

                ApiClient.ajax({
                    type: 'POST',
                    url: ApiClient.getUrl('ChannelSync/TestConnection'),
                    data: JSON.stringify({
                        ConnectionId: c.Id,
                        BaseUrl: c.BaseUrl,
                        ApiKey: c.ApiKey,
                        SystemType: c.SystemType,
                        EndpointSchemaId: schemaId
                    }),
                    contentType: 'application/json',
                    dataType: 'json'
                }).then(function (result) {
                    testBtn.dataset.busy = 'false';
                    testStatus.innerText = result.Success ? '✅ Reachable' : '❌ ' + result.Message;
                    c.LastTestSucceeded = result.Success;
                    c.LastTestedUtc = new Date().toISOString();
                    connBadge.innerText = connectionBadgeText(c);
                }).catch(function () {
                    testBtn.dataset.busy = 'false';
                    testStatus.innerText = '❌ Test request failed.';
                });
            });

            var statusWrap = document.createElement('span');
            statusWrap.className = 'connStatusWrap';
            statusWrap.appendChild(testStatus);
            statusWrap.appendChild(connBadge);

            row.appendChild(labelInput);
            row.appendChild(urlInput);
            row.appendChild(typeSelect);
            row.appendChild(keyWrap);
            row.appendChild(testBtn);
            row.appendChild(removeBtn);
            row.appendChild(statusWrap);
            list.appendChild(row);
        });
    }

    function saveConnections(view) {
        var statusEl = view.querySelector('#connStatus');
        statusEl.innerText = 'Saving…';

        ApiClient.ajax({
            type: 'POST',
            url: ApiClient.getUrl('ChannelSync/Connections'),
            data: JSON.stringify({ Payload: { Connections: connections } }),
            contentType: 'application/json',
            dataType: 'json'
        }).then(function () {
            statusEl.innerText = 'Saved. Any folders using a changed connection are being re-synced now.';
            renderConnectionAndSchemaSelects(view);
            setTimeout(function () {
                // 'Re-synced now' is present-tense and stops being true within
                // seconds — an un-cleared banner would read as still-ongoing
                // indefinitely, same issue as the earlier stale test-status bug.
                if (statusEl.innerText === 'Saved. Any folders using a changed connection are being re-synced now.') {
                    statusEl.innerText = '';
                }
            }, 5000);
        }).catch(function () {
            statusEl.innerText = 'Save failed — see server log.';
        });
    }

    // ===================================================================
    // Tabs
    // ===================================================================
    function wireTabs(view) {
        var buttons = view.querySelectorAll('.emby-tab-button');
        buttons.forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                buttons.forEach(function (b) { b.classList.remove('emby-tab-button-active'); });
                btn.classList.add('emby-tab-button-active');

                view.querySelectorAll('.mcsTab').forEach(function (t) { t.classList.remove('mcsTabVisible'); });
                view.querySelector('#tab-' + btn.dataset.tab).classList.add('mcsTabVisible');
            });
        });

        buttons[0].classList.add('emby-tab-button-active');
        view.querySelector('#tab-' + buttons[0].dataset.tab).classList.add('mcsTabVisible');
    }

    // ===================================================================
    // Load everything
    // ===================================================================
    function loadAll(view) {
        Promise.all([
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/Connections'), dataType: 'json' }),
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/EndpointSchemas'), dataType: 'json' }),
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/RuleSets'), dataType: 'json' }),
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/FolderTree'), dataType: 'json' })
        ]).then(function (results) {
            connections = (results[0] && results[0].Connections) || [];
            schemas = (results[1] && results[1].Schemas) || [];
            ruleSetsFile = (results[2] && results[2].RuleSets) ? results[2] : { RuleSets: [] };
            currentTree = results[3];

            renderConnectionAndSchemaSelects(view);

            var matching = ruleSetsForCurrentSchema(view);
            currentRuleSetIndex = matching.length ? matching[0].idx : -1;
            renderRuleSetSelect(view);
            renderCanvasForCurrentIndex(view);

            renderConnectionsTab(view);
            renderTree(view);
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
            wireRuleSetToolbar(view);
            loadAll(view);

            view.querySelector('#btnSave').addEventListener('click', function () { saveRuleSets(view); });
            view.querySelector('#ftSaveBtn').addEventListener('click', function () { saveFolderTree(view); });

            view.querySelector('#connAddBtn').addEventListener('click', function () {
                connections.push({ Id: newId(), DisplayLabel: 'New Connection', BaseUrl: '', ApiKey: '', SystemType: KNOWN_SYSTEM_TYPES[0], LastTestSucceeded: null, LastTestedUtc: null });
                renderConnectionsTab(view);
            });
            view.querySelector('#connSaveBtn').addEventListener('click', function () { saveConnections(view); });

            var jsonToggle = view.querySelector('#rcsToggleJson');
            var jsonPanel = view.querySelector('#rcsRuleJson');
            jsonToggle.addEventListener('click', function (e) {
                e.preventDefault();
                var showing = jsonPanel.style.display !== 'none';
                jsonPanel.style.display = showing ? 'none' : 'block';
                jsonToggle.innerText = showing ? 'Show rule JSON (for debugging)' : 'Hide rule JSON';
            });
        });
    };
});