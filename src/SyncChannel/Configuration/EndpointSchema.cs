// The generalization that lets a brand-new REST source (Sonarr, or anything
// else) be supported as data, not code. An EndpointSchema names one HTTP GET
// path plus how to read identity/display fields and which fields the rule
// builder is allowed to filter on. Radarr and Sonarr ship as two seeded
// EndpointSchema rows (see EndpointSchemaStore.SeedBuiltIns) rather than as
// their own IFetchProvider classes — HttpFetchProvider is generic against
// any schema.
namespace SyncChannel.Configuration
{
    using System;
    using System.Collections.Generic;

    public enum EndpointAuthStyle
    {
        // apikey= query string param AND X-Api-Key header, both sent —
        // matches the confirmed-working Radarr/Sonarr *arr-family shape.
        ApiKeyQueryAndHeader
    }

    public enum SchemaFieldType { String, Number, Bool, List }

    // Which kind of Emby channel object this schema's items should become.
    // FlatMedia -> a single playable ChannelItemInfo (Type=Media), the
    // existing Radarr-movie shape. Series -> a ChannelFolderType.Series
    // folder, with a synthesized Season 1 / Episode 1 underneath pointing
    // at the shared stub video (see SyncFolderChannel). No implicit
    // default — every schema, built-in or user-authored, states this
    // explicitly, since guessing wrong here is exactly what caused Sonarr
    // items to be misidentified as movies.
    public enum ChannelObjectKind { FlatMedia, Series }

    public class SchemaField
    {
        // Dotted JSON path into each array element, e.g. "ratings.imdb.value".
        // Same path grammar RuleEvaluator already walks — unchanged.
        public string JsonPath { get; set; } = string.Empty;

        public string DisplayName { get; set; } = string.Empty;

        public SchemaFieldType Type { get; set; } = SchemaFieldType.String;
    }

    public class EndpointSchema
    {
        public string Id { get; set; } = Guid.NewGuid().ToString("N");

        public string DisplayName { get; set; } = string.Empty;

        // "radarr", "sonarr", etc. — must match ConnectionEntry.SystemType
        // for a Fetch to be allowed to pair them. A user-authored schema
        // declares its own value here (free text) rather than picking from a
        // fixed enum, so a new self-hosted *arr-family app doesn't require a
        // code change.
        public string SystemType { get; set; } = string.Empty;

        // Marks Radarr/Sonarr's built-in seeds so the UI can label them
        // "built-in" and the store can re-seed them if ever deleted. Not
        // otherwise treated specially by fetch/evaluation code — a
        // user-authored schema works identically.
        public bool IsBuiltIn { get; set; }

        // Which Emby channel object this schema's items become. See
        // ChannelObjectKind above.
        public ChannelObjectKind ObjectKind { get; set; }

        // Appended to Connection.BaseUrl, e.g. "/api/v3/movie".
        public string Path { get; set; } = string.Empty;

        public EndpointAuthStyle AuthStyle { get; set; } = EndpointAuthStyle.ApiKeyQueryAndHeader;

        // Dotted paths resolved against each array element to build a
        // FetchedItem generically. IdentityField is the only required one —
        // same "no stable id, drop the item" discipline as the old
        // TitleSlug-only rule (see Evidence.md).
        public string IdentityField { get; set; } = string.Empty;
        public string TitleField { get; set; } = string.Empty;
        public string OriginalTitleField { get; set; } = string.Empty;
        public string YearField { get; set; } = string.Empty;
        public string OverviewField { get; set; } = string.Empty;
        public string PosterUrlField { get; set; } = string.Empty;

        // Extra dotted paths, beyond the display fields above, surfaced as
        // ProviderIds on the resulting channel item — e.g. Radarr's tmdbId
        // and imdbId, which Emby's own UI recognises under "Tmdb"/"Imdb".
        public Dictionary<string, string> ProviderIdFields { get; set; } = new Dictionary<string, string>();

        // The fields available in the rule builder's palette for this schema.
        public List<SchemaField> Fields { get; set; } = new List<SchemaField>();

        public string DetailUrlFormat { get; set; } = string.Empty; // e.g. "{baseUrl}/movie/{identity}"
    }

    public class EndpointSchemasFile
    {
        public List<EndpointSchema> Schemas { get; set; } = new List<EndpointSchema>();
    }
}