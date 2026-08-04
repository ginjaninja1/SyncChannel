// Generic replacement for the old per-provider IFetchProvider classes.
// Given a Connection (URL/key) + EndpointSchema (path/fields) + RuleSet
// (filter), this does the GET, evaluates, and maps results — identically
// for Radarr, Sonarr, or any future schema. Reuses RuleEvaluator unchanged.
// Same null-on-failure contract as the original RadarrClient/RadarrFetchProvider
// (see Evidence.md) — null means "skipped," never "zero matches."
namespace SyncChannel.Fetching
{
    using SyncChannel.Configuration;
    using SyncChannel.Rules;
    using MediaBrowser.Common.Net;
    using MediaBrowser.Model.Logging;
    using MediaBrowser.Model.Net;
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;
    using System.Threading;
    using System.Threading.Tasks;
    using System.Text.Json;

    public class HttpFetchProvider
    {
        private readonly IHttpClient httpClient;
        private readonly ILogger logger;

        public HttpFetchProvider(IHttpClient httpClient, ILogger logger)
        {
            this.httpClient = httpClient;
            this.logger = logger;
        }

        /// <summary>Runs the GET and returns the raw JSON array text, or null on failure.</summary>
        public async Task<string> FetchRawAsync(ConnectionEntry connection, EndpointSchema schema, CancellationToken cancellationToken)
        {
            if (connection == null || string.IsNullOrWhiteSpace(connection.BaseUrl) || string.IsNullOrWhiteSpace(connection.ApiKey))
            {
                logger.Warn("ChannelSync: Fetch skipped — connection URL/key not configured.");
                return null;
            }

            if (schema == null)
            {
                logger.Warn(
                    "ChannelSync: Fetch skipped — connection '{0}' is system type '{1}' but schema '{2}' is '{3}'.",
                    connection.DisplayLabel, connection.SystemType, "(missing)", connection.SystemType);
                return null;
            }

            var baseUrl = connection.BaseUrl.TrimEnd('/') + schema.Path;
            var url = baseUrl + "?" + BuildQueryString(schema, connection);

            var options = new HttpRequestOptions { Url = url, CancellationToken = cancellationToken };
            // Kept in addition to the query param for *arr-family compat
            // (confirmed working that way) — harmless extra header against
            // sources that ignore it, e.g. Emby.
            options.RequestHeaders["X-Api-Key"] = connection.ApiKey;

            logger.Info("ChannelSync: Fetching {0}?{1}", baseUrl, RedactedQueryString(schema, connection));

            try
            {
                using (var response = await httpClient.GetResponse(options).ConfigureAwait(false))
                using (var stream = response.Content)
                using (var reader = new StreamReader(stream))
                {
                    var text = await reader.ReadToEndAsync().ConfigureAwait(false);
                    logger.Info("ChannelSync: Fetch succeeded against {0} ({1} bytes).", baseUrl, text.Length);
                    return text;
                }
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Fetch call failed against {0}", ex, baseUrl);
                return null;
            }
        }

