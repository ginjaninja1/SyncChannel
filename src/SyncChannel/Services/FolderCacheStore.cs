namespace SyncChannel.Services
{
    using SyncChannel.Models;
    using MediaBrowser.Common.Configuration;
    using MediaBrowser.Model.Logging;
    using MediaBrowser.Model.Serialization;
    using System;
    using System.IO;

    public class FolderCacheStore
    {
        private readonly IApplicationPaths appPaths;
        private readonly IJsonSerializer json;
        private readonly ILogger logger;

        public FolderCacheStore(IApplicationPaths appPaths, IJsonSerializer json, ILogger logger)
        {
            this.appPaths = appPaths;
            this.json = json;
            this.logger = logger;
        }

        private string PathFor(string folderId) =>
            Path.Combine(appPaths.DataPath, "channel-sync", "folders", folderId + ".json");

        public FolderCache Read(string folderId)
        {
            var path = PathFor(folderId);

            if (!File.Exists(path))
            {
                return new FolderCache { LastSyncSucceeded = false };
            }

            try
            {
                var text = File.ReadAllText(path);
                return json.DeserializeFromString<FolderCache>(text) ?? new FolderCache { LastSyncSucceeded = false };
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Failed to read folder cache for {0}", ex, folderId);
                return new FolderCache { LastSyncSucceeded = false };
            }
        }

        public void Write(string folderId, FolderCache cache)
        {
            var path = PathFor(folderId);
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            File.WriteAllText(path, json.SerializeToString(cache));
        }

        /// <summary>
        /// Deletes cache files for folder ids that no longer exist in the
        /// current tree. Called after a tree save so a removed folder's
        /// stale cache file doesn't linger on disk forever (it's harmless —
        /// nothing reads an orphaned file — but there's no reason to keep it).
        /// </summary>
        public void DeleteOrphans(System.Collections.Generic.IEnumerable<string> liveFolderIds)
        {
            var dir = Path.Combine(appPaths.DataPath, "channel-sync", "folders");
            if (!Directory.Exists(dir))
            {
                return;
            }

            var live = new System.Collections.Generic.HashSet<string>(liveFolderIds, StringComparer.OrdinalIgnoreCase);

            foreach (var file in Directory.GetFiles(dir, "*.json"))
            {
                var id = Path.GetFileNameWithoutExtension(file);
                if (!live.Contains(id))
                {
                    try
                    {
                        File.Delete(file);
                    }
                    catch (Exception ex)
                    {
                        logger.ErrorException("ChannelSync: Failed to delete orphaned folder cache {0}", ex, file);
                    }
                }
            }
        }
    }
}
