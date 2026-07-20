namespace SyncChannel.Rules
{
    using System.Collections.Generic;

    public enum RuleNodeKind { Group, Condition }
    public enum RuleLogicOperator { And, Or }
    public enum RuleOperator { LT, LTE, GT, GTE, EQ, NEQ, CONTAINS, NOTCONTAINS }

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

        public RuleNode Root { get; set; } = new RuleNode { Kind = RuleNodeKind.Group };
    }

    public class RuleSetsFile
    {
        public List<RuleSet> RuleSets { get; set; } = new List<RuleSet>();
    }
}