        /// <summary>
        /// Evaluates raw JSON (already fetched) against a rule set and maps
        /// to FetchedItems. Null only on parse/evaluation failure — never an
        /// empty list to mean "failed," per the established contract.
        /// </summary>
        /// <param name="connection">
        /// Needed here (not just in FetchRawAsync) to resolve BaseUrl/
        /// ApiKeyName/ApiKeyValue mapping segments, including composable
        /// Provider ID links such as RadarrId and SonarrId.
        /// </param>
        public IReadOnlyList<FetchedItem> EvaluateAndMap(string rawJson, ConnectionEntry connection, EndpointSchema schema, RuleNode ruleRoot)
        {
            try
            {
                using (var doc = JsonDocument.Parse(rawJson))
                {
                    var results = new List<FetchedItem>();

                    if (!FieldDiscoveryService.TryLocateArray(doc.RootElement, schema.ItemsRootPath, out var arrayRoot, out _))
                    {
                        logger.Warn(
                            "ChannelSync: Response for schema '{0}' isn't a JSON array at '{1}' — check Items Root Path.",
                            schema.DisplayName, string.IsNullOrEmpty(schema.ItemsRootPath) ? "(root)" : schema.ItemsRootPath);
                        return null;
                    }

                    foreach (var el in arrayRoot.EnumerateArray())
                    {
                        if (!RuleEvaluator.Matches(el, ruleRoot))
                        {
                            continue;
                        }

                        // Identity resolves first — every other mapping may
                        // reference it via a MappingNodeKind.Identity
                        // node. A self-reference inside IdentityField's
                        // own mapping is passed identity: null, so it just
                        // resolves blank there (harmless, not circular).
                        var identity = ResolveMapping(el, schema.IdentityField, connection, null);
                        if (string.IsNullOrEmpty(identity))
                        {
                            var titleForLog = ResolveMapping(el, schema.TitleField, connection, null);
                            logger.Warn(
                                "ChannelSync: Item '{0}' dropped from '{1}' — no value from Identity field mapping.",
                                string.IsNullOrEmpty(titleForLog) ? "(unknown)" : titleForLog,
                                schema.DisplayName);
                            continue;
                        }

                        var item = new FetchedItem
                        {
                            StableId = identity,
                            Title = ResolveMapping(el, schema.TitleField, connection, identity),
                            OriginalTitle = ResolveMapping(el, schema.OriginalTitleField, connection, identity),
                            Overview = ResolveMapping(el, schema.OverviewField, connection, identity),
                            Year = ParseYear(ResolveMapping(el, schema.YearField, connection, identity)),
                            // Poster/MediaFileUrl null out entirely if any Field
                            // segment inside them resolved empty — same "never
                            // cache a URL built from a blank value" discipline
                            // as the old ApplyUrlTemplate had for {value}, now
                            // applied per-mapping instead of per-template.
                            PosterUrl = ResolveMappingOrNullIfAnyFieldBlank(el, schema.PosterUrlField, connection, identity),
                            Artist = ResolveMapping(el, schema.ArtistField, connection, identity),
                            AlbumArtist = ResolveMapping(el, schema.AlbumArtistField, connection, identity),
                            Artists = ResolveListMapping(el, schema.ArtistField, connection, identity),
                            AlbumArtists = ResolveListMapping(el, schema.AlbumArtistField, connection, identity),
                            Album = ResolveMapping(el, schema.AlbumField, connection, identity),
                            CatalogueArtist = ResolveMapping(el, schema.CatalogueArtistField, connection, identity),
                            CatalogueArtistOverview = ResolveMapping(el, schema.CatalogueArtistOverviewField, connection, identity),
                            CatalogueArtistPosterUrl = ResolveMappingOrNullIfAnyFieldBlank(el, schema.CatalogueArtistPosterUrlField, connection, identity),
                            AlbumOverview = ResolveMapping(el, schema.AlbumOverviewField, connection, identity),
                            AlbumPosterUrl = ResolveMappingOrNullIfAnyFieldBlank(el, schema.AlbumPosterUrlField, connection, identity),
                            AlbumYear = ParseYear(ResolveMapping(el, schema.AlbumYearField, connection, identity)),
                            TrackNumber = ParseInt(ResolveMapping(el, schema.TrackNumberField, connection, identity)),
                            DiscNumber = ParseInt(ResolveMapping(el, schema.DiscNumberField, connection, identity)),
                            MediaFileUrl = ResolveMappingOrNullIfAnyFieldBlank(el, schema.MediaFileUrlField, connection, identity),
                            ShowIdentity = ResolveMapping(el, schema.ShowIdentityField, connection, identity),
                            ShowTitle = ResolveMapping(el, schema.ShowTitleField, connection, identity),
                            ShowOverview = ResolveMapping(el, schema.ShowOverviewField, connection, identity),
                            ShowPosterUrl = ResolveMappingOrNullIfAnyFieldBlank(el, schema.ShowPosterUrlField, connection, identity),
                            SeasonNumber = ParseInt(ResolveMapping(el, schema.SeasonNumberField, connection, identity)),
                            SeasonTitle = ResolveMapping(el, schema.SeasonTitleField, connection, identity),
                            EpisodeNumber = ParseInt(ResolveMapping(el, schema.EpisodeNumberField, connection, identity)),
                            ArtistIdentity = ResolveMapping(el, schema.ArtistIdentityField, connection, identity),
                            AlbumIdentity = ResolveMapping(el, schema.AlbumIdentityField, connection, identity)
                        };

                        foreach (var kvp in schema.ProviderIdFields)
                        {
                            var value = ResolveMapping(el, kvp.Value, connection, identity);
                            if (!string.IsNullOrEmpty(value))
                            {
                                item.ProviderIds[kvp.Key] = value;
                            }
                        }

                        ResolveProviderIds(el, schema.SeriesProviderIdFields, connection, identity, item.SeriesProviderIds);
                        ResolveProviderIds(el, schema.SeasonProviderIdFields, connection, identity, item.SeasonProviderIds);
                        ResolveProviderIds(el, schema.ArtistProviderIdFields, connection, identity, item.ArtistProviderIds);
                        ResolveProviderIds(el, schema.AlbumProviderIdFields, connection, identity, item.AlbumProviderIds);

                        results.Add(item);
                    }

                    logger.Info(
                        "ChannelSync: Fetch against schema '{0}' matched {1} item(s).",
                        schema.DisplayName, results.Count);

                    return results;
                }
            }
            catch (Exception ex)
            {
                logger.ErrorException(
                    "ChannelSync: Rule evaluation/mapping failed for schema '{0}' — treating as failure, not zero matches",
                    ex, schema.DisplayName);
                return null;
            }
        }

