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

        // Replaces the old ProviderKey + free-form Settings bag. A fetch is
        // now just three references — connection, schema, rule set — which
        // is also what makes the UI's "only the rule set usually changes"
        // goal possible: editing a fetch is picking from three dropdowns,
        // not filling in a form.
        public string ConnectionId { get; set; } = string.Empty;
        public string EndpointSchemaId { get; set; } = string.Empty;
        public string RuleSetId { get; set; } = string.Empty;

        public bool Enabled { get; set; } = true;
        public string DisplayLabel { get; set; } = string.Empty;
    }

    public class FolderTreeFile
    {
        public FolderNode RootFolder { get; set; } = new FolderNode { IsRoot = true, DisplayName = "root" };
    }
}
