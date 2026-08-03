// Walks a raw JSON array response (the same shape HttpFetchProvider consumes)
// and infers the rule-builder field palette automatically, replacing the
// hand-authored SchemaField lists in EndpointSchemaStore.BuildRadarrMovies /
// BuildSonarrSeries. Runs over the FULL response set, not a sample — every
// element is unioned so a field only present on some items (e.g. Sonarr's
// "previousAiring", absent on unaired seasons) is still discovered.
//
// Not yet wired to replace the built-in seeded field lists — this powers a
// new "Discover fields" action from the connection screen. Built-ins keep
// their static lists until this has been run against live Radarr/Sonarr and
// the results are trusted.
namespace SyncChannel.Configuration
{
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using System.Text.Json;

    public static class FieldDiscoveryService
    {
        // Locates the array to walk, honoring an optional dotted path for
        // envelope-shaped responses (e.g. Emby's {"Items": [...],
        // "TotalRecordCount": ...}) where the root itself isn't the array.
        // Also always reports every top-level key whose value IS an array,
        // regardless of success — so a caller can suggest those as
        // candidates the moment the configured path doesn't resolve, or
        // when none is configured yet and the root isn't already an array.
        public static bool TryLocateArray(JsonElement root, string itemsRootPath, out JsonElement arrayElement, out List<string> topLevelArrayKeyCandidates)
        {
            topLevelArrayKeyCandidates = new List<string>();
            if (root.ValueKind == JsonValueKind.Object)
            {
                foreach (var prop in root.EnumerateObject())
                {
                    if (prop.Value.ValueKind == JsonValueKind.Array)
                    {
                        topLevelArrayKeyCandidates.Add(prop.Name);
                    }
                }
            }

            var current = root;
            if (!string.IsNullOrEmpty(itemsRootPath))
            {
                foreach (var segment in itemsRootPath.Split('.'))
                {
                    if (current.ValueKind != JsonValueKind.Object || !TryGetPropertyIgnoreCase(current, segment, out current))
                    {
                        arrayElement = default;
                        return false;
                    }
                }
            }

            if (current.ValueKind == JsonValueKind.Array)
            {
                arrayElement = current;
                return true;
            }

            arrayElement = default;
            return false;
        }

        private static bool TryGetPropertyIgnoreCase(JsonElement element, string name, out JsonElement value)
        {
            if (element.TryGetProperty(name, out value))
            {
                return true;
            }

            foreach (var property in element.EnumerateObject())
            {
                if (string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase))
                {
                    value = property.Value;
                    return true;
                }
            }

            value = default;
            return false;
        }

        // Depth budget from the array element root. 1 = top-level scalar,
        // 2 = one level of object/array nesting (ratings.value,
        // images.coverType), 3 = two levels (seasons.statistics.episodeCount).
        // Beyond this the rule builder palette stops being usable — dropped,
        // not flattened further.
        private const int MaxDepth = 3;

        /// <summary>
        /// Discovers the field palette from a raw JSON array response.
        /// <paramref name="favoritePaths"/> comes from FieldFavoritesStore
        /// (not the schema's old Fields list) — favorites live outside
        /// EndpointSchema entirely, see FieldFavoritesStore for why.
        /// Throws if rawJson doesn't parse as a JSON array; caller decides
        /// how to surface that (discovery only works against list endpoints).
        /// </summary>
        public static List<SchemaField> Discover(string rawJson, IEnumerable<string> favoritePaths = null)
        {
            var favorites = new HashSet<string>(favoritePaths ?? Enumerable.Empty<string>(), StringComparer.OrdinalIgnoreCase);

            var typeByPath = new Dictionary<string, SchemaFieldType>(StringComparer.OrdinalIgnoreCase);
            var orderByPath = new List<string>(); // first-seen order, preserved as the tiebreaker within a sort group

            // Per-path, per-RECORD raw values — slot[i] holds every value
            // seen for that path within record i (document order), for the
            // first MaxExampleRecords records only. Positional by record,
            // deliberately NOT flattened/deduped across records: that's what
            // lets the mapper preview show "record 2 had no value" instead of
            // silently reusing record 0's value, and lets Array[N] index into
            // one record's own array rather than a cross-record pool. Type
            // inference (Merge, below) still unions across every record.
            var examplesByPath = new Dictionary<string, List<string>[]>(StringComparer.OrdinalIgnoreCase);

            using (var doc = JsonDocument.Parse(rawJson))
            {
                if (doc.RootElement.ValueKind != JsonValueKind.Array)
                {
                    throw new InvalidOperationException("Discovery requires a JSON array response.");
                }

                var recordIndex = 0;
                foreach (var element in doc.RootElement.EnumerateArray())
                {
                    WalkObject(element, string.Empty, 1, typeByPath, orderByPath, examplesByPath, recordIndex);
                    recordIndex++;
                }
            }

            var fields = orderByPath.Select(path => new SchemaField
            {
                JsonPath = path,
                DisplayName = path,
                Type = typeByPath[path],
                IsFavorite = favorites.Contains(path),
                Examples = examplesByPath.TryGetValue(path, out var slots)
                    ? slots.Select(s => s ?? new List<string>()).ToList()
                    : EmptyExampleRecords()
            }).ToList();

            return Sort(fields);
        }