        private static int? ParseInt(string value)
        {
            return int.TryParse(value, out var parsed) ? parsed : (int?)null;
        }

        private static List<string> ResolveListMapping(
            JsonElement element,
            FieldMapping mapping,
            ConnectionEntry connection,
            string identity)
        {
            if (mapping?.Segments == null || mapping.Segments.Count == 0) return new List<string>();

            // Preserve native JSON cardinality for the normal list mapping:
            // one Field segment such as Artists or AlbumArtists.Name.
            if (mapping.Segments.Count == 1 && mapping.Segments[0].Kind == MappingNodeKind.Field)
            {
                return RuleEvaluator.ResolveDisplayValues(element, mapping.Segments[0].Value)
                    .Where(v => !string.IsNullOrWhiteSpace(v))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToList();
            }

            // Literal/composed mappings remain useful and are coerced to a
            // one-element list; they are never split on commas.
            var scalar = ResolveMapping(element, mapping, connection, identity);
            return string.IsNullOrWhiteSpace(scalar) ? new List<string>() : new List<string> { scalar };
        }

        private static void ResolveProviderIds(
            JsonElement element,
            Dictionary<string, FieldMapping> mappings,
            ConnectionEntry connection,
            string identity,
            Dictionary<string, string> destination)
        {
            if (mappings == null) return;
            foreach (var mapping in mappings)
            {
                var value = ResolveMapping(element, mapping.Value, connection, identity);
                if (!string.IsNullOrEmpty(value)) destination[mapping.Key] = value;
            }
        }

        // ---- FieldMapping resolution ----

        /// <summary>
        /// Public entry point for call sites outside a real fetch (e.g.
        /// ChannelSyncApiSurface.PreviewRule showing a per-row title) that
        /// need one resolved field value without running EvaluateAndMap's
        /// full per-item construction. Same resolution as everywhere else —
        /// just exposed, since ResolveMapping itself stays private to keep
        /// EvaluateAndMap's resolution order (identity first, then
        /// everything else) as the only place that decides it for a real fetch.
        /// </summary>
        public static string ResolveMappingPreview(JsonElement el, FieldMapping mapping, ConnectionEntry connection, string identity)
        {
            return ResolveMapping(el, mapping, connection, identity);
        }

