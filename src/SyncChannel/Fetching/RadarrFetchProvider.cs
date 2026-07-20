// Wraps the existing, evidence-confirmed Radarr integration behind
// IFetchProvider. Deliberately does NOT reuse RadarrClient as-is: that class
// is wired to the single global PluginConfiguration (one Radarr URL/key,
// one active rule set). A folder tree needs N independent Radarr fetch
// instances, each with its own URL/key/rule-set selection, so this provider
// does its own HTTP call — same request shape, same headers, same
// null-on-failure contract already confirmed working in RadarrClient — and
// reuses RuleEvaluator + RadarrRuleSetStore unchanged for rule evaluation.
//
// The existing RadarrClient / RadarrComingSoonChannel / RadarrChannelSyncTask
// are left completely untouched by this file — the original flat channel
// keeps working exactly as before while this provider powers the new
// folder-tree channel alongside it.
namespace SyncChannel.Fetching
{
    using SyncChannel.Rules;
    using MediaBrowser.Common.Net;
    using MediaBrowser.Model.Logging;
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;
    using System.Text.Json;
    using System.Threading;
    using System.Threading.Tasks;

    public class RadarrFetchProvider : IFetchProvider
    {
        public const string Key = "radarr";

        private readonly IHttpClient httpClient;
        private readonly RadarrRuleSetStore ruleSetStore;
        private readonly ILogger logger;

        public RadarrFetchProvider(IHttpClient httpClient, RadarrRuleSetStore ruleSetStore, ILogger logger)
        {
            this.httpClient = httpClient;
            this.ruleSetStore = ruleSetStore;
            this.logger = logger;
        }

        public string ProviderKey => Key;

        public string DisplayName => "Radarr";

        public IEnumerable<FetchFieldDefinition> GetFieldSchema()
        {
            yield return new FetchFieldDefinition
            {
                Key = "RadarrUrl",
                DisplayName = "Radarr URL",
                Description = "e.g. http://127.0.0.1:7878",
                Type = FetchFieldType.String,
                Required = true,
                DefaultValue = "http://127.0.0.1:7878"
            };
            yield return new FetchFieldDefinition
            {
                Key = "ApiKey",
                DisplayName = "Radarr API Key",
                Description = "Settings > General > Security in Radarr",
                Type = FetchFieldType.Password,
                Required = true
            };
            yield return new FetchFieldDefinition
            {
                Key = "RuleSetId",
                DisplayName = "Rule set",
                Description = "Which saved Radarr rule set this fetch evaluates movies against",
                Type = FetchFieldType.RuleSetPicker,
                Required = true
            };
        }

