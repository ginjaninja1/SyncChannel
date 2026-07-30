// Field favorites are a per-user UI preference (which fields sort to the
// top of the rule-builder palette), not a schema edit. Deliberately its own
// file/store rather than a property saved through EndpointSchemasStore —
// Post(SaveEndpointSchemas) unconditionally discards any built-in schema the
// client sends and re-attaches the on-disk copy (see Evidence.md), so
// favorites on Radarr/Sonarr's built-in fields would silently fail to
// persist if they lived on SchemaField.IsFavorite as the source of truth.
// SchemaField.IsFavorite still exists as a transport-only overlay value —
// ChannelSyncApiSurface stamps it onto each schema's Fields at read time
// from this store, right before returning to the client.
namespace SyncChannel.Configuration
{
    using MediaBrowser.Common.Configuration;
    using MediaBrowser.Model.Serialization;
    using System;
    using System.Collections.Generic;
    using System.IO;

    public class FieldFavoritesFile
    {
        // SchemaId -> set of favorited JsonPaths.
        public Dictionary<string, List<string>> FavoritesBySchemaId { get; set; } = new Dictionary<string, List<string>>();
    }

    public class FieldFavoritesStore
    {
        private const string FileName = "field-favorites.json";
        private static readonly object SyncRoot = new object();

        private readonly IApplicationPaths appPaths;
        private readonly IJsonSerializer json;

        public FieldFavoritesStore(IApplicationPaths appPaths, IJsonSerializer json)
        {
            this.appPaths = appPaths;
            this.json = json;
        }

        private string FilePath => Path.Combine(appPaths.DataPath, "channel-sync", FileName);

        public FieldFavoritesFile Load()
        {
            lock (SyncRoot)
            {
                return LoadCore();
            }
        }

        private FieldFavoritesFile LoadCore()
        {
            var path = FilePath;
            if (!File.Exists(path)) return new FieldFavoritesFile();

            try
            {
                return json.DeserializeFromString<FieldFavoritesFile>(File.ReadAllText(path)) ?? new FieldFavoritesFile();
            }
            catch
            {
                // Corrupt/unreadable favorites file: fail soft to "no
                // favorites" rather than block the rule builder from loading
                // at all — this store is a convenience layer, not core data.
                return new FieldFavoritesFile();
            }
        }

        public void Save(FieldFavoritesFile file)
        {
            lock (SyncRoot)
            {
                SaveCore(file);
            }
        }

        private void SaveCore(FieldFavoritesFile file)
        {
            var path = FilePath;
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                Directory.CreateDirectory(dir);

            File.WriteAllText(path, json.SerializeToString(file));
        }

        public HashSet<string> GetFavorites(string schemaId)
        {
            var file = Load();
            return file.FavoritesBySchemaId.TryGetValue(schemaId, out var paths)
                ? new HashSet<string>(paths, StringComparer.OrdinalIgnoreCase)
                : new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        }

        public void SetFavorite(string schemaId, string jsonPath, bool isFavorite)
        {
            lock (SyncRoot)
            {
                SetFavoriteCore(schemaId, jsonPath, isFavorite);
            }
        }

        private void SetFavoriteCore(string schemaId, string jsonPath, bool isFavorite)
        {
            var file = Load();

            if (!file.FavoritesBySchemaId.TryGetValue(schemaId, out var paths))
            {
                paths = new List<string>();
                file.FavoritesBySchemaId[schemaId] = paths;
            }

            bool alreadyPresent = paths.Exists(p => string.Equals(p, jsonPath, StringComparison.OrdinalIgnoreCase));

            if (isFavorite && !alreadyPresent)
            {
                paths.Add(jsonPath);
            }
            else if (!isFavorite && alreadyPresent)
            {
                paths.RemoveAll(p => string.Equals(p, jsonPath, StringComparison.OrdinalIgnoreCase));
            }
            else
            {
                return; // no-op — avoid an unnecessary disk write
            }

            Save(file);
        }
    }
}
