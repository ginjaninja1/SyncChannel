namespace SyncChannel.Rules
{
    using MediaBrowser.Model.Logging;
    using MediaBrowser.Model.Services;
    using SyncChannel.Configuration;
    using SyncChannel.Fetching;
    using SyncChannel.ScheduledTasks;
    using SyncChannel.Services;
    using System.Collections.Generic;
    using System.Linq;
    using System.Text.Json;
    using System.Threading;
    using System;
    using System.Threading.Tasks;
    using System.IO;
    using MediaBrowser.Common.Configuration;
    using MediaBrowser.Common.Net;
    using MediaBrowser.Model.Net;

    // ---- Connections ----
    [Route("/ChannelSync/Connections", "GET")] public class GetConnections : IReturn<ConnectionsFile> { }
    [Route("/ChannelSync/Connections", "POST")] public class SaveConnections : IReturn<object> { public ConnectionsFile Payload { get; set; } }
    [Route("/ChannelSync/Connections/{Id}", "DELETE")] public class DeleteConnection : IReturn<object> { public string Id { get; set; } }

    // ---- Endpoint schemas ----
    [Route("/ChannelSync/EndpointSchemas", "GET")] public class GetEndpointSchemas : IReturn<EndpointSchemasFile> { }
    [Route("/ChannelSync/EndpointSchemas", "POST")] public class SaveEndpointSchemas : IReturn<object> { public EndpointSchemasFile Payload { get; set; } }
    [Route("/ChannelSync/EndpointSchemas/{Id}", "DELETE")] public class DeleteEndpointSchema : IReturn<object> { public string Id { get; set; } }

    // ---- Rule sets ----
    [Route("/ChannelSync/RuleSets", "GET")] public class GetRuleSets : IReturn<RuleSetsFile> { }
    [Route("/ChannelSync/RuleSets", "POST")] public class SaveRuleSets : IReturn<object> { public RuleSetsFile Payload { get; set; } }
    [Route("/ChannelSync/RuleSets/{Id}", "DELETE")] public class DeleteRuleSet : IReturn<object> { public string Id { get; set; } }

    // ---- Live preview (cache-first: fetches live only if nothing cached
    // yet for this connection+schema pair, otherwise always reuses the
    // cached response — representative data is enough for rule-building,
    // and this keeps API/PC load minimal). Fully self-sufficient: does not
    // require a folder-tree sync to have ever run. ----
    [Route("/ChannelSync/RulePreview", "POST")]
    public class PreviewRule : IReturn<object>
    {
        public string EndpointSchemaId { get; set; }
        public RuleNode Rule { get; set; }
        public bool IncludeRawJson { get; set; }
    }

    // ---- Folder tree ----
    [Route("/ChannelSync/FolderTree", "GET")] public class GetFolderTree : IReturn<FolderTreeFile> { }
    [Route("/ChannelSync/FolderTree", "POST")] public class SaveFolderTree : IReturn<object> { public FolderNode RootFolder { get; set; } }

    // ---- Opt-in runtime media compatibility harness ----
    [Route("/ChannelSync/MediaTestHarness", "GET")]
    public class GetMediaTestHarness : IReturn<object> { }

    [Route("/ChannelSync/MediaTestHarness", "POST")]
    public class SaveMediaTestHarness : IReturn<object>
    {
        public bool Enabled { get; set; }
        public string VideoUrl { get; set; }
        public string AudioUrl { get; set; }
        public string ImageUrl { get; set; }
        public string HlsUrl { get; set; }
        public bool RunNow { get; set; }
    }

    // ---- Connection reachability test. Tests the LIVE field values sent
    // from the browser, not whatever's on disk — so it works before Save
    // as well as after. ConnectionId is included only so that, if this
    // connection also exists on disk, its persisted LastTestSucceeded/
    // LastTestedUtc badge gets updated too. ----
    [Route("/ChannelSync/TestConnection", "POST")]
    public class TestConnection : IReturn<object>
    {
        public string ConnectionId { get; set; }
        public string BaseUrl { get; set; }
        public string ApiKey { get; set; }
        public string SystemType { get; set; }
    }

    // ---- Field discovery. Cache-first, same contract as PreviewRule below —
    // reuses whatever's cached for this connection+schema pair, only fetches
    // live if nothing's cached yet. ForceRefresh bypasses the cache (the
    // palette's "Refresh" button). Purely computed on every call — nothing
    // written back to EndpointSchemasFile. See Evidence.md for why: a saved
    // snapshot of discovered fields would hit the same built-in-schema
    // save guard that broke favorites, and starting purely-computed avoids
    // that problem entirely rather than solving it. ----
    [Route("/ChannelSync/DiscoverFields", "POST")]
    public class DiscoverFields : IReturn<object>
    {
        // Used when the schema is already saved — looked up via
        // schemaStore.Find. Ignored if DraftSchema is supplied.
        public string EndpointSchemaId { get; set; }

        // The full in-progress schema, sent directly by the editor so a
        // brand-new, not-yet-saved schema can still be tested — Path and
        // role fields don't need a round trip through Save first. Caching
        // (lastResponseStore) still keys off Schema.Id, which the client
        // already generates locally before the first save, so this is
        // consistent with the saved-schema path once it does get saved.
        public EndpointSchema DraftSchema { get; set; }

        public bool ForceRefresh { get; set; }
    }

    // Browser image previews normally load their resolved URL directly. If
    // the remote application disallows cross-origin images, the editor uses
    // this same-origin fallback. The service validates the URL against the
    // selected saved connection before making any request.
    [Route("/ChannelSync/ImagePreview", "POST")]
    public class GetImagePreview : IReturn<object>
    {
        public string ConnectionId { get; set; }
        public string Url { get; set; }
    }

    // ---- Field favorites. Deliberately its own route, not folded into
    // SaveEndpointSchemas — see FieldFavoritesStore for why. ----
    [Route("/ChannelSync/FieldFavorite", "POST")]
    public class SetFieldFavorite : IReturn<object>
    {
        public string SchemaId { get; set; }
        public string JsonPath { get; set; }
        public bool IsFavorite { get; set; }
    }

    public class FetchValidationError
    {
        public string FolderId { get; set; }
        public string FetchId { get; set; }
        public string Field { get; set; } // "connection" | "schema" | "ruleset"
        public string Message { get; set; }
    }

    public class ChannelSyncApiSurface : IService
    {
        private readonly ConnectionsStore connectionsStore;
        private readonly EndpointSchemaStore schemaStore;
        private readonly FieldFavoritesStore favoritesStore;
        private readonly RuleSetStore ruleSetStore;
        private readonly FolderTreeStore treeStore;
        private readonly HttpFetchProvider fetchProvider;
        private readonly LastResponseCacheStore lastResponseStore;
        private readonly FolderTreeSyncTask syncTask;
        private readonly Services.ChannelIdentityReconciler reconciler;
        private readonly ILogger logger;
        private readonly IApplicationPaths appPaths;
        private readonly IHttpClient httpClient;

        public ChannelSyncApiSurface(
            ConnectionsStore connectionsStore,
            EndpointSchemaStore schemaStore,
            FieldFavoritesStore favoritesStore,
            RuleSetStore ruleSetStore,
            FolderTreeStore treeStore,
            HttpFetchProvider fetchProvider,
            LastResponseCacheStore lastResponseStore,
            FolderTreeSyncTask syncTask,
            Services.ChannelIdentityReconciler reconciler,
            IApplicationPaths appPaths,
            IHttpClient httpClient,
            ILogger logger)
        {
            this.connectionsStore = connectionsStore;
            this.schemaStore = schemaStore;
            this.favoritesStore = favoritesStore;
            this.ruleSetStore = ruleSetStore;
            this.treeStore = treeStore;
            this.fetchProvider = fetchProvider;
            this.lastResponseStore = lastResponseStore;
            this.syncTask = syncTask;
            this.reconciler = reconciler;
            this.appPaths = appPaths;
            this.httpClient = httpClient;
            this.logger = logger;
        }

        public object Get(GetConnections r) => connectionsStore.Load();

        public async Task<object> Post(GetImagePreview r)
        {
            const int maxImageBytes = 8 * 1024 * 1024;
            var connection = connectionsStore.Load().Connections.FirstOrDefault(c =>
                string.Equals(c.Id, r.ConnectionId, StringComparison.OrdinalIgnoreCase));
            if (connection == null)
                throw new ArgumentException("The preview connection no longer exists.");

            if (!Uri.TryCreate(connection.BaseUrl, UriKind.Absolute, out var baseUri) ||
                !Uri.TryCreate(r.Url, UriKind.Absolute, out var imageUri) ||
                (imageUri.Scheme != Uri.UriSchemeHttp && imageUri.Scheme != Uri.UriSchemeHttps) ||
                !string.Equals(baseUri.Scheme, imageUri.Scheme, StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(baseUri.Host, imageUri.Host, StringComparison.OrdinalIgnoreCase) ||
                baseUri.Port != imageUri.Port ||
                !ImagePathBelongsToConnection(baseUri, imageUri))
                throw new ArgumentException("The preview URL does not belong to the selected connection.");

            var options = new HttpRequestOptions
            {
                Url = imageUri.AbsoluteUri,
                CancellationToken = CancellationToken.None
            };
            using (var response = await httpClient.GetResponse(options).ConfigureAwait(false))
            using (var source = response.Content)
            using (var destination = new MemoryStream())
            {
                if (response.ContentLength.HasValue && response.ContentLength.Value > maxImageBytes)
                    throw new ArgumentException("The preview image is larger than 8 MB.");

                var buffer = new byte[81920];
                int read;
                while ((read = await source.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0)
                {
                    if (destination.Length + read > maxImageBytes)
                        throw new ArgumentException("The preview image is larger than 8 MB.");
                    destination.Write(buffer, 0, read);
                }

                var bytes = destination.ToArray();
                var contentType = DetectImageContentType(response.ContentType, bytes);
                if (contentType == null)
                    throw new ArgumentException("The preview endpoint did not return a supported image.");

                return new { ContentType = contentType, Data = Convert.ToBase64String(bytes) };
            }
        }

        private static bool ImagePathBelongsToConnection(Uri baseUri, Uri imageUri)
        {
            var basePath = baseUri.AbsolutePath.TrimEnd('/');
            if (basePath.Length == 0) return true;
            return imageUri.AbsolutePath.Equals(basePath, StringComparison.OrdinalIgnoreCase) ||
                imageUri.AbsolutePath.StartsWith(basePath + "/", StringComparison.OrdinalIgnoreCase);
        }

        private static string DetectImageContentType(string reportedContentType, byte[] bytes)
        {
            var contentType = (reportedContentType ?? string.Empty).Split(';')[0].Trim();
            if (contentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase)) return contentType;
            if (bytes.Length >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff) return "image/jpeg";
            if (bytes.Length >= 8 && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4e && bytes[3] == 0x47) return "image/png";
            if (bytes.Length >= 6 && bytes[0] == 0x47 && bytes[1] == 0x49 && bytes[2] == 0x46) return "image/gif";
            if (bytes.Length >= 12 && bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46 &&
                bytes[8] == 0x57 && bytes[9] == 0x45 && bytes[10] == 0x42 && bytes[11] == 0x50) return "image/webp";
            if (bytes.Length >= 2 && bytes[0] == 0x42 && bytes[1] == 0x4d) return "image/bmp";
            return null;
        }

        public object Post(SaveConnections r)
        {
            var before = connectionsStore.Load().Connections.ToDictionary(c => c.Id, c => c);
            if (r.Payload.Connections.Any(c => string.IsNullOrWhiteSpace(c.DisplayLabel) || string.IsNullOrWhiteSpace(c.SystemType)) ||
                r.Payload.Connections.GroupBy(c => c.DisplayLabel.Trim(), StringComparer.OrdinalIgnoreCase).Any(g => g.Count() > 1))
                throw new ArgumentException("Every Connection needs a unique name and a System.");

            var deletedConnectionIds = before.Keys
                .Where(id => r.Payload.Connections.All(c => !string.Equals(c.Id, id, StringComparison.OrdinalIgnoreCase)))
                .ToList();
            var treeBeforeConnectionSave = treeStore.Load();
            foreach (var deletedId in deletedConnectionIds)
            {
                if (FindFoldersUsingConnection(treeBeforeConnectionSave.RootFolder, deletedId).Count > 0)
                    throw new ArgumentException("A Connection used by a Folder Fetch cannot be deleted.");
            }
            foreach (var connection in r.Payload.Connections)
            {
                if (before.TryGetValue(connection.Id, out var prior) &&
                    !string.Equals(prior.SystemType, connection.SystemType, StringComparison.OrdinalIgnoreCase) &&
                    FindFoldersUsingConnection(treeBeforeConnectionSave.RootFolder, connection.Id).Count > 0)
                    throw new ArgumentException("The System of a Connection used by a Folder Fetch cannot be changed.");
            }

            if (deletedConnectionIds.Count > 0)
            {
                var schemaFile = schemaStore.Load();
                var deletedSchemaIds = schemaFile.Schemas
                    .Where(s => deletedConnectionIds.Contains(s.ConnectionId, StringComparer.OrdinalIgnoreCase))
                    .Select(s => s.Id)
                    .ToList();
                schemaFile.Schemas.RemoveAll(s => deletedSchemaIds.Contains(s.Id, StringComparer.OrdinalIgnoreCase));
                schemaStore.Save(schemaFile);
                var ruleFile = ruleSetStore.Load();
                ruleFile.RuleSets.RemoveAll(rs => deletedSchemaIds.Contains(rs.EndpointSchemaId, StringComparer.OrdinalIgnoreCase));
                ruleSetStore.Save(ruleFile);
            }
            connectionsStore.Save(r.Payload);
            var ensuredSchemas = schemaStore.EnsureBuiltIns(r.Payload.Connections);
            ruleSetStore.EnsureBuiltIns(ensuredSchemas.Schemas);

            var changedIds = r.Payload.Connections
                .Where(c => !before.TryGetValue(c.Id, out var prior) ||
                            prior.BaseUrl != c.BaseUrl || prior.ApiKey != c.ApiKey || prior.SystemType != c.SystemType)
                .Select(c => c.Id)
                .ToList();

            var affectedFolders = new List<string>();

            if (changedIds.Count > 0)
            {
                var tree = treeStore.Load();
                affectedFolders = changedIds
                    .SelectMany(id => FindFoldersUsingConnection(tree.RootFolder, id))
                    .Distinct()
                    .ToList();

                if (affectedFolders.Count > 0)
                {
                    logger.Info("ChannelSync: {0} connection(s) changed — re-syncing {1} affected folder(s).", changedIds.Count, affectedFolders.Count);
                    _ = syncTask.SyncFoldersAndRefresh(affectedFolders, CancellationToken.None);
                }
                else
                {
                    logger.Info("ChannelSync: {0} connection(s) changed, but no folder-tree fetch currently references them — nothing to re-sync.", changedIds.Count);
                }
            }

            return new { Success = true, AffectedFolderCount = affectedFolders.Count };
        }

        public object Delete(DeleteConnection r)
        {
            var originalConnections = connectionsStore.Load();
            var existing = originalConnections.Connections.FirstOrDefault(
                c => string.Equals(c.Id, r.Id, StringComparison.OrdinalIgnoreCase));
            if (existing == null)
                return CurrentConfigurationResponse();

            var dependentFolders = FindFoldersUsingConnection(treeStore.Load().RootFolder, r.Id);
            if (dependentFolders.Count > 0)
                return new
                {
                    Success = false,
                    Error = "Remove or reassign every Folder Fetch using this Connection before deleting it.",
                    DependentFolderIds = dependentFolders
                };

            var originalSchemas = schemaStore.Load();
            var originalRules = ruleSetStore.Load();
            var nextConnections = Clone(originalConnections);
            var nextSchemas = Clone(originalSchemas);
            var nextRules = Clone(originalRules);
            var deletedSchemaIds = new HashSet<string>(
                nextSchemas.Schemas
                    .Where(s => string.Equals(s.ConnectionId, r.Id, StringComparison.OrdinalIgnoreCase))
                    .Select(s => s.Id),
                StringComparer.OrdinalIgnoreCase);

            nextConnections.Connections.RemoveAll(c => string.Equals(c.Id, r.Id, StringComparison.OrdinalIgnoreCase));
            nextSchemas.Schemas.RemoveAll(s => deletedSchemaIds.Contains(s.Id));
            nextRules.RuleSets.RemoveAll(rs => deletedSchemaIds.Contains(rs.EndpointSchemaId));

            try
            {
                schemaStore.Save(nextSchemas);
                ruleSetStore.Save(nextRules);
                connectionsStore.Save(nextConnections);
                var ensuredSchemas = schemaStore.EnsureBuiltIns(nextConnections.Connections);
                var ensuredRules = ruleSetStore.EnsureBuiltIns(ensuredSchemas.Schemas);
                return new
                {
                    Success = true,
                    Connections = nextConnections.Connections,
                    Schemas = ensuredSchemas.Schemas,
                    RuleSets = ensuredRules.RuleSets
                };
            }
            catch
            {
                RestoreConfiguration(originalConnections, originalSchemas, originalRules);
                throw;
            }
        }

        private List<string> FindFoldersUsingConnection(FolderNode node, string connectionId)
        {
            var result = new List<string>();
            var schemaIds = new HashSet<string>(
                schemaStore.Load().Schemas
                    .Where(s => string.Equals(s.ConnectionId, connectionId, StringComparison.OrdinalIgnoreCase))
                    .Select(s => s.Id),
                StringComparer.OrdinalIgnoreCase);
            var ruleSetIds = new HashSet<string>(
                ruleSetStore.Load().RuleSets
                    .Where(rs => schemaIds.Contains(rs.EndpointSchemaId))
                    .Select(rs => rs.Id),
                StringComparer.OrdinalIgnoreCase);
            void Walk(FolderNode n)
            {
                if (n.Fetches.Any(f => ruleSetIds.Contains(f.RuleSetId)))
                {
                    result.Add(n.Id);
                }
                foreach (var c in n.Children) Walk(c);
            }
            Walk(node);
            return result;
        }

        public object Get(GetEndpointSchemas r)
        {
            var file = schemaStore.EnsureBuiltIns(connectionsStore.Load().Connections);
            foreach (var schema in file.Schemas)
            {
                var favorites = favoritesStore.GetFavorites(schema.Id);
                foreach (var field in schema.Fields)
                {
                    field.IsFavorite = favorites.Contains(field.JsonPath);
                }
            }
            return file;
        }
        public object Post(SaveEndpointSchemas r)
        {
            var connectionIds = new HashSet<string>(
                connectionsStore.Load().Connections.Select(c => c.Id), StringComparer.OrdinalIgnoreCase);
            if (r.Payload.Schemas.Any(s => !connectionIds.Contains(s.ConnectionId)))
                throw new ArgumentException("Every Schema must belong to an existing Connection.");
            if (r.Payload.Schemas.GroupBy(
                    s => s.ConnectionId + "\n" + (s.DisplayName ?? string.Empty).Trim(),
                    StringComparer.OrdinalIgnoreCase).Any(g => g.Count() > 1))
                throw new ArgumentException("Schema names must be unique within a Connection.");

            var existingSchemas = schemaStore.Load();
            var schemasBefore = existingSchemas.Schemas.ToDictionary(s => s.Id, s => s);
            var changedSchemaIds = r.Payload.Schemas
                .Where(s => !s.IsBuiltIn &&
                    (!schemasBefore.TryGetValue(s.Id, out var prior) || !EndpointSchemasEqual(prior, s)))
                .Select(s => s.Id)
                .ToList();
            var deletedSchemaIds = existingSchemas.Schemas
                .Where(s => !s.IsBuiltIn && r.Payload.Schemas.All(x => !string.Equals(x.Id, s.Id, StringComparison.OrdinalIgnoreCase)))
                .Select(s => s.Id)
                .ToList();
            var rulesBeforeSchemaSave = ruleSetStore.Load();
            var deletedRuleIds = rulesBeforeSchemaSave.RuleSets
                .Where(rs => deletedSchemaIds.Contains(rs.EndpointSchemaId, StringComparer.OrdinalIgnoreCase))
                .Select(rs => rs.Id)
                .ToList();
            if (deletedRuleIds.Any(id => RuleSetStore.FindFoldersUsingRuleSet(treeStore.Load().RootFolder, id).Count > 0))
                throw new ArgumentException("A Schema used by a Folder Fetch cannot be deleted.");
            rulesBeforeSchemaSave.RuleSets.RemoveAll(rs => deletedSchemaIds.Contains(rs.EndpointSchemaId, StringComparer.OrdinalIgnoreCase));
            ruleSetStore.Save(rulesBeforeSchemaSave);

            // Built-ins are never overwritten by a client save — the client
            // only ever sends user-authored schemas back for its own edits;
            // built-ins are re-seeded/refreshed by EndpointSchemaStore.Load()
            // on next read regardless.
            r.Payload.Schemas.RemoveAll(s => s.IsBuiltIn);
            var current = schemaStore.Load();
            r.Payload.Schemas.AddRange(current.Schemas.Where(s => s.IsBuiltIn));
            schemaStore.Save(r.Payload);
            ruleSetStore.EnsureBuiltIns(r.Payload.Schemas);

            var treeAfterSchemaSave = treeStore.Load();
            var affectedFolders = rulesBeforeSchemaSave.RuleSets
                .Where(rs => changedSchemaIds.Contains(rs.EndpointSchemaId, StringComparer.OrdinalIgnoreCase))
                .SelectMany(rs => RuleSetStore.FindFoldersUsingRuleSet(treeAfterSchemaSave.RootFolder, rs.Id))
                .Distinct()
                .ToList();
            if (affectedFolders.Count > 0)
            {
                logger.Info(
                    "ChannelSync: {0} endpoint schema(s) changed — re-syncing {1} affected folder(s).",
                    changedSchemaIds.Count,
                    affectedFolders.Count);
                _ = syncTask.SyncFoldersAndRefresh(affectedFolders, CancellationToken.None);
            }

            return new { Success = true, AffectedFolderCount = affectedFolders.Count };
        }

        public object Delete(DeleteEndpointSchema r)
        {
            var originalSchemas = schemaStore.Load();
            var existing = originalSchemas.Schemas.FirstOrDefault(
                s => string.Equals(s.Id, r.Id, StringComparison.OrdinalIgnoreCase));
            if (existing == null)
                return CurrentConfigurationResponse();
            if (existing.IsBuiltIn)
                return new { Success = false, Error = "Built-in Schemas cannot be deleted." };

            var originalRules = ruleSetStore.Load();
            var deletedRuleIds = originalRules.RuleSets
                .Where(rs => string.Equals(rs.EndpointSchemaId, r.Id, StringComparison.OrdinalIgnoreCase))
                .Select(rs => rs.Id)
                .ToList();
            var treeRoot = treeStore.Load().RootFolder;
            var dependentFolders = deletedRuleIds
                .SelectMany(id => RuleSetStore.FindFoldersUsingRuleSet(treeRoot, id))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            if (dependentFolders.Count > 0)
                return new
                {
                    Success = false,
                    Error = "Remove or reassign every Folder Fetch using this Schema's Rule Sets before deleting it.",
                    DependentFolderIds = dependentFolders
                };

            var nextSchemas = Clone(originalSchemas);
            var nextRules = Clone(originalRules);
            nextSchemas.Schemas.RemoveAll(s => string.Equals(s.Id, r.Id, StringComparison.OrdinalIgnoreCase));
            nextRules.RuleSets.RemoveAll(rs => string.Equals(rs.EndpointSchemaId, r.Id, StringComparison.OrdinalIgnoreCase));

            try
            {
                ruleSetStore.Save(nextRules);
                schemaStore.Save(nextSchemas);
                var ensuredSchemas = schemaStore.EnsureBuiltIns(connectionsStore.Load().Connections);
                var ensuredRules = ruleSetStore.EnsureBuiltIns(ensuredSchemas.Schemas);
                return new { Success = true, Schemas = ensuredSchemas.Schemas, RuleSets = ensuredRules.RuleSets };
            }
            catch
            {
                TryRestore(() => schemaStore.Save(originalSchemas), "Schemas");
                TryRestore(() => ruleSetStore.Save(originalRules), "Rule Sets");
                throw;
            }
        }

        public object Get(GetRuleSets r)
        {
            var schemas = schemaStore.EnsureBuiltIns(connectionsStore.Load().Connections);
            return ruleSetStore.EnsureBuiltIns(schemas.Schemas);
        }

        public object Post(SaveRuleSets r)
        {
            var before = ruleSetStore.Load().RuleSets.ToDictionary(rs => rs.Id, rs => rs);
            var schemaIds = new HashSet<string>(
                schemaStore.Load().Schemas.Select(s => s.Id), StringComparer.OrdinalIgnoreCase);
            if (r.Payload.RuleSets.Any(rs => !schemaIds.Contains(rs.EndpointSchemaId)))
                throw new ArgumentException("Every Rule Set must belong to an existing Schema.");
            if (r.Payload.RuleSets.GroupBy(
                    rs => rs.EndpointSchemaId + "\n" + (rs.Name ?? string.Empty).Trim(),
                    StringComparer.OrdinalIgnoreCase).Any(g => g.Count() > 1))
                throw new ArgumentException("Rule Set names must be unique within a Schema.");
            var deletedRuleSetIds = before.Keys
                .Where(id => r.Payload.RuleSets.All(rs => !string.Equals(rs.Id, id, StringComparison.OrdinalIgnoreCase)))
                .ToList();
            if (deletedRuleSetIds.Any(id => RuleSetStore.FindFoldersUsingRuleSet(treeStore.Load().RootFolder, id).Count > 0))
                throw new ArgumentException("A Rule Set used by a Folder Fetch cannot be deleted.");

            // Built-ins are never overwritten by a client save — same
            // discipline as SaveEndpointSchemas. Re-seeded/refreshed by
            // RuleSetStore.Load() on next read regardless.
            r.Payload.RuleSets.RemoveAll(rs => rs.IsBuiltIn);
            r.Payload.RuleSets.AddRange(before.Values.Where(rs => rs.IsBuiltIn));

            ruleSetStore.Save(r.Payload);

            // Responsive save: find which saved rule sets actually changed
            // (by content, not just presence), and re-sync only the folders
            // that reference them — the "cheap path" agreed with the operator,
            // rather than a full tree walk on every rule-set save.
            var changedIds = r.Payload.RuleSets
                .Where(rs => !before.TryGetValue(rs.Id, out var prior) || !RuleSetsEqual(prior, rs))
                .Select(rs => rs.Id)
                .ToList();

            var affectedFolders = new List<string>();

            if (changedIds.Count > 0)
            {
                var tree = treeStore.Load();
                affectedFolders = changedIds
                    .SelectMany(id => RuleSetStore.FindFoldersUsingRuleSet(tree.RootFolder, id))
                    .Distinct()
                    .ToList();

                if (affectedFolders.Count > 0)
                {
                    logger.Info(
                        "ChannelSync: {0} rule set(s) changed — re-syncing {1} affected folder(s).",
                        changedIds.Count, affectedFolders.Count);

                    // Fire-and-forget is deliberate here — the HTTP caller
                    // (the rule editor's Save button) shouldn't block on a
                    // full fetch+refresh round trip. Errors are logged
                    // inside SyncFoldersAndRefresh/its callees.
                    _ = syncTask.SyncFoldersAndRefresh(affectedFolders, CancellationToken.None);
                }
                else
                {
                    // Genuinely nothing to sync yet — surfaced explicitly so
                    // it isn't mistaken for a save failure. The Rule Sets
                    // tab's own live Preview (see Post(PreviewRule) below) is
                    // the primary way to confirm a rule works, independent
                    // of whether any folder references it yet.
                    logger.Info(
                        "ChannelSync: {0} rule set(s) changed, but no folder-tree fetch currently references them — nothing to re-sync yet. Add a Fetch on the Folder Tree tab using this rule set to trigger a real sync.",
                        changedIds.Count);
                }
            }

            return new { Success = true, AffectedFolderCount = affectedFolders.Count, ChangedRuleSetCount = changedIds.Count };
        }

        public object Delete(DeleteRuleSet r)
        {
            var originalRules = ruleSetStore.Load();
            var existing = originalRules.RuleSets.FirstOrDefault(
                rs => string.Equals(rs.Id, r.Id, StringComparison.OrdinalIgnoreCase));
            if (existing == null)
                return new { Success = true, RuleSets = originalRules.RuleSets };
            if (existing.IsBuiltIn)
                return new { Success = false, Error = "Built-in Rule Sets cannot be deleted." };
            var dependentFolders = RuleSetStore.FindFoldersUsingRuleSet(treeStore.Load().RootFolder, r.Id);
            if (dependentFolders.Count > 0)
                return new
                {
                    Success = false,
                    Error = "Remove or reassign every Folder Fetch using this Rule Set before deleting it.",
                    DependentFolderIds = dependentFolders
                };

            var nextRules = Clone(originalRules);
            nextRules.RuleSets.RemoveAll(rs => string.Equals(rs.Id, r.Id, StringComparison.OrdinalIgnoreCase));
            try
            {
                ruleSetStore.Save(nextRules);
                var ensured = ruleSetStore.EnsureBuiltIns(schemaStore.Load().Schemas);
                return new { Success = true, RuleSets = ensured.RuleSets };
            }
            catch
            {
                TryRestore(() => ruleSetStore.Save(originalRules), "Rule Sets");
                throw;
            }
        }

        public object Get(GetFolderTree r) => treeStore.Load();

        public object Get(GetMediaTestHarness r)
        {
            var cfg = SyncChannelPlugin.Instance.Configuration;
            return new
            {
                Enabled = cfg.EnableMediaTestHarness,
                VideoUrl = cfg.MediaTestVideoUrl,
                AudioUrl = cfg.MediaTestAudioUrl,
                ImageUrl = cfg.MediaTestImageUrl,
                HlsUrl = cfg.MediaTestHlsUrl
            };
        }

        public async Task<object> Post(SaveMediaTestHarness r)
        {
            var plugin = SyncChannelPlugin.Instance;
            var cfg = plugin.Configuration;
            cfg.EnableMediaTestHarness = r.Enabled;
            cfg.MediaTestVideoUrl = (r.VideoUrl ?? string.Empty).Trim();
            cfg.MediaTestAudioUrl = (r.AudioUrl ?? string.Empty).Trim();
            cfg.MediaTestImageUrl = (r.ImageUrl ?? string.Empty).Trim();
            cfg.MediaTestHlsUrl = (r.HlsUrl ?? string.Empty).Trim();

            string imageError = null;
            if (r.Enabled && !string.IsNullOrWhiteSpace(cfg.MediaTestImageUrl))
            {
                try
                {
                    cfg.MediaTestCachedImagePath = await DownloadMediaTestImage(cfg.MediaTestImageUrl).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    cfg.MediaTestCachedImagePath = string.Empty;
                    imageError = ex.Message;
                    logger.ErrorException("ChannelSync: Media test image download failed for {0}", ex, cfg.MediaTestImageUrl);
                }
            }
            plugin.UpdateConfiguration(cfg);

            if (r.RunNow)
            {
                logger.Info("ChannelSync: Media compatibility harness changed — running a full sync now.");
                _ = syncTask.Execute(CancellationToken.None, new Progress<double>());
            }

            return new { Success = true, ImageError = imageError };
        }

        private async Task<string> DownloadMediaTestImage(string url)
        {
            var directory = Path.Combine(appPaths.DataPath, "channel-sync", "media-tests");
            Directory.CreateDirectory(directory);
            var path = Path.Combine(directory, "photo-source.jpg");
            var options = new HttpRequestOptions { Url = url, CancellationToken = CancellationToken.None };
            using (var response = await httpClient.GetResponse(options).ConfigureAwait(false))
            using (var source = response.Content)
            using (var destination = File.Create(path))
            {
                await source.CopyToAsync(destination).ConfigureAwait(false);
            }
            return path;
        }

        public object Post(SaveFolderTree r)
        {
            r.RootFolder.IsRoot = true;

            var errors = ValidateFetchReferences(r.RootFolder);

            if (errors.Count > 0)
            {
                logger.Warn(
                    "ChannelSync: Folder tree save rejected — {0} fetch(es) reference something that no longer exists.",
                    errors.Count);

                return new { Success = false, Errors = errors };
            }

            ApplyRootIdentity(r.RootFolder);

            treeStore.Save(new FolderTreeFile { RootFolder = r.RootFolder });

            logger.Info("ChannelSync: Folder tree saved — running a full sync now.");
            _ = syncTask.Execute(CancellationToken.None, new Progress<double>());

            return new { Success = true };
        }

        /// <summary>
        /// The root folder's DisplayName/Tag are now the single source of
        /// truth for the channel's display name and identity tag — the old
        /// dedicated Config UI fields are gone (moved here per operator
        /// request). Detects a change against the currently persisted
        /// PluginConfiguration, cleans up any orphan still carrying the OLD
        /// tag before it's overwritten, and saves the new values. The
        /// subsequent sync's own reconciler.Reconcile(config) call (see
        /// FolderTreeSyncTask.Execute) applies the new tag/name/image.
        /// </summary>
        private void ApplyRootIdentity(FolderNode root)
        {
            var plugin = SyncChannelPlugin.Instance;
            var cfg = plugin.Configuration;

            string newName = string.IsNullOrWhiteSpace(root.DisplayName) ? "Channel Sync" : root.DisplayName.Trim();
            string newTag = string.IsNullOrWhiteSpace(root.Tag) ? "SyncChannel" : root.Tag.Trim();

            root.DisplayName = newName;
            root.Tag = newTag;

            bool nameChanged = !string.Equals(cfg.ChannelName, newName, StringComparison.OrdinalIgnoreCase);
            bool tagChanged = !string.Equals(cfg.ChannelIdentityTag, newTag, StringComparison.OrdinalIgnoreCase);

            if (!nameChanged && !tagChanged)
            {
                return;
            }

            string oldTag = cfg.ChannelIdentityTagLastApplied;

            cfg.ChannelName = newName;
            cfg.ChannelIdentityTag = newTag;
            plugin.UpdateConfiguration(cfg);

            if (tagChanged && !string.IsNullOrEmpty(oldTag))
            {
                reconciler.CleanupOrphansForTag(cfg, oldTag);
            }
        }

        /// <summary>
        /// A fetch stores only RuleSetId. Validate the complete ownership
        /// chain so an invalid rule-set/schema/connection graph can never be
        /// persisted.
        /// </summary>
        private List<FetchValidationError> ValidateFetchReferences(FolderNode root)
        {
            var connectionIds = new HashSet<string>(
                connectionsStore.Load().Connections.Select(c => c.Id), StringComparer.OrdinalIgnoreCase);
            var schemas = schemaStore.Load().Schemas.ToDictionary(s => s.Id, s => s, StringComparer.OrdinalIgnoreCase);
            var ruleSets = ruleSetStore.Load().RuleSets.ToDictionary(rs => rs.Id, rs => rs, StringComparer.OrdinalIgnoreCase);

            var errors = new List<FetchValidationError>();

            void Walk(FolderNode node)
            {
                foreach (var fetch in node.Fetches)
                {
                    if (!ruleSets.TryGetValue(fetch.RuleSetId, out var ruleSet))
                    {
                        errors.Add(new FetchValidationError
                        {
                            FolderId = node.Id,
                            FetchId = fetch.Id,
                            Field = "ruleset",
                            Message = string.Format("Folder '{0}', fetch '{1}': rule set no longer exists.", node.DisplayName, fetch.DisplayLabel)
                        });
                        continue;
                    }

                    if (!schemas.TryGetValue(ruleSet.EndpointSchemaId, out var schema))
                    {
                        errors.Add(new FetchValidationError
                        {
                            FolderId = node.Id,
                            FetchId = fetch.Id,
                            Field = "schema",
                            Message = string.Format("Folder '{0}', fetch '{1}': owning schema no longer exists.", node.DisplayName, fetch.DisplayLabel)
                        });
                        continue;
                    }

                    if (!connectionIds.Contains(schema.ConnectionId))
                    {
                        errors.Add(new FetchValidationError
                        {
                            FolderId = node.Id,
                            FetchId = fetch.Id,
                            Field = "connection",
                            Message = string.Format("Folder '{0}', fetch '{1}': owning connection no longer exists.", node.DisplayName, fetch.DisplayLabel)
                        });
                    }
                }

                foreach (var child in node.Children) Walk(child);
            }

            Walk(root);
            return errors;
        }

        public async Task<object> Post(TestConnection r)
        {
            var probeConnection = new ConnectionEntry
            {
                BaseUrl = r.BaseUrl,
                ApiKey = r.ApiKey,
                SystemType = r.SystemType
            };

            var (ok, message) = await fetchProvider.TestReachabilityAsync(probeConnection, CancellationToken.None);

            // If this connection also exists on disk, persist the badge so
            // every tab that lists connections can show it without a live
            // re-check. Harmless no-op if ConnectionId doesn't match anything
            // saved yet (e.g. testing before the first Save).
            if (!string.IsNullOrEmpty(r.ConnectionId))
            {
                var file = connectionsStore.Load();
                var saved = file.Connections.FirstOrDefault(c => string.Equals(c.Id, r.ConnectionId, StringComparison.OrdinalIgnoreCase));
                if (saved != null)
                {
                    saved.LastTestSucceeded = ok;
                    saved.LastTestedUtc = DateTimeOffset.UtcNow;
                    connectionsStore.Save(file);
                }
            }

            return new { Success = ok, Message = message };
        }

        public async Task<object> Post(DiscoverFields r)
        {
            var schema = r.DraftSchema ?? schemaStore.Find(r.EndpointSchemaId);
            var connection = connectionsStore.Load().Connections
                .FirstOrDefault(c => schema != null &&
                    string.Equals(c.Id, schema.ConnectionId, StringComparison.OrdinalIgnoreCase));

            if (schema == null || connection == null)
            {
                return new { Success = false, Message = "Connection not found, or no schema/draft schema supplied." };
            }

            var rawJson = r.ForceRefresh ? "[]" : lastResponseStore.Read(connection.Id, schema.Id);
            bool haveCache = rawJson != "[]";

            if (!haveCache)
            {
                var fetched = await fetchProvider.FetchRawAsync(connection, schema, CancellationToken.None);
                if (fetched == null)
                {
                    return new { Success = false, Message = "Fetch failed — check the connection on the Connections tab." };
                }

                lastResponseStore.Write(connection.Id, schema.Id, fetched);
                rawJson = fetched;
            }

            List<SchemaField> discovered;
            int itemCount;
            List<string> arrayFieldCandidates = new List<string>();
            try
            {
                using (var doc = JsonDocument.Parse(rawJson))
                {
                    if (!FieldDiscoveryService.TryLocateArray(doc.RootElement, schema.ItemsRootPath, out var arrayRoot, out arrayFieldCandidates))
                    {
                        var message = string.IsNullOrEmpty(schema.ItemsRootPath)
                            ? "Response isn't a JSON array at the root."
                            : "\"" + schema.ItemsRootPath + "\" didn't resolve to a JSON array.";

                        if (arrayFieldCandidates.Count > 0)
                        {
                            message += " Found " + arrayFieldCandidates.Count + " array-shaped field(s) at the top level — pick one below as the Items Root Path.";
                        }
                        else
                        {
                            message += " No array-shaped field found at the top level either — this endpoint's shape may need a deeper path, or isn't list-shaped at all.";
                        }

                        return new { Success = false, Message = message, ArrayFieldCandidates = arrayFieldCandidates, RawJson = rawJson };
                    }

                    itemCount = arrayRoot.GetArrayLength();
                    discovered = FieldDiscoveryService.Discover(arrayRoot.GetRawText(), favoritesStore.GetFavorites(schema.Id));
                }
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Field discovery failed for schema '{0}'", ex, schema.DisplayName);
                return new { Success = false, Message = "Response wasn't valid JSON." };
            }

            return new { Success = true, Fields = discovered, ItemCount = itemCount, ArrayFieldCandidates = arrayFieldCandidates, RawJson = rawJson };
        }

        public object Post(SetFieldFavorite r)
        {
            favoritesStore.SetFavorite(r.SchemaId, r.JsonPath, r.IsFavorite);
            return new { Success = true };
        }

        /// <summary>
        /// Cache-first live preview. Only performs a real HTTP fetch when
        /// nothing has ever been cached for this connection+schema pair;
        /// every subsequent rule edit re-evaluates against that same cached
        /// payload. Deliberately does not require a folder-tree sync to have
        /// run — a rule set should be fully testable on its own.
        /// </summary>
        public async Task<object> Post(PreviewRule request)
        {
            var schema = schemaStore.Find(request.EndpointSchemaId);
            var connection = connectionsStore.Load().Connections
                .FirstOrDefault(c => schema != null &&
                    string.Equals(c.Id, schema.ConnectionId, StringComparison.OrdinalIgnoreCase));

            if (schema == null || connection == null)
            {
                return new
                {
                    Status = "error",
                    Message = "Connection or endpoint not found — save it first.",
                    Fields = new List<string>(),
                    Matches = new List<object>()
                };
            }

            var rawJson = lastResponseStore.Read(connection.Id, request.EndpointSchemaId);
            bool haveCache = rawJson != "[]";

            if (!haveCache)
            {
                var fetched = await fetchProvider.FetchRawAsync(connection, schema, CancellationToken.None);

                if (fetched == null)
                {
                    return new
                    {
                        Status = "unavailable",
                        Message = "No data available yet — the fetch failed. Check the connection on the Connections tab.",
                        Fields = new List<string>(),
                        Matches = new List<object>()
                    };
                }

                lastResponseStore.Write(connection.Id, schema.Id, fetched);
                rawJson = fetched;
            }

            var fields = CollectFields(request.Rule, new List<string>());

            using (var doc = JsonDocument.Parse(rawJson))
            {
                // Same envelope-unwrap fix as DiscoverFields/EvaluateAndMap —
                // this was an independent, un-fixed third copy of the old
                // root-is-array assumption, which is why the wizard never
                // worked against Emby even after the other two were fixed.
                if (!FieldDiscoveryService.TryLocateArray(doc.RootElement, schema.ItemsRootPath, out var arrayRoot, out _))
                {
                    return new
                    {
                        Status = "error",
                        Message = string.IsNullOrEmpty(schema.ItemsRootPath)
                            ? "Response isn't a JSON array at the root — set 'Items root path' on this schema."
                            : "'" + schema.ItemsRootPath + "' didn't resolve to a JSON array — check 'Items root path' on this schema.",
                        RawJson = request.IncludeRawJson ? rawJson : null,
                        Fields = new List<string>(),
                        Matches = new List<object>()
                    };
                }

                int matchCount = 0;
                var rows = new List<object>();

                foreach (var el in arrayRoot.EnumerateArray())
                {
                    if (!RuleEvaluator.Matches(el, request.Rule)) continue;
                    matchCount++;

                    if (rows.Count < 10)
                    {
                        var values = fields.ToDictionary(f => f, f => RuleEvaluator.ResolveDisplayValue(el, f));

                        // TitleField/IdentityField are FieldMapping objects
                        // now (composable, not a single JsonPath string) --
                        // resolved via HttpFetchProvider's public preview
                        // wrapper rather than RuleEvaluator.ResolveDisplayValue
                        // directly, so {baseUrl}/{apiKeyName}/{apiKeyValue}/
                        // {identity} pieces in the mapping resolve correctly
                        // here too, same as a real fetch would.
                        var identity = SyncChannel.Fetching.HttpFetchProvider.ResolveMappingPreview(el, schema.IdentityField, connection, null);
                        var title = SyncChannel.Fetching.HttpFetchProvider.ResolveMappingPreview(el, schema.TitleField, connection, identity);
                        var displayTitle = string.IsNullOrEmpty(title) ? "(unknown)" : title;
                        rows.Add(new { Title = displayTitle, Values = values });
                    }
                }

                return new
                {
                    Status = "ok",
                    MatchCount = matchCount,
                    RawJson = request.IncludeRawJson ? rawJson : null,
                    Fields = fields,
                    Matches = rows
                };
            }
        }

        private static bool RuleSetsEqual(RuleSet a, RuleSet b) =>
            JsonSerializer.Serialize(a) == JsonSerializer.Serialize(b);

        private object CurrentConfigurationResponse()
        {
            var connections = connectionsStore.Load();
            var schemas = schemaStore.EnsureBuiltIns(connections.Connections);
            var rules = ruleSetStore.EnsureBuiltIns(schemas.Schemas);
            return new
            {
                Success = true,
                Connections = connections.Connections,
                Schemas = schemas.Schemas,
                RuleSets = rules.RuleSets
            };
        }

        private static T Clone<T>(T value) =>
            JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(value));

        private void RestoreConfiguration(
            ConnectionsFile connections,
            EndpointSchemasFile schemas,
            RuleSetsFile rules)
        {
            TryRestore(() => connectionsStore.Save(connections), "Connections");
            TryRestore(() => schemaStore.Save(schemas), "Schemas");
            TryRestore(() => ruleSetStore.Save(rules), "Rule Sets");
        }

        private void TryRestore(Action restore, string resourceName)
        {
            try
            {
                restore();
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Failed to roll back {0} after a deletion error", ex, resourceName);
            }
        }

        private static bool EndpointSchemasEqual(EndpointSchema a, EndpointSchema b) =>
            JsonSerializer.Serialize(a) == JsonSerializer.Serialize(b);

        private static List<string> CollectFields(RuleNode node, List<string> acc)
        {
            if (node == null) return acc;
            if (node.Kind == RuleNodeKind.Condition)
            {
                if (!string.IsNullOrEmpty(node.Field) && !acc.Contains(node.Field)) acc.Add(node.Field);
            }
            else if (node.Children != null)
            {
                foreach (var child in node.Children) CollectFields(child, acc);
            }
            return acc;
        }
    }
}