        /// <summary>
        /// Resolves every segment in a mapping against one item and
        /// concatenates them into a single string. Never null — an empty/
        /// null mapping resolves to "". Use
        /// <see cref="ResolveMappingOrNullIfAnyFieldBlank"/> instead for
        /// Poster/MediaFileUrl, where a blank source field must suppress
        /// the whole field rather than produce a broken URL.
        /// </summary>
        private static string ResolveMapping(JsonElement el, FieldMapping mapping, ConnectionEntry connection, string identity)
        {
            if (mapping?.Segments == null || mapping.Segments.Count == 0) return string.Empty;

            var sb = new System.Text.StringBuilder();
            foreach (var node in mapping.Segments)
            {
                sb.Append(ResolveNode(el, node, connection, identity));
            }
            return sb.ToString();
        }

        /// <summary>
        /// Same as <see cref="ResolveMapping"/>, but returns null if the
        /// mapping is empty OR any top-level Field node inside it resolved
        /// to an empty string — mirrors the old ApplyUrlTemplate "a template
        /// needs {value} to be meaningful" rule (see Evidence.md: once a
        /// blank/broken URL is applied as a Primary image via
        /// ChannelItemInfo.ImageUrl, ChannelManager never replaces it
        /// later, so this must never happen in the first place). Only
        /// top-level Field nodes are checked, same as before this became a
        /// tree — a Field wrapped inside a Function is not checked here,
        /// since a wrapping function (e.g. Left[4]) may legitimately turn a
        /// non-blank field into a blank result on purpose.
        /// </summary>
        private static string ResolveMappingOrNullIfAnyFieldBlank(JsonElement el, FieldMapping mapping, ConnectionEntry connection, string identity)
        {
            if (mapping?.Segments == null || mapping.Segments.Count == 0) return null;

            var sb = new System.Text.StringBuilder();
            foreach (var node in mapping.Segments)
            {
                var resolved = ResolveNode(el, node, connection, identity);
                if (node.Kind == MappingNodeKind.Field && string.IsNullOrEmpty(resolved))
                {
                    return null;
                }
                sb.Append(resolved);
            }
            return sb.ToString();
        }

        // Recursively resolves a mapping's node tree against one JSON item.
        // Leaf nodes (Field/CustomText/etc) resolve directly, same rules as
        // before this became a tree. A Function node resolves its Children
        // (concatenating if there's more than one), then applies its own
        // operation to that result — EXCEPT ArraySlice, which needs the raw
        // list of values rather than an already-joined string, so it
        // special-cases the single-Field-child shape and reads the list
        // directly via RuleEvaluator.ResolveDisplayValues.
        private static string ResolveNode(JsonElement el, MappingNode node, ConnectionEntry connection, string identity)
        {
            switch (node.Kind)
            {
                case MappingNodeKind.Field:
                    return RuleEvaluator.ResolveDisplayValue(el, node.Value) ?? string.Empty;
                case MappingNodeKind.CustomText:
                    return node.Value ?? string.Empty;
                case MappingNodeKind.ApiKeyName:
                    return connection == null ? string.Empty : (string.IsNullOrWhiteSpace(connection.ApiKeyParamName) ? "apikey" : connection.ApiKeyParamName);
                case MappingNodeKind.ApiKeyValue:
                    return connection?.ApiKey ?? string.Empty;
                case MappingNodeKind.BaseUrl:
                    return connection == null ? string.Empty : connection.BaseUrl.TrimEnd('/');
                case MappingNodeKind.Identity:
                    return identity ?? string.Empty;
                case MappingNodeKind.Function:
                    return ResolveFunction(el, node, connection, identity);
                default:
                    return string.Empty;
            }
        }