        // Every record slot present, even when nothing was ever captured for
        // this path — callers (the mapper preview) index by record position
        // and need a slot per record to know "absent" from "not discovered".
        private static List<List<string>> EmptyExampleRecords()
        {
            var list = new List<List<string>>();
            for (var i = 0; i < MaxExampleRecords; i++) list.Add(new List<string>());
            return list;
        }

        private static void WalkObject(
            JsonElement el, string prefix, int depth,
            Dictionary<string, SchemaFieldType> typeByPath, List<string> orderByPath,
            Dictionary<string, List<string>[]> examplesByPath, int recordIndex)
        {
            if (depth > MaxDepth || el.ValueKind != JsonValueKind.Object) return;

            foreach (var prop in el.EnumerateObject())
            {
                var path = prefix.Length == 0 ? prop.Name : prefix + "." + prop.Name;

                switch (prop.Value.ValueKind)
                {
                    case JsonValueKind.True:
                    case JsonValueKind.False:
                        Merge(typeByPath, orderByPath, path, SchemaFieldType.Bool);
                        AddExample(examplesByPath, path, prop.Value.GetBoolean().ToString(), recordIndex);
                        break;

                    case JsonValueKind.Number:
                        Merge(typeByPath, orderByPath, path, SchemaFieldType.Number);
                        AddExample(examplesByPath, path, prop.Value.ToString(), recordIndex);
                        break;

                    case JsonValueKind.String:
                        Merge(typeByPath, orderByPath, path, LooksLikeDate(prop.Value.GetString()) ? SchemaFieldType.Date : SchemaFieldType.String);
                        AddExample(examplesByPath, path, prop.Value.GetString(), recordIndex);
                        break;

                    case JsonValueKind.Object:
                        WalkObject(prop.Value, path, depth + 1, typeByPath, orderByPath, examplesByPath, recordIndex);
                        break;

                    case JsonValueKind.Array:
                        WalkArray(prop.Value, path, depth + 1, typeByPath, orderByPath, examplesByPath, recordIndex);
                        break;

                        // Null/Undefined: skip. Another element in the array may
                        // supply a typed value at the same path — that's exactly
                        // why we union across the full set rather than one sample.
                }
            }
        }

        // How many leading records get their own example slot, and a safety
        // cap on values captured per record (a record's own array is
        // normally tiny — this just bounds a pathological response).
        private const int MaxExampleRecords = 3;
        private const int MaxValuesPerRecord = 20;

        private static void AddExample(Dictionary<string, List<string>[]> examplesByPath, string path, string value, int recordIndex)
        {
            if (string.IsNullOrEmpty(value) || recordIndex >= MaxExampleRecords) return;

            if (!examplesByPath.TryGetValue(path, out var slots))
            {
                slots = new List<string>[MaxExampleRecords];
                for (var i = 0; i < MaxExampleRecords; i++) slots[i] = new List<string>();
                examplesByPath[path] = slots;
            }

            var list = slots[recordIndex];
            if (list.Count < MaxValuesPerRecord)
            {
                list.Add(value);
            }
        }

        private static void WalkArray(
            JsonElement arr, string path, int depth,
            Dictionary<string, SchemaFieldType> typeByPath, List<string> orderByPath,
            Dictionary<string, List<string>[]> examplesByPath, int recordIndex)
        {
            if (depth > MaxDepth) return;

            bool sawPrimitive = false;

            foreach (var item in arr.EnumerateArray())
            {
                switch (item.ValueKind)
                {
                    case JsonValueKind.String:
                        sawPrimitive = true;
                        AddExample(examplesByPath, path, item.GetString(), recordIndex);
                        break;

                    case JsonValueKind.Number:
                    case JsonValueKind.True:
                    case JsonValueKind.False:
                        sawPrimitive = true;
                        AddExample(examplesByPath, path, item.ToString(), recordIndex);
                        break;

                    case JsonValueKind.Object:
                        // Collapse: one level of scalar sub-fields off each
                        // array-of-objects entry becomes its own List-typed
                        // field at "arrayName.subfield" — the same shape as
                        // the existing hand-authored images.coverType /
                        // studios.name fields. Deliberately does not recurse
                        // further (an array inside an array item, e.g.
                        // seasons[].statistics.releaseGroups[], is dropped —
                        // that's the MaxDepth budget doing its job).
                        foreach (var prop in item.EnumerateObject())
                        {
                            var subPath = path + "." + prop.Name;
                            switch (prop.Value.ValueKind)
                            {
                                case JsonValueKind.String:
                                    Merge(typeByPath, orderByPath, subPath, SchemaFieldType.List);
                                    AddExample(examplesByPath, subPath, prop.Value.GetString(), recordIndex);
                                    break;
                                case JsonValueKind.Number:
                                case JsonValueKind.True:
                                case JsonValueKind.False:
                                    Merge(typeByPath, orderByPath, subPath, SchemaFieldType.List);
                                    AddExample(examplesByPath, subPath, prop.Value.ToString(), recordIndex);
                                    break;
                            }
                        }
                        break;

                        // Nested arrays-of-arrays: not a shape either Radarr or
                        // Sonarr produce; intentionally unhandled rather than
                        // guessed at.
                }
            }

            if (sawPrimitive)
            {
                Merge(typeByPath, orderByPath, path, SchemaFieldType.List);
            }
        }

