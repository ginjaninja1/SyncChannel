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
                        // reference it via a MappingSegmentKind.Identity
                        // segment. A self-reference inside IdentityField's
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
                            Album = ResolveMapping(el, schema.AlbumField, connection, identity),
                            MediaFileUrl = ResolveMappingOrNullIfAnyFieldBlank(el, schema.MediaFileUrlField, connection, identity)
                        };

                        foreach (var kvp in schema.ProviderIdFields)
                        {
                            var value = ResolveMapping(el, kvp.Value, connection, identity);
                            if (!string.IsNullOrEmpty(value))
                            {
                                item.ProviderIds[kvp.Key] = value;
                            }
                        }

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
            foreach (var seg in mapping.Segments)
            {
                sb.Append(ResolveSegment(el, seg, connection, identity));
            }
            return sb.ToString();
        }

        /// <summary>
        /// Same as <see cref="ResolveMapping"/>, but returns null if the
        /// mapping is empty OR any Field segment inside it resolved to an
        /// empty string — mirrors the old ApplyUrlTemplate "a template
        /// needs {value} to be meaningful" rule (see Evidence.md: once a
        /// blank/broken URL is applied as a Primary image via
        /// ChannelItemInfo.ImageUrl, ChannelManager never replaces it
        /// later, so this must never happen in the first place).
        /// </summary>
        private static string ResolveMappingOrNullIfAnyFieldBlank(JsonElement el, FieldMapping mapping, ConnectionEntry connection, string identity)
        {
            if (mapping?.Segments == null || mapping.Segments.Count == 0) return null;

            var sb = new System.Text.StringBuilder();
            foreach (var seg in mapping.Segments)
            {
                var resolved = ResolveSegment(el, seg, connection, identity);
                if (seg.Kind == MappingSegmentKind.Field && string.IsNullOrEmpty(resolved))
                {
                    return null;
                }
                sb.Append(resolved);
            }
            return sb.ToString();
        }

        private static string ResolveSegment(JsonElement el, MappingSegment seg, ConnectionEntry connection, string identity)
        {
            switch (seg.Kind)
            {
                case MappingSegmentKind.Field:
                    return ResolveFieldSegmentValue(el, seg.Value);
                case MappingSegmentKind.CustomText:
                    return seg.Value ?? string.Empty;
                case MappingSegmentKind.ApiKeyName:
                    return connection == null ? string.Empty : (string.IsNullOrWhiteSpace(connection.ApiKeyParamName) ? "apikey" : connection.ApiKeyParamName);
                case MappingSegmentKind.ApiKeyValue:
                    return connection?.ApiKey ?? string.Empty;
                case MappingSegmentKind.BaseUrl:
                    return connection == null ? string.Empty : connection.BaseUrl.TrimEnd('/');
                case MappingSegmentKind.Identity:
                    return identity ?? string.Empty;
                default:
                    return string.Empty;
            }
        }

        // Resolves one JSON field for use inside a mapping. Prefers the
        // *arr-family images[] -> {coverType:"poster", remoteUrl} special
        // case (moved here, unchanged in behavior, from the old
        // ResolvePoster helper) so ANY field in ANY mapping gets that
        // shape recognized, not just a dedicated PosterUrlField as before.
        // Falls back to RuleEvaluator.ResolveDisplayValue for every other
        // shape — same path grammar the rule builder's conditions use.
        private static string ResolveFieldSegmentValue(JsonElement el, string path)
        {
            if (string.IsNullOrEmpty(path)) return string.Empty;

            var imageArrayMatch = TryResolveImageArrayShape(el, path);
            if (imageArrayMatch != null) return imageArrayMatch;

            return RuleEvaluator.ResolveDisplayValue(el, path) ?? string.Empty;
        }

        // Radarr/Sonarr both express posters as images[].coverType == "poster" -> remoteUrl.
        // Kept as a small special case (same shape both built-in schemas share)
        // rather than a fully generic "nested array lookup" schema field —
        // a field that isn't shaped like this just falls through to the
        // generic resolver above.
        private static string TryResolveImageArrayShape(JsonElement el, string path)
        {
            if (!el.TryGetProperty(path, out var valueEl) || valueEl.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            foreach (var img in valueEl.EnumerateArray())
            {
                if (img.TryGetProperty("coverType", out var coverType) &&
                    string.Equals(coverType.GetString(), "poster", StringComparison.OrdinalIgnoreCase) &&
                    img.TryGetProperty("remoteUrl", out var remoteUrl))
                {
                    return remoteUrl.GetString();
                }
            }

            return null;
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
