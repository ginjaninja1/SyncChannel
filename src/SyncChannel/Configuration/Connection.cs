// A saved (URL, API key) pair, reusable across any number of fetches.
// Deliberately separate from EndpointSchema and RuleSet — this is the piece
// that changes least often (per the operator's own observation: rule sets
// get edited far more than connection details), so it's its own small,
// stable, named entity rather than a field bag embedded in every fetch.
namespace SyncChannel.Configuration
{
    using System;
    using System.Collections.Generic;

    public class ConnectionEntry
    {
        public string Id { get; set; } = Guid.NewGuid().ToString("N");

        public string DisplayLabel { get; set; } = string.Empty;

        public string BaseUrl { get; set; } = string.Empty;

        public string ApiKey { get; set; } = string.Empty;
    }

    public class ConnectionsFile
    {
        public List<ConnectionEntry> Connections { get; set; } = new List<ConnectionEntry>();
    }
}