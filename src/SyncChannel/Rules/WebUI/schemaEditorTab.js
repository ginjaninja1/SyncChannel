define(['jQuery', 'configurationpage?name=SyncChannelStoreJs',
        'configurationpage?name=SyncChannelDragEngineJs',
        'configurationpage?name=SyncChannelFieldDiscoveryJs',
        'configurationpage?name=SyncChannelSharedHelpersJs',
        'configurationpage?name=SyncChannelRuleBuilderTabJs',
        'configurationpage?name=SyncChannelConnectionsTabJs',
        'configurationpage?name=SyncChannelRuleSetManagerTabJs'],
    function ($, store, dragEngine, fieldDiscovery, helpers, ruleBuilderTab, connectionsTab, ruleSetManagerTab) {
        'use strict';

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
                schemaDiscoveryToken++;
                store.set('currentSchemaId', select.value);
                renderSchemaForm(view);
            };
        }

        function renderSchemaConnectionSelect(view) {
            var select = view.querySelector('#esConnectionSelect');
            var prior = select.value;
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
            if (!select.dataset.wired) {
                select.dataset.wired = '1';
                select.addEventListener('change', function () {
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

        // Compact text notation <-> Modifier object. Mirrors
        // HttpFetchProvider's C# application logic exactly (Left/Right take
        // a character count, Substring/ArraySlice take inclusive start:end,
        // ArraySlice end -1 means "all") — kept in one place so the preview
        // shown here never drifts from what actually gets resolved server-side.
        function formatModifier(modifier) {
            if (!modifier || modifier.Kind === 'None') return '';
            switch (modifier.Kind) {
                case 'Left': return 'Left[' + modifier.Start + ']';
                case 'Right': return 'Right[' + modifier.Start + ']';
                case 'Substring': return 'Substring[' + modifier.Start + ':' + modifier.End + ']';
                case 'ArraySlice':
                    if (modifier.End < 0) return '[all]';
                    return modifier.Start === modifier.End ? '[' + modifier.Start + ']' : '[' + modifier.Start + ':' + modifier.End + ']';
                default: return '';
            }
        }

        function parseModifierText(text) {
            var t = (text || '').trim();
            if (!t) return { Kind: 'None', Start: 0, End: -1 };

            var m;
            if ((m = /^left\[(\d+)\]$/i.exec(t))) return { Kind: 'Left', Start: parseInt(m[1], 10), End: -1 };
            if ((m = /^right\[(\d+)\]$/i.exec(t))) return { Kind: 'Right', Start: parseInt(m[1], 10), End: -1 };
            if ((m = /^substring\[(\d+):(\d+)\]$/i.exec(t))) return { Kind: 'Substring', Start: parseInt(m[1], 10), End: parseInt(m[2], 10) };
            if (/^\[all\]$/i.test(t)) return { Kind: 'ArraySlice', Start: 0, End: -1 };
            if ((m = /^\[(\d+):(\d+)\]$/.exec(t))) return { Kind: 'ArraySlice', Start: parseInt(m[1], 10), End: parseInt(m[2], 10) };
            if ((m = /^\[(\d+)\]$/.exec(t))) return { Kind: 'ArraySlice', Start: parseInt(m[1], 10), End: parseInt(m[1], 10) };

            return null; // unparseable — caller keeps previous value, flags invalid
        }

        // Client-side mirror of HttpFetchProvider's ApplyStringModifier /
        // ApplyArraySlice, used only for the hover-preview examples — the
        // server is always the source of truth for the actual resolved value.
        function applyModifierToValues(values, modifier) {
            if (!modifier || modifier.Kind === 'None') return values;
            if (modifier.Kind === 'ArraySlice') {
                if (modifier.End < 0) return [values.join(', ')];
                var start = Math.max(0, Math.min(modifier.Start, values.length - 1));
                var end = Math.max(start, Math.min(modifier.End, values.length - 1));
                return [values.slice(start, end + 1).join(', ')];
            }
            return values.map(function (v) {
                if (modifier.Kind === 'Left') return String(v).slice(0, Math.max(0, modifier.Start));
                if (modifier.Kind === 'Right') {
                    var n = Math.max(0, Math.min(modifier.Start, v.length));
                    return String(v).slice(v.length - n);
                }
                if (modifier.Kind === 'Substring') {
                    var s = Math.max(0, Math.min(modifier.Start, v.length));
                    var e = Math.max(s, Math.min(modifier.End, v.length - 1));
                    return String(v).slice(s, e + 1);
                }
                return v;
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

            var examplesEl = document.createElement('div');
            examplesEl.className = 'esMapExamples';

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

            function resolvedExamples() {
                var fbp = fieldsByPath();
                var connection = mapperConnId ? store.findConnection(mapperConnId) : null;
                var output = [];
                for (var exampleIndex = 0; exampleIndex < 3; exampleIndex++) {
                    var hasFieldValue = false;
                    var value = mapping.Segments.map(function (seg) {
                        if (seg.Kind === 'Field') {
                            var field = fbp[seg.Value];
                            var examples = field && field.Examples ? field.Examples : [];
                            if (!examples.length) return '';
                            hasFieldValue = true;
                            if (seg.Modifier && seg.Modifier.Kind === 'ArraySlice') {
                                return applyModifierToValues(examples, seg.Modifier)[0] || '';
                            }
                            var raw = String(examples[Math.min(exampleIndex, examples.length - 1)]);
                            return applyModifierToValues([raw], seg.Modifier)[0] || '';
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
                    // (modChip appended after the field-value chip below, once the value chip finishes building)

                    if (!locked) {
                        var dragHandle = document.createElement('span');
                        dragHandle.className = 'esMapDragHandle';
                        dragHandle.innerText = '\u2630';
                        dragHandle.dataset.dragLabel = mappingSegmentLabel(seg, fbp);
                        dragHandle.title = 'Drag to move within this field, or copy to another field';
                        dragEngine.makeDraggableSource(dragHandle, 'mapseg', function () {
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
                            markSchemasDirty(activeView);
                        });
                        chip.appendChild(input);
                    } else {
                        var textSpan = document.createElement('span');
                        textSpan.innerText = mappingSegmentLabel(seg, fbp);
                        chip.appendChild(textSpan);
                        if (seg.Kind === 'Field' && fbp[seg.Value] && fbp[seg.Value].Examples && fbp[seg.Value].Examples.length) {
                            chip.title = fbp[seg.Value].Examples.join('\n');
                        } else if (seg.Kind === 'BaseUrl') {
                            var baseConnection = mapperConnId ? store.findConnection(mapperConnId) : null;
                            chip.title = 'Value: ' + ((baseConnection && baseConnection.BaseUrl) || '(not set)');
                        } else if (seg.Kind === 'ApiKeyName') {
                            var nameConnection = mapperConnId ? store.findConnection(mapperConnId) : null;
                            chip.title = 'Value: ' + ((nameConnection && nameConnection.ApiKeyParamName) || '(not set)');
                        } else if (seg.Kind === 'ApiKeyValue') {
                            var keyConnection = mapperConnId ? store.findConnection(mapperConnId) : null;
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
                            markSchemasDirty(activeView);
                            renderSegments();
                            refreshWarning();
                        });
                        chip.appendChild(xBtn);
                    }

                    valueEl.appendChild(chip);

                    if (seg.Kind === 'Field' && !locked) {
                        var field = fbp[seg.Value];
                        var modChip = document.createElement('span');
                        modChip.className = 'rcsChip esMapSeg rcsChip-modifier';
                        modChip.title = 'String/array function on this field — e.g. Left[4], Right[2], Substring[0:3], [0:0], [1:2], [all]. Blank clears it.';

                        var modInput = document.createElement('input');
                        modInput.type = 'text';
                        modInput.className = 'esMapModifierInput';
                        modInput.placeholder = field && field.Type === 'List' ? '[0:0]' : 'fn';
                        modInput.value = formatModifier(seg.Modifier);

                        function refreshModHover() {
                            if (!field || !field.Examples || !field.Examples.length || !seg.Modifier) {
                                modChip.title = 'String/array function on this field — e.g. Left[4], Right[2], Substring[0:3], [0:0], [1:2], [all].';
                                return;
                            }
                            var applied = applyModifierToValues(field.Examples, seg.Modifier);
                            modChip.title = applied.slice(0, 3).join('\n') || 'No examples available.';
                        }
                        refreshModHover();

                        modInput.addEventListener('input', function (e) {
                            var parsed = parseModifierText(e.target.value);
                            if (parsed === null) {
                                modInput.classList.add('esMapModifierInvalid');
                                return;
                            }
                            modInput.classList.remove('esMapModifierInvalid');
                            seg.Modifier = parsed.Kind === 'None' ? null : parsed;
                            refreshModHover();
                            refreshExamples();
                            markSchemasDirty(activeView);
                        });
                        modInput.addEventListener('blur', function () {
                            // Revert visibly-invalid leftover text back to whatever
                            // last actually applied, rather than leaving a red,
                            // unparsed string sitting in the field.
                            if (modInput.classList.contains('esMapModifierInvalid')) {
                                modInput.value = formatModifier(seg.Modifier);
                                modInput.classList.remove('esMapModifierInvalid');
                            }
                        });

                        modChip.appendChild(modInput);
                        valueEl.appendChild(modChip);
                    }
                });

                valueEl.appendChild(examplesEl);
                refreshWarning();
                refreshExamples();
                refreshSchemaDirtyState(activeView);
            }

            if (!locked) {
                // onHover here is the generalization dragEngine.js expects:
                // this container decides its own horizontal insertion
                // indicator, dragEngine has no idea what "esMapValue" means.
                // dragEngine passes the current drag's reorderElement as a
                // third arg — that's what excludeEl needs, so a chip being
                // reordered within its own row doesn't count against itself.
                var onHover = function (clientX, clientY, reorderElement) {
                    showMappingInsertionIndicator(valueEl, clientX, reorderElement, clientY);
                };

                dragEngine.registerDropTarget(valueEl, ['field'].concat(STATIC_MAPPING_DRAG_KINDS), function (rawValue, reorderElement, clientYIgnored, clientX) {
                    var parsed = null;
                    try { parsed = JSON.parse(rawValue); } catch (e) { /* not a field chip */ }

                    var seg = (parsed && parsed.path)
                        ? { Kind: 'Field', Value: parsed.path }
                        : { Kind: rawValue, Value: '' };

                    if (seg.Kind === 'Field' && parsed && parsed.type === 'List') {
                        seg.Modifier = { Kind: 'ArraySlice', Start: 0, End: 0 };
                    }

                    var insertAt = findMappingInsertionIndex(valueEl, clientX, null, clientYIgnored);
                    mapping.Segments.splice(insertAt, 0, seg);
                    renderSegments();
                    markSchemasDirty(activeView);
                    if (seg.Kind === 'CustomText') {
                        var inputs = valueEl.querySelectorAll('.esMapTextInput');
                        if (inputs.length) inputs[Math.min(insertAt, inputs.length - 1)].focus();
                    }
                }, 'rcsDragOver', onHover);

                dragEngine.registerDropTarget(valueEl, ['mapseg'], function (value, reorderElement, clientYIgnored, clientX) {
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
                            Value: payload.Segment.Value || '',
                            Modifier: payload.Segment.Modifier || null
                        });
                    }
                    renderSegments();
                    markSchemasDirty(activeView);
                }, 'rcsDragOver', onHover);

                dragEngine.registerDropTarget(valueEl, ['mapmapping'], function (value, reorderElement, clientY, clientX) {
                    var payload;
                    try { payload = JSON.parse(value); } catch (e) { return; }
                    if (!payload || !Array.isArray(payload.Segments) || payload.SourceId === mappingDragId) return;
                    var copiedSegments = payload.Segments.map(function (seg) {
                        return { Kind: seg.Kind, Value: seg.Value || '', Modifier: seg.Modifier || null };
                    });
                    var insertAt = findMappingInsertionIndex(valueEl, clientX, null, clientY);
                    Array.prototype.splice.apply(mapping.Segments, [insertAt, 0].concat(copiedSegments));
                    renderSegments();
                    markSchemasDirty(activeView);
                }, 'rcsDragOver', onHover);

                dragEngine.registerDropTarget(mappingHandle, ['mapmapping'], function (value) {
                    var payload;
                    try { payload = JSON.parse(value); } catch (e) { return; }
                    if (!payload || !Array.isArray(payload.Segments) || payload.SourceId === mappingDragId) return;
                    mapping.Segments = payload.Segments.map(function (seg) {
                        return { Kind: seg.Kind, Value: seg.Value || '', Modifier: seg.Modifier || null };
                    });
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

                if (f.Examples && f.Examples.length) {
                    chip.title = chip.title + '\n' + f.Examples.join('\n');
                }

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
                container.innerHTML = '<div class="fieldDescription">No schema selected -- use + New to create one.</div>';
                refreshSchemaDirtyState(view);
                return;
            }

            var schema = store.currentSchema();
            var isBuiltInTemplate = !!schema.IsBuiltIn;
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
            // own compiled IExternalId classes. Deliberately NOT reserving
            // Tmdb/Imdb/Tvdb/etc — that would require knowing Emby's full
            // native IExternalId roster, which isn't confirmed. An admin
            // naming a custom field "Tmdb" and enabling our badge for it
            // just produces a harmless duplicate badge alongside Emby's own —
            // an acceptable, fail-safe edge case rather than a guess dressed
            // up as a rule.
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

                var nameLabel = document.createElement('span');
                nameLabel.className = 'esProviderIdRowLabel';
                nameLabel.innerText = 'Name';
                nameRow.appendChild(nameLabel);

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

                var urlLabel = document.createElement('span');
                urlLabel.className = 'esProviderIdRowLabel';
                urlLabel.innerText = 'URL format';
                urlRow.appendChild(urlLabel);

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

        function focusValueInputAfterKeyRename(view, newKey) {
            var keys = Object.keys((store.get('schemas').filter(function (s) { return s.Id === view.querySelector('#esSchemaSelect').value; })[0] || {}).StaticQueryParams || {});
            var idx = keys.indexOf(newKey);
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
            suggestBtn.disabled = !schema.Path || !!schemaDiscoveryBusyBySchemaId[schema.Id];
            suggestBtn.title = schema.Path ? 'Test this draft against its owning connection.' : 'Enter an Endpoint path first.';
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
            var source = store.currentSchema();
            if (!source) { Dashboard.alert('No schema selected to duplicate.'); return; }
            var name = prompt('Name for the duplicated schema:', (source.DisplayName || 'Schema') + ' copy');
            if (!name || !name.trim()) return;

            var connections = store.get('connections');
            var ownerIndex = connections.findIndex(function (c) { return c.Id === source.ConnectionId; });
            var choices = connections.map(function (c, i) { return (i + 1) + '. ' + c.DisplayLabel; }).join('\n');
            var targetAnswer = prompt('Target Connection (enter its number):\n' + choices, String(ownerIndex + 1));
            var targetIndex = parseInt(targetAnswer, 10) - 1;
            if (!connections[targetIndex]) { Dashboard.alert('No valid target Connection selected.'); return; }
            if (store.schemaNameExists(connections[targetIndex].Id, name)) { Dashboard.alert('Schema names must be unique within the target Connection.'); return; }

            var clone = JSON.parse(JSON.stringify(source));
            clone.Id = helpers.newId();
            clone.DisplayName = name.trim();
            clone.ConnectionId = connections[targetIndex].Id;
            clone.IsBuiltIn = false;
            var schemas = store.get('schemas');
            schemas.push(clone);
            markSchemasDirty(view);
            var ruleSetsFile = store.get('ruleSetsFile');
            if (confirm('Copy this schema\'s Rule Sets too?')) {
                ruleSetsFile.RuleSets
                    .filter(function (rs) { return rs.EndpointSchemaId === source.Id; })
                    .forEach(function (rs) {
                        var copy = JSON.parse(JSON.stringify(rs));
                        copy.Id = helpers.newId();
                        copy.EndpointSchemaId = clone.Id;
                        copy.IsBuiltIn = false;
                        ruleSetsFile.RuleSets.push(copy);
                    });
                store.set('schemaOperationChangedRuleSets', true);
                ruleBuilderTab.markRuleSetsDirty(view);
            }
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

            var ruleSetsFile = store.get('ruleSetsFile');
            var usedRuleIds = ruleSetsFile.RuleSets
                .filter(function (rs) { return rs.EndpointSchemaId === schema.Id; })
                .map(function (rs) { return rs.Id; });
            var currentTree = store.get('currentTree');
            if (store.folderTreeUsesAnyRuleSet(currentTree && currentTree.RootFolder, usedRuleIds)) {
                Dashboard.alert('This schema cannot be deleted because a Folder Fetch uses one of its Rule Sets.');
                return;
            }
            if (!confirm('Delete schema "' + schema.DisplayName + '" and its Rule Sets?')) return;
            var schemas = store.get('schemas').filter(function (s) { return s.Id !== schema.Id; });
            ruleSetsFile.RuleSets = ruleSetsFile.RuleSets.filter(function (rs) { return rs.EndpointSchemaId !== schema.Id; });
            store.set('schemas', schemas);
            store.set('currentSchemaId', '');
            markSchemasDirty(view);
            renderSchemaSelect(view);
            renderSchemaForm(view);
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
        var schemaRuleSetsSavedSnapshot = null;
        var builtInSchemaOriginals = {};
        var schemasHaveUnsavedChanges = false;
        var activeView = null;

        function snapshotSchemasSaved() {
            var schemas = store.get('schemas');
            schemasSavedSnapshot = JSON.stringify(schemas);
            schemaRuleSetsSavedSnapshot = JSON.stringify(store.get('ruleSetsFile'));
            schemasHaveUnsavedChanges = false;
            builtInSchemaOriginals = {};
            schemas.filter(function (schema) { return schema.IsBuiltIn; }).forEach(function (schema) {
                builtInSchemaOriginals[schema.Id] = JSON.stringify(schema);
            });
        }

        function refreshSchemaDirtyState(view) {
            if (!view) return;
            var warn = view.querySelector('#esDirtyWarning');
            var discard = view.querySelector('#esDiscardBtn');
            if (!warn) return;
            var dirty = schemasSavedSnapshot !== null &&
                (schemasHaveUnsavedChanges || store.get('schemaOperationChangedRuleSets'));
            warn.innerText = dirty ? 'Unsaved changes' : '';
            if (discard) discard.disabled = !dirty;
        }

        function markSchemasDirty(view) {
            schemasHaveUnsavedChanges = true;
            refreshSchemaDirtyState(view);
        }

        function discardEndpointSchemaChanges(view) {
            if (schemasSavedSnapshot === null) return;
            var schemaOperationChangedRuleSets = store.get('schemaOperationChangedRuleSets');
            if (schemaOperationChangedRuleSets &&
                !confirm('Discard Schema changes and the Rule Set copies/deletions made by those Schema operations?')) return;

            var selectedConnectionId = view.querySelector('#esConnectionSelect').value;
            var selectedSchemaId = store.get('currentSchemaId');
            var ruleSetsFile = store.get('ruleSetsFile');
            var currentRuleSetIndex = store.get('currentRuleSetIndex');
            var selectedRule = currentRuleSetIndex >= 0 ? ruleSetsFile.RuleSets[currentRuleSetIndex] : null;
            var selectedRuleId = selectedRule ? selectedRule.Id : '';
            var restoredSchemas = JSON.parse(schemasSavedSnapshot);
            if (schemaOperationChangedRuleSets && schemaRuleSetsSavedSnapshot) {
                store.set('ruleSetsFile', JSON.parse(schemaRuleSetsSavedSnapshot), 'ruleSetsChanged');
            }
            store.set('schemaOperationChangedRuleSets', false);
            schemasHaveUnsavedChanges = false;
            store.set('schemas', restoredSchemas, 'schemasChanged');

            renderSchemaConnectionSelect(view);
            var connections = store.get('connections');
            if (connections.some(function (connection) { return connection.Id === selectedConnectionId; })) {
                view.querySelector('#esConnectionSelect').value = selectedConnectionId;
            }
            store.set('currentSchemaId', restoredSchemas.some(function (schema) { return schema.Id === selectedSchemaId; })
                ? selectedSchemaId : '');
            renderSchemaSelect(view);
            renderSchemaForm(view);
            ruleSetManagerTab.renderConnectionAndSchemaSelects(view);
            var restoredRuleIndex = store.get('ruleSetsFile').RuleSets.findIndex(function (ruleSet) {
                return ruleSet.Id === selectedRuleId;
            });
            store.set('currentRuleSetIndex', restoredRuleIndex);
            ruleSetManagerTab.renderRuleSetSelect(view);
            ruleSetManagerTab.renderCanvasForCurrentIndex(view);
            view.querySelector('#esSaveStatus').innerText = '';
            snapshotSchemasSaved();
            refreshSchemaDirtyState(view);
        }

        function copySchemaRuntimeState(source, clone) {
            var sourceFields = fieldDiscovery.getDiscoveredFields(source.ConnectionId, source.Id);
            if (sourceFields) {
                fieldDiscovery.setDiscoveredFields(clone.ConnectionId, clone.Id, JSON.parse(JSON.stringify(sourceFields)));
                lastDiscoveryConnBySchemaId[clone.Id] = clone.ConnectionId;
            }
            if (lastRawJsonBySchemaId[source.Id]) lastRawJsonBySchemaId[clone.Id] = lastRawJsonBySchemaId[source.Id];
            if (rawJsonExpandedBySchemaId[source.Id]) rawJsonExpandedBySchemaId[clone.Id] = true;
            if (rawJsonStrippedBySchemaId[source.Id]) rawJsonStrippedBySchemaId[clone.Id] = true;
            if (schemaTestStatusBySchemaId[source.Id]) schemaTestStatusBySchemaId[clone.Id] = schemaTestStatusBySchemaId[source.Id];
        }

        function saveEditedBuiltInsAsCopies() {
            var schemas = store.get('schemas');
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
                if (store.schemaNameExists(source.ConnectionId, name) ||
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
                clone.Id = helpers.newId();
                clone.DisplayName = entry.name;
                clone.IsBuiltIn = false;

                var sourceIndex = schemas.findIndex(function (schema) { return schema.Id === source.Id; });
                schemas[sourceIndex] = JSON.parse(builtInSchemaOriginals[source.Id]);
                schemas.push(clone);
                copySchemaRuntimeState(source, clone);
                if (store.get('currentSchemaId') === source.Id) store.set('currentSchemaId', clone.Id);
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
            var selectedSchemaId = store.get('currentSchemaId');
            var ruleSetsFile = store.get('ruleSetsFile');
            var currentRuleSetIndex = store.get('currentRuleSetIndex');
            var selectedRule = currentRuleSetIndex >= 0 ? ruleSetsFile.RuleSets[currentRuleSetIndex] : null;
            var selectedRuleId = selectedRule ? selectedRule.Id : '';
            status.innerText = 'Saving...';

            ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl('ChannelSync/EndpointSchemas'),
                data: JSON.stringify({ Payload: { Schemas: store.get('schemas') } }),
                contentType: 'application/json',
                dataType: 'json'
            }).then(function (result) {
                affectedFolders += (result && result.AffectedFolderCount) || 0;
                var schemaOperationChangedRuleSets = store.get('schemaOperationChangedRuleSets');
                if (!schemaOperationChangedRuleSets) return Promise.resolve();
                return ApiClient.ajax({
                    type: 'POST',
                    url: ApiClient.getUrl('ChannelSync/RuleSets'),
                    data: JSON.stringify({ Payload: store.get('ruleSetsFile') }),
                    contentType: 'application/json',
                    dataType: 'json'
                }).then(function (result) {
                    affectedFolders += (result && result.AffectedFolderCount) || 0;
                });
            }).then(function () {
                status.innerText = affectedFolders > 0 ? 'Saved. Folder tree resync started.' : 'Saved.';
                return Promise.all([
                    ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/EndpointSchemas'), dataType: 'json' }),
                    ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ChannelSync/RuleSets'), dataType: 'json' })
                ]).then(function (results) {
                    var newSchemas = (results[0] && results[0].Schemas) || [];
                    var serverRuleSets = (results[1] && results[1].RuleSets) || [];
                    var liveSchemaIds = {};
                    newSchemas.forEach(function (s) { liveSchemaIds[s.Id] = true; });
                    var currentRuleSetsFile = store.get('ruleSetsFile');
                    var localCustomRules = currentRuleSetsFile.RuleSets.filter(function (rs) {
                        return !rs.IsBuiltIn && liveSchemaIds[rs.EndpointSchemaId];
                    });
                    var newRuleSetsFile = {
                        RuleSets: localCustomRules.concat(serverRuleSets.filter(function (rs) { return rs.IsBuiltIn; }))
                    };
                    store.set('schemas', newSchemas, 'schemasChanged');
                    store.set('ruleSetsFile', newRuleSetsFile, 'ruleSetsChanged');
                    connectionsTab.renderSystemTypeDatalist(view);
                    renderSchemaConnectionSelect(view);
                    view.querySelector('#esConnectionSelect').value = selectedConnectionId;
                    store.set('currentSchemaId', selectedSchemaId);
                    renderSchemaSelect(view);
                    renderSchemaForm(view);
                    ruleSetManagerTab.renderConnectionAndSchemaSelects(view);
                    var restoredRuleIndex = newRuleSetsFile.RuleSets.findIndex(function (rs) { return rs.Id === selectedRuleId; });
                    var availableRules = store.ruleSetsForSchema(selectedSchemaId);
                    store.set('currentRuleSetIndex', restoredRuleIndex >= 0 ? restoredRuleIndex : (availableRules.length ? availableRules[0].idx : -1));
                    ruleSetManagerTab.renderRuleSetSelect(view);
                    ruleSetManagerTab.renderCanvasForCurrentIndex(view);
                    snapshotSchemasSaved();
                    if (store.get('schemaOperationChangedRuleSets')) {
                        store.set('ruleSetsSavedSnapshot', JSON.stringify(store.get('ruleSetsFile')));
                        store.clearRuleSetEditFlags();
                    }
                    store.set('schemaOperationChangedRuleSets', false);
                    refreshSchemaDirtyState(view);
                });
            }).catch(function () {
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

            store.on('connectionsChanged', function () {
                renderSchemaConnectionSelect(view);
                renderSchemaForm(view);
            });
        }

        return {
            init: init,
            newSchema: newSchema,
            renderSchemaForm: renderSchemaForm
        };
    });
