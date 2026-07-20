// The admin-authored folder tree. Persisted separately from
// PluginConfiguration (own JSON file via FolderTreeStore) rather than folded
// into BasePluginConfiguration's XML serialization — this tree can grow
// deep and is edited via its own API surface/page, same separation already
// used for the Radarr rule sets (radarr-rulesets.json vs config.xml).
//
// Identity discipline: every node and every fetch instance is keyed by a
// stable, randomly-generated Id, never by DisplayName. This is deliberate —
// see the discussion in chat about why LibraryPathReconciler-style
// name-matching doesn't transfer here: subfolders are user-created and
// user-renamed, and a rename must never be treated as delete+create.
namespace SyncChannel.Configuration
{
    using System;
    using System.Collections.Generic;

    public class FolderNode
    {
        public string Id { get; set; } = Guid.NewGuid().ToString("N");

        public string DisplayName { get; set; } = string.Empty;

        public bool IsRoot { get; set; }

        public List<FetchRuleInstance> Fetches { get; set; } = new List<FetchRuleInstance>();

        public List<FolderNode> Children { get; set; } = new List<FolderNode>();
    }

    public class FetchRuleInstance
    {
        public string Id { get; set; } = Guid.NewGuid().ToString("N");

        /// <summary>Resolved against FetchProviderRegistry — e.g. "radarr".</summary>
        public string ProviderKey { get; set; } = string.Empty;

        public bool Enabled { get; set; } = true;

        /// <summary>User-editable label shown in the admin tree UI, e.g. "Radarr Sync #1".</summary>
        public string DisplayLabel { get; set; } = string.Empty;

        /// <summary>
        /// Provider-owned field bag. Never interpreted by folder-tree or
        /// channel code — only the matching IFetchProvider reads these keys,
        /// per its own GetFieldSchema().
        /// </summary>
        public Dictionary<string, string> Settings { get; set; } = new Dictionary<string, string>();
    }

    public class FolderTreeFile
    {
        public FolderNode RootFolder { get; set; } = new FolderNode { IsRoot = true, DisplayName = "root" };
    }
}