        private static string ResolveFunction(JsonElement el, MappingNode node, ConnectionEntry connection, string identity)
        {
            if (node.Function == FunctionKind.ArraySlice)
            {
                // Only meaningful against a single Field child pointing at
                // an array-shaped path — the schema editor's validity check
                // is what keeps a schema from being saved in any other
                // shape wrapped in ArraySlice, so this is a defensive
                // fallback, not the primary guard.
                if (node.Children.Count == 1 && node.Children[0].Kind == MappingNodeKind.Field)
                {
                    if (!string.IsNullOrWhiteSpace(node.ArrayMatchField))
                    {
                        return ResolveFirstArrayMatch(
                            el,
                            node.Children[0].Value,
                            node.ArrayMatchField,
                            node.ArrayMatchValue);
                    }

                    var values = RuleEvaluator.ResolveDisplayValues(el, node.Children[0].Value);
                    if (values.Count > 0) return ApplyArraySlice(values, node);
                }
                return string.Empty;
            }

            var joined = string.Concat(node.Children.ConvertAll(c => ResolveNode(el, c, connection, identity)));
            return ApplyStringFunction(joined, node);
        }

        private static string ApplyArraySlice(List<string> values, MappingNode node)
        {
            if (node.End < 0) return string.Join(", ", values); // "all"
            int start = Math.Max(0, Math.Min(node.Start, values.Count - 1));
            int end = Math.Max(start, Math.Min(node.End, values.Count - 1));
            var slice = new List<string>();
            for (int i = start; i <= end; i++) slice.Add(values[i]);
            return string.Join(", ", slice);
        }

