namespace SyncChannel.Rules
{
    using SyncChannel.Configuration;
    using SyncChannel.Fetching;
    using SyncChannel.ScheduledTasks;
    using SyncChannel.Services;
    using MediaBrowser.Model.Logging;
    using MediaBrowser.Model.Services;
    using System.Collections.Generic;
    using System.Linq;
    using System.Text.Json;
    using System.Threading;

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
    [Route("/ChannelSync/FolderTree", "GET")] public class GetFolderTree : IReturn<FolderTreeFile> { }
    [Route("/ChannelSync/FolderTree", "POST")] public class SaveFolderTree : IReturn<object> { public FolderNode RootFolder { get; set; } }

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
        public object Post(SaveConnections r) { connectionsStore.Save(r.Payload); return new { Success = true }; }

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
            return new { Success = true };
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