        private static void Merge(
            Dictionary<string, SchemaFieldType> typeByPath, List<string> orderByPath,
            string path, SchemaFieldType type)
        {
            if (typeByPath.TryGetValue(path, out var existing))
            {
                if (existing == type) return;

                // Conflicting types across the unioned set (e.g. one item has
                // a string, another has a number at the same path). List
                // always wins if either side saw a list shape; otherwise fall
                // back to String rather than silently guess — a String field
                // still works with EQ/CONTAINS, just not numeric comparisons.
                typeByPath[path] = (existing == SchemaFieldType.List || type == SchemaFieldType.List)
                    ? SchemaFieldType.List
                    : SchemaFieldType.String;
                return;
            }

            typeByPath[path] = type;
            orderByPath.Add(path);
        }

        // Deliberately strict: requires a full yyyy-MM-dd date component so
        // plain numeric-looking or short strings ("2026", "v3") aren't
        // misclassified. Accepts an optional time/offset suffix (Radarr/
        // Sonarr both emit full ISO-8601 UTC timestamps, e.g.
        // "2026-05-18T00:00:00Z"). Uses DateTimeOffset.TryParseExact against
        // the known *arr-family shapes rather than a loose TryParse, which
        // would also accept ambiguous non-date strings.
        private static bool LooksLikeDate(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length < 10) return false;

            return System.DateTimeOffset.TryParseExact(
                value,
                new[] { "yyyy-MM-dd", "yyyy-MM-ddTHH:mm:ssZ", "yyyy-MM-ddTHH:mm:ss.fffZ", "yyyy-MM-ddTHH:mm:sszzz" },
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None,
                out _);
        }

        // Favorites first, then grouped by type (Bool, Number, String, List —
        // matches quick-filter value first, "contains" filters last), then by
        // first-seen order within each group so re-running discovery doesn't
        // reshuffle the palette every time. List.Sort is not stable in .NET,
        // so this uses OrderBy against a captured original index instead.
        private static List<SchemaField> Sort(List<SchemaField> fields)
        {
            var withIndex = fields.Select((f, i) => (Field: f, Index: i));

            return withIndex
                .OrderByDescending(x => x.Field.IsFavorite)
                .ThenBy(x => TypeRank(x.Field.Type))
                .ThenBy(x => ImportanceRank(x.Field.JsonPath))
                .ThenBy(x => x.Index)
                .Select(x => x.Field)
                .ToList();
        }

        // Secondary tiebreaker within each type group: fields an admin is
        // likely to actually map (identity/display/date-ish things) sort
        // ahead of fields that are more often filter-only (genres/tags/
        // studio/urls), instead of pure first-seen order. Matched against
        // only the field's own last path segment (not the full dotted path)
        // so a nested field like "studios.name" is judged on "name", not
        // coincidentally matched by an unrelated ancestor segment.
        private static readonly string[] TopKeywords =
            { "title", "name", "id", "image", "poster", "overview", "description", "summary", "year", "date" };
        private static readonly string[] BottomKeywords =
            { "genre", "tag", "studio", "keyword", "url", "website", "link" };

        private static int ImportanceRank(string path)
        {
            var lastSegment = (path ?? string.Empty).Split('.').Last().ToLowerInvariant();
            if (BottomKeywords.Any(k => lastSegment.Contains(k))) return 2;
            if (TopKeywords.Any(k => lastSegment.Contains(k))) return 0;
            return 1;
        }

        private static int TypeRank(SchemaFieldType type)
        {
            switch (type)
            {
                case SchemaFieldType.Bool: return 0;
                case SchemaFieldType.Number: return 1;
                case SchemaFieldType.Date: return 2;
                case SchemaFieldType.String: return 3;
                case SchemaFieldType.List: return 4;
                default: return 5;
            }
        }
    }
}