        // Resolves Array[field=value][array.resultField] without flattening
        // array.resultField first. Keeping each original object intact is what
        // lets a sibling discriminator such as coverType reliably select its
        // own remoteUrl regardless of Radarr/Sonarr array ordering.
        private static string ResolveFirstArrayMatch(
            JsonElement itemRoot,
            string resultPath,
            string matchField,
            string matchValue)
        {
            var resultSegments = SplitPath(resultPath);
            if (resultSegments.Length < 2) return string.Empty;

            var current = itemRoot;
            var arraySegmentCount = 0;
            for (var i = 0; i < resultSegments.Length; i++)
            {
                if (current.ValueKind != JsonValueKind.Object ||
                    !current.TryGetProperty(resultSegments[i], out current))
                {
                    return string.Empty;
                }

                arraySegmentCount = i + 1;
                if (current.ValueKind == JsonValueKind.Array) break;
            }

            if (current.ValueKind != JsonValueKind.Array ||
                arraySegmentCount >= resultSegments.Length)
            {
                return string.Empty;
            }

            var relativeResult = resultSegments.Skip(arraySegmentCount).ToArray();
            var matchSegments = SplitPath(matchField);

            // Accept either the compact sibling form (coverType) or a full
            // path sharing the selected array prefix (images.coverType).
            if (matchSegments.Length > arraySegmentCount &&
                resultSegments.Take(arraySegmentCount)
                    .SequenceEqual(matchSegments.Take(arraySegmentCount), StringComparer.Ordinal))
            {
                matchSegments = matchSegments.Skip(arraySegmentCount).ToArray();
            }

            if (matchSegments.Length == 0) return string.Empty;

            foreach (var arrayItem in current.EnumerateArray())
            {
                if (!TryResolveRelative(arrayItem, matchSegments, out var actualMatch) ||
                    !string.Equals(JsonScalarToString(actualMatch), matchValue ?? string.Empty, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (TryResolveRelative(arrayItem, relativeResult, out var result))
                {
                    return JsonScalarToString(result);
                }

                return string.Empty;
            }

            return string.Empty;
        }

        private static string[] SplitPath(string path) =>
            (path ?? string.Empty)
                .Split(new[] { '.' }, StringSplitOptions.RemoveEmptyEntries);

        private static bool TryResolveRelative(JsonElement current, string[] segments, out JsonElement result)
        {
            result = current;
            foreach (var segment in segments)
            {
                if (result.ValueKind != JsonValueKind.Object ||
                    !result.TryGetProperty(segment, out var next))
                {
                    result = default;
                    return false;
                }
                result = next;
            }
            return true;
        }

        private static string JsonScalarToString(JsonElement value) =>
            value.ValueKind == JsonValueKind.String ? value.GetString() ?? string.Empty : value.ToString();

        private static string ApplyStringFunction(string value, MappingNode node)
        {
            if (string.IsNullOrEmpty(value)) return value ?? string.Empty;

            switch (node.Function)
            {
                case FunctionKind.Left:
                    {
                        int n = Math.Max(0, Math.Min(node.Start, value.Length));
                        return value.Substring(0, n);
                    }
                case FunctionKind.Right:
                    {
                        int n = Math.Max(0, Math.Min(node.Start, value.Length));
                        return value.Substring(value.Length - n);
                    }
                case FunctionKind.Substring:
                    {
                        int start = Math.Max(0, Math.Min(node.Start, value.Length));
                        int end = Math.Max(start, Math.Min(node.End, value.Length - 1));
                        int len = value.Length == 0 ? 0 : (end - start + 1);
                        return len <= 0 ? string.Empty : value.Substring(start, len);
                    }
                default:
                    return value;
            }
        }

        private static int? ParseYear(string s)
        {
            if (int.TryParse(s, out var n)) return n;

            // Falls back to date parsing — a Year role field pointed at a
            // date-shaped field (e.g. "premiereDate": "2024-03-01") is a
            // real, expected mapping, not a malformed one; extracting the
            // year is "parsing that should happen automatically" rather
            // than something to just warn about and leave broken.
            if (DateTimeOffset.TryParse(s, out var dt)) return dt.Year;

            return null;
        }

        // Builds a user-facing status message from a failed test, since Emby's
        // wrapped HTTP exceptions (e.g. SSL failures) often have a useless outer
        // Message ("...see inner exception.") with the real cause one level down.
        private static string DescribeFailure(Exception ex)
        {
            // Walk to the innermost exception — that's almost always where the
            // actually-descriptive message lives.
            var root = ex;
            while (root.InnerException != null)
            {
                root = root.InnerException;
            }

            if ((ex is HttpException httpException && httpException.IsTimedOut) ||
                ex is OperationCanceledException ||
                root is OperationCanceledException)
            {
                return "Timed out — no response from that host and port. Check the FQDN and port.";
            }

            if (root is System.Net.Sockets.SocketException sockEx)
            {
                switch (sockEx.SocketErrorCode)
                {
                    case System.Net.Sockets.SocketError.ConnectionRefused:
                        return "Connection refused — nothing is listening on that host/port.";
                    case System.Net.Sockets.SocketError.HostNotFound:
                        return "Host not found — check the URL/hostname.";
                    case System.Net.Sockets.SocketError.TimedOut:
                        return "Timed out — no response from that host and port. Check the FQDN and port.";
                    default:
                        return "Network error: " + sockEx.SocketErrorCode;
                }
            }

            if (root is System.Security.Authentication.AuthenticationException)
            {
                return "SSL/TLS handshake failed — check the URL scheme (http vs https) and that the server's certificate is valid.";
            }

            if (root is System.Net.WebException webEx)
            {
                return "HTTP error: " + webEx.Status;
            }

            // Fall back to the innermost message if nothing above matched, since
            // that's still more useful than the outer wrapper's generic text.
            return string.IsNullOrEmpty(root.Message) ? ex.Message : root.Message;
        }

        // Query-param name comes from the Connection now, not the schema —
        // it's a fact about the application (Radarr/Sonarr both use
        // "apikey"; Emby uses "api_key"), fixed regardless of which
        // endpoint on that application is being called. Static params
        // (e.g. Limit=25) remain schema-defined, since those genuinely are
        // per-endpoint.
        private static string BuildQueryString(EndpointSchema schema, ConnectionEntry connection)
        {
            var paramName = string.IsNullOrWhiteSpace(connection.ApiKeyParamName) ? "apikey" : connection.ApiKeyParamName;
            var parts = new List<string> { Uri.EscapeDataString(paramName) + "=" + Uri.EscapeDataString(connection.ApiKey) };

            if (schema.StaticQueryParams != null)
            {
                foreach (var kvp in schema.StaticQueryParams)
                {
                    if (string.IsNullOrEmpty(kvp.Key)) continue;
                    parts.Add(Uri.EscapeDataString(kvp.Key) + "=" + Uri.EscapeDataString(kvp.Value ?? string.Empty));
                }
            }

            return string.Join("&", parts);
        }

        // Same as BuildQueryString but with the key's value redacted, for logging.
        private static string RedactedQueryString(EndpointSchema schema, ConnectionEntry connection)
        {
            var paramName = string.IsNullOrWhiteSpace(connection.ApiKeyParamName) ? "apikey" : connection.ApiKeyParamName;
            var parts = new List<string> { paramName + "=***" };

            if (schema.StaticQueryParams != null)
            {
                foreach (var kvp in schema.StaticQueryParams)
                {
                    if (string.IsNullOrEmpty(kvp.Key)) continue;
                    parts.Add(kvp.Key + "=" + kvp.Value);
                }
            }

            return string.Join("&", parts);
        }

        // Deliberately schema-agnostic — a Connection is just a (URL, key)
        // pair and can be tested for bare reachability before any
        // EndpointSchema exists to pair it with. This can only prove the
        // host is up and answering HTTP; it cannot prove the API key is
        // valid, since there's no endpoint-specific path to call it
        // against. Real credential validation happens per-endpoint, via
        // the schema editor's field-discovery fetch (which has both a
        // Path and the connection's key to combine into a real call).
        public async Task<(bool Success, string Message)> TestReachabilityAsync(
            ConnectionEntry connection, CancellationToken cancellationToken)
        {
            // Deliberately no apikey/X-Api-Key here — this test only claims
            // to prove the host is up and speaking HTTP on that port, not
            // that any credential is valid (see comment above). Auth is
            // irrelevant to that claim, so it's not sent.
            var baseUrl = connection.BaseUrl.TrimEnd('/');

            logger.Info("ChannelSync: Testing connection against {0}", baseUrl);

            var options = new HttpRequestOptions
            {
                Url = baseUrl,
                CancellationToken = cancellationToken,
                TimeoutMs = 4000,
                // A manual "Test" click must always make a real attempt.
                // CoreHttpClientManager's automatic-timeout cooldown is
                // keyed by host:port only (GetHostFromUrl strips scheme),
                // so a prior failed test against the same host on a
                // different scheme (e.g. https vs http) would otherwise
                // silently short-circuit this call for up to 30s without
                // any network attempt — see Evidence.md.
                EnableAutomaticTimeouts = false
            };

            try
            {
                using (var response = await httpClient.GetResponse(options).ConfigureAwait(false))
                {
                    logger.Info("ChannelSync: Test connection succeeded against {0}.", baseUrl);
                    return (true, "Server reachable.");
                }
            }
            catch (HttpException httpEx)
            {
                // Emby's HTTP layer also wraps connection failures and
                // timeouts in HttpException. Only a populated HTTP status
                // proves that a server actually answered on this port.
                if (!httpEx.IsTimedOut && httpEx.StatusCode.HasValue)
                {
                    logger.Info(
                        "ChannelSync: Test connection against {0} received HTTP {1} — host and port are reachable.",
                        baseUrl,
                        (int)httpEx.StatusCode.Value);
                    return (true, "Server reachable (HTTP " + (int)httpEx.StatusCode.Value + ").");
                }

                logger.ErrorException("ChannelSync: Test connection failed against {0}", httpEx, baseUrl);
                return (false, DescribeFailure(httpEx));
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Test connection failed against {0}", ex, baseUrl);
                return (false, DescribeFailure(ex));
            }
        }
    }
}