        public async Task<IReadOnlyList<FetchedItem>> FetchAsync(Dictionary<string, string> settings, CancellationToken cancellationToken)
        {
            settings ??= new Dictionary<string, string>();
            settings.TryGetValue("RadarrUrl", out var radarrUrl);
            settings.TryGetValue("ApiKey", out var apiKey);
            settings.TryGetValue("RuleSetId", out var ruleSetId);

            if (string.IsNullOrWhiteSpace(radarrUrl) || string.IsNullOrWhiteSpace(apiKey))
            {
                logger.Warn("ChannelSync: Radarr fetch skipped — URL or API key not configured for this fetch instance.");
                return null;
            }

            var rawJson = await GetRawMoviesAsync(radarrUrl, apiKey, cancellationToken).ConfigureAwait(false);
            if (rawJson == null)
            {
                return null; // failure already logged in GetRawMoviesAsync — null propagates, never an empty list
            }

            var ruleRoot = ResolveRuleRoot(ruleSetId);

            try
            {
                using (var doc = JsonDocument.Parse(rawJson))
                {
                    var results = new List<FetchedItem>();

                    foreach (var movieEl in doc.RootElement.EnumerateArray())
                    {
                        if (!RuleEvaluator.Matches(movieEl, ruleRoot))
                        {
                            continue;
                        }

                        var titleSlug = movieEl.TryGetProperty("titleSlug", out var slugEl) ? slugEl.GetString() : null;

                        if (string.IsNullOrEmpty(titleSlug))
                        {
                            var titleForLog = movieEl.TryGetProperty("title", out var titleEl) ? titleEl.GetString() : "(unknown)";
                            logger.Warn("ChannelSync: Radarr movie '{0}' has no titleSlug — dropping from fetch results.", titleForLog);
                            continue;
                        }

                        var item = new FetchedItem
                        {
                            StableId = titleSlug,
                            Title = GetString(movieEl, "title"),
                            OriginalTitle = GetString(movieEl, "originalTitle"),
                            Year = movieEl.TryGetProperty("year", out var yearEl) && yearEl.TryGetInt32(out var y) ? y : (int?)null,
                            Overview = GetString(movieEl, "overview"),
                            PosterUrl = ResolvePosterUrl(movieEl)
                        };

                        item.ProviderIds["RadarrId"] = titleSlug;

                        if (movieEl.TryGetProperty("tmdbId", out var tmdbEl) && tmdbEl.TryGetInt32(out var tmdbId) && tmdbId > 0)
                        {
                            item.ProviderIds["Tmdb"] = tmdbId.ToString();
                        }

                        if (movieEl.TryGetProperty("imdbId", out var imdbEl) && imdbEl.ValueKind == JsonValueKind.String)
                        {
                            var imdbId = imdbEl.GetString();
                            if (!string.IsNullOrEmpty(imdbId))
                            {
                                item.ProviderIds["Imdb"] = imdbId;
                            }
                        }

                        results.Add(item);
                    }

                    logger.Info("ChannelSync: Radarr fetch matched {0} movie(s) against rule set '{1}'.", results.Count, ruleSetId);
                    return results;
                }
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Radarr rule evaluation failed for this fetch instance — treating as failure, not zero matches", ex);
                return null;
            }
        }

        private RuleNode ResolveRuleRoot(string ruleSetId)
        {
            var file = ruleSetStore.Load();

            var match = file.RuleSets.FirstOrDefault(r => string.Equals(r.Id, ruleSetId, StringComparison.OrdinalIgnoreCase));
            if (match != null)
            {
                return match.Root;
            }

            logger.Warn(
                "ChannelSync: Radarr fetch instance references rule set '{0}' which no longer exists — falling back to the first available rule set.",
                ruleSetId);

            return file.RuleSets.FirstOrDefault()?.Root
                   ?? new RuleNode { Kind = RuleNodeKind.Group };
        }

        private async Task<string> GetRawMoviesAsync(string radarrUrl, string apiKey, CancellationToken cancellationToken)
        {
            var baseUrl = radarrUrl.TrimEnd('/') + "/api/v3/movie";
            var url = baseUrl + "?apikey=" + Uri.EscapeDataString(apiKey);

            var options = new HttpRequestOptions
            {
                Url = url,
                CancellationToken = cancellationToken
            };
            options.RequestHeaders["X-Api-Key"] = apiKey;

            try
            {
                using (var response = await httpClient.GetResponse(options).ConfigureAwait(false))
                using (var stream = response.Content)
                using (var reader = new StreamReader(stream))
                {
                    return await reader.ReadToEndAsync().ConfigureAwait(false);
                }
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Radarr call failed for fetch instance against {0}", ex, baseUrl);
                return null;
            }
        }

        private static string ResolvePosterUrl(JsonElement movieEl)
        {
            if (!movieEl.TryGetProperty("images", out var imagesEl) || imagesEl.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            foreach (var img in imagesEl.EnumerateArray())
            {
                if (img.TryGetProperty("coverType", out var coverTypeEl) &&
                    string.Equals(coverTypeEl.GetString(), "poster", StringComparison.OrdinalIgnoreCase) &&
                    img.TryGetProperty("remoteUrl", out var remoteUrlEl))
                {
                    return remoteUrlEl.GetString();
                }
            }

            return null;
        }

        private static string GetString(JsonElement el, string property) =>
            el.TryGetProperty(property, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : string.Empty;
    }
}
