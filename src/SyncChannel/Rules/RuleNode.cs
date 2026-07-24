namespace SyncChannel.Rules
{
    using System.Collections.Generic;

    public enum RuleNodeKind { Group, Condition }
    public enum RuleLogicOperator { And, Or }
    public enum RuleOperator { LT, LTE, GT, GTE, EQ, NEQ, CONTAINS, NOTCONTAINS, STARTSWITH, ENDSWITH }

    public class RuleNode
    {
        public RuleNodeKind Kind { get; set; } = RuleNodeKind.Condition;
        public bool Not { get; set; } = false;
        public RuleLogicOperator LogicOperator { get; set; } = RuleLogicOperator.And;
        public List<RuleNode> Children { get; set; } = new List<RuleNode>();
        public string Field { get; set; } = string.Empty;
        public RuleOperator Operator { get; set; } = RuleOperator.EQ;
        public string Value { get; set; } = string.Empty;
    }

    public class RuleSet
    {
        public string Id { get; set; } = System.Guid.NewGuid().ToString("N");
        public string Name { get; set; } = string.Empty;

        // NEW — ties a rule set to exactly one schema, so "Radarr rule set
        // on a Sonarr endpoint" is structurally excluded rather than just
        // discouraged in the UI.
        public string EndpointSchemaId { get; set; } = string.Empty;

        // Marks a shipped-with-the-plugin default. Re-seeded/overwritten on
        // every RuleSetStore.Load() (see ReplaceBuiltIn) and stripped from
        // any client save (see ChannelSyncApiSurface.Post(SaveRuleSets)) —
        // same read-only discipline as EndpointSchema.IsBuiltIn. Users
        // duplicate it to get an editable copy rather than editing in place.
        public bool IsBuiltIn { get; set; }

        public RuleNode Root { get; set; } = new RuleNode { Kind = RuleNodeKind.Group };
    }

    public class RuleSetsFile
    {
        public List<RuleSet> RuleSets { get; set; } = new List<RuleSet>();
    }
}