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

    // ---- Live preview (against last-cached response for a connection+schema) ----
    [Route("/ChannelSync/RulePreview", "POST")]
    public class PreviewRule : IReturn<object>
    {
        public string ConnectionId { get; set; }
        public string EndpointSchemaId { get; set; }
        public RuleNode Rule { get; set; }
    }

    // ---- Folder tree ----
    // ---- Folder tree ----
    [Route("/ChannelSync/FolderTree", "GET")] public class GetFolderTree : IReturn<FolderTreeFile> { }
    [Route("/ChannelSync/FolderTree", "POST")] public class SaveFolderTree : IReturn<object> { public FolderNode RootFolder { get; set; } }

    // ---- Connection reachability test ----
    [Route("/ChannelSync/TestConnection", "POST")]
    public class TestConnection : IReturn<object>
    {
        public string ConnectionId { get; set; }
        public string EndpointSchemaId { get; set; }
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
                            prior.BaseUrl != c.BaseUrl || prior.ApiKey != c.ApiKey)
                .Select(c => c.Id)
                .ToList();

            if (changedIds.Count > 0)
            {
                var tree = treeStore.Load();
                var affectedFolders = changedIds
                    .SelectMany(id => FindFoldersUsingConnection(tree.RootFolder, id))
                    .Distinct()
                    .ToList();

                if (affectedFolders.Count > 0)
                {
                    _ = syncTask.SyncFoldersAndRefresh(affectedFolders, CancellationToken.None);
                }
            }

            return new { Success = true };
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
            // built-ins are re-seeded by EndpointSchemaStore.Load() on next
            // read regardless.
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

            if (changedIds.Count > 0)
            {
                var tree = treeStore.Load();
                var affectedFolders = changedIds
                    .SelectMany(id => RuleSetStore.FindFoldersUsingRuleSet(tree.RootFolder, id))
                    .Distinct()
                    .ToList();

                if (affectedFolders.Count > 0)
                {
                    // Fire-and-forget is deliberate here — the HTTP caller
                    // (the rule editor's Save button) shouldn't block on a
                    // full fetch+refresh round trip. Errors are logged
                    // inside SyncFoldersAndRefresh/its callees.
                    _ = syncTask.SyncFoldersAndRefresh(affectedFolders, CancellationToken.None);
                }
            }

            return new { Success = true };
        }

        public object Get(GetFolderTree r) => treeStore.Load();
        public object Post(SaveFolderTree r)
        {
            r.RootFolder.IsRoot = true;
            treeStore.Save(new FolderTreeFile { RootFolder = r.RootFolder });

            var warnings = ValidateFetchReferences(r.RootFolder);

            _ = syncTask.Execute(CancellationToken.None, new Progress<double>());

            return new { Success = true, Warnings = warnings };
        }

        /// <summary>
        /// Checks every fetch in the tree against what's currently on disk for
        /// connections/schemas/rule sets. Purely informational — does not block
        /// the save or the resync, since a fetch referencing something missing
        /// is already handled gracefully (skipped, logged) by FolderTreeSyncTask.
        /// This just surfaces that same condition to the UI immediately instead
        /// of leaving it to only show up in the server log.
        /// </summary>
        private List<string> ValidateFetchReferences(FolderNode root)
        {
            var connectionIds = new HashSet<string>(
                connectionsStore.Load().Connections.Select(c => c.Id), StringComparer.OrdinalIgnoreCase);
            var schemaIds = new HashSet<string>(
                schemaStore.Load().Schemas.Select(s => s.Id), StringComparer.OrdinalIgnoreCase);
            var ruleSetIds = new HashSet<string>(
                ruleSetStore.Load().RuleSets.Select(rs => rs.Id), StringComparer.OrdinalIgnoreCase);

            var warnings = new List<string>();

            void Walk(FolderNode node)
            {
                foreach (var fetch in node.Fetches)
                {
                    var missing = new List<string>();
                    if (!connectionIds.Contains(fetch.ConnectionId)) missing.Add("connection");
                    if (!schemaIds.Contains(fetch.EndpointSchemaId)) missing.Add("endpoint");
                    if (!ruleSetIds.Contains(fetch.RuleSetId)) missing.Add("rule set");

                    if (missing.Count > 0)
                    {
                        warnings.Add(string.Format(
                            "Folder '{0}', fetch '{1}': missing {2} — this fetch will be skipped until fixed.",
                            node.DisplayName, fetch.DisplayLabel, string.Join(" + ", missing)));
                    }
                }

                foreach (var child in node.Children) Walk(child);
            }

            Walk(root);
            return warnings;
        }

        public async Task<object> Post(TestConnection r)
        {
            var connections = connectionsStore.Load();
            var connection = connections.Connections.FirstOrDefault(c => c.Id == r.ConnectionId);
            var schema = schemaStore.Find(r.EndpointSchemaId);

            if (connection == null || schema == null)
            {
                return new { Success = false, Message = "Connection or endpoint not found." };
            }

            var (ok, message) = await fetchProvider.TestReachabilityAsync(connection, schema, CancellationToken.None);
            return new { Success = ok, Message = message };
        }

        public object Post(PreviewRule request)
        {
            var rawJson = lastResponseStore.Read(request.ConnectionId, request.EndpointSchemaId);
            var schema = schemaStore.Find(request.EndpointSchemaId);

            if (schema == null)
            {
                return new { MatchCount = 0, Fields = new List<string>(), Matches = new List<object>() };
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

                return new { MatchCount = matchCount, Fields = fields, Matches = rows };
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