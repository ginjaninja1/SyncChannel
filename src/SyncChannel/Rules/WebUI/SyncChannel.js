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
        Date:   ['LT', 'LTE', 'GT', 'GTE', 'EQ', 'NEQ'],
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

    // Clipboard.writeText is unavailable on many Emby installs because the
    // web UI is served over plain HTTP. The older selection-based API still
    // works there when called directly from the user's click.
    function copyTextToClipboard(text) {
        function legacyCopy() {
            return new Promise(function (resolve, reject) {
                var textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.setAttribute('readonly', '');
                textarea.style.position = 'fixed';
                textarea.style.left = '-9999px';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                var copied = false;
                try { copied = document.execCommand('copy'); } catch (e) { copied = false; }
                document.body.removeChild(textarea);
                if (copied) resolve();
                else reject(new Error('Clipboard copy was rejected by the browser.'));
            });
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).catch(function () {
                return legacyCopy();
            });
        }
        return legacyCopy();
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
    var dragScrollContainer = null;
    var dragScrollVelocity = 0;
    var dragScrollFrame = null;

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
            if (e.target.closest && e.target.closest('input,select,textarea,button,a,.esMapSegRemove')) return;
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
        ghost.innerText = (sourceEl && sourceEl.dataset.dragLabel) ||
            value || (sourceEl ? sourceEl.innerText : kind);
        document.body.appendChild(ghost);

        activeDrag = { kind: kind, value: value, reorderElement: reorderElement, ghostEl: ghost };
        dragScrollContainer = findDragScrollContainer(sourceEl);
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

    function findDragScrollContainer(sourceEl) {
        var el = sourceEl && sourceEl.parentElement;
        while (el && el !== document.body) {
            var style = window.getComputedStyle(el);
            if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) return el;
            el = el.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    }

    function updateDragEdgeScroll(clientY) {
        if (!dragScrollContainer) return;
        var isDocument = dragScrollContainer === document.scrollingElement ||
            dragScrollContainer === document.documentElement ||
            dragScrollContainer === document.body;
        var rect = isDocument
            ? { top: 0, bottom: window.innerHeight }
            : dragScrollContainer.getBoundingClientRect();
        var edge = Math.min(90, Math.max(50, (rect.bottom - rect.top) * 0.12));

        if (clientY < rect.top + edge) {
            dragScrollVelocity = -Math.ceil(18 * (rect.top + edge - clientY) / edge);
        } else if (clientY > rect.bottom - edge) {
            dragScrollVelocity = Math.ceil(18 * (clientY - (rect.bottom - edge)) / edge);
        } else {
            dragScrollVelocity = 0;
        }

        if (dragScrollVelocity && !dragScrollFrame) {
            dragScrollFrame = requestAnimationFrame(runDragEdgeScroll);
        }
    }

    function runDragEdgeScroll() {
        dragScrollFrame = null;
        if (!activeDrag || !dragScrollContainer || !dragScrollVelocity) return;
        var isDocument = dragScrollContainer === document.scrollingElement ||
            dragScrollContainer === document.documentElement ||
            dragScrollContainer === document.body;
        if (isDocument) window.scrollBy(0, dragScrollVelocity);
        else dragScrollContainer.scrollTop += dragScrollVelocity;
        dragScrollFrame = requestAnimationFrame(runDragEdgeScroll);
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
        indicator.style.height = '3px';
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
        updateDragEdgeScroll(e.clientY);

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
        } else if (target && target.el.classList.contains('esMapValue') &&
            (activeDrag.kind === 'mapseg' || activeDrag.kind === 'field' ||
                activeDrag.kind === 'mapmapping' ||
                STATIC_MAPPING_DRAG_KINDS.indexOf(activeDrag.kind) !== -1)) {
            showMappingInsertionIndicator(target.el, e.clientX, activeDrag.reorderElement, e.clientY);
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
        dragScrollVelocity = 0;
        dragScrollContainer = null;
        if (dragScrollFrame) {
            cancelAnimationFrame(dragScrollFrame);
            dragScrollFrame = null;
        }
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
    var connections = [];          // [{ Id, DisplayLabel, BaseUrl, ApiKey, SystemType, ApiKeyParamName, LastTestSucceeded, LastTestedUtc }]
    var connectionsSavedSnapshot = null;
    var connectionsSavedFullSnapshot = null;
    var pendingConnectionRemovals = {};
    var connectionSchemaOrder = {};
    var connectionRuleOrder = {};
    var schemas = [];               // [{ Id, DisplayName, ConnectionId, Fields: [{Key/JsonPath, DisplayName, Type}] }]
    var ruleSetsFile = null;        // { RuleSets: [{ Id, Name, EndpointSchemaId, IsBuiltIn, Root }] }
    var currentRuleSetIndex = -1;   // index into ruleSetsFile.RuleSets bound to the canvas
    var ruleSetsSavedSnapshot = null;
    var ruleSetsHaveUnsavedChanges = false;
    var ruleSetDomEditedById = {};
    var builtInRuleDraftRootsById = {};
    var activePageView = null;
    var persistedConnectionIds = {};
    var schemaOperationChangedRuleSets = false;

    function editableConnectionsJson(items) {
        return JSON.stringify((items || []).map(function (connection) {
            return {
                Id: connection.Id,
                DisplayLabel: connection.DisplayLabel,
                BaseUrl: connection.BaseUrl,
                BaseUrlIsUserEntered: !!connection.BaseUrlIsUserEntered,
                ApiKey: connection.ApiKey,
                SystemType: connection.SystemType,
                ApiKeyParamName: connection.ApiKeyParamName
            };
        }));
    }

    function snapshotConnectionsSaved() {
        connectionsSavedSnapshot = editableConnectionsJson(connections);
        connectionsSavedFullSnapshot = JSON.stringify(connections);
        pendingConnectionRemovals = {};
        connectionSchemaOrder = {};
        schemas.forEach(function (schema, index) { connectionSchemaOrder[schema.Id] = index; });
        connectionRuleOrder = {};
        (ruleSetsFile.RuleSets || []).forEach(function (ruleSet, index) { connectionRuleOrder[ruleSet.Id] = index; });
    }

    function refreshConnectionsDirtyState(view) {
        var warning = view.querySelector('#connDirtyWarning');
        var discard = view.querySelector('#connDiscardBtn');
        if (!warning) return;
        var dirty = connectionsSavedSnapshot !== null &&
            editableConnectionsJson(connections) !== connectionsSavedSnapshot;
        warning.innerText = dirty ? 'Unsaved changes' : '';
        if (discard) discard.disabled = !dirty;
    }

    function discardConnectionChanges(view) {
        if (connectionsSavedFullSnapshot === null) return;
        var latestTestState = {};
        connections.forEach(function (connection) {
            latestTestState[connection.Id] = {
                LastTestSucceeded: connection.LastTestSucceeded,
                LastTestedUtc: connection.LastTestedUtc
            };
        });
        connections = JSON.parse(connectionsSavedFullSnapshot);
        connections.forEach(function (connection) {
            var test = latestTestState[connection.Id];
            if (test) {
                connection.LastTestSucceeded = test.LastTestSucceeded;
                connection.LastTestedUtc = test.LastTestedUtc;
            }
        });
        Object.keys(pendingConnectionRemovals).forEach(function (connectionId) {
            var removed = pendingConnectionRemovals[connectionId];
            (removed.Schemas || []).forEach(function (schema) {
                if (!schemas.some(function (existing) { return existing.Id === schema.Id; })) schemas.push(schema);
            });
            (removed.RuleSets || []).forEach(function (ruleSet) {
                if (!ruleSetsFile.RuleSets.some(function (existing) { return existing.Id === ruleSet.Id; })) {
                    ruleSetsFile.RuleSets.push(ruleSet);
                }
            });
        });
        schemas.sort(function (a, b) {
            var ai = connectionSchemaOrder.hasOwnProperty(a.Id) ? connectionSchemaOrder[a.Id] : Number.MAX_SAFE_INTEGER;
            var bi = connectionSchemaOrder.hasOwnProperty(b.Id) ? connectionSchemaOrder[b.Id] : Number.MAX_SAFE_INTEGER;
            return ai - bi;
        });
        ruleSetsFile.RuleSets.sort(function (a, b) {
            var ai = connectionRuleOrder.hasOwnProperty(a.Id) ? connectionRuleOrder[a.Id] : Number.MAX_SAFE_INTEGER;
            var bi = connectionRuleOrder.hasOwnProperty(b.Id) ? connectionRuleOrder[b.Id] : Number.MAX_SAFE_INTEGER;
            return ai - bi;
        });
        pendingConnectionRemovals = {};
        renderConnectionsTab(view);
        renderSchemaConnectionSelect(view);
        renderSchemaForm(view);
        renderConnectionAndSchemaSelects(view);
        renderRuleSetSelect(view);
        renderCanvasForCurrentIndex(view);
        view.querySelector('#connStatus').innerText = '';
        refreshConnectionsDirtyState(view);
    }

    // ---- Strict ownership helpers ----
    function schemasForConnection(connectionId) {
        if (!connectionId) return [];
        return schemas.filter(function (s) { return s.ConnectionId === connectionId; });
    }

    function schemaOptionLabel(schema) {
        return (schema.IsBuiltIn ? '[Built-in] ' : '') +
            (schema.DisplayName || '(unnamed)') + (schema.IsBuiltIn ? ' 🔒' : '');
    }

    function findConnection(connectionId) {
        return connections.filter(function (x) { return x.Id === connectionId; })[0];
    }

    // schemaFields()/fieldTypeInSchema() removed — they read schema.Fields,
    // which the palette no longer sources from (see FieldDiscoveryService).
    // Replaced by fieldTypeFromDiscovery, which reads the same
    // discoveredFieldsCache the palette populates. Pure function — takes
    // connectionId/schemaId explicitly rather than reading DOM selects
    // itself, so callers control exactly which selection it resolves
    // against (matters once a stale async response could otherwise race a
    // newer one — see renderCanvasForCurrentIndex).
    function fieldTypeFromDiscovery(connectionId, schemaId, fieldPath) {
        var fields = discoveredFieldsCache[discoveryCacheKey(connectionId, schemaId)];
        if (!fields) return 'String';
        var f = fields.filter(function (x) { return x.JsonPath === fieldPath; })[0];
        return f ? f.Type : 'String';
    }

    // ===================================================================
    // Palette construction — schema-gated field list, operators unchanged.
    // ===================================================================
    // Client-side cache of the last DiscoverFields result per
    // connection+schema pair, so switching rule sets or toggling a favorite
    // doesn't re-hit the network every render — only a genuinely new
    // connection/schema pairing, or an explicit Refresh, does.
    var discoveredFieldsCache = {};

    function discoveryCacheKey(connectionId, schemaId) { return connectionId + '|' + schemaId; }

    function populatePalette(view, forceRefresh) {
        var opContainer = view.querySelector('#rcsOperatorChips');
        opContainer.innerHTML = '';
        ALL_OPERATORS.forEach(function (o) {
            opContainer.appendChild(makeOperatorChip(o));
        });

        var fieldContainer = view.querySelector('#rcsFieldChips');

        if (!connections.length) {
            fieldContainer.innerHTML = '<span class="rcsFieldHint">No connections saved yet — add and save one on the Connections tab first.</span>';
            return;
        }

        var connectionId = view.querySelector('#rcsConnectionSelect').value;
        var schemaId = view.querySelector('#rcsSchemaSelect').value;

        if (!connectionId || !schemaId) {
            fieldContainer.innerHTML = '<span class="rcsFieldHint">Pick a connection and endpoint to discover fields.</span>';
            return;
        }

        var cached = !forceRefresh && discoveredFieldsCache[discoveryCacheKey(connectionId, schemaId)];
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
    // Returns a Promise<fields[]>, resolved synchronously from
    // discoveredFieldsCache when already cached — both the palette
    // (populatePalette) and the canvas (renderCanvasForCurrentIndex, which
    // needs field types resolved before it can correctly render locked
    // operators / date pickers on reload) share this single path so they
    // can never disagree about what a field's type is.
    // Memoizes the in-flight Promise itself, not just the completed result —
    // populatePalette and renderCanvasForCurrentIndex both call this for the
    // same key on every canvas render; without this, a cold cache (or a
    // forced refresh) fires two concurrent identical requests before either
    // resolves. Assumes both callers within a single render pass the same
    // forceRefresh value (they do — both derive it from the same param) —
    // if that ever diverges, a non-forced call could get piggybacked onto
    // an in-flight forced one or vice versa.
    var discoveryInFlight = {};

    function ensureFieldsDiscovered(connectionId, schemaId, forceRefresh, draftSchema) {
        var key = discoveryCacheKey(connectionId, schemaId);

        // A draft (not-yet-saved) schema always bypasses the cache/in-flight
        // dedup below -- it's actively being edited, so a stale cached
        // result from a prior attempt would be actively misleading.
        if (!draftSchema) {
            if (!forceRefresh && discoveredFieldsCache[key]) {
                return Promise.resolve(discoveredFieldsCache[key]);
            }

            if (discoveryInFlight[key]) {
                return discoveryInFlight[key];
            }
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
                discoveredFieldsCache[key] = result.Fields || [];
                return discoveredFieldsCache[key];
            }
            return result.Fields || [];
        }).catch(function (err) {
            delete discoveryInFlight[key];
            throw err;
        });

        if (!draftSchema) {
            discoveryInFlight[key] = request;
        }
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
        var key = discoveryCacheKey(connectionId, schemaId);
        var fields = discoveredFieldsCache[key];
        if (!fields) return;

        var field = fields.filter(function (f) { return f.JsonPath === fieldPath; })[0];
        if (!field) return;

        field.IsFavorite = !field.IsFavorite;
        discoveredFieldsCache[key] = sortSchemaFields(fields);

        renderFieldChips(view, connectionId, schemaId, discoveredFieldsCache[key]);
        persistFieldFavorite(schemaId, fieldPath, field.IsFavorite);
    }

    // Silent background save — favoriting is a per-user UI preference, not a
    // rule-set edit, so it doesn't use the visible save banner used
    // elsewhere. A failed save just means the toggle doesn't survive a page
    // reload; not worth interrupting the drag-and-drop flow to report.
    // Deliberately its own route (FieldFavoritesStore), not folded into
    // SaveEndpointSchemas — that route discards built-in schemas the client
    // sends and re-attaches the on-disk copy, so a favorite saved through it
    // on a Radarr/Sonarr field would silently never persist.
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

        makeDraggableSource(chip, 'field', function () {
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
        makeDraggableSource(handle, 'reorder', '', function () { return node; });

        var fieldSlot = document.createElement('span');
        fieldSlot.className = 'rcsSlot rcsSlot-field';
        fieldSlot.dataset.slotType = 'field';
        fieldSlot.dataset.value = data.Field || '';
        fieldSlot.dataset.fieldType = data.Field ? fieldTypeFromDiscovery(connectionId, schemaId, data.Field) : 'String';
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
                childrenContainer.appendChild(buildGroupNode(child, false, onChange, connectionId, schemaId));
            } else {
                childrenContainer.appendChild(buildConditionNode(child, onChange, connectionId, schemaId));
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
            childrenContainer.insertBefore(buildConditionNode({}, onChange, connectionId, schemaId), insertBeforeEl);
            refreshEmptyHint();
            if (onChange) onChange();
        });

        registerDropTarget(childrenContainer, ['new-group'], function (value, reorderEl, clientY) {
            var insertBeforeEl = findInsertionPoint(childrenContainer, clientY);
            childrenContainer.insertBefore(buildGroupNode({}, false, onChange, connectionId, schemaId), insertBeforeEl);
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

    function scheduleAutoPreview(view, isUserEdit) {
        if (isUserEdit) {
            ruleSetsHaveUnsavedChanges = true;
            var edited = currentRuleSetIndex >= 0 ? ruleSetsFile.RuleSets[currentRuleSetIndex] : null;
            if (edited) ruleSetDomEditedById[edited.Id] = true;
        }
        refreshRuleSetDirtyState(view);
        if (autoPreviewTimer) clearTimeout(autoPreviewTimer);
        autoPreviewTimer = setTimeout(function () { runAutoPreview(view); }, 450);
    }

    function markRuleSetsDirty(view) {
        ruleSetsHaveUnsavedChanges = true;
        refreshRuleSetDirtyState(view);
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
            var activeRuleSet = currentRuleSetIndex >= 0 ? ruleSetsFile.RuleSets[currentRuleSetIndex] : null;
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
        if (!ruleSetDomEditedById[current.Id]) return;
        var rootGroupEl = view.querySelector('#conditionsList > .rcsGroupRoot');
        if (!rootGroupEl) return;
        if (current.IsBuiltIn) {
            builtInRuleDraftRootsById[current.Id] = readGroupFromDom(rootGroupEl);
        } else {
            current.Root = readGroupFromDom(rootGroupEl);
        }
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

    var canvasRenderToken = 0; // guards against a stale ensureFieldsDiscovered response rendering over a newer selection

    function renderCanvasForCurrentIndex(view, forceRefresh) {
        var list = view.querySelector('#conditionsList');
        list.innerHTML = '';
        resetDragEngine();
        populatePalette(view, forceRefresh);
        wireStaticPaletteChips(view);

        var connectionId = view.querySelector('#rcsConnectionSelect').value;
        var schemaId = view.querySelector('#rcsSchemaSelect').value;
        if (forceRefresh) delete ruleRawResponseBySchemaId[schemaId];
        renderRuleRawResponse(view, schemaId);
        refreshRuleSetDirtyState(view);

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

        ensureFieldsDiscovered(connectionId, schemaId, !!forceRefresh)
            .catch(function () { return []; }) // best-effort: still render the canvas on discovery failure, conditions just fall back to String typing
            .then(function () {
                if (renderToken !== canvasRenderToken) return; // superseded by a newer render — drop this response
                if (loadingHint.parentNode) loadingHint.parentNode.removeChild(loadingHint);

                var onChange = function () { scheduleAutoPreview(view, true); };
                var displayedRoot = builtInRuleDraftRootsById[ruleSet.Id] || ruleSet.Root || emptyRoot();
                list.appendChild(buildGroupNode(displayedRoot, true, onChange, connectionId, schemaId));

                scheduleAutoPreview(view, false);
            });
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
        var allowed = schemasForConnection(connSel.value);
        var currentVal = schemaSel.value;

        schemaSel.innerHTML = '';
        allowed.forEach(function (s) {
            var o = document.createElement('option');
            o.value = s.Id;
            o.innerText = schemaOptionLabel(s);
            if (s.Id === currentVal) o.selected = true;
            schemaSel.appendChild(o);
        });
    }

    function renderConnectionAndSchemaSelects(view) {
        var connSel = view.querySelector('#rcsConnectionSelect');
        var priorConnectionId = connSel.value;
        var schemaSel = view.querySelector('#rcsSchemaSelect');
        var priorSchemaId = schemaSel.value;
        connSel.innerHTML = '';
        connections.forEach(function (c) {
            var o = document.createElement('option');
            o.value = c.Id;
            o.innerText = connectionBadgeGlyph(c) + ' ' + (c.DisplayLabel || '(unnamed connection)');
            connSel.appendChild(o);
        });
        if (connections.some(function (c) { return c.Id === priorConnectionId; })) {
            connSel.value = priorConnectionId;
        }

        rebuildRuleSetsSchemaOptions(view);
        if (schemasForConnection(connSel.value).some(function (s) { return s.Id === priorSchemaId; })) {
            schemaSel.value = priorSchemaId;
        }

        // Guarded the same way refreshBtn already is below -- this function
        // is called after every save (Connections, Endpoint Schemas) plus
        // initial load, and connSel/schemaSel are the same persisting DOM
        // nodes each time (only their options are rebuilt). Without this
        // guard, each call stacked another 'change' listener on top of the
        // last, so later in a session a single dropdown change fired
        // multiple stale handlers, each re-rendering against a slightly
        // different snapshot -- the actual cause of the Connection/Endpoint/
        // RuleSet pane "not always in step" behavior.
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
        ruleSetsSavedSnapshot = JSON.stringify(ruleSetsFile || { RuleSets: [] });
        ruleSetsHaveUnsavedChanges = false;
        ruleSetDomEditedById = {};
        builtInRuleDraftRootsById = {};
    }

    function refreshRuleSetDirtyState(view) {
        var warning = view.querySelector('#rcsDirtyWarning');
        var discard = view.querySelector('#rcsDiscardBtn');
        if (!warning) return;
        var dirty = ruleSetsSavedSnapshot !== null && ruleSetsHaveUnsavedChanges;
        warning.innerText = dirty ? 'Unsaved changes' : '';
        if (discard) discard.disabled = !dirty;
    }

    function discardRuleSetChanges(view) {
        if (ruleSetsSavedSnapshot === null) return;
        var selected = currentRuleSetIndex >= 0 ? ruleSetsFile.RuleSets[currentRuleSetIndex] : null;
        var selectedId = selected ? selected.Id : '';
        ruleSetsFile = JSON.parse(ruleSetsSavedSnapshot);
        ruleSetsHaveUnsavedChanges = false;
        ruleSetDomEditedById = {};
        builtInRuleDraftRootsById = {};
        currentRuleSetIndex = ruleSetsFile.RuleSets.findIndex(function (ruleSet) { return ruleSet.Id === selectedId; });
        var matching = ruleSetsForCurrentSchema(view);
        if (currentRuleSetIndex < 0) currentRuleSetIndex = matching.length ? matching[0].idx : -1;
        renderRuleSetSelect(view);
        renderCanvasForCurrentIndex(view);
        view.querySelector('#rcsSaveStatus').innerText = '';
        refreshRuleSetDirtyState(view);
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

        var current = currentRuleSetIndex >= 0 ? ruleSetsFile.RuleSets[currentRuleSetIndex] : null;
        if (current && current.IsBuiltIn) {
            var copyName = prompt(
                'The built-in Rule Set "' + current.Name.replace(/^\[Built-in\]\s*/, '') +
                '" cannot be overwritten.\nName the new Rule Set for these edits:',
                current.Name.replace(/^\[Built-in\]\s*/, '') + ' custom');
            if (!copyName || !copyName.trim()) return;
            copyName = copyName.trim();
            if (ruleSetNameExists(current.EndpointSchemaId, copyName)) {
                Dashboard.alert('Rule Set names must be unique within a Schema.');
                return;
            }
            var copy = JSON.parse(JSON.stringify(current));
            copy.Id = newId();
            copy.Name = copyName;
            copy.IsBuiltIn = false;
            copy.Root = readGroupFromDom(rootGroupEl);
            ruleSetsFile.RuleSets.push(copy);
            currentRuleSetIndex = ruleSetsFile.RuleSets.length - 1;
            markRuleSetsDirty(view);
            renderRuleSetSelect(view);
        } else {
            captureCurrentEditsIntoFile(view);
        }

        var statusEl = view.querySelector('#rcsSaveStatus');
        statusEl.innerText = 'Saving…';

        ApiClient.ajax({
            type: 'POST',
            url: ApiClient.getUrl('ChannelSync/RuleSets'),
            data: JSON.stringify({ Payload: ruleSetsFile }),
            contentType: 'application/json',
            dataType: 'json'
        }).then(function (result) {
            snapshotRuleSetsSaved();
            refreshRuleSetDirtyState(view);
            var affected = (result && result.AffectedFolderCount) || 0;
            statusEl.innerText = affected > 0 ? 'Saved. Folder tree resync started.' : 'Saved.';
        }).catch(function () {
            statusEl.innerText = '';
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
            if (ruleSetNameExists(schemaId, name)) { Dashboard.alert('Rule Set names must be unique within a Schema.'); return; }
            ruleSetsFile.RuleSets.push({ Id: newId(), Name: name.trim(), EndpointSchemaId: schemaId, IsBuiltIn: false, Root: emptyRoot() });
            markRuleSetsDirty(view);
            switchRuleSetTo(view, ruleSetsFile.RuleSets.length - 1);
        });

        view.querySelector('#rcsDuplicateRuleSet').addEventListener('click', function () {
            captureCurrentEditsIntoFile(view);
            var source = ruleSetsFile.RuleSets[currentRuleSetIndex];
            if (currentRuleSetIndex < 0 || !source) { Dashboard.alert('No rule set selected to duplicate.'); return; }
            var defaultName = (source.Name || '').replace(/^\[Built-in\]\s*/, '') + ' copy';
            var name = prompt('Name for the duplicated rule set:', defaultName);
            if (!name) return;
            if (ruleSetNameExists(source.EndpointSchemaId, name)) { Dashboard.alert('Rule Set names must be unique within a Schema.'); return; }
            var clone = JSON.parse(JSON.stringify(source));
            clone.Id = newId();
            clone.Name = name.trim();
            clone.IsBuiltIn = false;
            if (builtInRuleDraftRootsById[source.Id]) {
                clone.Root = JSON.parse(JSON.stringify(builtInRuleDraftRootsById[source.Id]));
            }
            ruleSetsFile.RuleSets.push(clone);
            markRuleSetsDirty(view);
            switchRuleSetTo(view, ruleSetsFile.RuleSets.length - 1);
        });

        view.querySelector('#rcsRenameRuleSet').addEventListener('click', function () {
            var current = ruleSetsFile.RuleSets[currentRuleSetIndex];
            if (currentRuleSetIndex < 0 || !current) { Dashboard.alert('No rule set selected to rename.'); return; }
            if (current.IsBuiltIn) { Dashboard.alert('Built-in rule sets are read-only. Use Duplicate to make an editable copy.'); return; }
            var name = prompt('Rename rule set:', current.Name);
            if (!name) return;
            if (ruleSetNameExists(current.EndpointSchemaId, name, current.Id)) { Dashboard.alert('Rule Set names must be unique within a Schema.'); return; }
            current.Name = name.trim();
            markRuleSetsDirty(view);
            renderRuleSetSelect(view);
        });

        view.querySelector('#rcsDeleteRuleSet').addEventListener('click', function () {
            var current = ruleSetsFile.RuleSets[currentRuleSetIndex];
            if (currentRuleSetIndex < 0 || !current) {
                Dashboard.alert('No rule set selected to delete.');
                return;
            }
            if (current.IsBuiltIn) { Dashboard.alert('Built-in rule sets are read-only and cannot be deleted.'); return; }
            if (folderTreeUsesAnyRuleSet(currentTree && currentTree.RootFolder, [current.Id])) {
                Dashboard.alert('This Rule Set cannot be deleted because a Folder Fetch uses it.');
                return;
            }
            if (!confirm('Delete rule set "' + current.Name + '"?')) {
                return;
            }
            ruleSetsFile.RuleSets.splice(currentRuleSetIndex, 1);
            markRuleSetsDirty(view);
            var remaining = ruleSetsForCurrentSchema(view);
            switchRuleSetTo(view, remaining.length ? remaining[0].idx : -1);
        });

        view.querySelector('#rcsExportRuleSet').addEventListener('click', function () {
            exportRuleSet(view);
        });
        view.querySelector('#rcsImportRuleSet').addEventListener('click', function () {
            importRuleSet(view);
        });
    }

    function exportRuleSet(view) {
        var source = currentRuleSetIndex >= 0 ? ruleSetsFile.RuleSets[currentRuleSetIndex] : null;
        if (!source) { Dashboard.alert('No Rule Set selected to export.'); return; }

        var exported = JSON.parse(JSON.stringify(source));
        var rootGroupEl = view.querySelector('#conditionsList > .rcsGroupRoot');
        if (rootGroupEl) exported.Root = readGroupFromDom(rootGroupEl);

        var panel = view.querySelector('#rcsImportExportPanel');
        var text = view.querySelector('#rcsImportExportText');
        var status = view.querySelector('#rcsImportExportStatus');
        var confirmBtn = view.querySelector('#rcsImportExportConfirm');
        text.value = JSON.stringify(exported, null, 2);
        status.innerText = 'Copy this Rule Set JSON.';
        confirmBtn.innerText = 'Copy to clipboard';
        confirmBtn.onclick = function () {
            copyTextToClipboard(text.value).then(function () {
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
            parsed.Id = newId();
            parsed.EndpointSchemaId = schemaId;
            parsed.IsBuiltIn = false;
            parsed.Name = (parsed.Name || 'Imported Rule Set').replace(/^\[Built-in\]\s*/, '');
            if (ruleSetNameExists(schemaId, parsed.Name)) {
                status.innerText = 'A Rule Set with that name already exists for this Schema. Change Name in the JSON before importing.';
                return;
            }
            ruleSetsFile.RuleSets.push(parsed);
            currentRuleSetIndex = ruleSetsFile.RuleSets.length - 1;
            markRuleSetsDirty(view);
            renderRuleSetSelect(view);
            renderCanvasForCurrentIndex(view);
            panel.style.display = 'none';
            refreshRuleSetDirtyState(view);
        };
        panel.style.display = '';
        text.focus();
    }

    // ===================================================================
    // Folder tree tab
    // ===================================================================
    var currentTree = null;
    var folderTreeSavedSnapshot = null;

    function snapshotFolderTreeSaved() {
        folderTreeSavedSnapshot = JSON.stringify(currentTree);
    }

    function refreshFolderTreeDirtyState(view) {
        var warning = view.querySelector('#ftDirtyWarning');
        var discard = view.querySelector('#ftDiscardBtn');
        if (!warning) return;
        var dirty = folderTreeSavedSnapshot !== null && JSON.stringify(currentTree) !== folderTreeSavedSnapshot;
        warning.innerText = dirty ? 'Unsaved changes' : '';
        if (discard) discard.disabled = !dirty;
    }

    function discardFolderTreeChanges(view) {
        if (folderTreeSavedSnapshot === null) return;
        currentTree = JSON.parse(folderTreeSavedSnapshot);
        view.querySelector('#ftStatus').innerText = '';
        renderTree(view);
    }

    function connectionLabel(id) {
        var c = findConnection(id);
        return c ? c.DisplayLabel : '(unknown connection)';
    }

    // ===================================================================
    // Endpoint Schema editor
    // ===================================================================
    var currentSchemaId = '';

    function currentSchema() {
        return schemas.filter(function (s) { return s.Id === currentSchemaId; })[0] || null;
    }

    function schemaNameExists(connectionId, name, exceptId) {
        var normalized = (name || '').trim().toLowerCase();
        return schemas.some(function (s) {
            return s.ConnectionId === connectionId && s.Id !== exceptId &&
                (s.DisplayName || '').trim().toLowerCase() === normalized;
        });
    }

    function ruleSetNameExists(schemaId, name, exceptId) {
        var normalized = (name || '').trim().toLowerCase();
        return ruleSetsFile.RuleSets.some(function (rs) {
            return rs.EndpointSchemaId === schemaId && rs.Id !== exceptId &&
                (rs.Name || '').trim().toLowerCase() === normalized;
        });
    }

    var OBJECT_KINDS = [
        { value: 'FlatMedia', label: 'Flat Media (single playable item, e.g. Movie)' },
        { value: 'Series', label: 'Series (Series -> Season -> Episode)' },
        { value: 'MusicArtistAlbum', label: 'Music (Artist -> Album -> Song)' },
        { value: 'PhotoAlbum', label: 'Photo Album (Album -> Photo)' },
        { value: 'GenericContainer', label: 'Generic Container (N folders -> leaf)' },
        { value: 'DisplayCard', label: 'Display Card (picture + name only, nothing underneath, nothing to play)' }
    ];

    var LEAF_MEDIA_TYPES = ['Video', 'Audio'];
    var LEAF_CONTENT_TYPES = ['Clip', 'Podcast', 'Trailer', 'Movie', 'Episode', 'Song', 'MovieExtra', 'TvExtra', 'GameExtra', 'MusicVideo'];

    // Low-risk, override-always suggestions -- never a silent decision, just
    // a pre-filled default the admin confirms or replaces. Checked in
    // priority order per role; first discovered field matching any pattern
    // wins. Hardcoded-with-override, not itself admin-configurable, since a
    // wrong guess costs one dropdown click, not a broken schema.
    var ROLE_HEURISTICS = {
        IdentityField: [/slug/i, /^id$/i, /identifier/i, /guid/i],
        TitleField: [/^title$/i, /^name$/i, /artistname/i],
        OriginalTitleField: [/originaltitle/i],
        YearField: [/^year$/i, /releaseyear/i],
        OverviewField: [/overview/i, /summary/i, /description/i],
        PosterUrlField: [/poster/i, /cover/i, /^image/i],
        ArtistField: [/^artist/i],
        AlbumArtistField: [/albumartist/i],
        AlbumField: [/^album/i],
        MediaFileUrlField: [/^url$/i, /fileurl/i, /mediaurl/i, /^path$/i]
    };

    // Transient, per-schema-id runtime state -- deliberately NOT stored on
    // the schema object itself, so it can never leak into the saved JSON
    // payload (SaveEndpointSchemas just JSON.stringifies the whole schemas
    // array as-is).
    var lastDiscoveryConnBySchemaId = {};
    var lastRawJsonBySchemaId = {};
    var lastArrayCandidatesBySchemaId = {};
    var schemaTestStatusBySchemaId = {};
    var autoSuggestedItemsRootBySchemaId = {};
    var autoSuggestedMappingsBySchemaId = {};
    var schemaDiscoveryBusyBySchemaId = {};

    // Raw-response panel UI state, per schema id -- deliberately separate
    // from lastRawJsonBySchemaId (the DATA) so re-rendering the panel
    // (e.g. after a Test click) can restore whether it was left open and
    // which view mode it was in, instead of always resetting to closed.
    var rawJsonExpandedBySchemaId = {};
    var rawJsonStrippedBySchemaId = {};

    // The only role/type combinations that are genuinely unlikely to work
    // even with the resolver's existing generic coercion (arrays already
    // comma-join, scalars already stringify -- see RuleEvaluator.
    // ResolveDisplayValue) -- a List dropped onto a slot that needs exactly
    // one value. Left assignable for testing per explicit instruction, just
    // flagged.
    var ROLE_WARN_IF_LIST = { PosterUrlField: true, MediaFileUrlField: true, ArtistField: true, AlbumArtistField: true };

    function roleFieldWarning(role, fieldType) {
        if (fieldType === 'List' && ROLE_WARN_IF_LIST[role]) {
            return 'This field returns a list -- values would be joined with commas, which probably isn\'t right here. Left assignable for testing, but expect an odd result.';
        }
        return null;
    }

    function suggestRoleField(fields, patterns) {
        for (var p = 0; p < patterns.length; p++) {
            var match = fields.filter(function (f) {
                return patterns[p].test(f.JsonPath) || patterns[p].test(f.DisplayName || '');
            })[0];
            if (match) return match.JsonPath;
        }
        return '';
    }

    function discoveredPath(fields, expectedPath) {
        var match = (fields || []).filter(function (field) {
            return (field.JsonPath || '').toLowerCase() === expectedPath.toLowerCase();
        })[0];
        return match ? match.JsonPath : '';
    }

    function emptyMapping() { return { Segments: [] }; }

    function newEmptySchema(connectionId, displayName) {
        return {
            Id: newId(),
            DisplayName: displayName || 'New Schema',
            ConnectionId: connectionId || '',
            IsBuiltIn: false,
            ObjectKind: 'FlatMedia',
            LeafMediaType: 'Video',
            LeafContentType: 'Movie',
            ContainerLevelCount: 0,
            ContainerLevelNames: [],
            Path: '',
            ItemsRootPath: '',
            StaticQueryParams: {},
            IdentityField: emptyMapping(),
            TitleField: emptyMapping(),
            OriginalTitleField: emptyMapping(),
            YearField: emptyMapping(),
            OverviewField: emptyMapping(),
            PosterUrlField: emptyMapping(),
            ArtistField: emptyMapping(),
            AlbumArtistField: emptyMapping(),
            AlbumField: emptyMapping(),
            MediaFileUrlField: emptyMapping(),
            ProviderIdFields: {},
            Fields: []
        };
    }

    function renderSchemaSelect(view) {
        var select = view.querySelector('#esSchemaSelect');
        var connectionSelect = view.querySelector('#esConnectionSelect');
        select.innerHTML = '';

        schemasForConnection(connectionSelect.value).forEach(function (s) {
            var opt = document.createElement('option');
            opt.value = s.Id;
            opt.innerText = schemaOptionLabel(s);
            select.appendChild(opt);
        });

        var allowed = schemasForConnection(connectionSelect.value);
        if (!allowed.some(function (s) { return s.Id === currentSchemaId; })) {
            currentSchemaId = allowed.length ? allowed[0].Id : '';
        }
        select.value = currentSchemaId;

        select.onchange = function () {
            schemaDiscoveryToken++;
            currentSchemaId = select.value;
            renderSchemaForm(view);
        };
    }

    function renderSchemaConnectionSelect(view) {
        var select = view.querySelector('#esConnectionSelect');
        var prior = select.value;
        select.innerHTML = '';
        connections.forEach(function (c) {
            var option = document.createElement('option');
            option.value = c.Id;
            option.innerText = connectionBadgeGlyph(c) + ' ' + (c.DisplayLabel || '(unnamed connection)');
            select.appendChild(option);
        });
        if (connections.some(function (c) { return c.Id === prior; })) select.value = prior;
        if (!select.value && connections.length) select.value = connections[0].Id;
        if (!select.dataset.wired) {
            select.dataset.wired = '1';
            select.addEventListener('change', function () {
                schemaDiscoveryToken++;
                currentSchemaId = '';
                renderSchemaSelect(view);
                renderSchemaForm(view);
            });
        }
        renderSchemaSelect(view);
    }

    function esLabeledRow(labelText, inputEl, description) {
        var row = document.createElement('div');
        row.className = 'esFormRow';
        row.style.marginBottom = '0.9em';

        var label = document.createElement('label');
        label.innerText = labelText;
        label.style.display = 'block';
        label.style.marginBottom = '0.2em';
        row.appendChild(label);

        row.appendChild(inputEl);

        if (description) {
            var desc = document.createElement('div');
            desc.className = 'fieldDescription';
            desc.style.marginTop = '0.2em';
            desc.innerText = description;
            row.appendChild(desc);
        }

        return row;
    }

    function esTextInput(value, disabled, onChange) {
        var input = document.createElement('input');
        input.type = 'text';
        input.style.width = '100%';
        input.value = value || '';
        input.disabled = !!disabled;
        input.addEventListener('input', function (e) {
            onChange(e.target.value);
            if (activePageView) markSchemasDirty(activePageView);
        });
        return input;
    }

    function esSelectInput(options, value, disabled, onChange) {
        var select = document.createElement('select');
        select.disabled = !!disabled;
        options.forEach(function (o) {
            var opt = document.createElement('option');
            opt.value = o.value;
            opt.innerText = o.label;
            if (o.value === value) opt.selected = true;
            select.appendChild(opt);
        });
        select.addEventListener('change', function (e) {
            onChange(e.target.value);
            if (activePageView) markSchemasDirty(activePageView);
        });
        return select;
    }

    function esNumberInput(value, disabled, onChange) {
        var input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.style.width = '6em';
        input.value = (value === null || value === undefined) ? 0 : value;
        input.disabled = !!disabled;
        input.addEventListener('input', function (e) {
            var n = parseInt(e.target.value, 10);
            onChange(isNaN(n) ? 0 : n);
            if (activePageView) markSchemasDirty(activePageView);
        });
        return input;
    }

    // The five static, always-available mapping pieces beyond discovered
    // JSON fields. Kind values here match MappingSegmentKind exactly (the
    // .NET serializer emits enums as their string name -- confirmed by the
    // existing ObjectKind/LeafMediaType string comparisons elsewhere in
    // this file) -- these ARE the Segment.Kind values sent to the server,
    // not just UI labels.
    var STATIC_MAPPING_CHIPS = [
        { dragKind: 'mapcustomtext', segKind: 'CustomText', label: 'Text', title: 'Literal text; type its value after dropping it into a mapping' },
        { dragKind: 'mapbaseurl', segKind: 'BaseUrl', label: '{baseUrl}', title: 'This connection\'s base URL' },
        { dragKind: 'mapapikeyname', segKind: 'ApiKeyName', label: '{apiKeyName}', title: 'This connection\'s API key parameter name, e.g. "apikey" or "api_key"' },
        { dragKind: 'mapapikeyvalue', segKind: 'ApiKeyValue', label: '{apiKeyValue}', title: 'This connection\'s API key value' }
    ];
    var STATIC_MAPPING_DRAG_KINDS = STATIC_MAPPING_CHIPS.map(function (c) { return c.dragKind; });

    function renderStaticMappingChips(container, connection) {
        container.innerHTML = '';

        STATIC_MAPPING_CHIPS.forEach(function (item) {
            var chip = document.createElement('span');
            chip.className = 'rcsChip rcsChip-operator';
            chip.innerText = item.label;
            if (item.segKind === 'CustomText') {
                chip.title = item.title;
            } else if (item.segKind === 'BaseUrl') {
                chip.title = 'Value: ' + ((connection && connection.BaseUrl) || '(not set)');
            } else if (item.segKind === 'ApiKeyName') {
                chip.title = 'Value: ' + ((connection && connection.ApiKeyParamName) || '(not set)');
            } else if (item.segKind === 'ApiKeyValue') {
                chip.title = 'Value: ' + ((connection && connection.ApiKey) ? '(configured API key — hidden)' : '(not set)');
            }
            makeDraggableSource(chip, item.dragKind, item.segKind);
            container.appendChild(chip);
        });
    }

    function mappingSegmentLabel(seg, fieldsByPath) {
        switch (seg.Kind) {
            case 'Field':
                var f = fieldsByPath[seg.Value];
                return f ? (f.DisplayName || f.JsonPath) : (seg.Value || '(missing field)');
            case 'CustomText':
                return seg.Value || '(empty text)';
            case 'ApiKeyName': return '{apiKeyName}';
            case 'ApiKeyValue': return '{apiKeyValue}';
            case 'BaseUrl': return '{baseUrl}';
            case 'Identity': return '{identity}';
            default: return '?';
        }
    }

    // Horizontal equivalent of findInsertionPoint (which is vertical, for
    // the rule builder's group children) -- segments lay out left-to-right
    // on one line, so reordering compares clientX against each existing
    // chip's horizontal midpoint instead.
    function findMappingInsertionIndex(containerEl, clientX, excludeEl, clientY) {
        var chips = Array.prototype.filter.call(containerEl.children, function (el) {
            return el.classList.contains('esMapSeg') && el !== excludeEl;
        });
        for (var i = 0; i < chips.length; i++) {
            var rect = chips[i].getBoundingClientRect();
            if (typeof clientY === 'number' && clientY < rect.top) return i;
            if ((typeof clientY !== 'number' || clientY <= rect.bottom) &&
                clientX < rect.left + rect.width / 2) return i;
        }
        return chips.length;
    }

    function showMappingInsertionIndicator(containerEl, clientX, excludeEl, clientY) {
        var chips = Array.prototype.filter.call(containerEl.children, function (el) {
            return el.classList.contains('esMapSeg') && el !== excludeEl;
        });
        var wholeMappingHandle = containerEl.querySelector('.esMappingHandle');
        var x = wholeMappingHandle
            ? wholeMappingHandle.getBoundingClientRect().right + 3
            : containerEl.getBoundingClientRect().left + 6;
        var indicatorTop = containerEl.getBoundingClientRect().top + 5;
        var indicatorHeight = Math.max(18, containerEl.getBoundingClientRect().height - 10);
        for (var i = 0; i < chips.length; i++) {
            var rect = chips[i].getBoundingClientRect();
            if ((typeof clientY === 'number' && clientY < rect.top) ||
                ((typeof clientY !== 'number' || clientY <= rect.bottom) &&
                    clientX < rect.left + rect.width / 2)) {
                x = rect.left - 3;
                indicatorTop = rect.top - 2;
                indicatorHeight = rect.height + 4;
                break;
            }
            x = rect.right + 3;
            indicatorTop = rect.top - 2;
            indicatorHeight = rect.height + 4;
        }
        var indicator = ensureInsertionIndicator();
        indicator.style.display = 'block';
        indicator.style.left = x + 'px';
        indicator.style.top = indicatorTop + 'px';
        indicator.style.width = '3px';
        indicator.style.height = indicatorHeight + 'px';
    }

    // Composable replacement for the old single-field buildRoleDropSlot.
    // `mapping` is a live { Segments: [...] } object already attached to
    // the schema (or a ProviderIdFields entry) -- this function mutates
    // mapping.Segments directly and re-renders from that array on every
    // change, rather than tracking any parallel DOM-only state. Reuses the
    // same pointer-drag engine as the rule builder (makeDraggableSource /
    // registerDropTarget), with new drag kinds ('mapapikeyname' etc, plus
    // 'mapseg' for reordering existing pieces within a row) so they can't
    // cross-target the rule builder's condition slots, which only accept
    // 'field'/'operator'. Discovered JSON fields reuse the existing
    // 'field' kind and its {path,type,display} JSON payload as-is.
    var mappingDragSequence = 0;

    function buildMappingRow(mapping, mapperConnId, schemaId, labelText, description, locked, warnRoleKey) {
        if (!mapping.Segments) mapping.Segments = [];
        var mappingDragId = 'schema-mapping-' + (++mappingDragSequence);

        var row = document.createElement('div');
        row.className = 'esFormRow esMapRow';
        row.style.marginBottom = '0.9em';

        var line = document.createElement('div');
        line.className = 'esMapLine';

        var mappingHandle = null;
        if (!locked) {
            mappingHandle = document.createElement('span');
            mappingHandle.className = 'esMappingHandle';
            mappingHandle.innerText = '\u2630';
            mappingHandle.dataset.dragLabel = labelText + ' (whole field)';
            mappingHandle.title = 'Drag to another field to copy this entire mapping (replaces its current contents)';
            makeDraggableSource(mappingHandle, 'mapmapping', function () {
                return JSON.stringify({ SourceId: mappingDragId, Segments: mapping.Segments });
            });
        }

        var legend = document.createElement('label');
        legend.className = 'esMapLegend';
        legend.innerText = labelText;
        legend.tabIndex = 0;
        line.appendChild(legend);

        if (!locked) {
            var clearBtn = document.createElement('span');
            clearBtn.className = 'rcsIconBtn esMapClear';
            clearBtn.innerText = 'Clear';
            clearBtn.addEventListener('click', function () {
                mapping.Segments = [];
                if (activePageView) markSchemasDirty(activePageView);
                renderSegments();
            });
            line.appendChild(clearBtn);
        }

        var valueEl = document.createElement('span');
        valueEl.className = 'rcsSlot rcsSlot-field esMapValue';
        line.appendChild(valueEl);

        row.appendChild(line);

        var examplesEl = document.createElement('div');
        examplesEl.className = 'esMapExamples';

        var warnEl = document.createElement('div');
        warnEl.className = 'fieldDescription';
        warnEl.style.color = '#e0a030';
        row.appendChild(warnEl);

        function fieldsByPath() {
            var fields = mapperConnId ? discoveredFieldsCache[discoveryCacheKey(mapperConnId, schemaId)] : null;
            var map = {};
            (fields || []).forEach(function (f) { map[f.JsonPath] = f; });
            return map;
        }

        function refreshWarning() {
            if (!warnRoleKey) { warnEl.innerText = ''; return; }
            var fbp = fieldsByPath();
            var lastFieldSeg = mapping.Segments.filter(function (s) { return s.Kind === 'Field'; }).pop();
            var f = lastFieldSeg ? fbp[lastFieldSeg.Value] : null;
            warnEl.innerText = roleFieldWarning(warnRoleKey, f ? f.Type : null) || '';
        }

        function resolvedExamples() {
            var fbp = fieldsByPath();
            var connection = mapperConnId ? findConnection(mapperConnId) : null;
            var output = [];
            for (var exampleIndex = 0; exampleIndex < 3; exampleIndex++) {
                var hasFieldValue = false;
                var value = mapping.Segments.map(function (seg) {
                    if (seg.Kind === 'Field') {
                        var field = fbp[seg.Value];
                        var examples = field && field.Examples ? field.Examples : [];
                        if (!examples.length) return '';
                        hasFieldValue = true;
                        return String(examples[Math.min(exampleIndex, examples.length - 1)]);
                    }
                    if (seg.Kind === 'CustomText') return seg.Value || '';
                    if (seg.Kind === 'BaseUrl') return (connection && connection.BaseUrl) || '';
                    if (seg.Kind === 'ApiKeyName') return (connection && connection.ApiKeyParamName) || '';
                    if (seg.Kind === 'ApiKeyValue') return (connection && connection.ApiKey) ? '\u2022\u2022\u2022\u2022\u2022\u2022' : '';
                    if (seg.Kind === 'Identity') return '{identity}';
                    return '';
                }).join('');
                if (value && (hasFieldValue || exampleIndex === 0) && output.indexOf(value) === -1) output.push(value);
            }
            return output.slice(0, 3);
        }

        function refreshExamples() {
            examplesEl.innerHTML = '';
            var examples = resolvedExamples();
            legend.title = examples.length ? examples.join('\n') : 'No examples are available for the current mapping.';

            examples.forEach(function (example) {
                var looksLikeImage = /^https?:\/\/\S+$/i.test(example) &&
                    (/\.(jpe?g|png|gif|webp|bmp|svg)(?:[?#].*)?$/i.test(example) ||
                        /image|poster|thumb|art/i.test(warnRoleKey || labelText));
                if (looksLikeImage) {
                    var img = document.createElement('img');
                    img.className = 'esMapExampleImage';
                    img.src = example;
                    img.alt = example;
                    img.title = example;
                    img.addEventListener('error', function () {
                        if (img.parentNode) img.parentNode.removeChild(img);
                        if (!examplesEl.children.length) examplesEl.style.display = 'none';
                    });
                    examplesEl.appendChild(img);
                }
            });
        }

        function showExamples() {
            refreshExamples();
            examplesEl.style.display = examplesEl.children.length ? 'flex' : 'none';
        }
        function hideExamples() { examplesEl.style.display = 'none'; }
        legend.addEventListener('mouseenter', showExamples);
        legend.addEventListener('mouseleave', hideExamples);
        legend.addEventListener('focus', showExamples);
        legend.addEventListener('blur', hideExamples);

        function renderSegments() {
            valueEl.innerHTML = '';
            var fbp = fieldsByPath();
            if (mappingHandle) valueEl.appendChild(mappingHandle);

            if (!mapping.Segments.length) {
                var empty = document.createElement('span');
                empty.className = 'fieldDescription esMapEmptyHint';
                empty.innerText = locked ? '(unmapped)' : 'drop a building block here \u2192';
                valueEl.appendChild(empty);
            }

            mapping.Segments.forEach(function (seg, idx) {
                var chip = document.createElement('span');
                chip.className = 'rcsChip esMapSeg esMapSeg-' + seg.Kind.toLowerCase();

                if (!locked) {
                    var dragHandle = document.createElement('span');
                    dragHandle.className = 'esMapDragHandle';
                    dragHandle.innerText = '\u2630';
                    dragHandle.dataset.dragLabel = mappingSegmentLabel(seg, fbp);
                    dragHandle.title = 'Drag to move within this field, or copy to another field';
                    makeDraggableSource(dragHandle, 'mapseg', function () {
                        return JSON.stringify({ SourceId: mappingDragId, Index: idx, Segment: seg });
                    }, function () { return chip; });
                    chip.appendChild(dragHandle);
                }

                if (seg.Kind === 'CustomText' && !locked) {
                    var input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'esMapTextInput';
                    input.value = seg.Value || '';
                    input.placeholder = 'text';
                    input.size = Math.min(20, Math.max(3, (seg.Value || '').length));
                    chip.title = 'Literal text: ' + (seg.Value || '(empty)');
                    input.addEventListener('input', function (e) {
                        seg.Value = e.target.value;
                        input.size = Math.min(20, Math.max(3, e.target.value.length));
                        chip.title = 'Literal text: ' + (e.target.value || '(empty)');
                        refreshExamples();
                        if (activePageView) markSchemasDirty(activePageView);
                    });
                    chip.appendChild(input);
                } else {
                    var textSpan = document.createElement('span');
                    textSpan.innerText = mappingSegmentLabel(seg, fbp);
                    chip.appendChild(textSpan);
                    if (seg.Kind === 'Field' && fbp[seg.Value] && fbp[seg.Value].Examples && fbp[seg.Value].Examples.length) {
                        chip.title = fbp[seg.Value].Examples.join('\n');
                    } else if (seg.Kind === 'BaseUrl') {
                        var baseConnection = mapperConnId ? findConnection(mapperConnId) : null;
                        chip.title = 'Value: ' + ((baseConnection && baseConnection.BaseUrl) || '(not set)');
                    } else if (seg.Kind === 'ApiKeyName') {
                        var nameConnection = mapperConnId ? findConnection(mapperConnId) : null;
                        chip.title = 'Value: ' + ((nameConnection && nameConnection.ApiKeyParamName) || '(not set)');
                    } else if (seg.Kind === 'ApiKeyValue') {
                        var keyConnection = mapperConnId ? findConnection(mapperConnId) : null;
                        chip.title = 'Value: ' + ((keyConnection && keyConnection.ApiKey) ? '(configured API key — hidden)' : '(not set)');
                    } else if (seg.Kind === 'Identity') {
                        chip.title = 'Value: the resolved Identity field for this item';
                    }
                }

                if (!locked) {
                    var xBtn = document.createElement('span');
                    xBtn.className = 'esMapSegRemove';
                    xBtn.innerText = '\u2715';
                    xBtn.title = 'Remove this piece';
                    xBtn.addEventListener('click', function () {
                        mapping.Segments.splice(idx, 1);
                        if (activePageView) markSchemasDirty(activePageView);
                        renderSegments();
                        refreshWarning();
                    });
                    chip.appendChild(xBtn);
                }

                valueEl.appendChild(chip);
            });

            // Native browser title tooltips can only contain text. Image
            // examples therefore remain inside the mapping's permanent
            // bounding box and appear, right-aligned in a row, while its
            // legend is hovered or focused.
            valueEl.appendChild(examplesEl);
            refreshWarning();
            refreshExamples();
            if (activePageView) refreshSchemaDirtyState(activePageView);
        }

        if (!locked) {
            registerDropTarget(valueEl, ['field'].concat(STATIC_MAPPING_DRAG_KINDS), function (rawValue, reorderElement, clientYIgnored, clientX) {
                var parsed = null;
                try { parsed = JSON.parse(rawValue); } catch (e) { /* not a field chip */ }

                var seg = (parsed && parsed.path)
                    ? { Kind: 'Field', Value: parsed.path }
                    : { Kind: rawValue, Value: '' }; // one of the static chips' segKind, dropped as its own drag value

                var insertAt = findMappingInsertionIndex(valueEl, clientX, null, clientYIgnored);
                mapping.Segments.splice(insertAt, 0, seg);
                renderSegments();
                if (activePageView) markSchemasDirty(activePageView);
                if (seg.Kind === 'CustomText') {
                    var inputs = valueEl.querySelectorAll('.esMapTextInput');
                    if (inputs.length) inputs[Math.min(insertAt, inputs.length - 1)].focus();
                }
            });

            registerDropTarget(valueEl, ['mapseg'], function (value, reorderElement, clientYIgnored, clientX) {
                var payload;
                try { payload = JSON.parse(value); } catch (e) { return; }
                if (!payload || !payload.Segment) return;
                var toIdx = findMappingInsertionIndex(
                    valueEl,
                    clientX,
                    payload.SourceId === mappingDragId ? reorderElement : null,
                    clientYIgnored
                );
                if (payload.SourceId === mappingDragId) {
                    var moved = mapping.Segments.splice(payload.Index, 1)[0];
                    if (!moved) return;
                    mapping.Segments.splice(toIdx, 0, moved);
                } else {
                    mapping.Segments.splice(toIdx, 0, {
                        Kind: payload.Segment.Kind,
                        Value: payload.Segment.Value || ''
                    });
                }
                renderSegments();
                if (activePageView) markSchemasDirty(activePageView);
            });

            registerDropTarget(valueEl, ['mapmapping'], function (value, reorderElement, clientY, clientX) {
                var payload;
                try { payload = JSON.parse(value); } catch (e) { return; }
                if (!payload || !Array.isArray(payload.Segments) || payload.SourceId === mappingDragId) return;
                var copiedSegments = payload.Segments.map(function (seg) {
                    return { Kind: seg.Kind, Value: seg.Value || '' };
                });
                var insertAt = findMappingInsertionIndex(valueEl, clientX, null, clientY);
                Array.prototype.splice.apply(mapping.Segments, [insertAt, 0].concat(copiedSegments));
                renderSegments();
                if (activePageView) markSchemasDirty(activePageView);
            });

            registerDropTarget(mappingHandle, ['mapmapping'], function (value) {
                var payload;
                try { payload = JSON.parse(value); } catch (e) { return; }
                if (!payload || !Array.isArray(payload.Segments) || payload.SourceId === mappingDragId) return;
                mapping.Segments = payload.Segments.map(function (seg) {
                    return { Kind: seg.Kind, Value: seg.Value || '' };
                });
                renderSegments();
                if (activePageView) markSchemasDirty(activePageView);
            });
        }

        renderSegments();

        if (description) {
            var desc = document.createElement('div');
            desc.className = 'fieldDescription';
            desc.style.marginTop = '0.2em';
            desc.innerText = description;
            row.appendChild(desc);
        }

        return row;
    }

    // Same toggleFieldFavorite/persistFieldFavorite the rule builder uses --
    // just re-renders into the schema tab's own palette container instead
    // of #rcsFieldChips.
    function renderSchemaPaletteChips(view, connectionId, schemaId, targetContainer) {
        var chipsWrap = targetContainer || view.querySelector('#esPaletteChips');
        if (!chipsWrap) return;
        chipsWrap.innerHTML = '';

        var fields = discoveredFieldsCache[discoveryCacheKey(connectionId, schemaId)] || [];

        sortSchemaFields(fields).forEach(function (f) {
            var chip = makeFieldChip(f.JsonPath, f.DisplayName, f.Type, !!f.IsFavorite, function () {
                var current = discoveredFieldsCache[discoveryCacheKey(connectionId, schemaId)] || [];
                var field = current.filter(function (x) { return x.JsonPath === f.JsonPath; })[0];
                if (!field) return;
                field.IsFavorite = !field.IsFavorite;
                discoveredFieldsCache[discoveryCacheKey(connectionId, schemaId)] = sortSchemaFields(current);
                renderSchemaPaletteChips(view, connectionId, schemaId, chipsWrap);
                persistFieldFavorite(schemaId, f.JsonPath, field.IsFavorite);
            });

            // Hover tooltip, not an appended child element -- an inline
            // sibling here was shifting chip layout and breaking drag/drop.
            // Appended to makeFieldChip's existing favorite-hint tooltip
            // rather than overwriting it.
            if (f.Examples && f.Examples.length) {
                chip.title = chip.title + '\n' + f.Examples.join('\n');
            }

            chipsWrap.appendChild(chip);
        });
    }

    // Palette of draggable field chips, sourced from whatever was last
    // discovered for this schema. Auto-hydrates from the server's persisted
    // last-response cache (ForceRefresh: false) the first time this schema
    // is shown in a page session, rather than requiring an explicit Test
    // click every time -- same cache-first behavior the rule builder's
    // field palette already relies on (lastResponseStore, server-side).
    function buildFieldPalette(view, schema) {
        var result = document.createDocumentFragment();
        var rawJsonHolder = document.createElement('div');
        rawJsonHolder.id = 'esRawJsonHolder';
        result.appendChild(rawJsonHolder);

        var wrap = document.createElement('div');
        wrap.className = 'esBuilderPalette';
        result.appendChild(wrap);

        var paletteTitle = document.createElement('div');
        paletteTitle.className = 'esPaletteTitle';
        paletteTitle.innerText = 'Field Mapping Building Blocks';
        wrap.appendChild(paletteTitle);

        var connId = lastDiscoveryConnBySchemaId[schema.Id];
        var fields = connId ? discoveredFieldsCache[discoveryCacheKey(connId, schema.Id)] : null;

        // Always rendered, regardless of discovery state -- {baseUrl} and
        // the api-key pieces don't depend on any fetched
        // data, so a mapping can be built entirely from these plus custom
        // text even before an endpoint has ever been tested.
        var paletteFlow = document.createElement('div');
        paletteFlow.className = 'esPaletteFlow';
        wrap.appendChild(paletteFlow);

        var staticChipsWrap = document.createElement('div');
        staticChipsWrap.id = 'esStaticPaletteChips';
        paletteFlow.appendChild(staticChipsWrap);
        renderStaticMappingChips(staticChipsWrap, findConnection(schema.ConnectionId));

        var chipsWrap = document.createElement('div');
        chipsWrap.id = 'esPaletteChips';
        paletteFlow.appendChild(chipsWrap);

        function renderRawJson() {
            rawJsonHolder.innerHTML = '';
            var rawJson = lastRawJsonBySchemaId[schema.Id];
            if (!rawJson) return;

            var details = document.createElement('details');
            details.style.marginTop = '0.8em';
            // Restores whatever open/closed state this schema's panel was
            // last left in -- a fresh Test click re-renders this whole
            // palette, and without this it would always snap back closed.
            details.open = !!rawJsonExpandedBySchemaId[schema.Id];
            details.addEventListener('toggle', function () {
                rawJsonExpandedBySchemaId[schema.Id] = details.open;
            });

            var summary = document.createElement('summary');
            summary.innerText = 'Raw response';
            details.appendChild(summary);

            var toolbar = document.createElement('div');
            toolbar.className = 'esRawJsonToolbar';

            var copyBtn = document.createElement('span');
            copyBtn.className = 'rcsIconBtn';
            copyBtn.innerText = 'Copy to clipboard';

            var stripBtn = document.createElement('span');
            stripBtn.className = 'rcsIconBtn';

            var pre = document.createElement('pre');
            pre.className = 'esRawJsonPre';

            // "Strip the gubbins" -- re-parses and re-serializes the raw
            // response text into clean, indented JSON. Returns null if the
            // raw text isn't valid JSON at all (e.g. an HTML error page),
            // so the toggle can fall back to showing the raw text with a
            // clear reason rather than silently doing nothing.
            function cleanedJsonOrNull() {
                try { return JSON.stringify(JSON.parse(rawJson), null, 2); } catch (e) { return null; }
            }

            function refreshView() {
                var stripped = !!rawJsonStrippedBySchemaId[schema.Id];
                var cleaned = stripped ? cleanedJsonOrNull() : null;
                pre.innerText = (stripped && cleaned !== null) ? cleaned : rawJson;
                stripBtn.innerText = stripped ? 'Show raw response' : 'Strip to valid JSON';
                stripBtn.title = (stripped && cleaned === null) ? 'Could not parse as JSON -- showing the raw response instead.' : '';
            }

            stripBtn.addEventListener('click', function () {
                rawJsonStrippedBySchemaId[schema.Id] = !rawJsonStrippedBySchemaId[schema.Id];
                refreshView();
            });

            copyBtn.addEventListener('click', function () {
                var text = pre.innerText;
                var done = function () {
                    var original = copyBtn.innerText;
                    copyBtn.innerText = 'Copied!';
                    setTimeout(function () { copyBtn.innerText = original; }, 1500);
                };
                copyTextToClipboard(text).then(done).catch(function () {
                    copyBtn.innerText = 'Copy blocked -- select and copy manually.';
                });
            });

            refreshView();

            toolbar.appendChild(copyBtn);
            toolbar.appendChild(stripBtn);
            details.appendChild(toolbar);
            details.appendChild(pre);
            rawJsonHolder.appendChild(details);
        }

        // A raw response is useful even when discovery cannot yet locate
        // the item array, so render it independently of palette success.
        renderRawJson();

        if (fields && fields.length) {
            renderSchemaPaletteChips(view, connId, schema.Id, chipsWrap);
        } else if (!schemaDiscoveryBusyBySchemaId[schema.Id] &&
            !(lastArrayCandidatesBySchemaId[schema.Id] && lastArrayCandidatesBySchemaId[schema.Id].length) &&
            schema.Path && schema.ConnectionId) {
            var owningConnection = findConnection(schema.ConnectionId);
            if (owningConnection) {
                var requestedSchemaId = schema.Id;
                ApiClient.ajax({
                    type: 'POST',
                    url: ApiClient.getUrl('ChannelSync/DiscoverFields'),
                    data: JSON.stringify({ EndpointSchemaId: schema.Id, ForceRefresh: false, DraftSchema: schema }),
                    contentType: 'application/json',
                    dataType: 'json'
                }).then(function (result) {
                    if (currentSchemaId !== requestedSchemaId) return;
                    if (result && result.Success !== false && result.Fields && result.Fields.length) {
                        discoveredFieldsCache[discoveryCacheKey(owningConnection.Id, schema.Id)] = result.Fields;
                        lastDiscoveryConnBySchemaId[schema.Id] = owningConnection.Id;
                        lastRawJsonBySchemaId[schema.Id] = result.RawJson || '';
                        // Rebuild the complete form, not only the palette:
                        // mapping legends and dropped chips also depend on
                        // these examples/tooltips.
                        renderSchemaForm(view);
                    }
                }).catch(function () { /* explicit Test status supplies any actionable error */ });
            }
        }

        return result;
    }

    function renderSchemaForm(view) {
        var container = view.querySelector('#esForm');
        container.innerHTML = '';

        if (!currentSchema()) {
            container.innerHTML = '<div class="fieldDescription">No schema selected -- use + New to create one.</div>';
            refreshSchemaDirtyState(view);
            return;
        }

        var schema = currentSchema();
        var isBuiltInTemplate = !!schema.IsBuiltIn;
        // Built-ins use the same editor and live test workflow as custom
        // schemas. Their protected status is enforced at Save time by
        // creating a named custom copy instead of overwriting the template.
        var locked = false;

        if (isBuiltInTemplate) {
            var lockNotice = document.createElement('div');
            lockNotice.className = 'fieldDescription';
            lockNotice.style.marginBottom = '0.8em';
            lockNotice.innerText = 'This is a protected built-in template. You can test, inspect and edit it here; Save will ask for a new Schema name and preserve the built-in unchanged.';
            container.appendChild(lockNotice);
        }

        container.appendChild(esLabeledRow('Endpoint path', esTextInput(schema.Path, locked, function (v) {
            schema.Path = v;
            schemaTestStatusBySchemaId[schema.Id] = 'Endpoint changed — test again to refresh the response and field palette.';
            var testResult = view.querySelector('#esTestResult');
            if (testResult) testResult.innerText = schemaTestStatusBySchemaId[schema.Id];
        }),
            'Appended to the connection\'s base URL, e.g. "/api/v3/movie".'));

        container.appendChild(buildStaticQueryParamsEditor(view, schema, locked));

        var arrayCandidatesHolder = document.createElement('div');
        arrayCandidatesHolder.id = 'esArrayCandidates';
        container.appendChild(arrayCandidatesHolder);

        container.appendChild(buildSchemaTestAndSuggestRow(view, schema));

        // Items Root Path is a property of the test result, not an
        // independent up-front setting -- it only means anything once
        // there's a response shape to describe, and Test & Suggest above
        // will usually fill/correct it automatically via the array
        // candidates list.
        container.appendChild(esLabeledRow('Items root path', esTextInput(schema.ItemsRootPath, locked, function (v) {
            schema.ItemsRootPath = v;
            delete autoSuggestedItemsRootBySchemaId[schema.Id];
            schemaTestStatusBySchemaId[schema.Id] = 'Items root path changed — test again to inspect that array.';
            var testResult = view.querySelector('#esTestResult');
            if (testResult) testResult.innerText = schemaTestStatusBySchemaId[schema.Id];
        }), 'The path to the item array inside a wrapped response. For {"Items":[...]}, use "Items": the wrapper is ignored and each object inside Items is mapped. Leave blank only when the response itself is the array.'));

        container.appendChild(buildFieldPalette(view, schema));

        var objectSettings = document.createElement('div');
        objectSettings.className = 'esInlineSettings';
        objectSettings.appendChild(esLabeledRow('Object kind', esSelectInput(OBJECT_KINDS, schema.ObjectKind, locked, function (v) {
            schema.ObjectKind = v;
            renderSchemaForm(view); // re-render to show/hide kind-specific fields
        }), 'Which Emby channel shape this schema\'s items become. Fixed choices -- not every combination of container/leaf is meaningful in Emby.'));

        if (schema.ObjectKind === 'FlatMedia' || schema.ObjectKind === 'GenericContainer') {
            objectSettings.appendChild(esLabeledRow('Leaf media type', esSelectInput(
                LEAF_MEDIA_TYPES.map(function (t) { return { value: t, label: t }; }),
                schema.LeafMediaType, locked, function (v) { schema.LeafMediaType = v; })));
            objectSettings.appendChild(esLabeledRow('Leaf content type', esSelectInput(
                LEAF_CONTENT_TYPES.map(function (t) { return { value: t, label: t }; }),
                schema.LeafContentType, locked, function (v) { schema.LeafContentType = v; })));
        }
        container.appendChild(objectSettings);

        // Schemas have strict Connection ownership, so mapping pieces can
        // resolve connection facts immediately; discovered field examples
        // use the same connection+schema cache key when available.
        var mapperConnId = schema.ConnectionId;

        // ---- Always-present role fields ----
        if (locked) {
            container.appendChild(buildMappingRow(schema.IdentityField, mapperConnId, schema.Id, 'Identity field',
                'Required. A stable, unique id -- items without one are dropped.', true, 'IdentityField'));
            container.appendChild(buildMappingRow(schema.TitleField, mapperConnId, schema.Id, 'Title field', null, true, 'TitleField'));
            container.appendChild(buildMappingRow(schema.OriginalTitleField, mapperConnId, schema.Id, 'Original title field', null, true, 'OriginalTitleField'));
            container.appendChild(buildMappingRow(schema.YearField, mapperConnId, schema.Id, 'Year field', null, true, 'YearField'));
            container.appendChild(buildMappingRow(schema.OverviewField, mapperConnId, schema.Id, 'Overview field', null, true, 'OverviewField'));
            container.appendChild(buildMappingRow(schema.PosterUrlField, mapperConnId, schema.Id, 'Poster URL field', null, true, 'PosterUrlField'));
        } else {
            container.appendChild(buildMappingRow(schema.IdentityField, mapperConnId, schema.Id, 'Identity field',
                'Required. A stable, unique id -- items without one are dropped. Build from 1+ pieces below, e.g. a single Field piece, or Field + CustomText if the raw value alone isn\'t unique enough.', locked, 'IdentityField'));
            container.appendChild(buildMappingRow(schema.TitleField, mapperConnId, schema.Id, 'Title field', null, locked, 'TitleField'));
            container.appendChild(buildMappingRow(schema.OriginalTitleField, mapperConnId, schema.Id, 'Original title field', null, locked, 'OriginalTitleField'));
            container.appendChild(buildMappingRow(schema.YearField, mapperConnId, schema.Id, 'Year field', null, locked, 'YearField'));
            container.appendChild(buildMappingRow(schema.OverviewField, mapperConnId, schema.Id, 'Overview field', null, locked, 'OverviewField'));
            container.appendChild(buildMappingRow(schema.PosterUrlField, mapperConnId, schema.Id, 'Poster URL field',
                null, locked, 'PosterUrlField'));
        }

        // ---- Kind-specific fields ----
        if (schema.ObjectKind === 'MusicArtistAlbum') {
            if (locked) {
                container.appendChild(buildMappingRow(schema.ArtistField, mapperConnId, schema.Id, 'Artist field', null, true, null));
                container.appendChild(buildMappingRow(schema.AlbumArtistField, mapperConnId, schema.Id, 'Album artist field', null, true, null));
                container.appendChild(buildMappingRow(schema.AlbumField, mapperConnId, schema.Id, 'Album field', null, true, null));
            } else {
                container.appendChild(buildMappingRow(schema.ArtistField, mapperConnId, schema.Id, 'Artist field', null, locked, null));
                container.appendChild(buildMappingRow(schema.AlbumArtistField, mapperConnId, schema.Id, 'Album artist field', null, locked, null));
                container.appendChild(buildMappingRow(schema.AlbumField, mapperConnId, schema.Id, 'Album field', null, locked, null));
            }
        }

        if (schema.ObjectKind === 'PhotoAlbum') {
            container.appendChild(buildMappingRow(schema.MediaFileUrlField, mapperConnId, schema.Id, 'Media file URL field',
                'The actual image file URL -- distinct from Poster URL, which is a thumbnail. Same build-a-URL-from-pieces approach as Poster URL field above, if the source doesn\'t already return a ready-to-use URL.', locked, null));
        }

        if (schema.ObjectKind === 'GenericContainer') {
            container.appendChild(esLabeledRow('Container level count', esNumberInput(schema.ContainerLevelCount, locked, function (v) {
                schema.ContainerLevelCount = v;
                renderSchemaForm(view); // level-name inputs need to match the new count
            }), 'How many synthetic folder levels sit between this item and its playable leaf. 0 is valid.'));

            if (!schema.ContainerLevelNames) schema.ContainerLevelNames = [];

            for (var lvl = 0; lvl < schema.ContainerLevelCount; lvl++) {
                (function (levelIndex) {
                    var current = schema.ContainerLevelNames[levelIndex] || '';
                    container.appendChild(esLabeledRow('Level ' + (levelIndex + 1) + ' name', esTextInput(current, locked, function (v) {
                        schema.ContainerLevelNames[levelIndex] = v;
                    }), 'Display label only -- every level is a plain Container folder in Emby.'));
                })(lvl);
            }
        }

        if (!locked || Object.keys(schema.ProviderIdFields || {}).length) {
            container.appendChild(buildProviderIdFieldsEditor(view, schema, mapperConnId, locked));
        }

        if (lastArrayCandidatesBySchemaId[schema.Id] && lastArrayCandidatesBySchemaId[schema.Id].length) {
            renderArrayCandidates(
                view,
                schema,
                schema.ConnectionId,
                lastArrayCandidatesBySchemaId[schema.Id],
                schemaTestStatusBySchemaId[schema.Id]);
        }

        refreshSchemaDirtyState(view);
    }

    // Provider IDs (Tmdb/Imdb/Tvdb, or any other name) work through the
    // identical composable-mapping mechanism as every other field -- a
    // built-in schema populates these through the same path a
    // custom schema would, rather than a privileged shortcut.
    function buildProviderIdFieldsEditor(view, schema, mapperConnId, locked) {
        if (!schema.ProviderIdFields) schema.ProviderIdFields = {};

        var wrap = document.createElement('div');
        wrap.style.marginBottom = '0.9em';

        var label = document.createElement('label');
        label.innerText = 'Provider ID fields';
        label.style.display = 'block';
        label.style.marginBottom = '0.3em';
        wrap.appendChild(label);

        Object.keys(schema.ProviderIdFields).forEach(function (key) {
            var mapping = schema.ProviderIdFields[key];
            if (!mapping || !mapping.Segments) {
                mapping = { Segments: [] };
                schema.ProviderIdFields[key] = mapping;
            }

            var keyRow = document.createElement('div');
            keyRow.className = 'esProviderIdKeyRow';

            var keyInput = document.createElement('input');
            keyInput.type = 'text';
            keyInput.style.width = '10em';
            keyInput.value = key;
            keyInput.placeholder = 'e.g. Tmdb';
            keyInput.disabled = !!locked;
            keyInput.title = 'Recognised with a matching Emby badge: Tmdb, Imdb, Tvdb. Any other name still works internally as a stored provider id, just without a matching built-in badge.';
            keyInput.addEventListener('change', function (e) {
                var newKey = e.target.value;
                if (!newKey || newKey === key || schema.ProviderIdFields.hasOwnProperty(newKey)) { e.target.value = key; return; }
                schema.ProviderIdFields[newKey] = schema.ProviderIdFields[key];
                delete schema.ProviderIdFields[key];
                markSchemasDirty(view);
                renderSchemaForm(view);
            });
            keyRow.appendChild(keyInput);

            if (!locked) {
                var removeBtn = document.createElement('span');
                removeBtn.className = 'rcsIconBtn';
                removeBtn.innerText = 'Remove';
                removeBtn.addEventListener('click', function () {
                    delete schema.ProviderIdFields[key];
                    markSchemasDirty(view);
                    renderSchemaForm(view);
                });
                keyRow.appendChild(removeBtn);
            }

            wrap.appendChild(keyRow);
            wrap.appendChild(buildMappingRow(mapping, mapperConnId, schema.Id, '\u2192 value', null, locked, null));
        });

        if (!locked) {
            var addBtn = document.createElement('span');
            addBtn.className = 'rcsIconBtn';
            addBtn.innerText = '+ Add provider ID field';
            addBtn.addEventListener('click', function () {
                var n = 1, newKey = 'ProviderId';
                while (schema.ProviderIdFields.hasOwnProperty(newKey)) { newKey = 'ProviderId' + (++n); }
                schema.ProviderIdFields[newKey] = { Segments: [] };
                markSchemasDirty(view);
                renderSchemaForm(view);
            });
            wrap.appendChild(addBtn);
        }

        return wrap;
    }
    // (e.g. Limit=25) are explicit fields on screen, per preference for
    // fields over headers being more obvious.
    function buildStaticQueryParamsEditor(view, schema, locked) {
        if (!schema.StaticQueryParams) schema.StaticQueryParams = {};

        var wrap = document.createElement('div');
        wrap.style.marginBottom = '0.9em';

        var label = document.createElement('label');
        label.innerText = 'Additional static query parameters';
        label.style.display = 'block';
        label.style.marginBottom = '0.3em';
        wrap.appendChild(label);

        var keys = Object.keys(schema.StaticQueryParams);

        keys.forEach(function (key) {
            var row = document.createElement('div');
            row.style.display = 'flex';
            row.style.gap = '0.4em';
            row.style.marginBottom = '0.3em';

            var keyInput = document.createElement('input');
            keyInput.type = 'text';
            keyInput.style.width = '10em';
            keyInput.value = key;
            keyInput.placeholder = 'name, e.g. Limit';
            keyInput.disabled = !!locked;

            var valInput = document.createElement('input');
            valInput.type = 'text';
            valInput.style.width = '10em';
            valInput.value = schema.StaticQueryParams[key];
            valInput.placeholder = 'value, e.g. 25';
            valInput.disabled = !!locked;
            valInput.addEventListener('input', function (e) {
                schema.StaticQueryParams[key] = e.target.value;
                markSchemasDirty(view);
            });

            keyInput.addEventListener('change', function (e) {
                var newKey = e.target.value;
                if (!newKey || newKey === key) return;
                var val = schema.StaticQueryParams[key];
                delete schema.StaticQueryParams[key];
                schema.StaticQueryParams[newKey] = val;
                markSchemasDirty(view);
                renderSchemaForm(view);
            });

            row.appendChild(keyInput);
            row.appendChild(valInput);

            if (!locked) {
                var removeBtn = document.createElement('span');
                removeBtn.className = 'rcsIconBtn';
                removeBtn.innerText = 'Remove';
                removeBtn.addEventListener('click', function () {
                    delete schema.StaticQueryParams[key];
                    markSchemasDirty(view);
                    renderSchemaForm(view);
                });
                row.appendChild(removeBtn);
            }

            wrap.appendChild(row);
        });

        if (!locked) {
            var addBtn = document.createElement('span');
            addBtn.className = 'rcsIconBtn';
            addBtn.innerText = '+ Add parameter';
            addBtn.addEventListener('click', function () {
                var n = 1;
                var newKey = 'param';
                while (schema.StaticQueryParams.hasOwnProperty(newKey)) {
                    newKey = 'param' + (++n);
                }
                schema.StaticQueryParams[newKey] = '';
                markSchemasDirty(view);
                renderSchemaForm(view);
            });
            wrap.appendChild(addBtn);
        }

        var desc = document.createElement('div');
        desc.className = 'fieldDescription';
        desc.style.marginTop = '0.3em';
        desc.innerText = 'Always appended as literal query-string values, e.g. Limit=25. For values that should reflect fetched data, use the role fields instead.';
        wrap.appendChild(desc);

        return wrap;
    }

    // Raw ApiClient call (not ensureFieldsDiscovered's plain Promise-of-
    // fields contract) since this needs the FULL result -- including
    // ArrayFieldCandidates on failure -- not just the Fields array on
    // success. ensureFieldsDiscovered stays the simpler shape the rule
    // builder palette already relies on.
    var schemaDiscoveryToken = 0;

    function endpointObjectLabel(schema) {
        var parts = (schema.Path || '').split('?')[0].split('/').filter(function (p) { return !!p; });
        var label = parts.length ? parts[parts.length - 1] : 'item';
        if (/ies$/i.test(label)) label = label.substring(0, label.length - 3) + 'y';
        else if (/s$/i.test(label) && !/ss$/i.test(label) && !/series$/i.test(label)) label = label.substring(0, label.length - 1);
        return label || 'item';
    }

    function runSchemaDiscovery(view, schema, connectionId, forceRefresh) {
        var requestToken = ++schemaDiscoveryToken;
        var requestedSchemaId = schema.Id;
        var schemaBeforeDiscovery = JSON.stringify(schema);
        schemaDiscoveryBusyBySchemaId[schema.Id] = true;
        schemaTestStatusBySchemaId[schema.Id] = 'Testing ' + (schema.Path || 'endpoint') + '…';
        var candidatesHolder = view.querySelector('#esArrayCandidates');
        if (candidatesHolder) candidatesHolder.innerHTML = 'Testing...';
        var visibleStatus = view.querySelector('#esTestResult');
        if (visibleStatus) visibleStatus.innerText = schemaTestStatusBySchemaId[schema.Id];

        return ApiClient.ajax({
            type: 'POST',
            url: ApiClient.getUrl('ChannelSync/DiscoverFields'),
            data: JSON.stringify({ EndpointSchemaId: schema.Id, ForceRefresh: forceRefresh !== false, DraftSchema: schema }),
            contentType: 'application/json',
            dataType: 'json'
        }).then(function (result) {
            if (requestToken !== schemaDiscoveryToken || currentSchemaId !== requestedSchemaId) {
                schemaDiscoveryBusyBySchemaId[requestedSchemaId] = false;
                return;
            }
            if (result && result.RawJson) lastRawJsonBySchemaId[schema.Id] = result.RawJson;

            if (!result || result.Success === false) {
                var candidates = (result && result.ArrayFieldCandidates) || [];
                lastArrayCandidatesBySchemaId[schema.Id] = candidates;
                var previousAutoRoot = autoSuggestedItemsRootBySchemaId[schema.Id];
                var rootCanBeSuggested = !schema.ItemsRootPath || schema.ItemsRootPath === previousAutoRoot;

                if (candidates.length === 1 && rootCanBeSuggested) {
                    schema.ItemsRootPath = candidates[0];
                    autoSuggestedItemsRootBySchemaId[schema.Id] = candidates[0];
                    if (JSON.stringify(schema) !== schemaBeforeDiscovery) markSchemasDirty(view);
                    schemaTestStatusBySchemaId[schema.Id] =
                        'Found an item array wrapped in "' + candidates[0] + '". Inspecting its objects…';
                    renderSchemaForm(view);
                    return runSchemaDiscovery(view, schema, connectionId, false);
                }

                schemaTestStatusBySchemaId[schema.Id] = (result && result.Message) || 'The response could not be inspected.';
                schemaDiscoveryBusyBySchemaId[schema.Id] = false;
                renderSchemaForm(view);
                renderArrayCandidates(view, schema, connectionId, candidates, schemaTestStatusBySchemaId[schema.Id]);
                return;
            }

            var fields = result.Fields || [];
            lastArrayCandidatesBySchemaId[schema.Id] = [];

            // Populate the palette cache the same way ensureFieldsDiscovered
            // does for the rule builder, so fieldTypeFromDiscovery/
            // makeFieldChip behave identically here.
            discoveredFieldsCache[discoveryCacheKey(connectionId, schema.Id)] = fields;
            lastDiscoveryConnBySchemaId[schema.Id] = connectionId;

            var autoMappings = autoSuggestedMappingsBySchemaId[schema.Id] || {};
            var applicableRoles = [
                'IdentityField', 'TitleField', 'OriginalTitleField',
                'YearField', 'OverviewField', 'PosterUrlField'
            ];
            if (schema.ObjectKind === 'MusicArtistAlbum') {
                applicableRoles = applicableRoles.concat(['ArtistField', 'AlbumArtistField', 'AlbumField']);
            }
            if (schema.ObjectKind === 'PhotoAlbum') applicableRoles.push('MediaFileUrlField');

            applicableRoles.forEach(function (role) {
                if (!schema[role]) schema[role] = { Segments: [] };
                var currentSnapshot = JSON.stringify(schema[role]);
                var canSuggest = !schema[role].Segments.length || autoMappings[role] === currentSnapshot;
                if (canSuggest) {
                    var guess = suggestRoleField(fields, ROLE_HEURISTICS[role]);
                    if (guess) {
                        schema[role] = { Segments: [{ Kind: 'Field', Value: guess }] };
                        autoMappings[role] = JSON.stringify(schema[role]);
                    } else if (autoMappings[role] === currentSnapshot) {
                        schema[role] = { Segments: [] };
                        delete autoMappings[role];
                    }
                }
            });

            // Emby list responses expose an opaque image tag, not a ready
            // poster URL. When both required fields are present, suggest the
            // complete working URL recipe instead of the otherwise-useless
            // single ImageTags.Primary field.
            var owningConnection = findConnection(connectionId);
            if (owningConnection && (owningConnection.SystemType || '').toLowerCase() === 'emby') {
                var embyIdPath = discoveredPath(fields, 'Id');
                var embyPrimaryImageTagPath = discoveredPath(fields, 'ImageTags.Primary');
                var currentPosterSnapshot = JSON.stringify(schema.PosterUrlField || { Segments: [] });
                var posterCanBeSuggested = !schema.PosterUrlField ||
                    !schema.PosterUrlField.Segments.length ||
                    autoMappings.PosterUrlField === currentPosterSnapshot;
                if (posterCanBeSuggested && embyIdPath && embyPrimaryImageTagPath) {
                    schema.PosterUrlField = {
                        Segments: [
                            { Kind: 'BaseUrl', Value: '' },
                            { Kind: 'CustomText', Value: '/Items/' },
                            { Kind: 'Field', Value: embyIdPath },
                            { Kind: 'CustomText', Value: '/Images/Primary?tag=' },
                            { Kind: 'Field', Value: embyPrimaryImageTagPath }
                        ]
                    };
                    autoMappings.PosterUrlField = JSON.stringify(schema.PosterUrlField);
                }
            }
            autoSuggestedMappingsBySchemaId[schema.Id] = autoMappings;
            if (JSON.stringify(schema) !== schemaBeforeDiscovery) markSchemasDirty(view);

            var objectLabel = endpointObjectLabel(schema);
            var wrapperText = schema.ItemsRootPath ? ' wrapped in "' + schema.ItemsRootPath + '"' : ' at the response root';
            schemaTestStatusBySchemaId[schema.Id] =
                'Found ' + ((result.ItemCount === null || result.ItemCount === undefined) ? '' : result.ItemCount + ' ') +
                objectLabel + ' object(s)' + wrapperText + ', with ' + fields.length +
                ' fields available. The palette and automatic suggestions have been updated.';
            schemaDiscoveryBusyBySchemaId[schema.Id] = false;
            renderSchemaForm(view);
        }).catch(function () {
            if (requestToken !== schemaDiscoveryToken || currentSchemaId !== requestedSchemaId) {
                schemaDiscoveryBusyBySchemaId[requestedSchemaId] = false;
                return;
            }
            schemaTestStatusBySchemaId[schema.Id] = 'Test request failed — the previous raw response and palette have been retained.';
            schemaDiscoveryBusyBySchemaId[schema.Id] = false;
            renderSchemaForm(view);
        });
    }

    // The "have a go at guessing, show me the shape" behavior for
    // envelope-wrapped responses: the server already found every
    // top-level key whose value is itself an array (Emby's "Items", or
    // whatever the equivalent is for any other wrapped source) -- render
    // those as one-click choices that set Items Root Path and immediately
    // retry, rather than making the admin guess blind or read raw JSON.
    function renderArrayCandidates(view, schema, connectionId, candidates, message) {
        var holder = view.querySelector('#esArrayCandidates');
        if (!holder) return;
        holder.innerHTML = '';

        var msgEl = document.createElement('div');
        msgEl.className = 'fieldDescription';
        msgEl.style.marginTop = '0.4em';
        msgEl.innerText = message || 'Endpoint test failed.';
        holder.appendChild(msgEl);

        if (candidates && candidates.length) {
            var chipsWrap = document.createElement('div');
            chipsWrap.style.marginTop = '0.4em';

            candidates.forEach(function (key) {
                var chip = document.createElement('span');
                chip.className = 'rcsIconBtn';
                chip.style.marginRight = '0.4em';
                chip.innerText = 'Use "' + key + '"';
                chip.addEventListener('click', function () {
                    schema.ItemsRootPath = key;
                    autoSuggestedItemsRootBySchemaId[schema.Id] = key;
                    markSchemasDirty(view);
                    schemaTestStatusBySchemaId[schema.Id] = 'Inspecting objects wrapped in "' + key + '"…';
                    renderSchemaForm(view);
                    runSchemaDiscovery(view, schema, connectionId, false);
                });
                chipsWrap.appendChild(chip);
            });

            holder.appendChild(chipsWrap);
        }
    }

    // Test/Suggest lives right after the Endpoint path field -- it needs
    // Path to build a real URL, and repeats the System Type as its own
    // Test/Suggest always uses the schema's owning Connection. It works
    // against a not-yet-saved schema by passing the whole draft object, so
    // only the endpoint Path is needed before testing.
    function buildSchemaTestAndSuggestRow(view, schema) {
        var wrap = document.createElement('div');
        wrap.style.margin = '0.6em 0 1.2em';

        var suggestBtn = document.createElement('button');
        suggestBtn.setAttribute('is', 'emby-button');
        suggestBtn.type = 'button';
        suggestBtn.className = 'raised button-submit';
        suggestBtn.innerText = schemaDiscoveryBusyBySchemaId[schema.Id] ? 'Testing…' : 'Test and Suggest Field Mappings';
        suggestBtn.disabled = !schema.Path || !!schemaDiscoveryBusyBySchemaId[schema.Id];
        suggestBtn.title = schema.Path ? 'Test this draft against its owning connection.' : 'Enter an Endpoint path first.';
        suggestBtn.addEventListener('click', function () {
            if (!schema.Path) { Dashboard.alert('Enter an Endpoint path first.'); return; }
            if (!findConnection(schema.ConnectionId)) { Dashboard.alert('The owning connection no longer exists.'); return; }
            if (schemaDiscoveryBusyBySchemaId[schema.Id]) return;
            suggestBtn.disabled = true;
            suggestBtn.innerText = 'Testing…';
            runSchemaDiscovery(view, schema, schema.ConnectionId);
        });
        wrap.appendChild(suggestBtn);

        var resultText = document.createElement('div');
        resultText.id = 'esTestResult';
        resultText.className = 'esTestResult';
        var owner = findConnection(schema.ConnectionId);
        resultText.innerText = schemaTestStatusBySchemaId[schema.Id] ||
            (schema.Path
                ? 'Ready to test against ' + (owner ? owner.DisplayLabel : '(missing connection)') + '.'
                : 'Enter an Endpoint path to enable testing.');
        wrap.appendChild(resultText);

        return wrap;
    }

    function newSchema(view) {
        var connectionId = view.querySelector('#esConnectionSelect').value;
        if (!connectionId) { Dashboard.alert('Add and save a Connection first.'); return; }
        if (!persistedConnectionIds[connectionId]) {
            Dashboard.alert('Save this Connection before creating its first Schema.');
            return;
        }
        var name = prompt('Name for the new schema:', 'New Schema');
        if (!name || !name.trim()) return;
        if (schemaNameExists(connectionId, name)) { Dashboard.alert('Schema names must be unique within a Connection.'); return; }
        var fresh = newEmptySchema(connectionId, name.trim());
        schemas.push(fresh);
        currentSchemaId = fresh.Id;
        markSchemasDirty(view);
        renderSchemaSelect(view);
        renderSchemaForm(view);
    }

    function duplicateSchema(view) {
        var source = currentSchema();
        if (!source) { Dashboard.alert('No schema selected to duplicate.'); return; }
        var name = prompt('Name for the duplicated schema:', (source.DisplayName || 'Schema') + ' copy');
        if (!name || !name.trim()) return;

        var ownerIndex = connections.findIndex(function (c) { return c.Id === source.ConnectionId; });
        var choices = connections.map(function (c, i) { return (i + 1) + '. ' + c.DisplayLabel; }).join('\n');
        var targetAnswer = prompt('Target Connection (enter its number):\n' + choices, String(ownerIndex + 1));
        var targetIndex = parseInt(targetAnswer, 10) - 1;
        if (!connections[targetIndex]) { Dashboard.alert('No valid target Connection selected.'); return; }
        if (schemaNameExists(connections[targetIndex].Id, name)) { Dashboard.alert('Schema names must be unique within the target Connection.'); return; }

        var clone = JSON.parse(JSON.stringify(source));
        clone.Id = newId();
        clone.DisplayName = name.trim();
        clone.ConnectionId = connections[targetIndex].Id;
        clone.IsBuiltIn = false;
        schemas.push(clone);
        markSchemasDirty(view);
        if (confirm('Copy this schema\'s Rule Sets too?')) {
            ruleSetsFile.RuleSets
                .filter(function (rs) { return rs.EndpointSchemaId === source.Id; })
                .forEach(function (rs) {
                    var copy = JSON.parse(JSON.stringify(rs));
                    copy.Id = newId();
                    copy.EndpointSchemaId = clone.Id;
                    copy.IsBuiltIn = false;
                    ruleSetsFile.RuleSets.push(copy);
                });
            schemaOperationChangedRuleSets = true;
            markRuleSetsDirty(view);
        }
        view.querySelector('#esConnectionSelect').value = clone.ConnectionId;
        currentSchemaId = clone.Id;
        renderSchemaSelect(view);
        renderSchemaForm(view);
    }

    function renameSchema(view) {
        var schema = currentSchema();
        if (!schema) { Dashboard.alert('No schema selected to rename.'); return; }
        if (schema.IsBuiltIn) { Dashboard.alert('Built-in schemas are read-only. Duplicate it to make an editable copy.'); return; }
        var name = prompt('Rename schema:', schema.DisplayName);
        if (!name || !name.trim()) return;
        if (schemaNameExists(schema.ConnectionId, name, schema.Id)) { Dashboard.alert('Schema names must be unique within a Connection.'); return; }
        schema.DisplayName = name.trim();
        markSchemasDirty(view);
        renderSchemaSelect(view);
    }

    function folderTreeUsesAnyRuleSet(node, ruleSetIds) {
        if (!node) return false;
        var lookup = {};
        ruleSetIds.forEach(function (id) { lookup[id] = true; });
        if ((node.Fetches || []).some(function (f) { return !!lookup[f.RuleSetId]; })) return true;
        return (node.Children || []).some(function (child) {
            return folderTreeUsesAnyRuleSet(child, ruleSetIds);
        });
    }

    function deleteSchema(view) {
        var schema = currentSchema();
        if (!schema) return;
        if (schema.IsBuiltIn) { Dashboard.alert('Built-in endpoint schemas are read-only and cannot be deleted.'); return; }

        var usedRuleIds = ruleSetsFile.RuleSets
            .filter(function (rs) { return rs.EndpointSchemaId === schema.Id; })
            .map(function (rs) { return rs.Id; });
        if (folderTreeUsesAnyRuleSet(currentTree && currentTree.RootFolder, usedRuleIds)) {
            Dashboard.alert('This schema cannot be deleted because a Folder Fetch uses one of its Rule Sets.');
            return;
        }
        if (!confirm('Delete schema "' + schema.DisplayName + '" and its Rule Sets?')) return;
        schemas = schemas.filter(function (s) { return s.Id !== schema.Id; });
        ruleSetsFile.RuleSets = ruleSetsFile.RuleSets.filter(function (rs) { return rs.EndpointSchemaId !== schema.Id; });
        currentSchemaId = '';
        markSchemasDirty(view);
        renderSchemaSelect(view);
        renderSchemaForm(view);
    }

    // A simple copy/paste window rather than a file-download flow -- the
    // schema object already includes every value, field, ObjectKind, and
    // FieldMapping as plain JSON, so no server endpoint is needed: export
    // is just JSON.stringify(schema), import is JSON.parse + validate.
    function exportSchema(view) {
        if (!currentSchema()) { Dashboard.alert('No schema selected to export.'); return; }
        var panel = view.querySelector('#esImportExportPanel');
        var text = view.querySelector('#esImportExportText');
        var status = view.querySelector('#esImportExportStatus');
        var confirmBtn = view.querySelector('#esImportExportConfirm');

        var exported = JSON.parse(JSON.stringify(currentSchema()));
        // Fields are discovered/filter-palette metadata, not part of the
        // output mapping definition. Built-ins carry a small offline seed
        // (including hasFile for their shipped rules), but exports should be
        // portable schema definitions rather than cached palette baggage.
        delete exported.Fields;
        delete exported.DetailUrlFormat;
        text.value = JSON.stringify(exported, null, 2);
        text.readOnly = false;
        status.innerText = 'Copy the text above to share this schema, or edit it directly and re-import below.';
        confirmBtn.innerText = 'Copy to clipboard';
        confirmBtn.onclick = function () {
            copyTextToClipboard(text.value).then(function () {
                status.innerText = 'Copied to clipboard.';
            }).catch(function () {
                text.select();
                status.innerText = 'Clipboard copy was blocked -- text is selected, copy manually (Ctrl/Cmd+C).';
            });
        };
        panel.style.display = '';
        text.focus();
        text.select();
    }

    function importSchema(view) {
        var panel = view.querySelector('#esImportExportPanel');
        var text = view.querySelector('#esImportExportText');
        var status = view.querySelector('#esImportExportStatus');
        var confirmBtn = view.querySelector('#esImportExportConfirm');

        text.value = '';
        text.readOnly = false;
        status.innerText = 'Paste an exported schema\'s JSON below, then click Import.';
        confirmBtn.innerText = 'Import';
        confirmBtn.onclick = function () {
            var parsed;
            try {
                parsed = JSON.parse(text.value);
            } catch (e) {
                status.innerText = 'Not valid JSON -- paste the full exported schema text.';
                return;
            }
            if (!parsed || typeof parsed !== 'object' || !parsed.hasOwnProperty('IdentityField')) {
                status.innerText = 'Doesn\'t look like an Endpoint Schema (missing IdentityField) -- check you copied the whole export.';
                return;
            }

            parsed.Id = newId(); // always a new id -- never silently overwrites an existing schema by id collision
            parsed.IsBuiltIn = false; // an imported copy is never treated as a locked built-in, regardless of source
            parsed.ConnectionId = view.querySelector('#esConnectionSelect').value;
            parsed.Fields = [];
            delete parsed.DetailUrlFormat;
            if (!parsed.DisplayName) parsed.DisplayName = 'Imported schema';
            if (schemaNameExists(parsed.ConnectionId, parsed.DisplayName)) {
                status.innerText = 'A Schema with that name already exists on the selected Connection. Rename it in the JSON before importing.';
                return;
            }

            schemas.push(parsed);
            currentSchemaId = parsed.Id;
            markSchemasDirty(view);
            renderSchemaSelect(view);
            renderSchemaForm(view);
            panel.style.display = 'none';
        };
        panel.style.display = '';
        text.focus();
    }

    // Save-button staleness warning. Snapshotted right after load and
    // right after a successful save; re-checked on every renderSchemaForm
    // call, which every edit handler in this tab already triggers -- so
    // this doesn't need its own separate change-tracking wired through
    // every input.
    var schemasSavedSnapshot = null;
    var schemaRuleSetsSavedSnapshot = null;
    var builtInSchemaOriginals = {};
    var schemasHaveUnsavedChanges = false;

    function snapshotSchemasSaved() {
        schemasSavedSnapshot = JSON.stringify(schemas);
        schemaRuleSetsSavedSnapshot = JSON.stringify(ruleSetsFile);
        schemasHaveUnsavedChanges = false;
        builtInSchemaOriginals = {};
        schemas.filter(function (schema) { return schema.IsBuiltIn; }).forEach(function (schema) {
            builtInSchemaOriginals[schema.Id] = JSON.stringify(schema);
        });
    }

    function refreshSchemaDirtyState(view) {
        var warn = view.querySelector('#esDirtyWarning');
        var discard = view.querySelector('#esDiscardBtn');
        if (!warn) return;
        var dirty = schemasSavedSnapshot !== null &&
            (schemasHaveUnsavedChanges || schemaOperationChangedRuleSets);
        warn.innerText = dirty ? 'Unsaved changes' : '';
        if (discard) discard.disabled = !dirty;
    }

    function markSchemasDirty(view) {
        schemasHaveUnsavedChanges = true;
        refreshSchemaDirtyState(view);
    }

    function discardEndpointSchemaChanges(view) {
        if (schemasSavedSnapshot === null) return;
        if (schemaOperationChangedRuleSets &&
            !confirm('Discard Schema changes and the Rule Set copies/deletions made by those Schema operations?')) return;

        var selectedConnectionId = view.querySelector('#esConnectionSelect').value;
        var selectedSchemaId = currentSchemaId;
        var selectedRule = currentRuleSetIndex >= 0 ? ruleSetsFile.RuleSets[currentRuleSetIndex] : null;
        var selectedRuleId = selectedRule ? selectedRule.Id : '';
        schemas = JSON.parse(schemasSavedSnapshot);
        if (schemaOperationChangedRuleSets && schemaRuleSetsSavedSnapshot) {
            ruleSetsFile = JSON.parse(schemaRuleSetsSavedSnapshot);
        }
        schemaOperationChangedRuleSets = false;
        schemasHaveUnsavedChanges = false;

        renderSchemaConnectionSelect(view);
        if (connections.some(function (connection) { return connection.Id === selectedConnectionId; })) {
            view.querySelector('#esConnectionSelect').value = selectedConnectionId;
        }
        currentSchemaId = schemas.some(function (schema) { return schema.Id === selectedSchemaId; })
            ? selectedSchemaId : '';
        renderSchemaSelect(view);
        renderSchemaForm(view);
        renderConnectionAndSchemaSelects(view);
        currentRuleSetIndex = ruleSetsFile.RuleSets.findIndex(function (ruleSet) {
            return ruleSet.Id === selectedRuleId;
        });
        renderRuleSetSelect(view);
        renderCanvasForCurrentIndex(view);
        view.querySelector('#esSaveStatus').innerText = '';
        snapshotSchemasSaved();
        refreshSchemaDirtyState(view);
    }

    function copySchemaRuntimeState(source, clone) {
        var sourceKey = discoveryCacheKey(source.ConnectionId, source.Id);
        var cloneKey = discoveryCacheKey(clone.ConnectionId, clone.Id);
        if (discoveredFieldsCache[sourceKey]) {
            discoveredFieldsCache[cloneKey] = JSON.parse(JSON.stringify(discoveredFieldsCache[sourceKey]));
            lastDiscoveryConnBySchemaId[clone.Id] = clone.ConnectionId;
        }
        if (lastRawJsonBySchemaId[source.Id]) lastRawJsonBySchemaId[clone.Id] = lastRawJsonBySchemaId[source.Id];
        if (rawJsonExpandedBySchemaId[source.Id]) rawJsonExpandedBySchemaId[clone.Id] = true;
        if (rawJsonStrippedBySchemaId[source.Id]) rawJsonStrippedBySchemaId[clone.Id] = true;
        if (schemaTestStatusBySchemaId[source.Id]) schemaTestStatusBySchemaId[clone.Id] = schemaTestStatusBySchemaId[source.Id];
    }

    function saveEditedBuiltInsAsCopies() {
        var edits = schemas.filter(function (schema) {
            return schema.IsBuiltIn && builtInSchemaOriginals[schema.Id] &&
                JSON.stringify(schema) !== builtInSchemaOriginals[schema.Id];
        });
        if (!edits.length) return true;

        var requestedNames = [];
        for (var i = 0; i < edits.length; i++) {
            var source = edits[i];
            var name = prompt(
                'The built-in Schema "' + source.DisplayName + '" cannot be overwritten.\nName the new Schema for these edits:',
                source.DisplayName + ' custom');
            if (!name || !name.trim()) return false;
            name = name.trim();
            if (schemaNameExists(source.ConnectionId, name) ||
                requestedNames.some(function (entry) {
                    return entry.connectionId === source.ConnectionId &&
                        entry.name.toLowerCase() === name.toLowerCase();
                })) {
                Dashboard.alert('Schema names must be unique within a Connection.');
                return false;
            }
            requestedNames.push({ source: source, connectionId: source.ConnectionId, name: name });
        }

        requestedNames.forEach(function (entry) {
            var source = entry.source;
            var clone = JSON.parse(JSON.stringify(source));
            clone.Id = newId();
            clone.DisplayName = entry.name;
            clone.IsBuiltIn = false;

            var sourceIndex = schemas.findIndex(function (schema) { return schema.Id === source.Id; });
            schemas[sourceIndex] = JSON.parse(builtInSchemaOriginals[source.Id]);
            schemas.push(clone);
            copySchemaRuntimeState(source, clone);
            if (currentSchemaId === source.Id) currentSchemaId = clone.Id;
        });
        return true;
    }

    function saveEndpointSchemas(view) {
        var status = view.querySelector('#esSaveStatus');
        var affectedFolders = 0;
        if (!saveEditedBuiltInsAsCopies()) {
            status.innerText = 'Save cancelled.';
            return;
        }
        var selectedConnectionId = view.querySelector('#esConnectionSelect').value;
        var selectedSchemaId = currentSchemaId;
        var selectedRule = currentRuleSetIndex >= 0 ? ruleSetsFile.RuleSets[currentRuleSetIndex] : null;
        var selectedRuleId = selectedRule ? selectedRule.Id : '';
        status.innerText = 'Saving...';

        ApiClient.ajax({
            type: 'POST',
            url: ApiClient.getUrl('ChannelSync/EndpointSchemas'),
            data: JSON.stringify({ Payload: { Schemas: schemas } }),
            contentType: 'application/json',
            dataType: 'json'
        }).then(function (result) {
            affectedFolders += (result && result.AffectedFolderCount) || 0;
            if (!schemaOperationChangedRuleSets) return Promise.resolve();
            return ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl('ChannelSync/RuleSets'),
                data: JSON.stringify({ Payload: ruleSetsFile }),
                contentType: 'application/json',
                dataType: 'json'
            }).then(function (result) {
                affectedFolders += (result && result.AffectedFolderCount) || 0;
            });
        }).then(function () {
            status.innerText = affectedFolders > 0 ? 'Saved. Folder tree resync started.' : 'Saved.';
            // Server strips/re-adds built-ins on every save and re-seeds on
            // next load -- re-fetch so any built-in edits we sent are
            // discarded client-side too, keeping the dropdown honest.
            return Promise.all([
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/EndpointSchemas'), dataType: 'json' }),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/RuleSets'), dataType: 'json' })
            ]).then(function (results) {
                schemas = (results[0] && results[0].Schemas) || [];
                var serverRuleSets = (results[1] && results[1].RuleSets) || [];
                var liveSchemaIds = {};
                schemas.forEach(function (s) { liveSchemaIds[s.Id] = true; });
                var localCustomRules = ruleSetsFile.RuleSets.filter(function (rs) {
                    return !rs.IsBuiltIn && liveSchemaIds[rs.EndpointSchemaId];
                });
                ruleSetsFile = {
                    RuleSets: localCustomRules.concat(serverRuleSets.filter(function (rs) { return rs.IsBuiltIn; }))
                };
                renderSystemTypeDatalist(view);
                renderSchemaConnectionSelect(view);
                view.querySelector('#esConnectionSelect').value = selectedConnectionId;
                currentSchemaId = selectedSchemaId;
                renderSchemaSelect(view);
                renderSchemaForm(view);
                renderConnectionAndSchemaSelects(view);
                var restoredRuleIndex = ruleSetsFile.RuleSets.findIndex(function (rs) { return rs.Id === selectedRuleId; });
                var availableRules = ruleSetsForCurrentSchema(view);
                currentRuleSetIndex = restoredRuleIndex >= 0 ? restoredRuleIndex : (availableRules.length ? availableRules[0].idx : -1);
                renderRuleSetSelect(view);
                renderCanvasForCurrentIndex(view);
                snapshotSchemasSaved();
                if (schemaOperationChangedRuleSets) snapshotRuleSetsSaved();
                schemaOperationChangedRuleSets = false;
                refreshSchemaDirtyState(view);
            });
        }).catch(function () {
            status.innerText = 'Save failed -- see server log.';
        });
    }

    function schemaLabel(id) {
        var s = schemas.filter(function (x) { return x.Id === id; })[0];
        return s ? s.DisplayName : '(unknown endpoint)';
    }

    function ruleSetLabel(id) {
        var rs = ruleSetsFile.RuleSets.filter(function (x) { return x.Id === id; })[0];
        return rs ? rs.Name : '(unknown rule set)';
    }

    function ruleSetById(id) {
        return ruleSetsFile.RuleSets.filter(function (rs) { return rs.Id === id; })[0] || null;
    }

    function schemaForRuleSetId(id) {
        var ruleSet = ruleSetById(id);
        return ruleSet ? schemas.filter(function (s) { return s.Id === ruleSet.EndpointSchemaId; })[0] || null : null;
    }

    function connectionForRuleSetId(id) {
        var schema = schemaForRuleSetId(id);
        return schema ? findConnection(schema.ConnectionId) : null;
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

        var existingSchema = existingFetch ? schemaForRuleSetId(existingFetch.RuleSetId) : null;
        var existingConnection = existingSchema ? findConnection(existingSchema.ConnectionId) : null;

        var connSelect = makeSelectField(
            'Connection',
            connections.map(function (c) { return { value: c.Id, text: connectionBadgeGlyph(c) + ' ' + c.DisplayLabel }; }),
            existingConnection ? existingConnection.Id : (connections[0] && connections[0].Id));

        var schemaSelect = makeSelectField(
            'Schema',
            schemasForConnection(connSelect.value).map(function (s) { return { value: s.Id, text: schemaOptionLabel(s) }; }),
            existingSchema ? existingSchema.Id : (schemasForConnection(connSelect.value)[0] && schemasForConnection(connSelect.value)[0].Id));

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
            var allowed = schemasForConnection(connSelect.value);
            var currentVal = schemaSelect.value;
            schemaSelect.innerHTML = '';
            allowed.forEach(function (s) {
                var o = document.createElement('option');
                o.value = s.Id;
                o.innerText = schemaOptionLabel(s);
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
                    Id: newId(),
                    Enabled: true,
                    DisplayLabel: labelInput.value,
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
        var ruleSet = ruleSetById(fetch.RuleSetId);
        if (!ruleSet) problems.push('rule set');
        var schema = ruleSet ? schemaForRuleSetId(fetch.RuleSetId) : null;
        if (ruleSet && !schema) problems.push('endpoint');
        if (schema && !findConnection(schema.ConnectionId)) problems.push('connection');
        return problems;
    }

    function buildFetchRow(fetch, folderNode, onChange) {
        var row = document.createElement('div');
        row.className = 'ftFetch' + (fetch.Enabled ? '' : ' ftFetchDisabled');

        var badge = document.createElement('span');
        badge.className = 'ftFetchProviderBadge';
        var owningSchema = schemaForRuleSetId(fetch.RuleSetId);
        var owningConnection = connectionForRuleSetId(fetch.RuleSetId);
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
        refreshFolderTreeDirtyState(view);
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

            statusEl.innerText = 'Saved. Folder tree resync started.';
            snapshotFolderTreeSaved();
            refreshFolderTreeDirtyState(view);
        }).catch(function () {
            statusEl.innerText = 'Save failed — see server log.';
        });
    }

    // ===================================================================
    // Connections tab
    // ===================================================================
    // Seed suggestions only, not a closed set -- SystemType is free text
    // (EndpointSchema.SystemType is deliberately not a fixed enum, so a
    // user-authored schema for any new source doesn't need a code change).
    // Grown at render time with whatever SystemType values already exist
    // across saved schemas, so a custom one you've already typed once
    // reappears as a suggestion everywhere else too.
    var KNOWN_SYSTEM_TYPES = ['radarr', 'sonarr'];

    // The Application dropdown on the Connections tab. A known entry is
    // authoritative for SystemType + API key parameter name (always still
    // editable afterwards -- see renderConnectionsTab); "custom" hands
    // SystemType to a free-text field instead, for any REST source with
                // its own Endpoint Schema. This is the single source of truth for
    // that preset table -- it does not need to match KNOWN_SYSTEM_TYPES,
    // which is a separate, open-ended list seeded from whatever's
    // actually been used (including past custom SystemTypes).
    var KNOWN_APPLICATIONS = [
        { key: 'radarr', label: 'Radarr (built-in)', apiKeyParamName: 'apikey', urlPlaceholder: 'http://192.168.1.10:7878' },
        { key: 'sonarr', label: 'Sonarr (built-in)', apiKeyParamName: 'apikey', urlPlaceholder: 'http://192.168.1.10:8989' },
        { key: 'emby', label: 'Emby (built-in)', apiKeyParamName: 'api_key', urlPlaceholder: 'http://192.168.1.10:8096' },
        { key: 'custom', label: 'Custom', apiKeyParamName: 'apikey', urlPlaceholder: 'http://192.168.1.10:port' }
    ];
    var CUSTOM_APPLICATION = KNOWN_APPLICATIONS[KNOWN_APPLICATIONS.length - 1];

    function refreshKnownSystemTypesFromConnections() {
        connections.forEach(function (c) {
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
        var list = view.querySelector('#connList');
        list.innerHTML = '';

        connections.forEach(function (c, idx) {
            var row = document.createElement('tr');
            row.className = 'connDataRow';

            var labelInput = document.createElement('input');
            labelInput.style.width = '10em';
            labelInput.value = c.DisplayLabel;
            labelInput.placeholder = 'Label';
            labelInput.addEventListener('input', function (e) { c.DisplayLabel = e.target.value; });
            labelInput.addEventListener('change', function () {
                renderSchemaConnectionSelect(view);
                renderConnectionAndSchemaSelects(view);
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
            // name); Custom hands control of SystemType and the API key
            // parameter name to the operator directly. This replaces an
            // earlier attempt with two independent free-text fields that
            // silently guessed at each other -- confusing, and neither a
            // real closed choice nor a real free one. This is one.
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

            // Resolve the app dropdown's initial selection from persisted
            // state: an exact match to a known built-in key, or Custom for
            // anything else. BaseUrlIsUserEntered is the explicit ownership
            // boundary: presets follow Application changes until the user
            // types a value; a manual value is never overwritten.
            var currentApp = KNOWN_APPLICATIONS.find(function (a) { return a.key === c.SystemType; }) || CUSTOM_APPLICATION;
            appSelect.value = currentApp.key;
            customTypeInput.value = c.SystemType || '';
            customTypeInput.style.display = (currentApp.key === 'custom') ? '' : 'none';
            paramNameInput.value = c.ApiKeyParamName || currentApp.apiKeyParamName;
            if (!c.SystemType) { c.SystemType = currentApp.key; }
            if (!c.ApiKeyParamName) { c.ApiKeyParamName = paramNameInput.value; }
            if (!c.BaseUrlIsUserEntered) { c.BaseUrl = currentApp.urlPlaceholder; urlInput.value = c.BaseUrl; }
            urlInput.placeholder = currentApp.urlPlaceholder;

            appSelect.addEventListener('change', function (e) {
                var app = KNOWN_APPLICATIONS.find(function (a) { return a.key === e.target.value; }) || CUSTOM_APPLICATION;

                customTypeInput.style.display = (app.key === 'custom') ? '' : 'none';
                urlInput.placeholder = app.urlPlaceholder;

                // A built-in selection is authoritative over SystemType and
                // the API key parameter name -- that's the whole point of
                // picking a known application instead of Custom. Custom
                // hands both back to the operator, starting from whatever
                // was last set (usually blank on a brand-new connection).
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

                // Preset-managed values follow Application changes. Clearing
                // the field returns it to this automatic mode.
                if (!c.BaseUrlIsUserEntered) {
                    c.BaseUrl = app.urlPlaceholder;
                    urlInput.value = c.BaseUrl;
                }

                refreshKnownSystemTypesFromConnections();
                renderSystemTypeDatalist(view);
                renderSchemaForm(view);
            });

            customTypeInput.addEventListener('input', function (e) {
                c.SystemType = e.target.value;
                refreshKnownSystemTypesFromConnections();
                renderSystemTypeDatalist(view);
                renderSchemaForm(view);
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

            keyInput.addEventListener('input', function (e) {
                c.ApiKey = e.target.value;
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

            var connBadge = document.createElement('span');
            connBadge.className = 'connBadge';
            connBadge.innerText = connectionBadgeText(c);

            var removeBtn = document.createElement('span');
            removeBtn.className = 'ftIconBtn';
            removeBtn.style.cursor = 'pointer';
            removeBtn.innerText = '✕';
            removeBtn.title = 'Remove connection';
            removeBtn.addEventListener('click', function () {
                var ownedSchemas = schemasForConnection(c.Id);
                var ownedSchemaIds = ownedSchemas.map(function (s) { return s.Id; });
                var ownedRuleSets = ruleSetsFile.RuleSets
                    .filter(function (rs) { return ownedSchemaIds.indexOf(rs.EndpointSchemaId) !== -1; });
                var ownedRuleIds = ruleSetsFile.RuleSets
                    .filter(function (rs) { return ownedSchemaIds.indexOf(rs.EndpointSchemaId) !== -1; })
                    .map(function (rs) { return rs.Id; });
                if (folderTreeUsesAnyRuleSet(currentTree && currentTree.RootFolder, ownedRuleIds)) {
                    Dashboard.alert('This connection cannot be removed because a Folder Fetch uses one of its Rule Sets.');
                    return;
                }
                if (!confirm('Remove connection "' + c.DisplayLabel + '" and all of its Schemas and Rule Sets?')) return;
                pendingConnectionRemovals[c.Id] = {
                    Schemas: JSON.parse(JSON.stringify(ownedSchemas)),
                    RuleSets: JSON.parse(JSON.stringify(ownedRuleSets))
                };
                schemas = schemas.filter(function (s) { return s.ConnectionId !== c.Id; });
                ruleSetsFile.RuleSets = ruleSetsFile.RuleSets.filter(function (rs) {
                    return ownedSchemaIds.indexOf(rs.EndpointSchemaId) === -1;
                });
                connections.splice(idx, 1);
                renderConnectionsTab(view);
                renderSchemaConnectionSelect(view);
                renderSchemaForm(view);
                renderConnectionAndSchemaSelects(view);
                refreshConnectionsDirtyState(view);
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
            row.addEventListener('input', function () { refreshConnectionsDirtyState(view); });
            row.addEventListener('change', function () { refreshConnectionsDirtyState(view); });
        });
        refreshConnectionsDirtyState(view);
    }

    function saveConnections(view) {
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
        var selectedSchemaId = currentSchemaId;
        var selectedSchemaConnectionId = view.querySelector('#esConnectionSelect').value;
        var selectedRuleSet = currentRuleSetIndex >= 0 ? ruleSetsFile.RuleSets[currentRuleSetIndex] : null;
        var selectedRuleSetId = selectedRuleSet ? selectedRuleSet.Id : '';
        var localCustomSchemas = schemas.filter(function (s) { return !s.IsBuiltIn; });
        var localCustomRuleSets = ruleSetsFile.RuleSets.filter(function (rs) { return !rs.IsBuiltIn; });
        statusEl.innerText = 'Saving…';

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
                connections = (results[0] && results[0].Connections) || [];
                persistedConnectionIds = {};
                connections.forEach(function (c) { persistedConnectionIds[c.Id] = true; });
                var serverSchemas = (results[1] && results[1].Schemas) || [];
                var serverRuleSets = (results[2] && results[2].RuleSets) || [];
                schemas = localCustomSchemas.concat(serverSchemas.filter(function (s) { return s.IsBuiltIn; }));
                ruleSetsFile = {
                    RuleSets: localCustomRuleSets.concat(serverRuleSets.filter(function (rs) { return rs.IsBuiltIn; }))
                };

                renderConnectionsTab(view);
                renderSchemaConnectionSelect(view);
                if (connections.some(function (c) { return c.Id === selectedSchemaConnectionId; })) {
                    view.querySelector('#esConnectionSelect').value = selectedSchemaConnectionId;
                }
                currentSchemaId = selectedSchemaId;
                renderSchemaSelect(view);
                renderSchemaForm(view);
                renderConnectionAndSchemaSelects(view);
                var selectedRuleIndex = ruleSetsFile.RuleSets.findIndex(function (rs) { return rs.Id === selectedRuleSetId; });
                var matching = ruleSetsForCurrentSchema(view);
                currentRuleSetIndex = selectedRuleIndex >= 0 ? selectedRuleIndex : (matching.length ? matching[0].idx : -1);
                renderRuleSetSelect(view);
                renderCanvasForCurrentIndex(view);
                snapshotConnectionsSaved();
                refreshConnectionsDirtyState(view);
            });
        }).catch(function () {
            statusEl.innerText = 'Save failed — see server log.';
        });
    }

    function exportConnections(view) {
        var panel = view.querySelector('#connImportExportPanel');
        var text = view.querySelector('#connImportExportText');
        var status = view.querySelector('#connImportExportStatus');
        var confirmBtn = view.querySelector('#connImportExportConfirm');
        var exported = {
            Connections: connections.map(function (connection) {
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
            copyTextToClipboard(text.value).then(function () {
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
                    Id: newId(),
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
            panel.style.display = 'none';
            renderConnectionsTab(view);
            renderSchemaConnectionSelect(view);
            renderConnectionAndSchemaSelects(view);
            refreshConnectionsDirtyState(view);
        };
        panel.style.display = '';
        text.focus();
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

                // The field palette (and its auto-hydrated discovery cache)
                // otherwise only ever renders once, at initial page load --
                // switching to this tab later (e.g. after adding a
                // connection, or after a Test click on a previous visit)
                // never picked up newer state without this.
                if (btn.dataset.tab === 'schemas') {
                    renderSchemaForm(view);
                }
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
            persistedConnectionIds = {};
            connections.forEach(function (c) { persistedConnectionIds[c.Id] = true; });
            schemas = (results[1] && results[1].Schemas) || [];
            ruleSetsFile = (results[2] && results[2].RuleSets) ? results[2] : { RuleSets: [] };
            currentTree = results[3];

            refreshKnownSystemTypesFromConnections();
            renderSystemTypeDatalist(view);

            currentSchemaId = schemas.length ? schemas[0].Id : '';
            renderSchemaConnectionSelect(view);
            if (schemas[0]) {
                view.querySelector('#esConnectionSelect').value = schemas[0].ConnectionId;
                renderSchemaSelect(view);
            }
            renderSchemaForm(view);
            snapshotSchemasSaved();
            snapshotRuleSetsSaved();
            snapshotFolderTreeSaved();
            snapshotConnectionsSaved();

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
        activePageView = view;
        view.addEventListener('viewshow', function () {
            applySurfaceBackgroundVariable(view);
            wireTabs(view);
            wireRuleSetToolbar(view);
            loadAll(view);

            view.querySelector('#btnSave').addEventListener('click', function () { saveRuleSets(view); });
            view.querySelector('#rcsDiscardBtn').addEventListener('click', function () { discardRuleSetChanges(view); });
            view.querySelector('#ftSaveBtn').addEventListener('click', function () { saveFolderTree(view); });
            view.querySelector('#ftDiscardBtn').addEventListener('click', function () { discardFolderTreeChanges(view); });

            view.querySelector('#connAddBtn').addEventListener('click', function () {
                var defaultApp = KNOWN_APPLICATIONS[0];
                connections.push({
                    Id: newId(),
                    DisplayLabel: 'New Connection',
                    BaseUrl: '',
                    BaseUrlIsUserEntered: false,
                    ApiKey: '',
                    SystemType: defaultApp.key,
                    ApiKeyParamName: defaultApp.apiKeyParamName,
                    LastTestSucceeded: null,
                    LastTestedUtc: null
                });
                renderConnectionsTab(view);
                renderSchemaConnectionSelect(view);
                renderConnectionAndSchemaSelects(view);
                refreshConnectionsDirtyState(view);
            });
            view.querySelector('#connSaveBtn').addEventListener('click', function () { saveConnections(view); });
            view.querySelector('#connDiscardBtn').addEventListener('click', function () { discardConnectionChanges(view); });
            view.querySelector('#connExport').addEventListener('click', function () { exportConnections(view); });
            view.querySelector('#connImport').addEventListener('click', function () { importConnections(view); });
            view.querySelector('#connImportExportCancel').addEventListener('click', function () {
                view.querySelector('#connImportExportPanel').style.display = 'none';
            });

            view.querySelector('#esNewSchema').addEventListener('click', function () { newSchema(view); });
            view.querySelector('#esDuplicateSchema').addEventListener('click', function () { duplicateSchema(view); });
            view.querySelector('#esRenameSchema').addEventListener('click', function () { renameSchema(view); });
            view.querySelector('#esDeleteSchema').addEventListener('click', function () { deleteSchema(view); });
            view.querySelector('#esExportSchema').addEventListener('click', function () { exportSchema(view); });
            view.querySelector('#esImportSchema').addEventListener('click', function () { importSchema(view); });
            view.querySelector('#esImportExportCancel').addEventListener('click', function () {
                view.querySelector('#esImportExportPanel').style.display = 'none';
            });
            view.querySelector('#esSaveBtn').addEventListener('click', function () { saveEndpointSchemas(view); });
            view.querySelector('#esDiscardBtn').addEventListener('click', function () { discardEndpointSchemaChanges(view); });
            view.querySelector('#rcsImportExportCancel').addEventListener('click', function () {
                view.querySelector('#rcsImportExportPanel').style.display = 'none';
            });

            var ruleRawDetails = view.querySelector('#rcsRawResponse');
            ruleRawDetails.addEventListener('toggle', function () {
                var schemaId = view.querySelector('#rcsSchemaSelect').value;
                if (schemaId) ruleRawExpandedBySchemaId[schemaId] = ruleRawDetails.open;
            });
            view.querySelector('#rcsCopyRawResponse').addEventListener('click', function () {
                var button = view.querySelector('#rcsCopyRawResponse');
                copyTextToClipboard(view.querySelector('#rcsRawResponseText').innerText).then(function () {
                    button.innerText = 'Copied!';
                    setTimeout(function () { button.innerText = 'Copy to clipboard'; }, 1500);
                }).catch(function () {
                    button.innerText = 'Copy blocked';
                });
            });
            view.querySelector('#rcsStripRawResponse').addEventListener('click', function () {
                var schemaId = view.querySelector('#rcsSchemaSelect').value;
                if (!schemaId) return;
                ruleRawStrippedBySchemaId[schemaId] = !ruleRawStrippedBySchemaId[schemaId];
                renderRuleRawResponse(view, schemaId);
            });
        });
    };
});
