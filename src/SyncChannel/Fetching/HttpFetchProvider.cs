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

            if (!string.IsNullOrEmpty(connection.SystemType) && !string.IsNullOrEmpty(schema.SystemType) &&
                !string.Equals(connection.SystemType, schema.SystemType, StringComparison.OrdinalIgnoreCase))
            {
                logger.Warn(
                    "ChannelSync: Fetch skipped — connection '{0}' is system type '{1}' but schema '{2}' is '{3}'.",
                    connection.DisplayLabel, connection.SystemType, schema.DisplayName, schema.SystemType);
                return null;
            }

            var baseUrl = connection.BaseUrl.TrimEnd('/') + schema.Path;
            var url = baseUrl + "?apikey=" + Uri.EscapeDataString(connection.ApiKey);

            var options = new HttpRequestOptions { Url = url, CancellationToken = cancellationToken };
            options.RequestHeaders["X-Api-Key"] = connection.ApiKey;

            logger.Info("ChannelSync: Fetching {0}?apikey=***", baseUrl);

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
        /// Needed here (not just in FetchRawAsync) purely to build
        /// ProviderIds["SourceUrl"] (and the provider-specific RadarrId/
        /// SonarrId link, below) from schema.DetailUrlFormat, which
        /// substitutes {baseUrl} from the connection and {identity} from
        /// each resolved item.
        /// </param>
        public IReadOnlyList<FetchedItem> EvaluateAndMap(string rawJson, ConnectionEntry connection, EndpointSchema schema, RuleNode ruleRoot)
        {
            try
            {
                using (var doc = JsonDocument.Parse(rawJson))
                {
                    var results = new List<FetchedItem>();

                    foreach (var el in doc.RootElement.EnumerateArray())
                    {
                        if (!RuleEvaluator.Matches(el, ruleRoot))
                        {
                            continue;
                        }

                        var identity = ResolveString(el, schema.IdentityField);
                        if (string.IsNullOrEmpty(identity))
                        {
                            var titleForLog = ResolveString(el, schema.TitleField);
                            logger.Warn(
                                "ChannelSync: Item '{0}' dropped from '{1}' — no value at identity field '{2}'.",
                                string.IsNullOrEmpty(titleForLog) ? "(unknown)" : titleForLog,
                                schema.DisplayName,
                                schema.IdentityField);
                            continue;
                        }

                        var item = new FetchedItem
                        {
                            StableId = identity,
                            Title = ResolveString(el, schema.TitleField),
                            OriginalTitle = ResolveString(el, schema.OriginalTitleField),
                            Overview = ResolveString(el, schema.OverviewField),
                            Year = ResolveInt(el, schema.YearField),
                            PosterUrl = ResolvePoster(el, schema.PosterUrlField)
                        };

                        foreach (var kvp in schema.ProviderIdFields)
                        {
                            var value = ResolveString(el, kvp.Value);
                            if (!string.IsNullOrEmpty(value))
                            {
                                item.ProviderIds[kvp.Key] = value;
                            }
                        }

                        // Click-through URL. Built here rather than
                        // reconstructed later by an IExternalId from a stored
                        // provider id + a guessed format string — only the
                        // schema knows its own detail-URL shape, and only the
                        // connection knows its own base URL, so this is the
                        // one place both are in scope together.
                        if (!string.IsNullOrEmpty(schema.DetailUrlFormat) && connection != null)
                        {
                            var resolvedUrl = schema.DetailUrlFormat
                                .Replace("{baseUrl}", connection.BaseUrl.TrimEnd('/'))
                                .Replace("{identity}", identity);

                            bool isRadarr = string.Equals(schema.SystemType, "radarr", StringComparison.OrdinalIgnoreCase);
                            bool isSonarr = string.Equals(schema.SystemType, "sonarr", StringComparison.OrdinalIgnoreCase);

                            if (isRadarr)
                            {
                                item.ProviderIds["RadarrId"] = resolvedUrl;
                            }
                            else if (isSonarr)
                            {
                                item.ProviderIds["SonarrId"] = resolvedUrl;
                            }
                            else
                            {
                                // No dedicated badge for this system — generic "Source" link is the
                                // only click-through available, so it's worth keeping here.
                                item.ProviderIds["SourceUrl"] = resolvedUrl;
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

        private static string ResolveString(JsonElement el, string fieldPath)
        {
            if (string.IsNullOrEmpty(fieldPath)) return string.Empty;
            var value = RuleEvaluator.ResolveDisplayValue(el, fieldPath);
            return value ?? string.Empty;
        }

        private static int? ResolveInt(JsonElement el, string fieldPath)
        {
            var s = ResolveString(el, fieldPath);
            return int.TryParse(s, out var n) ? n : (int?)null;
        }

        // Radarr/Sonarr both express posters as images[].coverType == "poster" -> remoteUrl.
        // Kept as a small special case (same shape both built-in schemas share)
        // rather than a fully generic "nested array lookup" schema field —
        // a future custom schema with a differently-shaped poster field can
        // just leave PosterUrlField blank and get no poster, which is fine.
        private static string ResolvePoster(JsonElement el, string posterField)
        {
            if (string.IsNullOrEmpty(posterField) ||
                !el.TryGetProperty(posterField, out var imagesEl) ||
                imagesEl.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            foreach (var img in imagesEl.EnumerateArray())
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

        public async Task<(bool Success, string Message)> TestReachabilityAsync(
            ConnectionEntry connection, EndpointSchema schema, CancellationToken cancellationToken)
        {
            if (!string.IsNullOrEmpty(connection.SystemType) && !string.IsNullOrEmpty(schema.SystemType) &&
                !string.Equals(connection.SystemType, schema.SystemType, StringComparison.OrdinalIgnoreCase))
            {
                return (false, string.Format(
                    "Connection is system type '{0}' but you're testing against a '{1}' endpoint — pick a matching endpoint.",
                    connection.SystemType, schema.SystemType));
            }

            var baseUrl = connection.BaseUrl.TrimEnd('/') + schema.Path;
            var url = baseUrl + "?apikey=" + Uri.EscapeDataString(connection.ApiKey);

            logger.Info("ChannelSync: Testing connection against {0}?apikey=***", baseUrl);

            var options = new HttpRequestOptions
            {
                Url = url,
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
            options.RequestHeaders["X-Api-Key"] = connection.ApiKey;

            try
            {
                using (var response = await httpClient.GetResponse(options).ConfigureAwait(false))
                {
                    logger.Info("ChannelSync: Test connection succeeded against {0}.", baseUrl);
                    return (true, "Reachable.");
                }
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Test connection failed against {0}", ex, baseUrl);
                return (false, ex.Message);
            }
        }
    }
}