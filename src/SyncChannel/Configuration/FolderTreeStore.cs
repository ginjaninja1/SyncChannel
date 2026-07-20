namespace SyncChannel.Configuration
{
    using MediaBrowser.Common.Configuration;
    using MediaBrowser.Model.Logging;
    using MediaBrowser.Model.Serialization;
    using System;
    using System.IO;

    /// <summary>
    /// Load/save for the folder tree JSON file. Mirrors RadarrRuleSetStore's
    /// shape exactly (seed-default-on-missing-or-corrupt, same file layout
    /// under channel-sync/) for consistency with the rest of the plugin.
    /// </summary>
    public class FolderTreeStore
    {
        private const string FileName = "folder-tree.json";

        private readonly IApplicationPaths appPaths;
        private readonly IJsonSerializer json;
        private readonly ILogger logger;

        public FolderTreeStore(IApplicationPaths appPaths, IJsonSerializer json, ILogger logger)
        {
            this.appPaths = appPaths;
            this.json = json;
            this.logger = logger;
        }

        private string FilePath => Path.Combine(appPaths.DataPath, "channel-sync", FileName);

        public FolderTreeFile Load()
        {
            var path = FilePath;

            if (!File.Exists(path))
            {
                var seeded = new FolderTreeFile();
                Save(seeded);
                return seeded;
            }

            try
            {
                var text = File.ReadAllText(path);
                var file = json.DeserializeFromString<FolderTreeFile>(text);

                if (file?.RootFolder == null)
                {
                    var seeded = new FolderTreeFile();
                    Save(seeded);
                    return seeded;
                }

                // Root must always be marked IsRoot and cannot itself be
                // deleted client-side — guard against a hand-edited or
                // stale file losing that flag.
                file.RootFolder.IsRoot = true;

                return file;
            }
            catch (Exception ex)
            {
                logger.ErrorException("ChannelSync: Failed to read {0} — reseeding default folder tree", ex, path);
                var seeded = new FolderTreeFile();
                Save(seeded);
                return seeded;
            }
        }

        public void Save(FolderTreeFile file)
        {
            file.RootFolder.IsRoot = true;

            var path = FilePath;
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            File.WriteAllText(path, json.SerializeToString(file));
        }

        /// <summary>Depth-first search for a node by Id, or null if not found.</summary>
        public static FolderNode FindNode(FolderNode root, string nodeId)
        {
            if (root == null)
            {
                return null;
            }

            if (string.Equals(root.Id, nodeId, StringComparison.OrdinalIgnoreCase))
            {
                return root;
            }

            foreach (var child in root.Children)
            {
                var found = FindNode(child, nodeId);
                if (found != null)
                {
                    return found;
                }
            }

            return null;
        }

        /// <summary>Depth-first search for a node's direct parent, or null if root or not found.</summary>
        public static FolderNode FindParent(FolderNode root, string childId)
        {
            if (root == null)
            {
                return null;
            }

            foreach (var child in root.Children)
            {
                if (string.Equals(child.Id, childId, StringComparison.OrdinalIgnoreCase))
                {
                    return root;
                }

                var found = FindParent(child, childId);
                if (found != null)
                {
                    return found;
                }
            }

            return null;
        }
    }
}
