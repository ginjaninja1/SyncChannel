namespace SyncChannel.Rules
{
    using MediaBrowser.Common.Configuration;
    using MediaBrowser.Model.Logging;
    using MediaBrowser.Model.Serialization;
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;

    public class RuleSetStore
    {
        private const string FileName = "rulesets.json";

        private readonly IApplicationPaths appPaths;
        private readonly IJsonSerializer json;
        private readonly ILogger logger;

        public RuleSetStore(IApplicationPaths appPaths, IJsonSerializer json, ILogger logger)
        {
            this.appPaths = appPaths;
            this.json = json;
            this.logger = logger;
        }

        private string FilePath => Path.Combine(appPaths.DataPath, "channel-sync", FileName);

        public RuleSetsFile Load()
        {
            var path = FilePath;

            if (!File.Exists(path))
            {
                return new RuleSetsFile();
            }

            try
            {
                return json.DeserializeFromString<RuleSetsFile>(File.ReadAllText(path)) ?? new RuleSetsFile();
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Failed to read {0}", ex, path);
                return new RuleSetsFile();
            }
        }

        public void Save(RuleSetsFile file)
        {
            var path = FilePath;
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                Directory.CreateDirectory(dir);

            File.WriteAllText(path, json.SerializeToString(file));
        }

        public RuleSet Find(string id)
        {
            return Load().RuleSets.FirstOrDefault(r => string.Equals(r.Id, id, StringComparison.OrdinalIgnoreCase));
        }

        public IEnumerable<RuleSet> ForSchema(string endpointSchemaId)
        {
            return Load().RuleSets.Where(r => string.Equals(r.EndpointSchemaId, endpointSchemaId, StringComparison.OrdinalIgnoreCase));
        }

        /// <summary>Every FolderNode.Fetches entry (recursively) whose RuleSetId matches.</summary>
        public static List<string> FindFoldersUsingRuleSet(Configuration.FolderNode root, string ruleSetId)
        {
            var result = new List<string>();
            Walk(root, ruleSetId, result);
            return result;
        }

        private static void Walk(Configuration.FolderNode node, string ruleSetId, List<string> result)
        {
            if (node.Fetches.Any(f => string.Equals(f.RuleSetId, ruleSetId, StringComparison.OrdinalIgnoreCase)))
            {
                result.Add(node.Id);
            }

            foreach (var child in node.Children)
            {
                Walk(child, ruleSetId, result);
            }
        }
    }
}
