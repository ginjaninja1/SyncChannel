namespace SyncChannel.Rules
{
    using MediaBrowser.Common.Configuration;
    using MediaBrowser.Model.Logging;
    using MediaBrowser.Model.Serialization;
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;
    using System.Text.Json;

    public class RuleSetStore
    {
        private const string FileName = "rulesets.json";

        // Fixed ids for shipped defaults — never regenerate these, they're
        // how ReplaceBuiltIn recognizes "this same built-in" across loads.
        private const string RadarrMonitoredMissingId = "builtin-radarr-monitored-missing";
        private const string RadarrMonitoredId = "builtin-radarr-monitored";
        private const string SonarrMonitoredId = "builtin-sonarr-monitored";

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
            RuleSetsFile file = null;

            if (File.Exists(path))
            {
                try
                {
                    file = json.DeserializeFromString<RuleSetsFile>(File.ReadAllText(path));
                }
                catch (Exception ex)
                {
                    logger.ErrorException("ChannelSync: Failed to read {0} — reseeding built-in rule sets", ex, path);
                }
            }

            file ??= new RuleSetsFile();

            // Re-seed (or refresh) built-ins on every load — same pattern as
            // EndpointSchemaStore. A built-in is fully REPLACED with the
            // current code's definition rather than left alone, so a plugin
            // update can fix a bad default rule for every existing install.
            bool changed = false;
            foreach (var builtIn in BuildBuiltInRuleSets())
            {
                changed |= ReplaceBuiltIn(file, builtIn);
            }

            if (changed || !File.Exists(path))
            {
                Save(file);
            }

            return file;
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

        // Always brings a stored built-in in line with the current code
        // definition. Returns true if the file changed (fresh add or an
        // existing stale copy replaced), so the caller knows whether to re-save.
        private static bool ReplaceBuiltIn(RuleSetsFile file, RuleSet builtIn)
        {
            var existingIndex = file.RuleSets.FindIndex(
                r => string.Equals(r.Id, builtIn.Id, StringComparison.OrdinalIgnoreCase));

            if (existingIndex < 0)
            {
                file.RuleSets.Add(builtIn);
                return true;
            }

            var existing = file.RuleSets[existingIndex];
            bool identical =
                existing.Name == builtIn.Name &&
                existing.EndpointSchemaId == builtIn.EndpointSchemaId &&
                existing.IsBuiltIn &&
                JsonSerializer.Serialize(existing.Root) == JsonSerializer.Serialize(builtIn.Root);

            if (identical)
            {
                return false;
            }

            file.RuleSets[existingIndex] = builtIn;
            return true;
        }

        // ---- Seeded rule sets — edit these to change what ships with the plugin. ----

        private static IEnumerable<RuleSet> BuildBuiltInRuleSets()
        {
            yield return new RuleSet
            {
                Id = RadarrMonitoredId,
                Name = "[Built-in] Monitored",
                EndpointSchemaId = Configuration.EndpointSchemaStore.RadarrMoviesId,
                IsBuiltIn = true,
                Root = new RuleNode
                {
                    Kind = RuleNodeKind.Group,
                    LogicOperator = RuleLogicOperator.And,
                    Children = new List<RuleNode>
                    {
                        new RuleNode { Kind = RuleNodeKind.Condition, Field = "monitored", Operator = RuleOperator.EQ, Value = "true" }
                    }
                }
            };

            yield return new RuleSet
            {
                Id = RadarrMonitoredMissingId,
                Name = "[Built-in] Monitored, missing file",
                EndpointSchemaId = Configuration.EndpointSchemaStore.RadarrMoviesId,
                IsBuiltIn = true,
                Root = new RuleNode
                {
                    Kind = RuleNodeKind.Group,
                    LogicOperator = RuleLogicOperator.And,
                    Children = new List<RuleNode>
                    {
                        new RuleNode { Kind = RuleNodeKind.Condition, Field = "monitored", Operator = RuleOperator.EQ, Value = "true" },
                        new RuleNode { Kind = RuleNodeKind.Condition, Field = "hasFile", Operator = RuleOperator.EQ, Value = "false" }
                    }
                }
            };

            yield return new RuleSet
            {
                Id = SonarrMonitoredId,
                Name = "[Built-in] Monitored",
                EndpointSchemaId = Configuration.EndpointSchemaStore.SonarrSeriesId,
                IsBuiltIn = true,
                Root = new RuleNode
                {
                    Kind = RuleNodeKind.Group,
                    LogicOperator = RuleLogicOperator.And,
                    Children = new List<RuleNode>
                    {
                        new RuleNode { Kind = RuleNodeKind.Condition, Field = "monitored", Operator = RuleOperator.EQ, Value = "true" }
                    }
                }
            };
        }
    }
}