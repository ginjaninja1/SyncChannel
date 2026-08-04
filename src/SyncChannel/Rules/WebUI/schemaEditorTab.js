define(['jQuery', 'configurationpage?name=SyncChannelStoreJs',
        'configurationpage?name=SyncChannelEditorSessionJs',
        'configurationpage?name=SyncChannelDragEngineJs',
        'configurationpage?name=SyncChannelFieldDiscoveryJs',
        'configurationpage?name=SyncChannelSharedHelpersJs',
        'configurationpage?name=SyncChannelRuleBuilderTabJs'],
    function ($, store, editorSession, dragEngine, fieldDiscovery, helpers, ruleBuilderTab) {
        'use strict';

        // field.Examples is per-record (Examples[i] = record i's own
        // values, possibly several e.g. two images per movie). Chip
        // tooltips should read the same way as the row-level resolved
        // preview: one line per record, that record's values comma-joined,
        // 'null' when the record had no value — NOT a flattened/deduped
        // pool across records (that would merge distinct records' values
        // together and silently drop "record has no value" information).
        function fieldPerRecordExamples(field) {
            var output = [];
            for (var i = 0; i < 3; i++) {
                var values = field && field.Examples ? field.Examples[i] : null;
                output.push(values && values.length ? values.join(', ') : null);
            }
            return output;
        }

        // Shared floating panel — used ONLY for the "every record resolved
        // to a single image" case (e.g. an Array[0]-sliced field). Same
        // position:fixed panel reused across every anchor rather than one
        // per chip.
        var floatingExamplesPanel = null;
        function ensureFloatingExamplesPanel() {
            if (!floatingExamplesPanel) {
                floatingExamplesPanel = document.createElement('div');
                floatingExamplesPanel.className = 'esMapExamples esMapFloatingExamples';
                document.body.appendChild(floatingExamplesPanel);
            }
            return floatingExamplesPanel;
        }
        function hideFloatingExamples() {
            if (floatingExamplesPanel) floatingExamplesPanel.style.display = 'none';
        }

        // A record's resolved example counts as "an image" only if it is
        // itself a single, bare URL — NOT a comma-joined list (two images
        // for one movie is a list, and lists are text, per the standing
        // "lists are comma joined" rule). This is what previously broke:
        // testing the whole joined string as one unit made any multi-value
        // record fail the image test and silently degrade to text.
        function isSingleImageValue(value, roleHint) {
            return value !== null &&
                /^https?:\/\/\S+$/i.test(value) &&
                (/\.(jpe?g|png|gif|webp|bmp|svg)(?:[?#].*)?$/i.test(value) || /image|poster|thumb|art/i.test(roleHint || ''));
        }

        // Single hover-preview implementation for every anchor that shows
        // resolved examples — the row legend, a mapping's Field chips, a
        // Function/Array badge, and a palette chip all call this the same
        // way, so they look and behave identically. The choice is
        // whole-field, never a per-line mix: only when EVERY non-null
        // record example is a single bare image URL do we show the
        // side-by-side image panel (dark background, as the Array badge
        // always did); anything else — any record being a list, or not
        // image-like — falls back to the plain native title tooltip
        // (stacked lines via '\n', default text, no custom background,
        // exactly how the legend already behaved for non-image fields).
        function updateHoverPreview(anchorEl, examples, roleHint) {
            var nonNull = (examples || []).filter(function (e) { return e !== null; });
            var allImages = nonNull.length > 0 && nonNull.every(function (e) { return isSingleImageValue(e, roleHint); });

            if (allImages) {
                anchorEl.title = '';
                var panel = ensureFloatingExamplesPanel();
                panel.innerHTML = '';
                nonNull.forEach(function (url) {
                    var img = document.createElement('img');
                    img.className = 'esMapExampleImage';
                    img.src = url;
                    img.alt = url;
                    img.title = url;
                    img.addEventListener('error', function () {
                        if (img.parentNode) img.parentNode.removeChild(img);
                    });
                    panel.appendChild(img);
                });
                if (!panel.children.length) { panel.style.display = 'none'; return; }
                var rect = anchorEl.getBoundingClientRect();
                panel.style.display = 'flex';
                panel.style.left = Math.max(4, rect.left) + 'px';
                panel.style.top = (rect.bottom + 6) + 'px';
            } else {
                hideFloatingExamples();
                anchorEl.title = (examples || []).length
                    ? examples.map(function (e) { return e === null ? 'null' : e; }).join('\n')
                    : 'No examples are available for the current mapping.';
            }
        }
        function hideHoverPreview() { hideFloatingExamples(); }

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

        var lastDiscoveryConnBySchemaId = {};
        var lastRawJsonBySchemaId = {};
        var lastArrayCandidatesBySchemaId = {};
        var schemaTestStatusBySchemaId = {};
        var autoSuggestedItemsRootBySchemaId = {};
        var autoSuggestedMappingsBySchemaId = {};
        var schemaDiscoveryBusyBySchemaId = {};
        var rawJsonExpandedBySchemaId = {};
        var rawJsonStrippedBySchemaId = {};

        var ROLE_WARN_IF_LIST = { PosterUrlField: true, MediaFileUrlField: true, ArtistField: true, AlbumArtistField: true };

        function roleFieldWarning(role, fieldType) {
            if (fieldType === 'List' && ROLE_WARN_IF_LIST[role]) {
                return 'This field returns a list -- values would be joined with commas, which probably isn\'t right here. Left assignable for testing, but expect an odd result.';
            }
            return null;
        }

        function emptyMapping() { return { Segments: [] }; }

        function newEmptySchema(connectionId, displayName) {
            return {
                Id: helpers.newId(),
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

        function blockSchemaEntityNavigation() {
            return !editorSession.allowNavigation('schema', null, function (blocked) {
                alert(editorSession.blockedMessage(blocked));
            });
        }

        function renderSchemaSelect(view) {
            var select = view.querySelector('#esSchemaSelect');
            var connectionSelect = view.querySelector('#esConnectionSelect');
            select.innerHTML = '';

            store.schemasForConnection(connectionSelect.value).forEach(function (s) {
                var opt = document.createElement('option');
                opt.value = s.Id;
                opt.innerText = store.schemaOptionLabel(s);
                select.appendChild(opt);
            });

            var allowed = store.schemasForConnection(connectionSelect.value);
            var currentSchemaId = store.get('currentSchemaId');
            if (!allowed.some(function (s) { return s.Id === currentSchemaId; })) {
                currentSchemaId = allowed.length ? allowed[0].Id : '';
                store.set('currentSchemaId', currentSchemaId);
            }
            select.value = currentSchemaId;

            select.onchange = function () {
                if (!editorSession.allowNavigation('schema', null, function (blocked) {
                    alert(editorSession.blockedMessage(blocked));
                })) {
                    select.value = store.get('currentSchemaId');
                    return;
                }
                schemaDiscoveryToken++;
                store.set('currentSchemaId', select.value);
                renderSchemaForm(view);
            };
        }

        function renderSchemaConnectionSelect(view, preferredConnectionId) {
            var select = view.querySelector('#esConnectionSelect');
            var prior = preferredConnectionId || select.value;
            select.innerHTML = '';
            var connections = store.get('connections');
            connections.forEach(function (c) {
                var option = document.createElement('option');
                option.value = c.Id;
                option.innerText = helpers.connectionBadgeGlyph(c) + ' ' + (c.DisplayLabel || '(unnamed connection)');
                select.appendChild(option);
            });
            if (connections.some(function (c) { return c.Id === prior; })) select.value = prior;
            if (!select.value && connections.length) select.value = connections[0].Id;
            lastConnectionSelectValue = select.value;
            if (!select.dataset.wired) {
                select.dataset.wired = '1';
                select.addEventListener('change', function () {
                    if (!editorSession.allowNavigation('connection', null, function (blocked) {
                        alert(editorSession.blockedMessage(blocked));
                    })) {
                        var currentSchema = store.currentSchema();
                        select.value = currentSchema ? currentSchema.ConnectionId : lastConnectionSelectValue;
                        return;
                    }
                    lastConnectionSelectValue = select.value;
                    schemaDiscoveryToken++;
                    store.set('currentSchemaId', '');
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
                markSchemasDirty(activeView);
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
                markSchemasDirty(activeView);
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
                markSchemasDirty(activeView);
            });
            return input;
        }

        var STATIC_MAPPING_CHIPS = [
            { dragKind: 'mapcustomtext', segKind: 'CustomText', label: 'Text', title: 'Literal text; type its value after dropping it into a mapping' },
            { dragKind: 'mapbaseurl', segKind: 'BaseUrl', label: '{baseUrl}', title: 'This connection\'s base URL' },
            { dragKind: 'mapapikeyname', segKind: 'ApiKeyName', label: '{apiKeyName}', title: 'This connection\'s API key parameter name, e.g. "apikey" or "api_key"' },
            { dragKind: 'mapapikeyvalue', segKind: 'ApiKeyValue', label: '{apiKeyValue}', title: 'This connection\'s API key value' }
        ];
        var STATIC_MAPPING_DRAG_KINDS = STATIC_MAPPING_CHIPS.map(function (c) { return c.dragKind; });

        // Function palette presets. Each is dropped either as a fresh empty
        // shell (dropped into empty space in the field builder) or onto an
        // existing node's own drag handle (which wraps that node as the
        // function's single child, keeping whatever was already built).
        // Array defaults to picking the first element; its parameter also
        // accepts ranges, all, and sibling-field matches such as
        // coverType=poster.
        var FUNCTION_PRESETS = [
            { name: 'Left', title: 'Keep the first N characters of whatever this wraps, e.g. Left[4] on "1974-03-03" gives "1974"', defaults: { Function: 'Left', Start: 4, End: -1 } },
            { name: 'Right', title: 'Keep the last N characters of whatever this wraps', defaults: { Function: 'Right', Start: 4, End: -1 } },
            { name: 'Substring', title: 'Keep characters from index Start to End (inclusive) of whatever this wraps', defaults: { Function: 'Substring', Start: 0, End: 3 } },
            { name: 'Array', title: 'Pick list values by index/range, select all, or select the first object matching siblingField=value. Only valid wrapping a single list-type field.', defaults: { Function: 'ArraySlice', Start: 0, End: 0 } }
        ];

        function renderFunctionPaletteChips(container) {
            container.innerHTML = '';
            FUNCTION_PRESETS.forEach(function (preset) {
                var chip = document.createElement('span');
                chip.className = 'rcsChip rcsChip-modifier';
                chip.innerText = preset.name;
                chip.title = preset.title;
                chip.dataset.dragLabel = preset.name;
                dragEngine.makeDraggableSource(chip, 'mapfunction', function () {
                    return JSON.stringify(preset.defaults);
                });
                container.appendChild(chip);
            });
        }

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
                chip.dataset.dragLabel = item.label;
                dragEngine.makeDraggableSource(chip, item.dragKind, item.segKind);
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
                case 'Function': return functionDisplayText(seg);
                default: return '?';
            }
        }

        // Compact text notation for a Function node's own badge + param
        // input, e.g. "Left" chip showing "[4]" beside it, or "Array"
        // chip showing "[0]"/"[0:2]"/"[all]"/"[coverType=poster]".
        // Kept purely for display —
        // parseModifierParamText below is the inverse, used when the param
        // text is edited directly.
        function functionDisplayText(node) {
            switch (node.Function) {
                case 'Left': return 'Left';
                case 'Right': return 'Right';
                case 'Substring': return 'Substring';
                case 'ArraySlice': return 'Array';
                default: return 'fn';
            }
        }

        function formatModifierParamText(node) {
            switch (node.Function) {
                case 'Left':
                case 'Right':
                    return String(node.Start);
                case 'Substring':
                    return node.Start + ':' + node.End;
                case 'ArraySlice':
                    if (node.ArrayMatchField) return node.ArrayMatchField + '=' + (node.ArrayMatchValue || '');
                    if (node.End < 0) return 'all';
                    return node.Start === node.End ? String(node.Start) : (node.Start + ':' + node.End);
                default:
                    return '';
            }
        }

        // Parses just the bracket contents (the part that's actually
        // editable text) back into {Start, End} for the node's existing
        // Function kind — the function itself (Left/Right/Substring/Array)
        // is fixed by which palette chip was dropped, never re-typed.
        function parseModifierParamText(functionKind, text) {
            var t = (text || '').trim();
            if (functionKind === 'ArraySlice') {
                if (/^all$/i.test(t)) return { Start: 0, End: -1, ArrayMatchField: '', ArrayMatchValue: '' };
                var m2 = /^(\d+):(\d+)$/.exec(t);
                if (m2) return { Start: parseInt(m2[1], 10), End: parseInt(m2[2], 10), ArrayMatchField: '', ArrayMatchValue: '' };
                var m1 = /^(\d+)$/.exec(t);
                if (m1) return { Start: parseInt(m1[1], 10), End: parseInt(m1[1], 10), ArrayMatchField: '', ArrayMatchValue: '' };
                var match = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.+)$/.exec(t);
                if (match && match[2].trim()) {
                    return {
                        Start: 0,
                        End: -1,
                        ArrayMatchField: match[1],
                        ArrayMatchValue: match[2].trim()
                    };
                }
                return null;
            }
            if (functionKind === 'Substring') {
                var ms = /^(\d+):(\d+)$/.exec(t);
                return ms ? { Start: parseInt(ms[1], 10), End: parseInt(ms[2], 10) } : null;
            }
            // Left / Right
            var mn = /^(\d+)$/.exec(t);
            return mn ? { Start: parseInt(mn[1], 10), End: -1 } : null;
        }

        // ArraySlice is only meaningful wrapping a single list-typed field.
        // Field types live in the discovery cache, never on persisted mapping
        // nodes; rendering configuration must be a read-only operation.
        function functionNodeValidity(node, fieldByPath) {
            if (node.Kind !== 'Function') return true;
            if (node.Function !== 'ArraySlice') return true;
            if (node.Children.length !== 1 || node.Children[0].Kind !== 'Field') return false;
            if (node.ArrayMatchField && !node.ArrayMatchValue) return false;
            var field = fieldByPath && fieldByPath[node.Children[0].Value];
            var type = field && field.Type;
            return type === undefined || type === 'List';
        }

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
            var indicator = dragEngine.ensureInsertionIndicator();
            indicator.style.display = 'block';
            indicator.style.left = x + 'px';
            indicator.style.top = indicatorTop + 'px';
            indicator.style.width = '3px';
            indicator.style.height = indicatorHeight + 'px';
        }

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
                dragEngine.makeDraggableSource(mappingHandle, 'mapmapping', function () {
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
                    markSchemasDirty(activeView);
                    renderSegments();
                });
                line.appendChild(clearBtn);
            }

            var valueEl = document.createElement('span');
            valueEl.className = 'rcsSlot rcsSlot-field esMapValue';
            line.appendChild(valueEl);

            row.appendChild(line);

            var warnEl = document.createElement('div');
            warnEl.className = 'fieldDescription';
            warnEl.style.color = '#e0a030';
            row.appendChild(warnEl);

            function fieldsByPath() {
                var fields = mapperConnId ? fieldDiscovery.getDiscoveredFields(mapperConnId, schemaId) : null;
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

            // Mirrors HttpFetchProvider's C# resolution logic for preview
            // purposes only — the server is always the source of truth for
            // the actual resolved value. Operates on the node tree directly:
            // a Function node concatenates its Children's preview text (or,
            // for ArraySlice, reads its single Field child's raw example
            // list directly and optionally aligns it with a sibling field),
            // then applies its own operation.
            // Returns the raw record-record's example values for `field` at
            // `exampleIndex` (record 0/1/2), or null if that field wasn't
            // discovered or that particular record had no value at this
            // path — never falls back to another record's value.
            function fieldExampleRecord(field, exampleIndex) {
                if (!field || !field.Examples || !field.Examples[exampleIndex]) return null;
                var values = field.Examples[exampleIndex];
                return values.length ? values : null;
            }

            function previewResolveNode(node, fbp, connection, exampleIndex) {
                switch (node.Kind) {
                    case 'Field':
                        var field = fbp[node.Value];
                        var recordValues = fieldExampleRecord(field, exampleIndex);
                        if (recordValues === null) return { text: null, hasFieldValue: false };
                        return { text: recordValues.join(', '), hasFieldValue: true };
                    case 'CustomText':
                        return { text: node.Value || '', hasFieldValue: false };
                    case 'BaseUrl':
                        return { text: (connection && connection.BaseUrl) || '', hasFieldValue: false };
                    case 'ApiKeyName':
                        return { text: (connection && connection.ApiKeyParamName) || '', hasFieldValue: false };
                    case 'ApiKeyValue':
                        return { text: (connection && connection.ApiKey) ? '\u2022\u2022\u2022\u2022\u2022\u2022' : '', hasFieldValue: false };
                    case 'Identity':
                        return { text: '{identity}', hasFieldValue: false };
                    case 'Function':
                        return previewResolveFunction(node, fbp, connection, exampleIndex);
                    default:
                        return { text: '', hasFieldValue: false };
                }
            }

            function previewResolveFunction(node, fbp, connection, exampleIndex) {
                if (node.Function === 'ArraySlice') {
                    if (node.Children.length === 1 && node.Children[0].Kind === 'Field') {
                        var field = fbp[node.Children[0].Value];
                        var recordValues = fieldExampleRecord(field, exampleIndex);
                        if (recordValues === null) return { text: null, hasFieldValue: false };

                        if (node.ArrayMatchField) {
                            var resultPath = node.Children[0].Value || '';
                            var lastDot = resultPath.lastIndexOf('.');
                            if (lastDot < 1) return { text: null, hasFieldValue: false };
                            var arrayPath = resultPath.slice(0, lastDot);
                            var matchPath = node.ArrayMatchField.indexOf('.') >= 0
                                ? node.ArrayMatchField
                                : arrayPath + '.' + node.ArrayMatchField;
                            var matchValues = fieldExampleRecord(fbp[matchPath], exampleIndex);
                            if (matchValues === null) return { text: null, hasFieldValue: false };
                            var wanted = String(node.ArrayMatchValue || '').toLowerCase();
                            for (var i = 0; i < matchValues.length; i++) {
                                if (String(matchValues[i]).toLowerCase() === wanted && i < recordValues.length) {
                                    return { text: recordValues[i], hasFieldValue: true };
                                }
                            }
                            return { text: null, hasFieldValue: false };
                        }

                        var sliced = node.End < 0 ? recordValues : recordValues.slice(
                            Math.max(0, Math.min(node.Start, recordValues.length - 1)),
                            Math.max(0, Math.min(node.End, recordValues.length - 1)) + 1
                        );
                        return sliced.length
                            ? { text: sliced.join(', '), hasFieldValue: true }
                            : { text: null, hasFieldValue: false };
                    }
                    return { text: null, hasFieldValue: false };
                }
                var hasFieldValue = false;
                var joined = node.Children.map(function (c) {
                    var r = previewResolveNode(c, fbp, connection, exampleIndex);
                    if (r.hasFieldValue) hasFieldValue = true;
                    return r.text;
                }).join('');
                return { text: applyStringFunctionPreview(joined, node), hasFieldValue: hasFieldValue };
            }

            function applyStringFunctionPreview(value, node) {
                if (!value) return value || '';
                if (node.Function === 'Left') return value.slice(0, Math.max(0, node.Start));
                if (node.Function === 'Right') {
                    var n = Math.max(0, Math.min(node.Start, value.length));
                    return value.slice(value.length - n);
                }
                if (node.Function === 'Substring') {
                    var s = Math.max(0, Math.min(node.Start, value.length));
                    var e = Math.max(s, Math.min(node.End, value.length - 1));
                    return value.slice(s, e + 1);
                }
                return value;
            }

            // One line per source record (0/1/2), not deduped away — a
            // record that had no value for the mapped field(s) shows as
            // null rather than being dropped or silently repeating another
            // record's value. Exception: a mapping with no field/slice
            // segments at all (pure literal text) resolves identically for
            // every record, so that case collapses to a single line instead
            // of showing the same text three times.
            function resolvedExamples() {
                var fbp = fieldsByPath();
                var connection = mapperConnId ? store.findConnection(mapperConnId) : null;
                var perRecord = [];
                var anyFieldValue = false;
                for (var exampleIndex = 0; exampleIndex < 3; exampleIndex++) {
                    var hasFieldValue = false;
                    var value = mapping.Segments.map(function (seg) {
                        var r = previewResolveNode(seg, fbp, connection, exampleIndex);
                        if (r.hasFieldValue) hasFieldValue = true;
                        return r.text;
                    }).join('');
                    if (hasFieldValue) anyFieldValue = true;
                    perRecord.push({ value: value, hasFieldValue: hasFieldValue });
                }

                if (!anyFieldValue) {
                    return perRecord[0].value ? [perRecord[0].value] : [];
                }

                return perRecord.map(function (r) { return r.hasFieldValue ? r.value : null; });
            }

            // Same idea as resolvedExamples() above, but scoped to a single
            // node rather than the whole mapping — used for the hover
            // preview on a Function chip's own badge (e.g. Array), so
            // hovering "Array[0]" shows what that slice actually resolves
            // to per record, not the whole field's mapping.
            function nodeResolvedExamples(node) {
                var fbp = fieldsByPath();
                var connection = mapperConnId ? store.findConnection(mapperConnId) : null;
                var output = [];
                for (var exampleIndex = 0; exampleIndex < 3; exampleIndex++) {
                    var r = previewResolveNode(node, fbp, connection, exampleIndex);
                    output.push(r.hasFieldValue ? r.text : null);
                }
                return output;
            }

            function showLegendPreview() {
                updateHoverPreview(legend, resolvedExamples(), warnRoleKey || labelText);
            }
            legend.addEventListener('mouseenter', showLegendPreview);
            legend.addEventListener('mouseleave', hideHoverPreview);
            legend.addEventListener('focus', showLegendPreview);
            legend.addEventListener('blur', hideHoverPreview);

            // ---- Recursive node-tree rendering ----

            // Renders `nodesArray` (mapping.Segments, or some Function
            // node's own Children) into `containerEl` and wires its
            // insertion-anchor drop targets. isRoot controls whether the
            // whole-mapping drag handle and the hover-examples element are
            // included alongside the chips (only true at the top level).
            function renderNodeList(containerEl, nodesArray, fbp, connection, isRoot) {
                containerEl.innerHTML = '';

                if (isRoot && mappingHandle) containerEl.appendChild(mappingHandle);

                if (!nodesArray.length) {
                    var empty = document.createElement('span');
                    empty.className = 'fieldDescription esMapEmptyHint';
                    empty.innerText = locked ? '(unmapped)' : (isRoot ? 'drop a building block here \u2192' : 'drop something inside \u2192');
                    containerEl.appendChild(empty);
                }

                nodesArray.forEach(function (node, idx) {
                    containerEl.appendChild(renderNode(node, nodesArray, idx, fbp, connection));
                });

                if (!locked) wireContainerDropTargets(containerEl, nodesArray);
            }

            function renderNode(node, parentArray, idx, fbp, connection) {
                if (node.Kind === 'Function') {
                    return renderFunctionNode(node, parentArray, idx, fbp, connection);
                }

                var chip = document.createElement('span');
                chip.className = 'rcsChip esMapSeg esMapSeg-' + node.Kind.toLowerCase();

                if (!locked) {
                    var dragHandle = document.createElement('span');
                    dragHandle.className = 'esMapDragHandle';
                    dragHandle.innerText = '\u2630';
                    dragHandle.dataset.dragLabel = mappingSegmentLabel(node, fbp);
                    dragHandle.title = 'Drag to move within this field, or copy to another field. Drop a function chip here to wrap this in it.';
                    dragEngine.makeDraggableSource(dragHandle, 'mapseg', function () {
                        return JSON.stringify({ SourceId: mappingDragId, Path: nodePath(node), Node: node });
                    }, function () { return chip; });
                    chip.appendChild(dragHandle);

                    // Wrap target: dropping a function preset directly onto
                    // THIS node's own handle wraps just this node — distinct
                    // from the container-level before/after insertion drop
                    // targets (wireContainerDropTargets), which only insert
                    // beside things, never wrap them.
                    dragEngine.registerDropTarget(dragHandle, ['mapfunction'], function (rawValue) {
                        wrapNodeWithFunction(node, parentArray, idx, rawValue);
                    });
                }

                if (node.Kind === 'CustomText' && !locked) {
                    var input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'esMapTextInput';
                    input.value = node.Value || '';
                    input.placeholder = 'text';
                    input.size = Math.min(20, Math.max(3, (node.Value || '').length));
                    chip.title = 'Literal text: ' + (node.Value || '(empty)');
                    input.addEventListener('input', function (e) {
                        node.Value = e.target.value;
                        input.size = Math.min(20, Math.max(3, e.target.value.length));
                        chip.title = 'Literal text: ' + (e.target.value || '(empty)');
                        markSchemasDirty(activeView);
                    });
                    chip.appendChild(input);
                } else {
                    var textSpan = document.createElement('span');
                    textSpan.innerText = mappingSegmentLabel(node, fbp);
                    chip.appendChild(textSpan);
                    if (node.Kind === 'Field') {
                        var field = fbp[node.Value];
                        chip.addEventListener('mouseenter', function () {
                            updateHoverPreview(chip, nodeResolvedExamples(node), warnRoleKey || labelText);
                        });
                        chip.addEventListener('mouseleave', hideHoverPreview);
                    } else if (node.Kind === 'BaseUrl') {
                        chip.title = 'Value: ' + ((connection && connection.BaseUrl) || '(not set)');
                    } else if (node.Kind === 'ApiKeyName') {
                        chip.title = 'Value: ' + ((connection && connection.ApiKeyParamName) || '(not set)');
                    } else if (node.Kind === 'ApiKeyValue') {
                        chip.title = 'Value: ' + ((connection && connection.ApiKey) ? '(configured API key — hidden)' : '(not set)');
                    } else if (node.Kind === 'Identity') {
                        chip.title = 'Value: the resolved Identity field for this item';
                    }
                }

                if (!locked) {
                    var xBtn = document.createElement('span');
                    xBtn.className = 'esMapSegRemove';
                    xBtn.innerText = '\u2715';
                    xBtn.title = 'Remove this piece';
                    xBtn.addEventListener('click', function () {
                        parentArray.splice(idx, 1);
                        markSchemasDirty(activeView);
                        renderSegments();
                        refreshWarning();
                    });
                    chip.appendChild(xBtn);
                }

                return chip;
            }

            function renderFunctionNode(node, parentArray, idx, fbp, connection) {
                var wrap = document.createElement('span');
                var valid = functionNodeValidity(node, fbp);
                wrap.className = 'rcsChip esMapSeg esMapSeg-function ' + (valid ? 'rcsChip-modifier' : 'rcsChip-modifier-invalid');
                wrap.dataset.mapNodeValid = valid ? '1' : '0';

                if (!locked) {
                    var dragHandle = document.createElement('span');
                    dragHandle.className = 'esMapDragHandle';
                    dragHandle.innerText = '\u2630';
                    dragHandle.dataset.dragLabel = functionDisplayText(node);
                    dragHandle.title = 'Drag to move this function (and everything inside it). Drop another function chip here to wrap it further.';
                    dragEngine.makeDraggableSource(dragHandle, 'mapseg', function () {
                        return JSON.stringify({ SourceId: mappingDragId, Path: nodePath(node), Node: node });
                    }, function () { return wrap; });
                    wrap.appendChild(dragHandle);

                    dragEngine.registerDropTarget(dragHandle, ['mapfunction'], function (rawValue) {
                        wrapNodeWithFunction(node, parentArray, idx, rawValue);
                    });
                }

                var badge = document.createElement('span');
                badge.className = 'esMapFunctionBadge';
                badge.innerText = functionDisplayText(node);
                badge.title = valid
                    ? 'Function applied to whatever is inside the brackets.'
                    : 'Array only works wrapping a single list-type field — this won\'t resolve to anything as configured. Saving is blocked until this is fixed.';
                badge.addEventListener('mouseenter', function () {
                    if (valid) updateHoverPreview(badge, nodeResolvedExamples(node), warnRoleKey || labelText);
                });
                badge.addEventListener('mouseleave', hideHoverPreview);
                wrap.appendChild(badge);

                var paramInput = document.createElement('input');
                paramInput.type = 'text';
                paramInput.className = 'esMapModifierInput';
                paramInput.value = formatModifierParamText(node);
                paramInput.disabled = !!locked;
                paramInput.title = node.Function === 'ArraySlice'
                    ? 'Index, start:end, "all", or siblingField=value — e.g. 0, 0:1, all, coverType=poster'
                    : 'Character count' + (node.Function === 'Substring' ? ' as start:end' : '');
                paramInput.addEventListener('input', function (e) {
                    var parsed = parseModifierParamText(node.Function, e.target.value);
                    if (!parsed) { paramInput.classList.add('esMapModifierInvalid'); return; }
                    paramInput.classList.remove('esMapModifierInvalid');
                    node.Start = parsed.Start;
                    node.End = parsed.End;
                    if (node.Function === 'ArraySlice') {
                        node.ArrayMatchField = parsed.ArrayMatchField || '';
                        node.ArrayMatchValue = parsed.ArrayMatchValue || '';
                    }
                    markSchemasDirty(activeView);
                });
                paramInput.addEventListener('blur', function () {
                    if (paramInput.classList.contains('esMapModifierInvalid')) {
                        paramInput.value = formatModifierParamText(node);
                        paramInput.classList.remove('esMapModifierInvalid');
                    }
                });
                wrap.appendChild(paramInput);

                var openBracket = document.createElement('span');
                openBracket.innerText = '[';
                wrap.appendChild(openBracket);

                var childrenEl = document.createElement('span');
                childrenEl.className = 'esMapFunctionChildren';
                wrap.appendChild(childrenEl);

                var closeBracket = document.createElement('span');
                closeBracket.innerText = ']';
                wrap.appendChild(closeBracket);

                if (!locked) {
                    var unwrapBtn = document.createElement('span');
                    unwrapBtn.className = 'esMapSegRemove';
                    unwrapBtn.innerText = '\u21b1';
                    unwrapBtn.title = 'Unwrap: remove just this function, keeping what\'s inside it';
                    unwrapBtn.addEventListener('click', function () {
                        Array.prototype.splice.apply(parentArray, [idx, 1].concat(node.Children));
                        markSchemasDirty(activeView);
                        renderSegments();
                    });
                    wrap.appendChild(unwrapBtn);

                    var xBtn = document.createElement('span');
                    xBtn.className = 'esMapSegRemove';
                    xBtn.innerText = '\u2715';
                    xBtn.title = 'Remove this function AND everything inside it';
                    xBtn.addEventListener('click', function () {
                        parentArray.splice(idx, 1);
                        markSchemasDirty(activeView);
                        renderSegments();
                        refreshWarning();
                    });
                    wrap.appendChild(xBtn);
                }

                renderNodeList(childrenEl, node.Children, fbp, connection, false);

                return wrap;
            }

            // Locates a node's path — an array of indices from
            // mapping.Segments down to this exact node — by searching the
            // tree. Used as the drag payload's move-target reference
            // instead of a flat index, since a node can live at any depth.
            function nodePath(target, nodes, prefix) {
                nodes = nodes || mapping.Segments;
                prefix = prefix || [];
                for (var i = 0; i < nodes.length; i++) {
                    if (nodes[i] === target) return prefix.concat(i);
                    if (nodes[i].Kind === 'Function') {
                        var found = nodePath(target, nodes[i].Children, prefix.concat(i));
                        if (found) return found;
                    }
                }
                return null;
            }

            function arrayAndIndexForPath(path) {
                var nodes = mapping.Segments;
                for (var i = 0; i < path.length - 1; i++) {
                    nodes = nodes[path[i]].Children;
                }
                return { array: nodes, index: path[path.length - 1] };
            }

            function wrapNodeWithFunction(node, parentArray, idx, rawPresetValue) {
                var preset;
                try { preset = JSON.parse(rawPresetValue); } catch (e) { return; }
                if (!preset || !preset.Function) return;
                var fnNode = {
                    Kind: 'Function',
                    Function: preset.Function,
                    Start: preset.Start,
                    End: preset.End,
                    Children: [node]
                };
                parentArray.splice(idx, 1, fnNode);
                markSchemasDirty(activeView);
                renderSegments();
            }

            // True if `arr` is `node`'s own Children array (at any depth) —
            // prevents dropping a function inside its own children, which
            // would otherwise splice it out of the tree it's still nested
            // within and corrupt the structure.
            function isDescendantArray(node, arr) {
                if (node.Kind !== 'Function') return false;
                if (node.Children === arr) return true;
                return node.Children.some(function (c) { return isDescendantArray(c, arr); });
            }

            function cloneNode(node) {
                var copy = { Kind: node.Kind, Value: node.Value || '' };
                if (node.Kind === 'Function') {
                    copy.Function = node.Function;
                    copy.Start = node.Start;
                    copy.End = node.End;
                    copy.Children = (node.Children || []).map(cloneNode);
                }
                return copy;
            }

            function wireContainerDropTargets(containerEl, nodesArray) {
                var onHover = function (clientX, clientY, reorderElement) {
                    showMappingInsertionIndicator(containerEl, clientX, reorderElement, clientY);
                };

                // Insert a brand-new leaf (field/text/apikey/baseurl) or an
                // empty function shell at the anchor point.
                dragEngine.registerDropTarget(containerEl, ['field'].concat(STATIC_MAPPING_DRAG_KINDS).concat(['mapfunction']), function (rawValue, reorderElement, clientYIgnored, clientX) {
                    var parsed = null;
                    try { parsed = JSON.parse(rawValue); } catch (e) { /* not JSON */ }

                    var node;
                    if (parsed && parsed.path) {
                        node = { Kind: 'Field', Value: parsed.path };
                    } else if (parsed && parsed.Function) {
                        node = { Kind: 'Function', Function: parsed.Function, Start: parsed.Start, End: parsed.End, Children: [] };
                    } else {
                        node = { Kind: rawValue, Value: '' };
                    }

                    var insertAt = findMappingInsertionIndex(containerEl, clientX, null, clientYIgnored);
                    nodesArray.splice(insertAt, 0, node);
                    renderSegments();
                    markSchemasDirty(activeView);
                    if (node.Kind === 'CustomText') {
                        var inputs = containerEl.querySelectorAll('.esMapTextInput');
                        if (inputs.length) inputs[Math.min(insertAt, inputs.length - 1)].focus();
                    }
                }, 'rcsDragOver', onHover);

                // Move an existing node (leaf, or a whole function subtree)
                // here from elsewhere in the SAME mapping, or copy one in
                // from a different field's mapping.
                dragEngine.registerDropTarget(containerEl, ['mapseg'], function (value, reorderElement, clientYIgnored, clientX) {
                    var payload;
                    try { payload = JSON.parse(value); } catch (e) { return; }
                    if (!payload || !payload.Node) return;
                    var toIdx = findMappingInsertionIndex(
                        containerEl,
                        clientX,
                        payload.SourceId === mappingDragId ? reorderElement : null,
                        clientYIgnored
                    );
                    if (payload.SourceId === mappingDragId && payload.Path) {
                        if (isDescendantArray(payload.Node, nodesArray)) return;
                        var loc = arrayAndIndexForPath(payload.Path);
                        var moved = loc.array.splice(loc.index, 1)[0];
                        if (!moved) return;
                        nodesArray.splice(toIdx, 0, moved);
                    } else {
                        nodesArray.splice(toIdx, 0, cloneNode(payload.Node));
                    }
                    renderSegments();
                    markSchemasDirty(activeView);
                }, 'rcsDragOver', onHover);

                dragEngine.registerDropTarget(containerEl, ['mapmapping'], function (value, reorderElement, clientY, clientX) {
                    var payload;
                    try { payload = JSON.parse(value); } catch (e) { return; }
                    if (!payload || !Array.isArray(payload.Segments) || payload.SourceId === mappingDragId) return;
                    var copied = payload.Segments.map(cloneNode);
                    var insertAt = findMappingInsertionIndex(containerEl, clientX, null, clientY);
                    Array.prototype.splice.apply(nodesArray, [insertAt, 0].concat(copied));
                    renderSegments();
                    markSchemasDirty(activeView);
                }, 'rcsDragOver', onHover);
            }

            function renderSegments() {
                renderNodeList(valueEl, mapping.Segments, fieldsByPath(), mapperConnId ? store.findConnection(mapperConnId) : null, true);
                refreshWarning();
                refreshSchemaDirtyState(activeView);
            }

            if (!locked) {
                dragEngine.registerDropTarget(mappingHandle, ['mapmapping'], function (value) {
                    var payload;
                    try { payload = JSON.parse(value); } catch (e) { return; }
                    if (!payload || !Array.isArray(payload.Segments) || payload.SourceId === mappingDragId) return;
                    mapping.Segments = payload.Segments.map(cloneNode);
                    renderSegments();
                    markSchemasDirty(activeView);
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

        function renderSchemaPaletteChips(view, connectionId, schemaId, targetContainer) {
            var chipsWrap = targetContainer || view.querySelector('#esPaletteChips');
            if (!chipsWrap) return;
            chipsWrap.innerHTML = '';

            var fields = fieldDiscovery.getDiscoveredFields(connectionId, schemaId) || [];

            ruleBuilderTab.sortSchemaFields(fields).forEach(function (f) {
                var chip = ruleBuilderTab.makeFieldChip(f.JsonPath, f.DisplayName, f.Type, !!f.IsFavorite, function () {
                    var current = fieldDiscovery.getDiscoveredFields(connectionId, schemaId) || [];
                    var field = current.filter(function (x) { return x.JsonPath === f.JsonPath; })[0];
                    if (!field) return;
                    field.IsFavorite = !field.IsFavorite;
                    fieldDiscovery.setDiscoveredFields(connectionId, schemaId, ruleBuilderTab.sortSchemaFields(current));
                    renderSchemaPaletteChips(view, connectionId, schemaId, chipsWrap);
                    ruleBuilderTab.persistFieldFavorite(schemaId, f.JsonPath, field.IsFavorite);
                });

                chip.addEventListener('mouseenter', function () {
                    updateHoverPreview(chip, fieldPerRecordExamples(f), f.DisplayName || f.JsonPath);
                });
                chip.addEventListener('mouseleave', hideHoverPreview);

                chipsWrap.appendChild(chip);
            });
        }

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
            var fields = connId ? fieldDiscovery.getDiscoveredFields(connId, schema.Id) : null;

            var paletteFlow = document.createElement('div');
            paletteFlow.className = 'esPaletteFlow';
            wrap.appendChild(paletteFlow);

            var staticChipsWrap = document.createElement('div');
            staticChipsWrap.id = 'esStaticPaletteChips';
            paletteFlow.appendChild(staticChipsWrap);
            renderStaticMappingChips(staticChipsWrap, store.findConnection(schema.ConnectionId));

            var functionChipsWrap = document.createElement('div');
            functionChipsWrap.id = 'esFunctionPaletteChips';
            paletteFlow.appendChild(functionChipsWrap);
            renderFunctionPaletteChips(functionChipsWrap);

            var chipsWrap = document.createElement('div');
            chipsWrap.id = 'esPaletteChips';
            paletteFlow.appendChild(chipsWrap);

            function renderRawJson() {
                rawJsonHolder.innerHTML = '';
                var rawJson = lastRawJsonBySchemaId[schema.Id];
                if (!rawJson) return;

                var details = document.createElement('details');
                details.style.marginTop = '0.8em';
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
                    helpers.copyTextToClipboard(text).then(done).catch(function () {
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

            renderRawJson();

            if (fields && fields.length) {
                renderSchemaPaletteChips(view, connId, schema.Id, chipsWrap);
            } else if (!schemaDiscoveryBusyBySchemaId[schema.Id] &&
                !(lastArrayCandidatesBySchemaId[schema.Id] && lastArrayCandidatesBySchemaId[schema.Id].length) &&
                schema.Path && schema.ConnectionId) {
                var owningConnection = store.findConnection(schema.ConnectionId);
                if (owningConnection) {
                    var requestedSchemaId = schema.Id;
                    ApiClient.ajax({
                        type: 'POST',
                        url: ApiClient.getUrl('ChannelSync/DiscoverFields'),
                        data: JSON.stringify({ EndpointSchemaId: schema.Id, ForceRefresh: false, DraftSchema: schema }),
                        contentType: 'application/json',
                        dataType: 'json'
                    }).then(function (result) {
                        if (store.get('currentSchemaId') !== requestedSchemaId) return;
                        if (result && result.Success !== false && result.Fields && result.Fields.length) {
                            fieldDiscovery.setDiscoveredFields(owningConnection.Id, schema.Id, result.Fields);
                            lastDiscoveryConnBySchemaId[schema.Id] = owningConnection.Id;
                            lastRawJsonBySchemaId[schema.Id] = result.RawJson || '';
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

            if (!store.currentSchema()) {
                refreshSchemaDirtyState(view);
                return;
            }

            var schema = store.currentSchema();
            var isBuiltInTemplate = !!schema.IsBuiltIn;
            var locked = isBuiltInTemplate;

            if (isBuiltInTemplate) {
                var lockNotice = document.createElement('div');
                lockNotice.className = 'fieldDescription';
                lockNotice.style.marginBottom = '0.8em';
                lockNotice.innerText = 'This is a read-only built-in template. Use Duplicate to create an editable custom Schema.';
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
                renderSchemaForm(view);
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

            var mapperConnId = schema.ConnectionId;

            container.appendChild(buildMappingRow(schema.IdentityField, mapperConnId, schema.Id, 'Identity field',
                locked ? 'Required. A stable, unique id -- items without one are dropped.'
                    : 'Required. A stable, unique id -- items without one are dropped. Build from 1+ pieces below, e.g. a single Field piece, or Field + CustomText if the raw value alone isn\'t unique enough.',
                locked, 'IdentityField'));
            container.appendChild(buildMappingRow(schema.TitleField, mapperConnId, schema.Id, 'Title field', null, locked, 'TitleField'));
            container.appendChild(buildMappingRow(schema.OriginalTitleField, mapperConnId, schema.Id, 'Original title field', null, locked, 'OriginalTitleField'));
            container.appendChild(buildMappingRow(schema.YearField, mapperConnId, schema.Id, 'Year field', null, locked, 'YearField'));
            container.appendChild(buildMappingRow(schema.OverviewField, mapperConnId, schema.Id, 'Overview field', null, locked, 'OverviewField'));
            container.appendChild(buildMappingRow(schema.PosterUrlField, mapperConnId, schema.Id, 'Poster URL field', null, locked, 'PosterUrlField'));

            if (schema.ObjectKind === 'MusicArtistAlbum') {
                container.appendChild(buildMappingRow(schema.ArtistField, mapperConnId, schema.Id, 'Artist field', null, locked, null));
                container.appendChild(buildMappingRow(schema.AlbumArtistField, mapperConnId, schema.Id, 'Album artist field', null, locked, null));
                container.appendChild(buildMappingRow(schema.AlbumField, mapperConnId, schema.Id, 'Album field', null, locked, null));
            }

            if (schema.ObjectKind === 'PhotoAlbum') {
                container.appendChild(buildMappingRow(schema.MediaFileUrlField, mapperConnId, schema.Id, 'Media file URL field',
                    'The actual image file URL -- distinct from Poster URL, which is a thumbnail. Same build-a-URL-from-pieces approach as Poster URL field above, if the source doesn\'t already return a ready-to-use URL.', locked, null));
            }

            if (schema.ObjectKind === 'GenericContainer') {
                container.appendChild(esLabeledRow('Container level count', esNumberInput(schema.ContainerLevelCount, locked, function (v) {
                    schema.ContainerLevelCount = v;
                    renderSchemaForm(view);
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

        function buildProviderIdFieldsEditor(view, schema, mapperConnId, locked) {
            if (!schema.ProviderIdFields) schema.ProviderIdFields = {};
            if (!schema.BadgeEnabledProviderIdKeys) schema.BadgeEnabledProviderIdKeys = [];
            if (!schema.ProviderIdBadgeUrlFormats) schema.ProviderIdBadgeUrlFormats = {};

            var wrap = document.createElement('div');
            wrap.style.marginBottom = '0.9em';

            var label = document.createElement('label');
            label.innerText = 'Provider ID fields';
            label.style.display = 'block';
            label.style.marginBottom = '0.3em';
            wrap.appendChild(label);

            // Only keys this plugin has zero-guessing certainty about: its
            // own compiled IExternalId classes (RadarrExternalId,
            // SonarrExternalId). Deliberately NOT reserving Tmdb/Imdb/Tvdb or
            // any other Emby-native key — that would require confirmed
            // knowledge of Emby's full built-in IExternalId roster, which
            // isn't available here. An admin naming a custom field "Tmdb"
            // and enabling our badge for it just produces a harmless
            // duplicate badge alongside Emby's own native one — an
            // acceptable, fail-safe edge case rather than a guess dressed up
            // as a rule.
            var RESERVED_BADGE_KEYS = ['radarrid', 'sonarrid'];
            var BADGE_SLOT_COUNT = 5;

            function allEnabledBadgeKeysAcrossSchemas(excludeSchemaId, excludeKey) {
                var keys = [];
                store.get('schemas').forEach(function (s) {
                    (s.BadgeEnabledProviderIdKeys || []).forEach(function (k) {
                        if (s.Id === excludeSchemaId && k === excludeKey) return;
                        keys.push(k.toLowerCase());
                    });
                });
                return keys;
            }

            Object.keys(schema.ProviderIdFields).forEach(function (key) {
                var mapping = schema.ProviderIdFields[key];
                if (!mapping || !mapping.Segments) {
                    mapping = { Segments: [] };
                    schema.ProviderIdFields[key] = mapping;
                }

                var providerBlock = document.createElement('div');
                providerBlock.className = 'esProviderIdBlock';

                // ---- Row 1: Name (+ badge toggle + remove) — controls that
                // belong to the PROVIDER as a whole, not to its value. ----
                var nameRow = document.createElement('div');
                nameRow.className = 'esProviderIdKeyRow';

                var nameRowLabel = document.createElement('span');
                nameRowLabel.className = 'esProviderIdRowLabel';
                nameRowLabel.innerText = 'Name';
                nameRow.appendChild(nameRowLabel);

                var keyInput = document.createElement('input');
                keyInput.type = 'text';
                keyInput.style.width = '10em';
                keyInput.value = key;
                keyInput.placeholder = 'e.g. Tmdb';
                keyInput.disabled = !!locked;
                keyInput.title = 'Stored under this name in ProviderIds. Some names (Tmdb, Imdb) are already recognised with a built-in Emby badge; any other name still works internally, it just needs the Badge toggle here to also show one.';
                keyInput.addEventListener('change', function (e) {
                    var newKey = e.target.value;
                    if (!newKey || newKey === key || schema.ProviderIdFields.hasOwnProperty(newKey)) { e.target.value = key; return; }
                    schema.ProviderIdFields[newKey] = schema.ProviderIdFields[key];
                    delete schema.ProviderIdFields[key];
                    var badgeIdx = schema.BadgeEnabledProviderIdKeys.indexOf(key);
                    if (badgeIdx >= 0) schema.BadgeEnabledProviderIdKeys[badgeIdx] = newKey;
                    if (schema.ProviderIdBadgeUrlFormats.hasOwnProperty(key)) {
                        schema.ProviderIdBadgeUrlFormats[newKey] = schema.ProviderIdBadgeUrlFormats[key];
                        delete schema.ProviderIdBadgeUrlFormats[key];
                    }
                    markSchemasDirty(view);
                    renderSchemaForm(view);
                    focusProviderIdValueInputAfterRename(view, newKey);
                });
                nameRow.appendChild(keyInput);

                var isReserved = RESERVED_BADGE_KEYS.indexOf(key.toLowerCase()) >= 0;
                var badgeLabel = document.createElement('label');
                badgeLabel.className = 'esBadgeToggleLabel';
                var badgeToggle = document.createElement('input');
                badgeToggle.type = 'checkbox';
                badgeToggle.disabled = !!locked || isReserved;
                badgeToggle.checked = schema.BadgeEnabledProviderIdKeys.indexOf(key) >= 0;
                var atCapacity = allEnabledBadgeKeysAcrossSchemas(schema.Id, key).length >= BADGE_SLOT_COUNT;
                if (isReserved) {
                    badgeLabel.title = 'Already has a built-in badge (RadarrId/SonarrId) — no toggle needed.';
                } else if (!badgeToggle.checked && atCapacity) {
                    badgeToggle.disabled = true;
                    badgeLabel.title = 'All 5 provider-id badge slots are in use. Turn one off elsewhere, or ask for the slot pool to be increased (requires a rebuild + restart).';
                } else {
                    badgeLabel.title = 'Show this as a clickable provider-id badge under Edit Metadata in the Emby client.';
                }
                badgeToggle.addEventListener('change', function (e) {
                    var idx = schema.BadgeEnabledProviderIdKeys.indexOf(key);
                    if (e.target.checked && idx < 0) schema.BadgeEnabledProviderIdKeys.push(key);
                    if (!e.target.checked && idx >= 0) schema.BadgeEnabledProviderIdKeys.splice(idx, 1);
                    markSchemasDirty(view);
                    renderSchemaForm(view);
                });
                badgeLabel.appendChild(badgeToggle);
                badgeLabel.appendChild(document.createTextNode(' Badge'));
                nameRow.appendChild(badgeLabel);

                if (!locked) {
                    var removeBtn = document.createElement('span');
                    removeBtn.className = 'rcsIconBtn';
                    removeBtn.innerText = 'Remove';
                    removeBtn.addEventListener('click', function () {
                        delete schema.ProviderIdFields[key];
                        var badgeIdx = schema.BadgeEnabledProviderIdKeys.indexOf(key);
                        if (badgeIdx >= 0) schema.BadgeEnabledProviderIdKeys.splice(badgeIdx, 1);
                        delete schema.ProviderIdBadgeUrlFormats[key];
                        markSchemasDirty(view);
                        renderSchemaForm(view);
                    });
                    nameRow.appendChild(removeBtn);
                }

                providerBlock.appendChild(nameRow);

                // ---- Row 2: Value — the field builder itself. "Clear"
                // lives inside buildMappingRow already, scoped correctly to
                // just this row's segments, not the provider as a whole. ----
                providerBlock.appendChild(buildMappingRow(mapping, mapperConnId, schema.Id, 'Value', null, locked, null));

                // ---- Row 3: URL format — only meaningful, and only
                // enabled, once the badge is on. ----
                var urlRow = document.createElement('div');
                urlRow.className = 'esProviderIdUrlRow';

                var urlRowLabel = document.createElement('span');
                urlRowLabel.className = 'esProviderIdRowLabel';
                urlRowLabel.innerText = 'URL format';
                urlRow.appendChild(urlRowLabel);

                var urlFormatInput = document.createElement('input');
                urlFormatInput.type = 'text';
                urlFormatInput.className = 'esBadgeUrlFormatInput';
                urlFormatInput.placeholder = '{0}';
                urlFormatInput.value = schema.ProviderIdBadgeUrlFormats[key] || '';
                urlFormatInput.disabled = !!locked || !badgeToggle.checked;
                urlFormatInput.title = 'Optional link template — "{0}" is replaced with the Value above. Leave ' +
                    'blank to just link straight to that value (the default, and what RadarrId/SonarrId use — ' +
                    'their Value IS the full link already). Only set a template here if the target URL is fixed ' +
                    'no matter which connection produced the item, e.g. a public site like TheTVDB. Do NOT use ' +
                    'this for anything host/port-specific to a connection — the template can\'t vary per ' +
                    'connection, only the Value field can (build the full URL into Value instead, as RadarrId/' +
                    'SonarrId do).';
                urlFormatInput.addEventListener('input', function (e) {
                    if (e.target.value) {
                        schema.ProviderIdBadgeUrlFormats[key] = e.target.value;
                    } else {
                        delete schema.ProviderIdBadgeUrlFormats[key];
                    }
                    markSchemasDirty(view);
                });
                urlRow.appendChild(urlFormatInput);

                providerBlock.appendChild(urlRow);

                wrap.appendChild(providerBlock);
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

        // The key input's 'change' handler fires mid focus-transition (the
        // blur that precedes Tab moving focus onward) and rebuilds the whole
        // form, destroying the element Tab was about to land on. Since the
        // browser can't complete a transition into a DOM node that no longer
        // exists, focus falls back to <body> and the next Tab press starts
        // over from the top of the page. Re-focusing the newly-rebuilt value
        // input here restores the Tab-to-value flow the UI is supposed to have.
        function focusValueInputAfterKeyRename(view, newKey) {
            var schemaId = view.querySelector('#esSchemaSelect').value;
            var schema = store.get('schemas').filter(function (s) { return s.Id === schemaId; })[0];
            if (!schema || !schema.StaticQueryParams) return;
            var idx = Object.keys(schema.StaticQueryParams).indexOf(newKey);
            if (idx < 0) return;
            var rows = view.querySelectorAll('#esStaticQueryParamsWrap > div');
            var row = rows[idx];
            var valInput = row && row.querySelectorAll('input')[1];
            if (valInput) valInput.focus();
        }

        function focusProviderIdValueInputAfterRename(view, newKey) {
            var nameInput = view.querySelector('.esProviderIdKeyRow input[value="' + newKey.replace(/"/g, '\\"') + '"]');
            if (!nameInput) return;
            var block = nameInput.closest('.esProviderIdBlock');
            var firstFieldInput = block && block.querySelector('.esMapRow .esMapTextInput, .esMapRow input');
            if (firstFieldInput) firstFieldInput.focus();
        }

        function buildStaticQueryParamsEditor(view, schema, locked) {
            if (!schema.StaticQueryParams) schema.StaticQueryParams = {};

            var wrap = document.createElement('div');
            wrap.id = 'esStaticQueryParamsWrap';
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
                    focusValueInputAfterKeyRename(view, newKey);
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

        var schemaDiscoveryToken = 0;
        // Last value the connection select was legitimately set to (by
        // render or a completed switch) — used to revert the dropdown when
        // a switch is blocked by unsaved schema changes, since by the time
        // 'change' fires the browser has already applied the new value.
        var lastConnectionSelectValue = '';

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
                if (requestToken !== schemaDiscoveryToken || store.get('currentSchemaId') !== requestedSchemaId) {
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

                fieldDiscovery.setDiscoveredFields(connectionId, schema.Id, fields);
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
                        var guess = fieldDiscovery.suggestRoleField(fields, ROLE_HEURISTICS[role]);
                        if (guess) {
                            schema[role] = { Segments: [{ Kind: 'Field', Value: guess }] };
                            autoMappings[role] = JSON.stringify(schema[role]);
                        } else if (autoMappings[role] === currentSnapshot) {
                            schema[role] = { Segments: [] };
                            delete autoMappings[role];
                        }
                    }
                });

                var owningConnection = store.findConnection(connectionId);
                if (owningConnection && (owningConnection.SystemType || '').toLowerCase() === 'emby') {
                    var embyIdPath = fieldDiscovery.discoveredPath(fields, 'Id');
                    var embyPrimaryImageTagPath = fieldDiscovery.discoveredPath(fields, 'ImageTags.Primary');
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
                if (requestToken !== schemaDiscoveryToken || store.get('currentSchemaId') !== requestedSchemaId) {
                    schemaDiscoveryBusyBySchemaId[requestedSchemaId] = false;
                    return;
                }
                schemaTestStatusBySchemaId[schema.Id] = 'Test request failed — the previous raw response and palette have been retained.';
                schemaDiscoveryBusyBySchemaId[schema.Id] = false;
                renderSchemaForm(view);
            });
        }

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

        function buildSchemaTestAndSuggestRow(view, schema) {
            var wrap = document.createElement('div');
            wrap.style.margin = '0.6em 0 1.2em';

            var suggestBtn = document.createElement('button');
            suggestBtn.setAttribute('is', 'emby-button');
            suggestBtn.type = 'button';
            suggestBtn.className = 'raised button-submit';
            suggestBtn.innerText = schemaDiscoveryBusyBySchemaId[schema.Id] ? 'Testing…' : 'Test and Suggest Field Mappings';
            suggestBtn.disabled = !!schema.IsBuiltIn || !schema.Path || !!schemaDiscoveryBusyBySchemaId[schema.Id];
            suggestBtn.title = schema.IsBuiltIn
                ? 'Duplicate this built-in Schema before testing or applying suggestions.'
                : (schema.Path ? 'Test this draft against its owning connection.' : 'Enter an Endpoint path first.');
            suggestBtn.addEventListener('click', function () {
                if (!schema.Path) { Dashboard.alert('Enter an Endpoint path first.'); return; }
                if (!store.findConnection(schema.ConnectionId)) { Dashboard.alert('The owning connection no longer exists.'); return; }
                if (schemaDiscoveryBusyBySchemaId[schema.Id]) return;
                suggestBtn.disabled = true;
                suggestBtn.innerText = 'Testing…';
                runSchemaDiscovery(view, schema, schema.ConnectionId);
            });
            wrap.appendChild(suggestBtn);

            var resultText = document.createElement('div');
            resultText.id = 'esTestResult';
            resultText.className = 'esTestResult';
            var owner = store.findConnection(schema.ConnectionId);
            resultText.innerText = schemaTestStatusBySchemaId[schema.Id] ||
                (schema.Path
                    ? 'Ready to test against ' + (owner ? owner.DisplayLabel : '(missing connection)') + '.'
                    : 'Enter an Endpoint path to enable testing.');
            wrap.appendChild(resultText);

            return wrap;
        }

        function newSchema(view) {
            if (blockSchemaEntityNavigation()) return;
            var connectionId = view.querySelector('#esConnectionSelect').value;
            if (!connectionId) { Dashboard.alert('Add and save a Connection first.'); return; }
            var persistedConnectionIds = store.get('persistedConnectionIds');
            if (!persistedConnectionIds[connectionId]) {
                Dashboard.alert('Save this Connection before creating its first Schema.');
                return;
            }
            var name = prompt('Name for the new schema:', 'New Schema');
            if (!name || !name.trim()) return;
            if (store.schemaNameExists(connectionId, name)) { Dashboard.alert('Schema names must be unique within a Connection.'); return; }
            var fresh = newEmptySchema(connectionId, name.trim());
            var schemas = store.get('schemas');
            schemas.push(fresh);
            store.set('currentSchemaId', fresh.Id);
            markSchemasDirty(view);
            renderSchemaSelect(view);
            renderSchemaForm(view);
        }

        function duplicateSchema(view) {
            if (blockSchemaEntityNavigation()) return;
            var source = store.currentSchema();
            if (!source) { Dashboard.alert('No schema selected to duplicate.'); return; }
            var name = prompt('Name for the duplicated schema:', (source.DisplayName || 'Schema') + ' copy');
            if (!name || !name.trim()) return;
            if (store.schemaNameExists(source.ConnectionId, name)) {
                Dashboard.alert('Schema names must be unique within a Connection.');
                return;
            }

            var clone = JSON.parse(JSON.stringify(source));
            clone.Id = helpers.newId();
            clone.DisplayName = name.trim();
            clone.ConnectionId = source.ConnectionId;
            clone.IsBuiltIn = false;
            var schemas = store.get('schemas');
            schemas.push(clone);
            markSchemasDirty(view);
            view.querySelector('#esConnectionSelect').value = clone.ConnectionId;
            store.set('currentSchemaId', clone.Id);
            renderSchemaSelect(view);
            renderSchemaForm(view);
        }

        function renameSchema(view) {
            var schema = store.currentSchema();
            if (!schema) { Dashboard.alert('No schema selected to rename.'); return; }
            if (schema.IsBuiltIn) { Dashboard.alert('Built-in schemas are read-only. Duplicate it to make an editable copy.'); return; }
            var name = prompt('Rename schema:', schema.DisplayName);
            if (!name || !name.trim()) return;
            if (store.schemaNameExists(schema.ConnectionId, name, schema.Id)) { Dashboard.alert('Schema names must be unique within a Connection.'); return; }
            schema.DisplayName = name.trim();
            markSchemasDirty(view);
            renderSchemaSelect(view);
        }

        function deleteSchema(view) {
            var schema = store.currentSchema();
            if (!schema) return;
            if (schema.IsBuiltIn) { Dashboard.alert('Built-in endpoint schemas are read-only and cannot be deleted.'); return; }

            var sameConnection = store.schemasForConnection(schema.ConnectionId);
            var deletedIndex = sameConnection.findIndex(function (item) { return item.Id === schema.Id; });
            var usedRuleIds = store.get('ruleSetsFile').RuleSets
                .filter(function (rs) { return rs.EndpointSchemaId === schema.Id; })
                .map(function (rs) { return rs.Id; });
            var currentTree = store.get('currentTree');
            var references = store.folderTreeReferencesForRuleSets(
                currentTree && currentTree.RootFolder, usedRuleIds);
            if (references.length) {
                Dashboard.alert(helpers.folderFetchDependencyMessage(
                    'schema', schema.DisplayName, references));
                return;
            }

            var savedSchemas = schemasSavedSnapshot === null ? [] : JSON.parse(schemasSavedSnapshot);
            var persisted = savedSchemas.some(function (item) { return item.Id === schema.Id; });
            if (!persisted) {
                var localSchemas = store.get('schemas').filter(function (item) { return item.Id !== schema.Id; });
                var localRemaining = localSchemas.filter(function (item) { return item.ConnectionId === schema.ConnectionId; });
                store.set('schemas', localSchemas);
                store.set('currentSchemaId', editorSession.selectionAfterDeletion(
                    localRemaining, deletedIndex, function (item) { return item.Id; }));
                renderSchemaSelect(view);
                renderSchemaForm(view);
                refreshSchemaDirtyState(view);
                return;
            }
            if (schemasAreDirty()) {
                Dashboard.alert('Save or discard your Schema changes before deleting a saved Schema.');
                return;
            }
            if (!confirm('Delete schema "' + schema.DisplayName + '" and its ' + usedRuleIds.length + ' Rule Set(s)?')) return;

            var status = view.querySelector('#esSaveStatus');
            status.innerText = 'Deleting\u2026';
            savingSchemas = true;
            editorSession.setBusy(view, 'schemas', true);
            ApiClient.ajax({
                type: 'DELETE',
                url: ApiClient.getUrl('ChannelSync/EndpointSchemas/' + encodeURIComponent(schema.Id)),
                dataType: 'json'
            }).then(function (result) {
                if (!result || result.Success !== true) {
                    savingSchemas = false;
                    editorSession.setBusy(view, 'schemas', false);
                    status.innerText = 'Deletion blocked -- nothing was removed.';
                    Dashboard.alert((result && result.Error) || 'The Schema could not be deleted.');
                    return;
                }
                var newSchemas = (result && result.Schemas) || [];
                var newRuleSets = (result && result.RuleSets) || [];
                var remaining = newSchemas.filter(function (item) { return item.ConnectionId === schema.ConnectionId; });
                var nextSchemaId = editorSession.selectionAfterDeletion(
                    remaining, deletedIndex, function (item) { return item.Id; });

                store.set('schemas', newSchemas);
                store.set('currentSchemaId', nextSchemaId);
                store.set('ruleSetsFile', { RuleSets: newRuleSets });
                if (!newRuleSets.some(function (ruleSet) { return ruleSet.Id === store.get('currentRuleSetId'); })) {
                    store.set('currentRuleSetId', '');
                }
                store.emit('schemasChanged');
                store.emit('ruleSetsChanged');
                snapshotSchemasSaved();
                refreshSchemaDirtyState(view);
                status.innerText = 'Deleted.';
                savingSchemas = false;
                editorSession.setBusy(view, 'schemas', false);
            }).catch(function () {
                savingSchemas = false;
                editorSession.setBusy(view, 'schemas', false);
                status.innerText = 'Delete failed -- nothing was removed. See server log.';
            });
        }

        function exportSchema(view) {
            if (!store.currentSchema()) { Dashboard.alert('No schema selected to export.'); return; }
            var panel = view.querySelector('#esImportExportPanel');
            var text = view.querySelector('#esImportExportText');
            var status = view.querySelector('#esImportExportStatus');
            var confirmBtn = view.querySelector('#esImportExportConfirm');

            var exported = JSON.parse(JSON.stringify(store.currentSchema()));
            delete exported.Fields;
            delete exported.DetailUrlFormat;
            text.value = JSON.stringify(exported, null, 2);
            text.readOnly = false;
            status.innerText = 'Copy the text above to share this schema, or edit it directly and re-import below.';
            confirmBtn.innerText = 'Copy to clipboard';
            confirmBtn.onclick = function () {
                helpers.copyTextToClipboard(text.value).then(function () {
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
            if (blockSchemaEntityNavigation()) return;
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

                parsed.Id = helpers.newId();
                parsed.IsBuiltIn = false;
                parsed.ConnectionId = view.querySelector('#esConnectionSelect').value;
                parsed.Fields = [];
                delete parsed.DetailUrlFormat;
                if (!parsed.DisplayName) parsed.DisplayName = 'Imported schema';
                if (store.schemaNameExists(parsed.ConnectionId, parsed.DisplayName)) {
                    status.innerText = 'A Schema with that name already exists on the selected Connection. Rename it in the JSON before importing.';
                    return;
                }

                var schemas = store.get('schemas');
                schemas.push(parsed);
                store.set('currentSchemaId', parsed.Id);
                markSchemasDirty(view);
                renderSchemaSelect(view);
                renderSchemaForm(view);
                panel.style.display = 'none';
            };
            panel.style.display = '';
            text.focus();
        }

        var schemasSavedSnapshot = null;
        var schemasSavedComparison = null;
        var savingSchemas = false;
        var activeView = null;

        function schemasForComparison(schemas) {
            return editorSession.canonicalJson(schemas || [], { CachedType: true, IsFavorite: true });
        }

        function schemasAreDirty() {
            return schemasSavedComparison !== null &&
                schemasForComparison(store.get('schemas')) !== schemasSavedComparison;
        }

        function snapshotSchemasSaved() {
            var schemas = store.get('schemas');
            schemasSavedSnapshot = JSON.stringify(schemas);
            schemasSavedComparison = schemasForComparison(schemas);
        }

        function refreshSchemaDirtyState(view) {
            if (!view) return;
            var warn = view.querySelector('#esDirtyWarning');
            var discard = view.querySelector('#esDiscardBtn');
            if (!warn) return;
            var dirty = schemasAreDirty();
            warn.innerText = dirty ? 'Unsaved changes' : '';
            if (discard) discard.disabled = !dirty;
        }

        function markSchemasDirty(view) {
            refreshSchemaDirtyState(view);
        }

        function discardEndpointSchemaChanges(view) {
            if (schemasSavedSnapshot === null) return;
            var selectedConnectionId = view.querySelector('#esConnectionSelect').value;
            var selectedSchemaId = store.get('currentSchemaId');
            var restoredSchemas = JSON.parse(schemasSavedSnapshot);
            var restoredSelectedSchema = restoredSchemas.filter(function (schema) {
                return schema.Id === selectedSchemaId;
            })[0] || null;
            // A schema's owner is the authoritative connection selection.
            // The select's DOM value may still be the connection the user
            // just attempted to switch to when the dirty guard intervened.
            // Restoring that transient value alongside a schema owned by the
            // previous connection makes renderSchemaSelect reject the pair
            // and clear currentSchemaId, leaving a misleading empty editor.
            var restoredConnectionId = restoredSelectedSchema
                ? restoredSelectedSchema.ConnectionId
                : selectedConnectionId;
            var connections = store.get('connections');
            if (!connections.some(function (connection) { return connection.Id === restoredConnectionId; })) {
                restoredConnectionId = connections.length ? connections[0].Id : '';
            }
            var restoredSchemaId = restoredSelectedSchema && restoredSelectedSchema.ConnectionId === restoredConnectionId
                ? restoredSelectedSchema.Id
                : '';
            // Publish a consistent collection/selection state. Emitting
            // schemasChanged between replacing the collection and restoring
            // currentSchemaId exposes an invalid intermediate state to every
            // dependent tab and makes their renders order-dependent.
            store.set('schemas', restoredSchemas);
            store.set('currentSchemaId', restoredSchemaId);
            renderSchemaConnectionSelect(view, restoredConnectionId);
            renderSchemaForm(view);
            store.emit('schemasChanged');
            view.querySelector('#esSaveStatus').innerText = '';
            snapshotSchemasSaved();
            refreshSchemaDirtyState(view);
        }

        // Generic walk that finds every MappingNode across every schema by
        // duck-typing on {Segments:[...]} / {Children:[...]} shape rather
        // than hardcoding property names — stays correct if fields get
        // added/renamed on EndpointSchema later without needing a matching
        // update here. Returns every invalid Function node found (currently
        // only an invalid ArraySlice shape or match — see
        // functionNodeValidity). Field types come from the runtime discovery
        // cache and never get written onto persisted mapping nodes.
        function collectInvalidFunctionNodes(schemas) {
            var invalid = [];
            function walkNodes(nodes, fieldByPath) {
                (nodes || []).forEach(function (node) {
                    if (node && node.Kind === 'Function') {
                        if (!functionNodeValidity(node, fieldByPath)) invalid.push(node);
                        walkNodes(node.Children, fieldByPath);
                    }
                });
            }
            function walkValue(v, fieldByPath) {
                if (!v || typeof v !== 'object') return;
                if (Array.isArray(v)) { v.forEach(function (item) { walkValue(item, fieldByPath); }); return; }
                if (Array.isArray(v.Segments)) { walkNodes(v.Segments, fieldByPath); return; }
                Object.keys(v).forEach(function (k) { walkValue(v[k], fieldByPath); });
            }
            (schemas || []).forEach(function (schema) {
                var fields = fieldDiscovery.getDiscoveredFields(schema.ConnectionId, schema.Id) || [];
                var fieldByPath = {};
                fields.forEach(function (field) { fieldByPath[field.JsonPath] = field; });
                walkValue(schema, fieldByPath);
            });
            return invalid;
        }

        function saveEndpointSchemas(view) {
            if (savingSchemas) return;
            var status = view.querySelector('#esSaveStatus');
            var affectedFolders = 0;

            var currentSchema = store.currentSchema();
            var invalidFunctionNodes = collectInvalidFunctionNodes(currentSchema ? [currentSchema] : []);
            if (invalidFunctionNodes.length > 0) {
                var invalidChip = view.querySelector('.esMapSeg-function[data-map-node-valid="0"]');
                if (invalidChip) invalidChip.scrollIntoView({ behavior: 'smooth', block: 'center' });
                Dashboard.alert(
                    invalidFunctionNodes.length + ' Array function(s) are outlined in red because they aren\'t ' +
                    'wrapping a single list-type field — fix or remove them before saving.'
                );
                status.innerText = 'Save cancelled.';
                return;
            }

            var selectedConnectionId = view.querySelector('#esConnectionSelect').value;
            var selectedSchemaId = store.get('currentSchemaId');
            status.innerText = 'Saving...';
            savingSchemas = true;
            editorSession.setBusy(view, 'schemas', true);

            ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl('ChannelSync/EndpointSchemas'),
                data: JSON.stringify({ Payload: { Schemas: store.get('schemas') } }),
                contentType: 'application/json',
                dataType: 'json'
            }).then(function (result) {
                affectedFolders += (result && result.AffectedFolderCount) || 0;
            }).then(function () {
                status.innerText = affectedFolders > 0 ? 'Saved. Folder tree resync started.' : 'Saved.';
                return Promise.all([
                    ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/EndpointSchemas'), dataType: 'json' }),
                    ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/RuleSets'), dataType: 'json' })
                ]).then(function (results) {
                    var newSchemas = (results[0] && results[0].Schemas) || [];
                    var serverRuleSets = (results[1] && results[1].RuleSets) || [];
                    var newRuleSetsFile = { RuleSets: serverRuleSets };
                    store.set('schemas', newSchemas, 'schemasChanged');
                    store.set('ruleSetsFile', newRuleSetsFile, 'ruleSetsChanged');
                    renderSchemaConnectionSelect(view);
                    view.querySelector('#esConnectionSelect').value = selectedConnectionId;
                    store.set('currentSchemaId', selectedSchemaId);
                    renderSchemaSelect(view);
                    renderSchemaForm(view);
                    snapshotSchemasSaved();
                    refreshSchemaDirtyState(view);
                    savingSchemas = false;
                    editorSession.setBusy(view, 'schemas', false);
                });
            }).catch(function () {
                savingSchemas = false;
                editorSession.setBusy(view, 'schemas', false);
                status.innerText = 'Save failed -- see server log.';
            });
        }

        function wireSchemaToolbar(view) {
            view.querySelector('#esNewSchema').addEventListener('click', function () { newSchema(view); });
            view.querySelector('#esDuplicateSchema').addEventListener('click', function () { duplicateSchema(view); });
            view.querySelector('#esRenameSchema').addEventListener('click', function () { renameSchema(view); });
            view.querySelector('#esDeleteSchema').addEventListener('click', function () { deleteSchema(view); });
            view.querySelector('#esExportSchema').addEventListener('click', function () { exportSchema(view); });
            view.querySelector('#esImportSchema').addEventListener('click', function () { importSchema(view); });
            var cancelBtn = view.querySelector('#esImportExportCancel');
            if (cancelBtn) cancelBtn.addEventListener('click', function () {
                view.querySelector('#esImportExportPanel').style.display = 'none';
            });
            view.querySelector('#esSaveBtn').addEventListener('click', function () { saveEndpointSchemas(view); });
            view.querySelector('#esDiscardBtn').addEventListener('click', function () { discardEndpointSchemaChanges(view); });
        }

        function init(view) {
            activeView = view;
            wireSchemaToolbar(view);
            renderSchemaConnectionSelect(view);
            renderSchemaForm(view);
            snapshotSchemasSaved();

            store.on('schemasChanged', function () {
                renderSchemaConnectionSelect(view);
                renderSchemaForm(view);
                snapshotSchemasSaved();
                refreshSchemaDirtyState(view);
            });

            store.on('connectionsChanged', function () {
                renderSchemaConnectionSelect(view);
                renderSchemaForm(view);
            });
        }

        return {
            init: init,
            newSchema: newSchema,
            renderSchemaForm: renderSchemaForm,
            hasUnsavedChanges: schemasAreDirty,
            isSaving: function () { return savingSchemas; }
        };
    });
