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

    // ---- Connections ----
    [Route("/ChannelSync/Connections", "GET")] public class GetConnections : IReturn<ConnectionsFile> { }
    [Route("/ChannelSync/Connections", "POST")] public class SaveConnections : IReturn<object> { public ConnectionsFile Payload { get; set; } }

    // ---- Endpoint schemas ----
    [Route("/ChannelSync/EndpointSchemas", "GET")] public class GetEndpointSchemas : IReturn<EndpointSchemasFile> { }
    [Route("/ChannelSync/EndpointSchemas", "POST")] public class SaveEndpointSchemas : IReturn<object> { public EndpointSchemasFile Payload { get; set; } }

    // ---- Rule sets ----
    [Route("/ChannelSync/RuleSets", "GET")] public class GetRuleSets : IReturn<RuleSetsFile> { }
    [Route("/ChannelSync/RuleSets", "POST")] public class SaveRuleSets : IReturn<object> { public RuleSetsFile Payload { get; set; } }

    // ---- Live preview (cache-first: fetches live only if nothing cached
    // yet for this connection+schema pair, otherwise always reuses the
    // cached response — representative data is enough for rule-building,
    // and this keeps API/PC load minimal). Fully self-sufficient: does not
    // require a folder-tree sync to have ever run. ----
    [Route("/ChannelSync/RulePreview", "POST")]
    public class PreviewRule : IReturn<object>
    {
        public string ConnectionId { get; set; }
        public string EndpointSchemaId { get; set; }
        public RuleNode Rule { get; set; }
    }

    // ---- Folder tree ----
    [Route("/ChannelSync/FolderTree", "GET")] public class GetFolderTree : IReturn<FolderTreeFile> { }
    [Route("/ChannelSync/FolderTree", "POST")] public class SaveFolderTree : IReturn<object> { public FolderNode RootFolder { get; set; } }

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
        public string EndpointSchemaId { get; set; }
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
        private readonly RuleSetStore ruleSetStore;
        private readonly FolderTreeStore treeStore;
        private readonly HttpFetchProvider fetchProvider;
        private readonly LastResponseCacheStore lastResponseStore;
        private readonly FolderTreeSyncTask syncTask;
        private readonly ILogger logger;

        public ChannelSyncApiSurface(
            ConnectionsStore connectionsStore,
            EndpointSchemaStore schemaStore,
            RuleSetStore ruleSetStore,
            FolderTreeStore treeStore,
            HttpFetchProvider fetchProvider,
            LastResponseCacheStore lastResponseStore,
            FolderTreeSyncTask syncTask,
            ILogger logger)
        {
            this.connectionsStore = connectionsStore;
            this.schemaStore = schemaStore;
            this.ruleSetStore = ruleSetStore;
            this.treeStore = treeStore;
            this.fetchProvider = fetchProvider;
            this.lastResponseStore = lastResponseStore;
            this.syncTask = syncTask;
            this.logger = logger;
        }

        public object Get(GetConnections r) => connectionsStore.Load();

        public object Post(SaveConnections r)
        {
            var before = connectionsStore.Load().Connections.ToDictionary(c => c.Id, c => c);
            connectionsStore.Save(r.Payload);

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

        private static List<string> FindFoldersUsingConnection(FolderNode node, string connectionId)
        {
            var result = new List<string>();
            void Walk(FolderNode n)
            {
                if (n.Fetches.Any(f => string.Equals(f.ConnectionId, connectionId, StringComparison.OrdinalIgnoreCase)))
                {
                    result.Add(n.Id);
                }
                foreach (var c in n.Children) Walk(c);
            }
            Walk(node);
            return result;
        }

        public object Get(GetEndpointSchemas r) => schemaStore.Load();
        public object Post(SaveEndpointSchemas r)
        {
            // Built-ins are never overwritten by a client save — the client
            // only ever sends user-authored schemas back for its own edits;
            // built-ins are re-seeded/refreshed by EndpointSchemaStore.Load()
            // on next read regardless.
            r.Payload.Schemas.RemoveAll(s => s.IsBuiltIn);
            var current = schemaStore.Load();
            r.Payload.Schemas.AddRange(current.Schemas.Where(s => s.IsBuiltIn));
            schemaStore.Save(r.Payload);
            return new { Success = true };
        }

        public object Get(GetRuleSets r) => ruleSetStore.Load();

        public object Post(SaveRuleSets r)
        {
            var before = ruleSetStore.Load().RuleSets.ToDictionary(rs => rs.Id, rs => rs);
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

        public object Get(GetFolderTree r) => treeStore.Load();

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

            treeStore.Save(new FolderTreeFile { RootFolder = r.RootFolder });

            logger.Info("ChannelSync: Folder tree saved — running a full sync now.");
            _ = syncTask.Execute(CancellationToken.None, new Progress<double>());

            return new { Success = true };
        }

        /// <summary>
        /// Hard-fail check only: does every fetch's ConnectionId/
        /// EndpointSchemaId/RuleSetId resolve to something that actually
        /// exists? This blocks the save — there's no legitimate reason to
        /// persist a fetch pointing at nothing. Deliberately does NOT check
        /// live reachability or system-type mismatches here; those are
        /// soft/informational (surfaced via each connection's persisted
        /// LastTestSucceeded badge instead), since a connection being
        /// temporarily offline is not a reason to refuse saving a tree that
        /// references it correctly.
        /// </summary>
        private List<FetchValidationError> ValidateFetchReferences(FolderNode root)
        {
            var connectionIds = new HashSet<string>(
                connectionsStore.Load().Connections.Select(c => c.Id), StringComparer.OrdinalIgnoreCase);
            var schemaIds = new HashSet<string>(
                schemaStore.Load().Schemas.Select(s => s.Id), StringComparer.OrdinalIgnoreCase);
            var ruleSetIds = new HashSet<string>(
                ruleSetStore.Load().RuleSets.Select(rs => rs.Id), StringComparer.OrdinalIgnoreCase);

            var errors = new List<FetchValidationError>();

            void Walk(FolderNode node)
            {
                foreach (var fetch in node.Fetches)
                {
                    if (!connectionIds.Contains(fetch.ConnectionId))
                    {
                        errors.Add(new FetchValidationError
                        {
                            FolderId = node.Id,
                            FetchId = fetch.Id,
                            Field = "connection",
                            Message = string.Format("Folder '{0}', fetch '{1}': connection no longer exists.", node.DisplayName, fetch.DisplayLabel)
                        });
                    }

                    if (!schemaIds.Contains(fetch.EndpointSchemaId))
                    {
                        errors.Add(new FetchValidationError
                        {
                            FolderId = node.Id,
                            FetchId = fetch.Id,
                            Field = "schema",
                            Message = string.Format("Folder '{0}', fetch '{1}': endpoint no longer exists.", node.DisplayName, fetch.DisplayLabel)
                        });
                    }

                    if (!ruleSetIds.Contains(fetch.RuleSetId))
                    {
                        errors.Add(new FetchValidationError
                        {
                            FolderId = node.Id,
                            FetchId = fetch.Id,
                            Field = "ruleset",
                            Message = string.Format("Folder '{0}', fetch '{1}': rule set no longer exists.", node.DisplayName, fetch.DisplayLabel)
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
            var schema = schemaStore.Find(r.EndpointSchemaId);
            if (schema == null)
            {
                return new { Success = false, Message = "Endpoint schema not found." };
            }

            var probeConnection = new ConnectionEntry
            {
                BaseUrl = r.BaseUrl,
                ApiKey = r.ApiKey,
                SystemType = r.SystemType
            };

            var (ok, message) = await fetchProvider.TestReachabilityAsync(probeConnection, schema, CancellationToken.None);

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
                .FirstOrDefault(c => string.Equals(c.Id, request.ConnectionId, StringComparison.OrdinalIgnoreCase));

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

            var rawJson = lastResponseStore.Read(request.ConnectionId, request.EndpointSchemaId);
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
                int matchCount = 0;
                var rows = new List<object>();

                foreach (var el in doc.RootElement.EnumerateArray())
                {
                    if (!RuleEvaluator.Matches(el, request.Rule)) continue;
                    matchCount++;

                    if (rows.Count < 10)
                    {
                        var values = fields.ToDictionary(f => f, f => RuleEvaluator.ResolveDisplayValue(el, f));
                        var title = string.IsNullOrEmpty(schema.TitleField) ? "(unknown)" : RuleEvaluator.ResolveDisplayValue(el, schema.TitleField);
                        rows.Add(new { Title = title, Values = values });
                    }
                }

                return new
                {
                    Status = "ok",
                    MatchCount = matchCount,
                    Fields = fields,
                    Matches = rows
                };
            }
        }

        private static bool RuleSetsEqual(RuleSet a, RuleSet b) =>
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