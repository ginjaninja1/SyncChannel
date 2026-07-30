namespace SyncChannel.Configuration
{
    using MediaBrowser.Common.Configuration;
    using MediaBrowser.Model.Logging;
    using MediaBrowser.Model.Serialization;
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;

    public class EndpointSchemaStore
    {
        private const string FileName = "endpoint-schemas.json";

        public const string RadarrMoviesId = "builtin-radarr-movies";
        public const string SonarrSeriesId = "builtin-sonarr-series";

        private readonly IApplicationPaths appPaths;
        private readonly IJsonSerializer json;
        private readonly ILogger logger;

        public EndpointSchemaStore(IApplicationPaths appPaths, IJsonSerializer json, ILogger logger)
        {
            this.appPaths = appPaths;
            this.json = json;
            this.logger = logger;
        }

        private string FilePath => Path.Combine(appPaths.DataPath, "channel-sync", FileName);

        public EndpointSchemasFile Load()
        {
            var path = FilePath;
            EndpointSchemasFile file = null;

            if (File.Exists(path))
            {
                try
                {
                    file = json.DeserializeFromString<EndpointSchemasFile>(File.ReadAllText(path));
                }
                catch (Exception ex)
                {
                    logger.ErrorException("ChannelSync: Failed to read {0} — reseeding built-ins", ex, path);
                }
            }

            file ??= new EndpointSchemasFile();

            // Re-seed (or refresh) built-ins on every load — cheap, idempotent,
            // and means a user who deletes a built-in by mistake gets it back
            // rather than silently losing Radarr/Sonarr support. Built-ins are
            // code-owned (SaveEndpointSchemas already strips and re-adds them
            // on every save), so an existing on-disk copy is fully REPLACED
            // with the current code's definition rather than left alone —
            // otherwise a schema saved before a new field (e.g. SystemType)
            // was added would keep loading with that field permanently blank.
            bool changed = ReplaceBuiltIn(file, BuildRadarrMovies());
            changed |= ReplaceBuiltIn(file, BuildSonarrSeries());

            if (changed || !File.Exists(path))
            {
                Save(file);
            }

            return file;
        }

        public void Save(EndpointSchemasFile file)
        {
            var path = FilePath;
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                Directory.CreateDirectory(dir);

            File.WriteAllText(path, json.SerializeToString(file));
        }

        public EndpointSchema Find(string id)
        {
            return Load().Schemas.FirstOrDefault(s => string.Equals(s.Id, id, StringComparison.OrdinalIgnoreCase));
        }

        // Always brings the stored built-in in line with the current code
        // definition. Returns true if the file changed (either a fresh add,
        // or an existing stale copy was replaced) so the caller knows
        // whether to re-save. Compares the whole serialized shape rather
        // than field-by-field now that fields are FieldMapping objects, not
        // plain strings — simpler and can't silently miss a new field the
        // way a hand-maintained field list could.
        private bool ReplaceBuiltIn(EndpointSchemasFile file, EndpointSchema builtIn)
        {
            var existingIndex = file.Schemas.FindIndex(
                s => string.Equals(s.Id, builtIn.Id, StringComparison.OrdinalIgnoreCase));

            if (existingIndex < 0)
            {
                file.Schemas.Add(builtIn);
                return true;
            }

            var existing = file.Schemas[existingIndex];
            bool identical = json.SerializeToString(existing) == json.SerializeToString(builtIn);

            if (identical)
            {
                return false;
            }

            file.Schemas[existingIndex] = builtIn;
            return true;
        }

        // ---- Small helpers so the seeds below read as intent, not
        // boilerplate segment-list construction. ----

        private static FieldMapping Field(string jsonPath) => new FieldMapping
        {
            Segments = new List<MappingSegment>
            {
                new MappingSegment { Kind = MappingSegmentKind.Field, Value = jsonPath }
            }
        };

        // ---- Seeded schemas — the "Radarr support" and "Sonarr support"
        // that used to be C# classes now live here as data. ----

        private static EndpointSchema BuildRadarrMovies() => new EndpointSchema
        {
            Id = RadarrMoviesId,
            DisplayName = "Radarr — Movies",
            IsBuiltIn = true,
            SystemType = "radarr",
            ObjectKind = ChannelObjectKind.FlatMedia,
            Path = "/api/v3/movie",
            IdentityField = Field("titleSlug"),
            TitleField = Field("title"),
            OriginalTitleField = Field("originalTitle"),
            YearField = Field("year"),
            OverviewField = Field("overview"),
            // "images" resolves via the images[].coverType=="poster"->remoteUrl
            // special case inside HttpFetchProvider.ResolveFieldSegmentValue —
            // a single Field segment is enough, no template needed.
            PosterUrlField = Field("images"),
            DetailUrlFormat = "{baseUrl}/movie/{identity}",
            ProviderIdFields = new Dictionary<string, FieldMapping>
            {
                ["Tmdb"] = Field("tmdbId"),
                ["Imdb"] = Field("imdbId"),
                ["RadarrId"] = Field("titleSlug")
            },
            Fields = new List<SchemaField>
            {
                new SchemaField { JsonPath = "monitored", DisplayName = "monitored", Type = SchemaFieldType.Bool },
                new SchemaField { JsonPath = "hasFile", DisplayName = "hasFile", Type = SchemaFieldType.Bool },
                new SchemaField { JsonPath = "year", DisplayName = "year", Type = SchemaFieldType.Number },
                new SchemaField { JsonPath = "runtime", DisplayName = "runtime", Type = SchemaFieldType.Number },
                new SchemaField { JsonPath = "tmdbId", DisplayName = "tmdbId", Type = SchemaFieldType.Number },
                new SchemaField { JsonPath = "imdbId", DisplayName = "imdbId", Type = SchemaFieldType.String },
                new SchemaField { JsonPath = "title", DisplayName = "title", Type = SchemaFieldType.String },
                new SchemaField { JsonPath = "originalTitle", DisplayName = "originalTitle", Type = SchemaFieldType.String },
                new SchemaField { JsonPath = "overview", DisplayName = "overview", Type = SchemaFieldType.String },
                new SchemaField { JsonPath = "certification", DisplayName = "certification", Type = SchemaFieldType.String },
                new SchemaField { JsonPath = "titleSlug", DisplayName = "titleSlug", Type = SchemaFieldType.String },
                new SchemaField { JsonPath = "genres", DisplayName = "genres", Type = SchemaFieldType.List },
                new SchemaField { JsonPath = "studios.name", DisplayName = "studios", Type = SchemaFieldType.List },
                new SchemaField { JsonPath = "images.coverType", DisplayName = "image cover types", Type = SchemaFieldType.List },
                new SchemaField { JsonPath = "ratings.imdb.value", DisplayName = "ratings.imdb.value", Type = SchemaFieldType.Number },
                new SchemaField { JsonPath = "ratings.tmdb.value", DisplayName = "ratings.tmdb.value", Type = SchemaFieldType.Number },
                new SchemaField { JsonPath = "ratings.rottenTomatoes.value", DisplayName = "ratings.rottenTomatoes.value", Type = SchemaFieldType.Number },
                new SchemaField { JsonPath = "ratings.metacritic.value", DisplayName = "ratings.metacritic.value", Type = SchemaFieldType.Number },
                new SchemaField { JsonPath = "ratings.imdb.votes", DisplayName = "ratings.imdb.votes", Type = SchemaFieldType.Number },
                new SchemaField { JsonPath = "ratings.tmdb.votes", DisplayName = "ratings.tmdb.votes", Type = SchemaFieldType.Number },
            }
        };

        // Sonarr's /api/v3/series shape is documented (same *arr-family
        // conventions as Radarr) but has NOT been run against a live Sonarr
        // instance from this codebase the way Radarr has — flagged here the
        // same way README-folder-tree.md flagged the untested DI chain.
        // Treat field names as "best guess from the public Sonarr API docs,"
        // not "confirmed," until someone runs it once and updates this.
        private static EndpointSchema BuildSonarrSeries() => new EndpointSchema
        {
            Id = SonarrSeriesId,
            DisplayName = "Sonarr — Series",
            IsBuiltIn = true,
            SystemType = "sonarr",
            ObjectKind = ChannelObjectKind.Series,
            Path = "/api/v3/series",
            IdentityField = Field("titleSlug"),
            TitleField = Field("title"),
            OriginalTitleField = Field("title"),
            YearField = Field("year"),
            OverviewField = Field("overview"),
            PosterUrlField = Field("images"),
            DetailUrlFormat = "{baseUrl}/series/{identity}",
            ProviderIdFields = new Dictionary<string, FieldMapping>
            {
                ["Tvdb"] = Field("tvdbId"),
                ["SonarrId"] = Field("titleSlug")
            },
            Fields = new List<SchemaField>
            {
                new SchemaField { JsonPath = "monitored", DisplayName = "monitored", Type = SchemaFieldType.Bool },
                new SchemaField { JsonPath = "status", DisplayName = "status", Type = SchemaFieldType.String },
                new SchemaField { JsonPath = "year", DisplayName = "year", Type = SchemaFieldType.Number },
                new SchemaField { JsonPath = "network", DisplayName = "network", Type = SchemaFieldType.String },
                new SchemaField { JsonPath = "title", DisplayName = "title", Type = SchemaFieldType.String },
                new SchemaField { JsonPath = "titleSlug", DisplayName = "titleSlug", Type = SchemaFieldType.String },
                new SchemaField { JsonPath = "genres", DisplayName = "genres", Type = SchemaFieldType.List },
                new SchemaField { JsonPath = "seasonCount", DisplayName = "seasonCount", Type = SchemaFieldType.Number },
            }
        };
    }
}